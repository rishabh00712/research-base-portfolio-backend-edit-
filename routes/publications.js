// routes/publications.js - Publications page (Google Scholar / ORCID links + publication list)
// Mount in server.js:  app.use("/api", require("./routes/publications"));
// and DELETE the old  app.get("/api/publications", ...)  from server.js.
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

const FOLDER = "publications";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DESC = 5000;
const MAX_LINK = 1000;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 50;
const MIN_GAP = 1e-6; // neighbours closer than this -> renumber everything first
const LOCK_ID = 7001; // serialises position changes

// p = optional table alias prefix, e.g. cols("p.")
const cols = (p = "") =>
  `${p}id, to_char(${p}date, 'YYYY-MM-DD') AS date, EXTRACT(YEAR FROM ${p}date)::int AS year,
   ${p}image, ${p}description, ${p}paper_link, ${p}tags, ${p}position`;

/* ---------- Cloudinary + image helpers (same as people.js) ---------- */
const uploadImage = (buffer) =>
  new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ resource_type: "image", folder: FOLDER }, (err, result) =>
        err ? reject(err) : resolve(result)
      )
      .end(buffer);
  });

// Only deletes images in OUR cloud; silently ignores Drive links, /paths, etc.
const deleteImage = async (url) => {
  if (!url) return;
  const m = /^https?:\/\/res\.cloudinary\.com\/([^/]+)\/image\/upload\/(?:v\d+\/)?(.+?)(?:\?.*)?$/.exec(url);
  if (!m || m[1] !== process.env.CLOUDINARY_CLOUD_NAME) return;
  const publicId = decodeURIComponent(m[2]).replace(/\.[^/.]+$/, "");
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
  } catch (err) {
    console.error("Cloudinary delete failed:", err.message);
  }
};

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
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Image must be under 8 MB" });
    return res.status(400).json({ error: "Could not read the uploaded file" });
  });

const normalizeUrl = (raw) => {
  const l = String(raw ?? "").trim();
  if (!l) return "";
  return /^https?:\/\//i.test(l) ? l : `https://${l}`;
};

/* =====================================================================
   GET /api/publications  - the public page. Sorted by position, highest first.
   ===================================================================== */
router.get("/publications", async (req, res) => {
  try {
    const profile = (await pool.query(`SELECT google_scholar, orcid FROM profile ORDER BY id LIMIT 1`)).rows[0];
    const publications = (
      await pool.query(`SELECT ${cols()} FROM publications ORDER BY position DESC, id DESC`)
    ).rows;

    res.json({
      google_scholar: profile?.google_scholar || null,
      orcid: profile?.orcid || null,
      publications,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =====================================================================
   PATCH /api/publications/links  { google_scholar?, orcid? }   ("" = delete)
   (must stay ABOVE the /:id routes)
   ===================================================================== */
router.patch("/publications/links", async (req, res) => {
  try {
    const body = req.body || {};
    const sets = [];
    const values = [];

    for (const key of ["google_scholar", "orcid"]) {
      if (!(key in body)) continue;
      let v = body[key];
      if (v === null || v === undefined) v = "";
      if (typeof v !== "string") return res.status(400).json({ error: `${key} must be text` });
      v = key === "google_scholar" ? normalizeUrl(v) : v.trim(); // ORCID may be a bare id
      if (v.length > MAX_LINK) return res.status(400).json({ error: `${key} is too long` });
      values.push(v || null);
      sets.push(`${key} = $${values.length}`); // key comes from the fixed list above
    }
    if (sets.length === 0) return res.status(400).json({ error: "Nothing to update" });

    const result = await pool.query(
      `UPDATE profile SET ${sets.join(", ")}
       WHERE id = (SELECT id FROM profile ORDER BY id LIMIT 1)
       RETURNING google_scholar, orcid`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Profile not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- read + validate publication fields (only the keys present) ---------- */
const readPub = (body, creating) => {
  const values = {};

  if (creating || "date" in body) {
    const d = String(body.date ?? "").trim();
    const dt = new Date(`${d}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== d)
      return { error: "Enter a valid date" };
    values.date = d;
  }

  if (creating || "description" in body) {
    const t = String(body.description ?? "").trim();
    if (!t) return { error: "Description is required" };
    if (t.length > MAX_DESC) return { error: `Description must be ${MAX_DESC} characters or less` };
    values.description = t;
  }

  if ("paper_link" in body) {
    const v = normalizeUrl(body.paper_link);
    if (v.length > MAX_LINK) return { error: "paper_link is too long" };
    values.paper_link = v || null;
  }

  if ("tags" in body) {
    const raw = Array.isArray(body.tags) ? body.tags : String(body.tags ?? "").split(",");
    const seen = new Set();
    const tags = [];
    for (const t of raw.map((x) => String(x).trim()).filter(Boolean)) {
      if (t.length > MAX_TAG_LEN) return { error: `Each tag must be ${MAX_TAG_LEN} characters or less` };
      if (!seen.has(t.toLowerCase())) {
        seen.add(t.toLowerCase());
        tags.push(t);
      }
    }
    if (tags.length > MAX_TAGS) return { error: `Use at most ${MAX_TAGS} tags` };
    values.tags = tags;
  }

  return { values };
};

/* ---------- position logic ----------
   The page shows position DESC, so:
     "above" the anchor = a number between the anchor and the next HIGHER position
     "below" the anchor = a number between the anchor and the next LOWER position
   Only the new row gets a position; nothing else is rewritten (unless gaps get tiny). */
const renumber = (client) =>
  client.query(
    `UPDATE publications p SET position = s.rn
     FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY position ASC, id ASC) AS rn FROM publications) s
     WHERE p.id = s.id`
  );

// returns a number, or null if the anchor doesn't exist
const nextPosition = async (client, place, anchorId) => {
  if (!anchorId) {
    const r = await client.query(`SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM publications`);
    return Number(r.rows[0].pos); // no anchor = top of the list
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const a = (await client.query(`SELECT position FROM publications WHERE id = $1`, [anchorId])).rows[0];
    if (!a) return null;
    const cur = Number(a.position);
    const above = place === "above";
    const n = (
      await client.query(
        above
          ? `SELECT MIN(position) AS p FROM publications WHERE position > $1`
          : `SELECT MAX(position) AS p FROM publications WHERE position < $1`,
        [cur]
      )
    ).rows[0].p;
    if (n === null) return above ? cur + 1 : cur - 1; // anchor is first / last
    const neighbour = Number(n);
    if (Math.abs(neighbour - cur) > MIN_GAP) return (cur + neighbour) / 2;
    await renumber(client); // gaps ran out: spread everything out, then try again
  }
  throw new Error("Could not find a free position");
};

/* =====================================================================
   POST /api/publications   (multipart: date, description, paper_link, tags, image,
                             anchor_id?, place = "above" | "below")
   no anchor_id = add at the top
   ===================================================================== */
router.post("/publications", receiveImage, async (req, res) => {
  const body = req.body || {};
  const parsed = readPub(body, true);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (req.file) {
    const bad = imageError(req.file);
    if (bad) return res.status(400).json({ error: bad });
  }

  let anchorId = null;
  let place = "above";
  if (body.anchor_id) {
    anchorId = Number(body.anchor_id);
    if (!Number.isInteger(anchorId)) return res.status(400).json({ error: "Invalid anchor" });
    if (body.place !== "above" && body.place !== "below") return res.status(400).json({ error: "Invalid place" });
    place = body.place;
  }

  let imageUrl = null;
  if (req.file) {
    try {
      imageUrl = (await uploadImage(req.file.buffer)).secure_url;
    } catch (err) {
      console.error("Cloudinary upload failed:", err.message);
      return res.status(502).json({ error: "Upload failed. Please try again." });
    }
  }

  const v = parsed.values;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_ID]);

    const position = await nextPosition(client, place, anchorId);
    if (position === null) {
      await client.query("ROLLBACK");
      await deleteImage(imageUrl);
      return res.status(404).json({ error: "Publication not found" });
    }

    const result = await client.query(
      `INSERT INTO publications (date, description, paper_link, tags, image, position)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${cols()}`,
      [v.date, v.description, v.paper_link ?? null, v.tags ?? [], imageUrl, position]
    );
    await client.query("COMMIT");
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    await deleteImage(imageUrl); // DB failed: don't leave an orphan
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

/* =====================================================================
   PATCH /api/publications/:id   (multipart, only the fields you send; remove_image = "1" clears the image)
   position is NOT changed here
   ===================================================================== */
router.patch("/publications/:id", receiveImage, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

  const body = req.body || {};
  const parsed = readPub(body, false);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (req.file) {
    const bad = imageError(req.file);
    if (bad) return res.status(400).json({ error: bad });
  }

  const sets = [];
  const values = [];
  for (const key of ["date", "description", "paper_link", "tags"]) {
    if (!(key in parsed.values)) continue;
    values.push(parsed.values[key]);
    sets.push(`${key} = $${values.length}`); // fixed list, never from the user
  }

  let newUrl = null;
  if (req.file) {
    try {
      newUrl = (await uploadImage(req.file.buffer)).secure_url;
    } catch (err) {
      console.error("Cloudinary upload failed:", err.message);
      return res.status(502).json({ error: "Upload failed. Please try again." });
    }
    values.push(newUrl);
    sets.push(`image = $${values.length}`);
  } else if (body.remove_image === "1") {
    sets.push(`image = NULL`);
  }
  if (sets.length === 0) return res.status(400).json({ error: "Nothing to update" });

  try {
    values.push(id);
    const result = await pool.query(
      `WITH old AS (SELECT id, image FROM publications WHERE id = $${values.length} FOR UPDATE)
       UPDATE publications p SET ${sets.join(", ")}
       FROM old WHERE p.id = old.id
       RETURNING ${cols("p.")}, old.image AS old_image`,
      values
    );
    if (result.rows.length === 0) {
      await deleteImage(newUrl);
      return res.status(404).json({ error: "Publication not found" });
    }
    const { old_image: oldUrl, ...row } = result.rows[0];
    if (oldUrl && oldUrl !== row.image) await deleteImage(oldUrl); // replaced or removed
    res.json(row);
  } catch (err) {
    await deleteImage(newUrl);
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =====================================================================
   DELETE /api/publications/:id
   ===================================================================== */
router.delete("/publications/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
    const result = await pool.query(`DELETE FROM publications WHERE id = $1 RETURNING image`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Publication not found" });
    await deleteImage(result.rows[0].image);
    res.json({ id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;