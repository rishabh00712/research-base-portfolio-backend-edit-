// routes/education.js - Education & Career (read + add above/below + edit + delete)
// Display order: position DESC (highest position = top of the page)
const express = require("express");
const pool = require("../db");

const router = express.Router();

const LOCK_KEY = 7301; // serialises reorder operations
const ORDER = "ORDER BY position DESC, id DESC";

const COLUMNS = `id, heading, start_date, end_date, university, location,
                 COALESCE(subjects, '{}') AS subjects, position`;

const listEducation = async (db = pool) =>
  (await db.query(`SELECT ${COLUMNS} FROM education_and_career ${ORDER}`)).rows;

// ids in DISPLAY order (top -> bottom)
const currentIds = async (db) =>
  (await db.query(`SELECT id FROM education_and_career ${ORDER}`)).rows.map((r) => r.id);

// Writes positions n..1 (first id = top of page = highest number) in ONE statement
const renumber = (db, ids) =>
  db.query(
    `UPDATE education_and_career e
     SET position = $2::int - o.pos + 1
     FROM unnest($1::int[]) WITH ORDINALITY AS o(id, pos)
     WHERE e.id = o.id`,
    [ids, ids.length]
  );

/* ---------- validation shared by POST and PATCH ---------- */
const LIMITS = { heading: 255, start_date: 50, end_date: 50, university: 255, location: 255 };
const MAX_SUBJECTS = 30;
const MAX_SUBJECT_LEN = 200;

const readFields = (body, requireHeading) => {
  const values = {};

  for (const [key, max] of Object.entries(LIMITS)) {
    if (!(key in body)) continue;
    let v = body[key];
    if (v === null || v === undefined) v = "";
    if (typeof v !== "string") return { error: `${key} must be text` };
    v = v.trim();
    if (v.length > max) return { error: `${key} must be ${max} characters or less` };
    values[key] = v;
  }

  if ("subjects" in body) {
    const s = body.subjects;
    if (!Array.isArray(s) || s.some((x) => typeof x !== "string"))
      return { error: "Subjects must be a list of text" };
    const clean = s.map((x) => x.trim()).filter(Boolean);
    if (clean.length > MAX_SUBJECTS) return { error: `At most ${MAX_SUBJECTS} subjects are allowed` };
    if (clean.some((x) => x.length > MAX_SUBJECT_LEN))
      return { error: `Each subject must be ${MAX_SUBJECT_LEN} characters or less` };
    values.subjects = clean;
  }

  if (("heading" in values && !values.heading) || (requireHeading && !values.heading))
    return { error: "Heading is required" };

  return { values };
};

/* ---------- GET /api/education : top of page first (position DESC) ---------- */
router.get("/education", async (req, res) => {
  try {
    res.json(await listEducation());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- POST /api/education ----------
   place = "top" | "end" | "before:<id>" | "after:<id>"  (default "end")
   before = visually above that row, after = visually below it */
router.post("/education", async (req, res) => {
  const body = req.body || {};
  const parsed = readFields(body, true);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const place = body.place ?? "end";
  const match = /^(before|after):(\d+)$/.exec(String(place));
  if (place !== "top" && place !== "end" && !match)
    return res.status(400).json({ error: "Invalid place" });

  const v = parsed.values;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);

    const ids = await currentIds(client); // display order

    let index = ids.length; // default: bottom
    if (place === "top") index = 0;
    else if (match) {
      const at = ids.indexOf(Number(match[2]));
      if (at === -1) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "That entry no longer exists" });
      }
      index = match[1] === "before" ? at : at + 1;
    }

    const inserted = await client.query(
      `INSERT INTO education_and_career
         (heading, start_date, end_date, university, location, subjects, position)
       VALUES ($1, $2, $3, $4, $5, $6, 0)
       RETURNING id`,
      [v.heading, v.start_date ?? "", v.end_date ?? "", v.university ?? "", v.location ?? "", v.subjects ?? []]
    );

    ids.splice(index, 0, inserted.rows[0].id); // put it exactly where it belongs
    await renumber(client, ids); // store n..1 for every row

    await client.query("COMMIT");
    res.status(201).json(await listEducation());
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

/* ---------- PATCH /api/education/:id (position is never changed here) ---------- */
router.patch("/education/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

    const parsed = readFields(req.body || {}, false);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const sets = [];
    const values = [];
    for (const key of [...Object.keys(LIMITS), "subjects"]) {
      if (!(key in parsed.values)) continue;
      values.push(parsed.values[key]);
      sets.push(`${key} = $${values.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: "Nothing to update" });

    values.push(id);
    const result = await pool.query(
      `UPDATE education_and_career SET ${sets.join(", ")}
       WHERE id = $${values.length} RETURNING ${COLUMNS}`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Entry not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- DELETE /api/education/:id : remove, then re-store positions ---------- */
router.delete("/education/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);

    const del = await client.query("DELETE FROM education_and_career WHERE id = $1", [id]);
    if (del.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Entry not found" });
    }

    await renumber(client, await currentIds(client));

    await client.query("COMMIT");
    res.json(await listEducation());
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

module.exports = router;