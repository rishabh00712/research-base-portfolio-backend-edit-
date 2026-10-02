// routes/home.js - everything the Home page needs (read + edit)
const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const pool = require("../db");

const router = express.Router();

/* ---------- Cloudinary + upload setup ---------- */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith("image/")
      ? cb(null, true)
      : cb(new Error("Only images are allowed")),
});

/* ---------- helpers ---------- */
// "https://res.cloudinary.com/<cloud>/image/upload/v123/lab/profile/abc.jpg" -> "lab/profile/abc"
const publicIdFromUrl = (url = "") => {
  if (!url || !url.includes(`res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`)) return null;
  const part = url.split("/upload/")[1];
  if (!part) return null;
  const path = decodeURIComponent(part.split("?")[0]).replace(/^v\d+\//, "");
  return path.replace(/\.[a-z0-9]+$/i, "") || null;
};

const uploadToCloudinary = (buffer) =>
  new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ folder: "lab/profile", resource_type: "image" }, (err, result) =>
        err ? reject(err) : resolve(result)
      )
      .end(buffer);
  });

const listSocial = async (profileId) =>
  (
    await pool.query(
      "SELECT id, name, link FROM social_media_links WHERE profile_id = $1 ORDER BY id",
      [profileId]
    )
  ).rows;

const getProfileId = async () =>
  (await pool.query("SELECT id FROM profile ORDER BY id LIMIT 1")).rows[0]?.id;

/* ---------- GET /api/profile : profile + social links ---------- */
router.get("/profile", async (req, res) => {
  try {
    const profileResult = await pool.query("SELECT * FROM profile ORDER BY id LIMIT 1");
    if (profileResult.rows.length === 0) {
      return res.status(404).json({ error: "Profile not found" });
    }
    const profile = profileResult.rows[0];
    res.json({ ...profile, social_media_links: await listSocial(profile.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- PATCH /api/profile : lab name / description ---------- */
const EDITABLE = ["lab_name", "short_description"];

router.patch("/profile", async (req, res) => {
  try {
    const keys = EDITABLE.filter((k) => typeof req.body[k] === "string");
    if (keys.length === 0) return res.status(400).json({ error: "Nothing to update" });
    if (keys.includes("lab_name") && !req.body.lab_name.trim())
      return res.status(400).json({ error: "Lab name can't be empty" });

    const profileId = await getProfileId();
    if (!profileId) return res.status(404).json({ error: "Profile not found" });

    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
    const values = keys.map((k) => req.body[k].trim());
    const result = await pool.query(
      `UPDATE profile SET ${sets} WHERE id = $${keys.length + 1} RETURNING ${keys.join(", ")}`,
      [...values, profileId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- POST /api/profile/image : replace profile image ---------- */
router.post("/profile/image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });

    const { rows } = await pool.query("SELECT id, image FROM profile ORDER BY id LIMIT 1");
    if (rows.length === 0) return res.status(404).json({ error: "Profile not found" });

    // upload first, so a failed upload never leaves the profile without an image
    const result = await uploadToCloudinary(req.file.buffer);

    // then remove the previous image (ignored if it isn't on Cloudinary / already gone)
    const oldId = publicIdFromUrl(rows[0].image);
    if (oldId) {
      try {
        await cloudinary.uploader.destroy(oldId, { invalidate: true });
      } catch (e) {
        console.warn("Old image not removed:", e.message);
      }
    }

    await pool.query("UPDATE profile SET image = $1 WHERE id = $2", [result.secure_url, rows[0].id]);
    res.json({ image: result.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Image upload failed" });
  }
});

/* ---------- social links: add / change / remove ---------- */
router.post("/social", async (req, res) => {
  try {
    const { name, link } = req.body;
    if (!name || !link) return res.status(400).json({ error: "Name and link are required" });
    const profileId = await getProfileId();
    await pool.query(
      "INSERT INTO social_media_links (profile_id, name, link) VALUES ($1, $2, $3)",
      [profileId, name, link]
    );
    res.json(await listSocial(profileId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/social/:id", async (req, res) => {
  try {
    const profileId = await getProfileId();
    await pool.query(
      "UPDATE social_media_links SET link = $1 WHERE id = $2 AND profile_id = $3",
      [req.body.link || "", req.params.id, profileId]
    );
    res.json(await listSocial(profileId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/social/:id", async (req, res) => {
  try {
    const profileId = await getProfileId();
    await pool.query("DELETE FROM social_media_links WHERE id = $1 AND profile_id = $2", [
      req.params.id,
      profileId,
    ]);
    res.json(await listSocial(profileId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- multer / upload errors -> JSON (only for this router) ---------- */
router.use((err, req, res, next) => {
  res.status(400).json({ error: err.message || "Bad request" });
});

module.exports = router;