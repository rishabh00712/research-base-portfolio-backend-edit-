// routes/contact.js - Contact section (read + edit fields + CV upload/replace/remove)
const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const pool = require("../db");

const router = express.Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const CV_FOLDER = "cv";
const MAX_CV_BYTES = 10 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROW = `(SELECT id FROM profile ORDER BY id LIMIT 1)`;
const COLUMNS = `email, number, office_location, department, cv`;

// Read-only social icons. If your old /api/contact query for these was different,
// copy it here (only this one query needs to match).
const getContact = async () => {
  const profile = (await pool.query(`SELECT ${COLUMNS} FROM profile ORDER BY id LIMIT 1`)).rows[0];
  if (!profile) return null;
  const social = (await pool.query(`SELECT id, name, link FROM social_media_links ORDER BY id`)).rows;
  return { ...profile, social_links: social };
};

/* ---------- Cloudinary helpers ---------- */
const uploadPdf = (buffer) =>
  new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        { resource_type: "raw", folder: CV_FOLDER, public_id: `cv_${Date.now()}.pdf` },
        (err, result) => (err ? reject(err) : resolve(result))
      )
      .end(buffer);
  });

// Works out what to delete from a stored URL. Returns null if it isn't one of OUR cv files.
const parseCloudinaryUrl = (url) => {
  if (!url) return null;
  const m = /^https?:\/\/res\.cloudinary\.com\/([^/]+)\/(image|raw)\/upload\/(?:v\d+\/)?(.+?)(?:\?.*)?$/.exec(url);
  if (!m || m[1] !== process.env.CLOUDINARY_CLOUD_NAME) return null;

  let publicId = decodeURIComponent(m[3]);
  if (!publicId.startsWith(`${CV_FOLDER}/`)) return null; // never touch other files (e.g. profile photo)
  if (m[2] === "image") publicId = publicId.replace(/\.[^/.]+$/, ""); // image ids have no extension
  return { publicId, resourceType: m[2] };
};

const deleteFromCloudinary = async (url) => {
  const target = parseCloudinaryUrl(url);
  if (!target) return;
  try {
    await cloudinary.uploader.destroy(target.publicId, {
      resource_type: target.resourceType,
      invalidate: true,
    });
  } catch (err) {
    console.error("Cloudinary delete failed:", err.message); // don't fail the request
  }
};

/* ---------- multer: keep the file in memory, PDF only ---------- */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CV_BYTES } });
const receiveCv = (req, res, next) =>
  upload.single("cv")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "CV must be under 10 MB" });
    return res.status(400).json({ error: "Could not read the uploaded file" });
  });

/* ---------- GET /api/contact ---------- */
router.get("/contact", async (req, res) => {
  try {
    res.json(await getContact());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- PATCH /api/contact : email, number, office_location, department ---------- */
const FIELDS = { email: 255, number: 50, office_location: 255, department: 255 };

router.patch("/contact", async (req, res) => {
  try {
    const body = req.body || {};
    const sets = [];
    const values = [];

    for (const [key, max] of Object.entries(FIELDS)) {
      if (!(key in body)) continue;
      let v = body[key];
      if (v === null || v === undefined) v = "";
      if (typeof v !== "string") return res.status(400).json({ error: `${key} must be text` });
      v = v.trim();
      if (v.length > max) return res.status(400).json({ error: `${key} must be ${max} characters or less` });
      if (key === "email" && v && !EMAIL_RE.test(v))
        return res.status(400).json({ error: "That email address isn't valid" });
      values.push(v);
      sets.push(`${key} = $${values.length}`); // key comes from FIELDS, never from the user
    }

    if (sets.length === 0) return res.status(400).json({ error: "Nothing to update" });

    const result = await pool.query(
      `UPDATE profile SET ${sets.join(", ")} WHERE id = ${ROW} RETURNING ${COLUMNS}`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Profile not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- POST /api/contact/cv : upload a PDF, replace the old one ---------- */
router.post("/contact/cv", receiveCv, async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "Choose a PDF file" });
  if (file.mimetype !== "application/pdf" || file.buffer.subarray(0, 4).toString() !== "%PDF")
    return res.status(400).json({ error: "Only PDF files are allowed" });

  let uploaded;
  try {
    uploaded = await uploadPdf(file.buffer); // 1) new file first, so a failure loses nothing
  } catch (err) {
    console.error("Cloudinary upload failed:", err.message);
    return res.status(502).json({ error: "Upload failed. Please try again." });
  }

  try {
    // 2) swap the URL and read the OLD one in the same statement
    const result = await pool.query(
      `WITH old AS (SELECT id, cv FROM profile ORDER BY id LIMIT 1 FOR UPDATE)
       UPDATE profile p SET cv = $1
       FROM old WHERE p.id = old.id
       RETURNING old.cv AS old_cv, p.cv AS cv`,
      [uploaded.secure_url]
    );
    if (result.rows.length === 0) {
      await deleteFromCloudinary(uploaded.secure_url);
      return res.status(404).json({ error: "Profile not found" });
    }

    // 3) only now remove the previous file
    const oldUrl = result.rows[0].old_cv;
    if (oldUrl && oldUrl !== uploaded.secure_url) await deleteFromCloudinary(oldUrl);

    res.json({ cv: result.rows[0].cv });
  } catch (err) {
    await deleteFromCloudinary(uploaded.secure_url); // DB failed: don't leave an orphan
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- DELETE /api/contact/cv : remove the CV completely ---------- */
router.delete("/contact/cv", async (req, res) => {
  try {
    const result = await pool.query(
      `WITH old AS (SELECT id, cv FROM profile ORDER BY id LIMIT 1 FOR UPDATE)
       UPDATE profile p SET cv = NULL
       FROM old WHERE p.id = old.id
       RETURNING old.cv AS old_cv`
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Profile not found" });
    await deleteFromCloudinary(result.rows[0].old_cv);
    res.json({ cv: null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;