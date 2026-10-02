// routes/news.js - everything the News section needs (read + edit + add + delete)
const express = require("express");
const pool = require("../db");

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = (v) => DATE_RE.test(v) && !Number.isNaN(Date.parse(v));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Makes any typed link safe for the "link_format" check:
//   name@site.com -> mailto:name@site.com
//   site.com      -> https://site.com
//   http(s)://, #, / links are kept as they are
const normalizeLink = (raw) => {
  const l = String(raw ?? "").trim();
  if (!l) return "";
  const plain = l.replace(/^mailto:/i, "");
  if (EMAIL_RE.test(plain.split("?")[0])) return `mailto:${plain}`;
  return /^(https?:\/\/|#|\/)/i.test(l) ? l : `https://${l}`;
};

// same columns everywhere; date comes back as "YYYY-MM-DD" (no timezone shift)
const COLUMNS = `id, title, type, description, link, is_active, position,
                 to_char("date", 'YYYY-MM-DD') AS date`;

const listNews = async (db = pool) =>
  (await db.query(`SELECT ${COLUMNS} FROM news ORDER BY position ASC, id ASC`)).rows;

/* ---------- GET /api/news : all items, lowest position first ---------- */
router.get("/news", async (req, res) => {
  try {
    res.json(await listNews());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- PATCH /api/news/:id : change any field(s) ---------- */
const FIELDS = {
  title: "string",
  type: "string",
  description: "string",
  link: "string",
  date: "date",
  is_active: "boolean",
};

router.patch("/news/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

    const sets = [];
    const values = [];

    for (const [key, kind] of Object.entries(FIELDS)) {
      if (!(key in req.body)) continue;
      let v = req.body[key];

      if (kind === "string") {
        if (typeof v !== "string") return res.status(400).json({ error: `${key} must be text` });
        v = v.trim();
        if (key === "title" && !v) return res.status(400).json({ error: "Title can't be empty" });
        if (key === "type" && v.length > 100)
          return res.status(400).json({ error: "Type must be 100 characters or less" });
        if (key === "link") v = normalizeLink(v);
      } else if (kind === "boolean") {
        if (typeof v !== "boolean") return res.status(400).json({ error: `${key} must be true or false` });
      } else if (kind === "date") {
        if (v === null || v === "") v = null;
        else if (typeof v !== "string" || !isValidDate(v))
          return res.status(400).json({ error: "Date must look like YYYY-MM-DD" });
      }

      values.push(v);
      sets.push(`"${key}" = $${values.length}`);
    }

    if (sets.length === 0) return res.status(400).json({ error: "Nothing to update" });

    values.push(id);
    const result = await pool.query(
      `UPDATE news SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING ${COLUMNS}`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "News item not found" });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23514") return res.status(400).json({ error: "That link isn't in a valid format" });
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- POST /api/news : add one item in the right place ----------
   body: { title, type, description, link, date, is_active, place }
   place = "top" | "end" | <id of the item it should come after>
   Positions are re-numbered 1..n so the order is always exact. */
router.post("/news", async (req, res) => {
  const client = await pool.connect();
  try {
    const { title, type = "", description = "", link = "", date, is_active = true, place } = req.body;

    if (typeof title !== "string" || !title.trim())
      return res.status(400).json({ error: "Title is required" });
    if (String(type).length > 100)
      return res.status(400).json({ error: "Type must be 100 characters or less" });
    if (date && (typeof date !== "string" || !isValidDate(date)))
      return res.status(400).json({ error: "Date must look like YYYY-MM-DD" });

    await client.query("BEGIN");

    const existing = (await client.query("SELECT id FROM news ORDER BY position ASC, id ASC")).rows;
    const ids = existing.map((r) => r.id);

    const inserted = await client.query(
      `INSERT INTO news (title, type, description, link, "date", is_active, position)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, 0)
       RETURNING id`,
      [
        title.trim(),
        String(type).trim(),
        String(description).trim(),
        normalizeLink(link),
        date || null,
        is_active !== false,
      ]
    );
    const newId = inserted.rows[0].id;

    let index = ids.length; // default: at the end
    if (place === "top") index = 0;
    else if (place !== "end" && place !== undefined && place !== null) {
      const at = ids.indexOf(Number(place));
      if (at !== -1) index = at + 1; // right after that item
    }
    ids.splice(index, 0, newId);

    for (let i = 0; i < ids.length; i += 1) {
      await client.query("UPDATE news SET position = $1 WHERE id = $2", [i + 1, ids[i]]);
    }

    await client.query("COMMIT");
    res.json(await listNews());
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23514") return res.status(400).json({ error: "That link isn't in a valid format" });
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

/* ---------- DELETE /api/news/:id ---------- */
router.delete("/news/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
    await pool.query("DELETE FROM news WHERE id = $1", [id]);
    res.json(await listNews());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;