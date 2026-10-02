// routes/footer.js - footer data: name, affiliations (add / delete) and social links
const express = require("express");
const pool = require("../db");

const router = express.Router();

const MAX_AFFILIATIONS = 30;
const MAX_AFFILIATION_LEN = 255;
const LINKS_TABLE = "social_links"; // columns: id, name, link

// the single profile row
const ROW = `(SELECT id FROM profile ORDER BY id LIMIT 1)`;
const COLUMNS = `name, COALESCE(affiliations, '{}') AS affiliations`;

/* ---------- Make sure the links table exists (runs once, safe to repeat) ---------- */
let linksTableReady = null;
const ensureLinksTable = () => {
  if (!linksTableReady) {
    linksTableReady = pool
      .query(
        `CREATE TABLE IF NOT EXISTS ${LINKS_TABLE} (
           id   SERIAL PRIMARY KEY,
           name VARCHAR(100) NOT NULL,
           link TEXT NOT NULL
         )`
      )
      .catch((err) => {
        linksTableReady = null; // retry on the next request
        throw err;
      });
  }
  return linksTableReady;
};

const getFooter = async () =>
  (await pool.query(`SELECT ${COLUMNS} FROM profile ORDER BY id LIMIT 1`)).rows[0] || null;

/* ---------- GET /api/footer ---------- */
router.get("/footer", async (req, res) => {
  try {
    const profile = (await getFooter()) || { name: "", affiliations: [] };

    let links = [];
    try {
      await ensureLinksTable();
      links = (await pool.query(`SELECT id, name, link FROM ${LINKS_TABLE} ORDER BY id`)).rows;
    } catch (e) {
      console.error("Footer links query failed:", e.message);
    }

    res.json({ ...profile, links });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- POST /api/footer/affiliations : add one affiliation ---------- */
router.post("/footer/affiliations", async (req, res) => {
  try {
    const affiliation = typeof req.body?.affiliation === "string" ? req.body.affiliation.trim() : "";
    if (!affiliation) return res.status(400).json({ error: "Affiliation can't be empty" });
    if (affiliation.length > MAX_AFFILIATION_LEN)
      return res
        .status(400)
        .json({ error: `Affiliation must be ${MAX_AFFILIATION_LEN} characters or less` });

    // one atomic statement: only appends if not a duplicate and under the limit
    const result = await pool.query(
      `UPDATE profile
       SET affiliations = array_append(COALESCE(affiliations, '{}'), $1)
       WHERE id = ${ROW}
         AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(affiliations, '{}')) a WHERE lower(a) = lower($1))
         AND COALESCE(array_length(affiliations, 1), 0) < $2
       RETURNING ${COLUMNS}`,
      [affiliation, MAX_AFFILIATIONS]
    );

    if (result.rows.length === 0) {
      const current = await getFooter();
      if (!current) return res.status(404).json({ error: "Profile not found" });
      if (current.affiliations.length >= MAX_AFFILIATIONS)
        return res.status(400).json({ error: `You can have at most ${MAX_AFFILIATIONS} affiliations` });
      return res.status(409).json({ error: "That affiliation already exists" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- DELETE /api/footer/affiliations/:affiliation : remove one ---------- */
router.delete("/footer/affiliations/:affiliation", async (req, res) => {
  try {
    const affiliation = req.params.affiliation; // Express already decodes it
    const result = await pool.query(
      `UPDATE profile
       SET affiliations = array_remove(COALESCE(affiliations, '{}'), $1)
       WHERE id = ${ROW}
       RETURNING ${COLUMNS}`,
      [affiliation]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Profile not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;