// routes/people.js - People page (profile fields, work roles, photo, team members)
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

const PROFILE_FOLDER = "profile";
const TEAM_FOLDER = "team";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ROLES = 30;
const MAX_ROLE_LEN = 100;

const ROW = `(SELECT id FROM profile ORDER BY id LIMIT 1)`;
const PERSON_COLUMNS = `image, name, one_line_description, mid_description,
                        COALESCE(work_role, '{}') AS work_role`;
const MEMBER_COLUMNS = `id, name, role, image, link`;

/* ---------- Cloudinary + image helpers ---------- */
const uploadImage = (buffer, folder) =>
  new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ resource_type: "image", folder }, (err, result) =>
        err ? reject(err) : resolve(result)
      )
      .end(buffer);
  });

// Only ever deletes images in OUR cloud. Returns silently for any other URL.
const deleteImage = async (url) => {
  if (!url) return;
  const m = /^https?:\/\/res\.cloudinary\.com\/([^/]+)\/image\/upload\/(?:v\d+\/)?(.+?)(?:\?.*)?$/.exec(url);
  if (!m || m[1] !== process.env.CLOUDINARY_CLOUD_NAME) return;
  const publicId = decodeURIComponent(m[2]).replace(/\.[^/.]+$/, ""); // image ids have no extension
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
  } catch (err) {
    console.error("Cloudinary delete failed:", err.message); // never fail the request for this
  }
};

// real image? (mimetype AND file signature)
const imageError = (file) => {
  const b = file.buffer;
  const ok =
    file.mimetype.startsWith("image/") &&
    ((b[0] === 0xff && b[1] === 0xd8) || // jpeg
      b.subarray(0, 4).toString("hex") === "89504e47" || // png
      b.subarray(0, 4).toString() === "GIF8" || // gif
      (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP")); // webp
  return ok ? null : "Only image files (JPG, PNG, GIF, WebP) are allowed";
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } });
const receiveImage = (req, res, next) =>
  upload.single("image")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Image must be under 5 MB" });
    return res.status(400).json({ error: "Could not read the uploaded file" });
  });

/* =====================================================================
   PROFILE (the person card)
   ===================================================================== */
const getPerson = async () => {
  const person = (await pool.query(`SELECT ${PERSON_COLUMNS} FROM profile ORDER BY id LIMIT 1`)).rows[0];
  if (!person) return null;
  // read-only social icons; copy your old query here if it differs
  const social = (await pool.query(`SELECT id, name, link FROM social_media_links ORDER BY id`)).rows;
  return { ...person, social_links: social };
};

router.get("/people", async (req, res) => {
  try {
    res.json(await getPerson());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* PATCH /api/people : name, one_line_description, mid_description */
const PERSON_FIELDS = { name: 255, one_line_description: 255, mid_description: null }; // null = no limit

router.patch("/people", async (req, res) => {
  try {
    const body = req.body || {};
    const sets = [];
    const values = [];

    for (const [key, max] of Object.entries(PERSON_FIELDS)) {
      if (!(key in body)) continue;
      let v = body[key];
      if (v === null || v === undefined) v = "";
      if (typeof v !== "string") return res.status(400).json({ error: `${key} must be text` });
      v = v.trim();
      if (key === "name" && !v) return res.status(400).json({ error: "Name can't be empty" });
      if (max && v.length > max)
        return res.status(400).json({ error: `${key} must be ${max} characters or less` });
      values.push(v);
      sets.push(`${key} = $${values.length}`); // key comes from PERSON_FIELDS, never from the user
    }
    if (sets.length === 0) return res.status(400).json({ error: "Nothing to update" });

    const result = await pool.query(
      `UPDATE profile SET ${sets.join(", ")} WHERE id = ${ROW} RETURNING ${PERSON_COLUMNS}`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Profile not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* POST /api/people/roles : add one work role (atomic, no duplicates, max 30) */
router.post("/people/roles", async (req, res) => {
  try {
    const role = typeof req.body?.role === "string" ? req.body.role.trim() : "";
    if (!role) return res.status(400).json({ error: "Role can't be empty" });
    if (role.length > MAX_ROLE_LEN)
      return res.status(400).json({ error: `Role must be ${MAX_ROLE_LEN} characters or less` });

    const result = await pool.query(
      `UPDATE profile
       SET work_role = array_append(COALESCE(work_role, '{}'), $1)
       WHERE id = ${ROW}
         AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(work_role, '{}')) r WHERE lower(r) = lower($1))
         AND COALESCE(array_length(work_role, 1), 0) < $2
       RETURNING ${PERSON_COLUMNS}`,
      [role, MAX_ROLES]
    );

    if (result.rows.length === 0) {
      const current = (await pool.query(`SELECT ${PERSON_COLUMNS} FROM profile ORDER BY id LIMIT 1`)).rows[0];
      if (!current) return res.status(404).json({ error: "Profile not found" });
      if (current.work_role.length >= MAX_ROLES)
        return res.status(400).json({ error: `You can have at most ${MAX_ROLES} roles` });
      return res.status(409).json({ error: "That role already exists" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* DELETE /api/people/roles/:role : remove one work role */
router.delete("/people/roles/:role", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE profile SET work_role = array_remove(COALESCE(work_role, '{}'), $1)
       WHERE id = ${ROW} RETURNING ${PERSON_COLUMNS}`,
      [req.params.role]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Profile not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* POST /api/people/image : new photo, then remove the old one from Cloudinary */
router.post("/people/image", receiveImage, async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "Choose an image" });
  const bad = imageError(file);
  if (bad) return res.status(400).json({ error: bad });

  let uploaded;
  try {
    uploaded = await uploadImage(file.buffer, PROFILE_FOLDER); // 1) new file first
  } catch (err) {
    console.error("Cloudinary upload failed:", err.message);
    return res.status(502).json({ error: "Upload failed. Please try again." });
  }

  try {
    // 2) swap the URL and read the OLD one in the same statement
    const result = await pool.query(
      `WITH old AS (SELECT id, image FROM profile ORDER BY id LIMIT 1 FOR UPDATE)
       UPDATE profile p SET image = $1
       FROM old WHERE p.id = old.id
       RETURNING old.image AS old_image, p.image AS image`,
      [uploaded.secure_url]
    );
    if (result.rows.length === 0) {
      await deleteImage(uploaded.secure_url);
      return res.status(404).json({ error: "Profile not found" });
    }
    // 3) only now remove the previous file
    const oldUrl = result.rows[0].old_image;
    if (oldUrl && oldUrl !== uploaded.secure_url) await deleteImage(oldUrl);

    res.json({ image: result.rows[0].image });
  } catch (err) {
    await deleteImage(uploaded.secure_url); // DB failed: don't leave an orphan
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =====================================================================
   TEAM MEMBERS (name, role, link, image)
   ===================================================================== */
const MEMBER_LIMITS = { name: 255, role: 255, link: 500 };

const normalizeUrl = (raw) => {
  const l = String(raw ?? "").trim();
  if (!l) return "";
  return /^https?:\/\//i.test(l) ? l : `https://${l}`;
};

// returns { error } or { values } (only the keys present in body)
const readMember = (body, requireName) => {
  const values = {};
  for (const [key, max] of Object.entries(MEMBER_LIMITS)) {
    if (!(key in body)) continue;
    let v = body[key];
    if (v === null || v === undefined) v = "";
    if (typeof v !== "string") return { error: `${key} must be text` };
    v = key === "link" ? normalizeUrl(v) : v.trim();
    if (v.length > max) return { error: `${key} must be ${max} characters or less` };
    values[key] = v;
  }
  if (("name" in values && !values.name) || (requireName && !values.name))
    return { error: "Name is required" };
  return { values };
};

router.get("/team-members", async (req, res) => {
  try {
    // change ORDER BY if your table has its own position column
    res.json((await pool.query(`SELECT ${MEMBER_COLUMNS} FROM team_members ORDER BY id ASC`)).rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/team-members", receiveImage, async (req, res) => {
  const parsed = readMember(req.body || {}, true);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (req.file) {
    const bad = imageError(req.file);
    if (bad) return res.status(400).json({ error: bad });
  }

  let imageUrl = null;
  if (req.file) {
    try {
      imageUrl = (await uploadImage(req.file.buffer, TEAM_FOLDER)).secure_url;
    } catch (err) {
      console.error("Cloudinary upload failed:", err.message);
      return res.status(502).json({ error: "Upload failed. Please try again." });
    }
  }

  const v = parsed.values;
  try {
    const result = await pool.query(
      `INSERT INTO team_members (name, role, link, image)
       VALUES ($1, $2, $3, $4) RETURNING ${MEMBER_COLUMNS}`,
      [v.name, v.role ?? "", v.link ?? "", imageUrl]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await deleteImage(imageUrl);
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/team-members/:id", receiveImage, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = readMember(req.body || {}, false);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (req.file) {
    const bad = imageError(req.file);
    if (bad) return res.status(400).json({ error: bad });
  }

  const sets = [];
  const values = [];
  for (const key of Object.keys(MEMBER_LIMITS)) {
    if (!(key in parsed.values)) continue;
    values.push(parsed.values[key]);
    sets.push(`${key} = $${values.length}`); // fixed list, never from the user
  }

  let newUrl = null;
  if (req.file) {
    try {
      newUrl = (await uploadImage(req.file.buffer, TEAM_FOLDER)).secure_url;
    } catch (err) {
      console.error("Cloudinary upload failed:", err.message);
      return res.status(502).json({ error: "Upload failed. Please try again." });
    }
    values.push(newUrl);
    sets.push(`image = $${values.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: "Nothing to update" });

  try {
    values.push(id);
    const result = await pool.query(
      `WITH old AS (SELECT id, image FROM team_members WHERE id = $${values.length} FOR UPDATE)
       UPDATE team_members t SET ${sets.join(", ")}
       FROM old WHERE t.id = old.id
       RETURNING t.id, t.name, t.role, t.image, t.link, old.image AS old_image`,
      values
    );
    if (result.rows.length === 0) {
      await deleteImage(newUrl);
      return res.status(404).json({ error: "Team member not found" });
    }
    const { old_image: oldUrl, ...row } = result.rows[0];
    if (newUrl && oldUrl && oldUrl !== newUrl) await deleteImage(oldUrl);
    res.json(row);
  } catch (err) {
    await deleteImage(newUrl);
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/team-members/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
    const result = await pool.query(`DELETE FROM team_members WHERE id = $1 RETURNING image`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Team member not found" });
    await deleteImage(result.rows[0].image);
    res.json({ id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;