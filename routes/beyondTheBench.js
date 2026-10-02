// routes/beyondTheBench.js - categories + projects (add, rename/edit, delete, positions, Cloudinary cleanup)
// Mount in server.js:  app.use("/api", require("./routes/beyondTheBench"));
// and DELETE the old  app.get("/api/beyond-the-bench", ...)  from server.js.
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

const FOLDER = "projects";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_LABEL = 150;
const MAX_NAME = 200;
const MAX_DESC = 10000;
const MAX_LINK = 1000;
const MIN_GAP = 1e-6; // neighbours closer than this -> renumber first
const LOCK_ID = 7002; // serialises position changes

// tables the position helpers may touch (fixed list, never from the user)
const CATEGORIES = { table: "categories", scope: null };
const PROJECTS = { table: "projects", scope: "category_id" }; // positions are per category

const pcols = (p = "") =>
  `${p}id, ${p}name, ${p}image_url, ${p}description, ${p}linkedin_url,
   to_char(${p}date, 'YYYY-MM-DD') AS date, ${p}category_id`;

/* ---------- Cloudinary + image helpers ---------- */
const uploadImage = (buffer) =>
  new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ resource_type: "image", folder: FOLDER }, (err, result) =>
        err ? reject(err) : resolve(result)
      )
      .end(buffer);
  });

// Only deletes images in OUR cloud; silently ignores any other URL (or empty string).
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

const normalizeUrl = (raw) => {
  const l = String(raw ?? "").trim();
  if (!l) return "";
  return /^https?:\/\//i.test(l) ? l : `https://${l}`;
};

/* ---------- position logic ----------
   Everything is shown by position DESC (highest first).
   "higher" = goes BEFORE the anchor (above a category / left of a project)
   "lower"  = goes AFTER  the anchor (below a category / right of a project)
   Only the new row gets a position; other rows are untouched (unless the gaps get tiny). */
const renumber = (client, cfg, scopeVal) =>
  client.query(
    `UPDATE ${cfg.table} t SET position = s.rn
     FROM (
       SELECT id, ROW_NUMBER() OVER (ORDER BY position ASC, id ASC) AS rn
       FROM ${cfg.table} ${cfg.scope ? `WHERE ${cfg.scope} = $1` : ""}
     ) s
     WHERE t.id = s.id`,
    cfg.scope ? [scopeVal] : []
  );

// returns { position, scopeVal } or null when the anchor doesn't exist
const findPosition = async (client, cfg, { anchorId, higher, scopeVal }) => {
  if (!anchorId) {
    const r = await client.query(
      `SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM ${cfg.table}${cfg.scope ? ` WHERE ${cfg.scope} = $1` : ""}`,
      cfg.scope ? [scopeVal] : []
    );
    return { position: Number(r.rows[0].pos), scopeVal }; // no anchor = first in the list
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const a = (
      await client.query(
        `SELECT position${cfg.scope ? `, ${cfg.scope} AS scope` : ""} FROM ${cfg.table} WHERE id = $1`,
        [anchorId]
      )
    ).rows[0];
    if (!a) return null;

    const cur = Number(a.position);
    const sv = cfg.scope ? a.scope : undefined;
    const n = (
      await client.query(
        `SELECT ${higher ? "MIN" : "MAX"}(position) AS p FROM ${cfg.table}
         WHERE position ${higher ? ">" : "<"} $1${cfg.scope ? ` AND ${cfg.scope} = $2` : ""}`,
        cfg.scope ? [cur, sv] : [cur]
      )
    ).rows[0].p;

    if (n === null) return { position: higher ? cur + 1 : cur - 1, scopeVal: sv }; // anchor is first / last
    const neighbour = Number(n);
    if (Math.abs(neighbour - cur) > MIN_GAP) return { position: (cur + neighbour) / 2, scopeVal: sv };
    await renumber(client, cfg, sv); // gaps ran out: spread everything out, then retry
  }
  throw new Error("Could not find a free position");
};

const readLabel = (raw) => {
  const t = String(raw ?? "").trim();
  if (!t) return { error: "Name can't be empty" };
  if (t.length > MAX_LABEL) return { error: `Name must be ${MAX_LABEL} characters or less` };
  return { value: t };
};

/* =====================================================================
   GET /api/beyond-the-bench   (categories by position DESC, projects by position DESC)
   ===================================================================== */
router.get("/beyond-the-bench", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c.id,
        c.label,
        c.position,
        COALESCE(
          json_agg(
            json_build_object(
              'id', p.id,
              'name', p.name,
              'image_url', p.image_url,
              'description', p.description,
              'linkedin_url', p.linkedin_url,
              'date', to_char(p.date, 'YYYY-MM-DD'),
              'category_id', p.category_id
            )
            ORDER BY p.position DESC, p.id DESC
          ) FILTER (WHERE p.id IS NOT NULL),
          '[]'
        ) AS projects
      FROM categories c
      LEFT JOIN projects p ON p.category_id = c.id
      GROUP BY c.id
      ORDER BY c.position DESC, c.id DESC
    `);
    res.json({ categories: rows });
  } catch (err) {
    console.error("beyond-the-bench error:", err);
    res.status(500).json({ error: "Failed to load projects" });
  }
});

/* =====================================================================
   CATEGORIES
   ===================================================================== */

/* POST { label, anchor_id?, place: "above" | "below" }   no anchor = add at the top */
router.post("/beyond-the-bench/categories", async (req, res) => {
  const body = req.body || {};
  const label = readLabel(body.label);
  if (label.error) return res.status(400).json({ error: label.error });

  let anchorId = null;
  let higher = true;
  if (body.anchor_id) {
    anchorId = Number(body.anchor_id);
    if (!Number.isInteger(anchorId)) return res.status(400).json({ error: "Invalid anchor" });
    if (body.place !== "above" && body.place !== "below") return res.status(400).json({ error: "Invalid place" });
    higher = body.place === "above";
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_ID]);

    const found = await findPosition(client, CATEGORIES, { anchorId, higher });
    if (!found) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Category not found" });
    }
    const result = await client.query(
      `INSERT INTO categories (label, position) VALUES ($1, $2) RETURNING id, label, position`,
      [label.value, found.position]
    );
    await client.query("COMMIT");
    res.status(201).json({ ...result.rows[0], projects: [] }); // new categories start empty
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

/* PATCH { label } : rename */
router.patch("/beyond-the-bench/categories/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
    const label = readLabel(req.body?.label);
    if (label.error) return res.status(400).json({ error: label.error });

    const result = await pool.query(`UPDATE categories SET label = $1 WHERE id = $2 RETURNING id, label`, [
      label.value,
      id,
    ]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Category not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* DELETE : removes the category, ALL its projects, and every one of their Cloudinary images */
router.delete("/beyond-the-bench/categories/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_ID]);

    const exists = await client.query(`SELECT id FROM categories WHERE id = $1 FOR UPDATE`, [id]);
    if (exists.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Category not found" });
    }

    const gone = await client.query(`DELETE FROM projects WHERE category_id = $1 RETURNING image_url`, [id]);
    await client.query(`DELETE FROM categories WHERE id = $1`, [id]);
    await client.query("COMMIT");

    // only after the DB commit: remove the images (never throws)
    await Promise.all(gone.rows.map((r) => deleteImage(r.image_url)));
    res.json({ id, deleted_projects: gone.rows.length });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

/* =====================================================================
   PROJECTS
   ===================================================================== */

// returns { error } or { values } (only the keys present in body)
const readProject = (body, creating) => {
  const values = {};

  if (creating || "name" in body) {
    const n = String(body.name ?? "").trim();
    if (!n) return { error: "Name is required" };
    if (n.length > MAX_NAME) return { error: `Name must be ${MAX_NAME} characters or less` };
    values.name = n;
  }

  if (creating || "description" in body) {
    const t = String(body.description ?? "").trim();
    if (!t) return { error: "Description is required" };
    if (t.length > MAX_DESC) return { error: `Description must be ${MAX_DESC} characters or less` };
    values.description = t;
  }

  if (creating || "date" in body) {
    const d = String(body.date ?? "").trim();
    const dt = new Date(`${d}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== d)
      return { error: "Enter a valid date" };
    values.date = d;
  }

  if ("linkedin_url" in body) {
    const v = normalizeUrl(body.linkedin_url);
    if (v.length > MAX_LINK) return { error: "LinkedIn link is too long" };
    values.linkedin_url = v; // column is NOT NULL, so "no link" is an empty string
  }

  return { values };
};

/* POST (multipart: name, description, date, linkedin_url, image,
         anchor_id + place "left"|"right"      -> next to that project (same category)
         OR category_id                         -> first project in that category) */
router.post("/beyond-the-bench/projects", receiveImage, async (req, res) => {
  const body = req.body || {};
  const parsed = readProject(body, true);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (req.file) {
    const bad = imageError(req.file);
    if (bad) return res.status(400).json({ error: bad });
  }

  let anchorId = null;
  let categoryId = null;
  let higher = true;
  if (body.anchor_id) {
    anchorId = Number(body.anchor_id);
    if (!Number.isInteger(anchorId)) return res.status(400).json({ error: "Invalid anchor" });
    if (body.place !== "left" && body.place !== "right") return res.status(400).json({ error: "Invalid place" });
    higher = body.place === "left";
  } else {
    categoryId = Number(body.category_id);
    if (!Number.isInteger(categoryId)) return res.status(400).json({ error: "Choose a category" });
  }

  let imageUrl = "";
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

    if (!anchorId) {
      const c = await client.query(`SELECT id FROM categories WHERE id = $1`, [categoryId]);
      if (c.rows.length === 0) {
        await client.query("ROLLBACK");
        await deleteImage(imageUrl);
        return res.status(404).json({ error: "Category not found" });
      }
    }

    const found = await findPosition(client, PROJECTS, { anchorId, higher, scopeVal: categoryId });
    if (!found) {
      await client.query("ROLLBACK");
      await deleteImage(imageUrl);
      return res.status(404).json({ error: "Project not found" });
    }

    const result = await client.query(
      `INSERT INTO projects (name, description, date, linkedin_url, image_url, category_id, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${pcols()}`,
      [v.name, v.description, v.date, v.linkedin_url ?? "", imageUrl, found.scopeVal, found.position]
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
router.patch("/beyond-the-bench/projects/:id", receiveImage, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

  const body = req.body || {};
  const parsed = readProject(body, false);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (req.file) {
    const bad = imageError(req.file);
    if (bad) return res.status(400).json({ error: bad });
  }

  const sets = [];
  const values = [];
  for (const key of ["name", "description", "date", "linkedin_url"]) {
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
    sets.push(`image_url = ''`);
  }
  if (sets.length === 0) return res.status(400).json({ error: "Nothing to update" });

  try {
    values.push(id);
    const result = await pool.query(
      `WITH old AS (SELECT id, image_url FROM projects WHERE id = $${values.length} FOR UPDATE)
       UPDATE projects p SET ${sets.join(", ")}
       FROM old WHERE p.id = old.id
       RETURNING ${pcols("p.")}, old.image_url AS old_image`,
      values
    );
    if (result.rows.length === 0) {
      await deleteImage(newUrl);
      return res.status(404).json({ error: "Project not found" });
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

/* DELETE : removes the project and its Cloudinary image */
router.delete("/beyond-the-bench/projects/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
    const result = await pool.query(`DELETE FROM projects WHERE id = $1 RETURNING image_url`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Project not found" });
    await deleteImage(result.rows[0].image_url);
    res.json({ id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;