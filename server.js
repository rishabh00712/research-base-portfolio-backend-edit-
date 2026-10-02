require("dotenv").config();
const express = require("express");
const cors = require("cors");

const homeRoutes = require("./routes/home");
const newsRoutes = require("./routes/news");
const aboutRoutes = require("./routes/about");
const educationRoutes = require("./routes/education");
const contactRoutes = require("./routes/contact");
const peopleRoutes = require("./routes/people");
const publications = require("./routes/publications");
const beyondTheBench = require("./routes/beyondTheBench");
const research = require("./routes/research");
const footer = require("./routes/footerRoutes");

const app = express();
const PORT = process.env.PORT || 5001;
const allowedOrigins = [
  process.env.CLIENT_URL,
  "https://sayanchattopadhyay.vercel.app",
  "http://localhost:5173",
]
  .filter(Boolean)
  .map((o) => o.trim().replace(/\/+$/, ""));

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "x-admin-key"],
  })
);
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Backend is running!");
});

app.use("/api", homeRoutes);
app.use("/api", newsRoutes);
app.use("/api", aboutRoutes);
app.use("/api", educationRoutes);
app.use("/api", contactRoutes);
app.use("/api", peopleRoutes);
app.use("/api", publications);
app.use("/api", beyondTheBench);
app.use("/api", research);
app.use("/api", footer);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);

  // Keep-alive for Render's free tier: ping our own public URL every 10 minutes.
  // Render sets RENDER_EXTERNAL_URL automatically, so this does nothing locally.
  const selfUrl = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
  if (selfUrl) {
    const INTERVAL_MS = 10 * 60 * 1000; // under Render's 15-minute idle limit
    setInterval(async () => {
      try {
        const r = await fetch(selfUrl.replace(/\/+$/, "") + "/");
        console.log(`[keep-alive] ping -> ${r.status}`);
      } catch (err) {
        console.error("[keep-alive] ping failed:", err.message);
      }
    }, INTERVAL_MS);
  }
});