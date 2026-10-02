// routes/research.js - research cards (add left/right, edit, delete, positions, Cloudinary cleanup)
// server.js already has:  const research = require("./routes/research");  app.use("/api", research);
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

const FOLDER = "research";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TITLE = 255; // column is VARCHAR(255)
const MAX_URL = 500; // columns are VARCHAR(500)
const MAX_TEXT = 20000;
const MIN_GAP = 0.001; // column is NUMERIC(10,4): neighbours closer than this -> renumber first
const LOCK_ID = 7003; // serialises position changes

const rcols = (p = "") =>
  `${p}id, ${p}title, to_char(${p}research_date, 'YYYY-MM-DD') AS research_date,
   ${p}description, ${p}image_url, ${p}paper_url, ${p}pdf_url,
   ${p}literature_survey, ${p}apparatus, ${p}methodology, ${p}conclusion, ${p}position`;

/* ---------- Cloudinary + image helpers ---------- */
const uploadImage = (buffer) =>
  new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ resource_type: "image", folder: FOLDER }, (err, result) =>
        err ? reject(err) : resolve(result)
      )
      .end(buffer);
  });

// Only deletes images in OUR cloud; silently ignores any other URL (or empty value).
const deleteImage = async (url) => {
  if (!url) return;
  const m = /^https?:\/\/res\.cloudinary\.com\/([^/]+)\/image\/upload\/(?:v\d+\/)?(.+?)(?:\?.*)?$/.exec(url);
  if (!m || m[1] !== process.env.CLOUDINARY_CLOUD_NAME) return;
  const publicId = decodeURIComponent(m[2]).replace(/\.[^/.]+$/, "");
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
  } catch (err) {
    console.error("Cloudinary delete failed:", err.message); // never fail the request for this
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

/* ---------- position logic ----------
   Cards are shown by position ASC (lowest first).
   "left"  = goes BEFORE the anchor (lower position)
   "right" = goes AFTER  the anchor (higher position)
   Only the new row gets a position; other rows are untouched
   (unless the gaps get tiny, or several rows share the same position). */
const renumber = (client) =>
  client.query(
    `UPDATE research t SET position = s.rn
     FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY position ASC, id ASC) AS rn FROM research) s
     WHERE t.id = s.id`
  );

// returns a position number, or null when the anchor doesn't exist
const findPosition = async (client, { anchorId, before }) => {
  if (!anchorId) {
    const r = await client.query(`SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM research`);
    return Number(r.rows[0].pos); // no anchor = added at the end
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const a = (await client.query(`SELECT position FROM research WHERE id = $1`, [anchorId])).rows[0];
    if (!a) return null;
    const cur = Number(a.position);

    // other rows with the very same position (e.g. the default 1): spread out first
    const tie = await client.query(`SELECT 1 FROM research WHERE position = $1 AND id <> $2 LIMIT 1`, [
      cur,
      anchorId,
    ]);
    if (tie.rows.length > 0) {
      await renumber(client);
      continue;
    }

    const n = (
      await client.query(
        `SELECT ${before ? "MAX" : "MIN"}(position) AS p FROM research WHERE position ${before ? "<" : ">"} $1`,
        [cur]
      )
    ).rows[0].p;

    if (n === null) return before ? cur - 1 : cur + 1; // anchor is first / last
    const neighbour = Number(n);
    if (Math.abs(neighbour - cur) > MIN_GAP) return (cur + neighbour) / 2;
    await renumber(client); // gaps ran out: spread everything out, then retry
  }
  throw new Error("Could not find a free position");
};

/* ---------- reading the form ---------- */
const OPTIONAL_TEXT = [
  ["description", MAX_TEXT],
  ["paper_url", MAX_URL],
  ["pdf_url", MAX_URL],
  ["literature_survey", MAX_TEXT],
  ["apparatus", MAX_TEXT],
  ["methodology", MAX_TEXT],
  ["conclusion", MAX_TEXT],
];

// returns { error } or { values } (only the keys present in body; empty optional text -> null)
const readResearch = (body, creating) => {
  const values = {};

  if (creating || "title" in body) {
    const t = String(body.title ?? "").trim();
    if (!t) return { error: "Title is required" };
    if (t.length > MAX_TITLE) return { error: `Title must be ${MAX_TITLE} characters or less` };
    values.title = t;
  }

  if (creating || "research_date" in body) {
    const d = String(body.research_date ?? "").trim();
    const dt = new Date(`${d}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== d)
      return { error: "Enter a valid date" };
    values.research_date = d;
  }

  for (const [key, max] of OPTIONAL_TEXT) {
    if (!(key in body)) continue;
    const t = String(body[key] ?? "").trim();
    if (t.length > max) return { error: `${key.replace(/_/g, " ")} is too long` };
    values[key] = t === "" ? null : t;
  }

  return { values };
};

/* =====================================================================
   GET /api/research   (position ASC)
   ===================================================================== */
router.get("/research", async (req, res) => {
  try {
    const result = await pool.query(`SELECT ${rcols()} FROM research ORDER BY position ASC, id ASC`);
    res.json(result.rows);
  } catch (err) {
    console.error("research error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* POST (multipart: title, research_date, description, paper_url, pdf_url,
         literature_survey, apparatus, methodology, conclusion, image,
         anchor_id + place "left"|"right"  -> next to that card
         no anchor_id                       -> added at the end) */
router.post("/research", receiveImage, async (req, res) => {
  const body = req.body || {};
  const parsed = readResearch(body, true);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (req.file) {
    const bad = imageError(req.file);
    if (bad) return res.status(400).json({ error: bad });
  }

  let anchorId = null;
  let before = false;
  if (body.anchor_id) {
    anchorId = Number(body.anchor_id);
    if (!Number.isInteger(anchorId)) return res.status(400).json({ error: "Invalid anchor" });
    if (body.place !== "left" && body.place !== "right") return res.status(400).json({ error: "Invalid place" });
    before = body.place === "left";
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

    const position = await findPosition(client, { anchorId, before });
    if (position === null) {
      await client.query("ROLLBACK");
      await deleteImage(imageUrl);
      return res.status(404).json({ error: "Research not found" });
    }

    const result = await client.query(
      `INSERT INTO research
         (title, research_date, description, image_url, paper_url, pdf_url,
          literature_survey, apparatus, methodology, conclusion, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING ${rcols()}`,
      [
        v.title,
        v.research_date,
        v.description ?? null,
        imageUrl,
        v.paper_url ?? null,
        v.pdf_url ?? null,
        v.literature_survey ?? null,
        v.apparatus ?? null,
        v.methodology ?? null,
        v.conclusion ?? null,
        position,
      ]
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

/* PATCH (multipart, only the fields you send; remove_image = "1" clears the image) */
router.patch("/research/:id", receiveImage, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

  const body = req.body || {};
  const parsed = readResearch(body, false);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (req.file) {
    const bad = imageError(req.file);
    if (bad) return res.status(400).json({ error: bad });
  }

  const sets = [];
  const values = [];
  for (const key of ["title", "research_date", ...OPTIONAL_TEXT.map(([k]) => k)]) {
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
    sets.push(`image_url = $${values.length}`);
  } else if (body.remove_image === "1") {
    sets.push(`image_url = NULL`);
  }
  if (sets.length === 0) return res.status(400).json({ error: "Nothing to update" });
  sets.push(`updated_at = now()`);

  try {
    values.push(id);
    const result = await pool.query(
      `WITH old AS (SELECT id, image_url FROM research WHERE id = $${values.length} FOR UPDATE)
       UPDATE research p SET ${sets.join(", ")}
       FROM old WHERE p.id = old.id
       RETURNING ${rcols("p.")}, old.image_url AS old_image`,
      values
    );
    if (result.rows.length === 0) {
      await deleteImage(newUrl);
      return res.status(404).json({ error: "Research not found" });
    }
    const { old_image: oldUrl, ...row } = result.rows[0];
    if (oldUrl && oldUrl !== row.image_url) await deleteImage(oldUrl); // replaced or removed
    res.json(row);
  } catch (err) {
    await deleteImage(newUrl);
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* DELETE : removes the research and its Cloudinary image */
router.delete("/research/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
    const result = await pool.query(`DELETE FROM research WHERE id = $1 RETURNING image_url`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Research not found" });
    await deleteImage(result.rows[0].image_url);
    res.json({ id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;