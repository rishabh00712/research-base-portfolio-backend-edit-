// routes/about.js - everything the About (Dr. Ferrocene) section needs
const express = require("express");
const pool = require("../db");

const router = express.Router();

const MAX_HOBBIES = 30;
const MAX_HOBBY_LEN = 50;

// the single profile row
const ROW = `(SELECT id FROM profile ORDER BY id LIMIT 1)`;
const COLUMNS = `name, long_description, COALESCE(hobbies, '{}') AS hobbies`;

const getAbout = async () =>
  (await pool.query(`SELECT ${COLUMNS} FROM profile ORDER BY id LIMIT 1`)).rows[0] || null;

/* ---------- GET /api/about ---------- */
router.get("/about", async (req, res) => {
  try {
    res.json(await getAbout());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- PATCH /api/about : name and/or long_description ---------- */
router.patch("/about", async (req, res) => {
  try {
    const body = req.body || {};
    const sets = [];
    const values = [];

    if ("name" in body) {
      if (typeof body.name !== "string") return res.status(400).json({ error: "Name must be text" });
      const v = body.name.trim();
      if (!v) return res.status(400).json({ error: "Name can't be empty" });
      if (v.length > 255) return res.status(400).json({ error: "Name must be 255 characters or less" });
      values.push(v);
      sets.push(`name = $${values.length}`);
    }

    if ("long_description" in body) {
      if (typeof body.long_description !== "string")
        return res.status(400).json({ error: "Description must be text" });
      values.push(body.long_description.trim());
      sets.push(`long_description = $${values.length}`);
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

/* ---------- POST /api/about/hobbies : add one hobby ---------- */
router.post("/about/hobbies", async (req, res) => {
  try {
    const hobby = typeof req.body?.hobby === "string" ? req.body.hobby.trim() : "";
    if (!hobby) return res.status(400).json({ error: "Hobby can't be empty" });
    if (hobby.length > MAX_HOBBY_LEN)
      return res.status(400).json({ error: `Hobby must be ${MAX_HOBBY_LEN} characters or less` });

    // one atomic statement: only appends if not a duplicate and under the limit
    const result = await pool.query(
      `UPDATE profile
       SET hobbies = array_append(COALESCE(hobbies, '{}'), $1)
       WHERE id = ${ROW}
         AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(hobbies, '{}')) h WHERE lower(h) = lower($1))
         AND COALESCE(array_length(hobbies, 1), 0) < $2
       RETURNING ${COLUMNS}`,
      [hobby, MAX_HOBBIES]
    );

    if (result.rows.length === 0) {
      const current = await getAbout();
      if (!current) return res.status(404).json({ error: "Profile not found" });
      if (current.hobbies.length >= MAX_HOBBIES)
        return res.status(400).json({ error: `You can have at most ${MAX_HOBBIES} hobbies` });
      return res.status(409).json({ error: "That hobby already exists" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- DELETE /api/about/hobbies/:hobby : remove one hobby ---------- */
router.delete("/about/hobbies/:hobby", async (req, res) => {
  try {
    const hobby = req.params.hobby; // Express already decodes it
    const result = await pool.query(
      `UPDATE profile
       SET hobbies = array_remove(COALESCE(hobbies, '{}'), $1)
       WHERE id = ${ROW}
       RETURNING ${COLUMNS}`,
      [hobby]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Profile not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;