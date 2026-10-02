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
  "http://localhost:5174",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // allow requests with no origin (curl, Postman) and the listed origins
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
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
});