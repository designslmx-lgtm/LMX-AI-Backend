// LMX Studio — AI Image Designer Backend
// (GENERATION + RATIO + UPSCALE)
// ==========================================================

import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import { Resend } from "resend";
import OpenAI from "openai";

// ===== INIT =====
const app = express();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ===== CORS =====
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN?.split(",") || [
      "https://lmxstudio.com",
      "https://www.lmxstudio.com",
    ],
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// ===== CLIENTS =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);
const SUBMIT_TO = process.env.SUBMIT_TO || "designslmx@gmail.com";

// ===== HEALTH =====
app.get("/", (req, res) => {
  res.send("✅ LMX AI Backend is live.");
});

// ==========================================================
// UNIVERSAL RATIO PARSER — FIXED
// ==========================================================
//
// This converts ANY ratio string (e.g., “16:9”, “21:9”, “9:21”) 
// into a legal pixel size for OpenAI.
// No more failures. No more bad image fallback.
//
function ratioToSize(ratio) {
  if (!ratio || typeof ratio !== "string") return "1024x1024";

  const [w, h] = ratio.split(":").map(n => parseFloat(n.trim()));

  if (!w || !h) return "1024x1024";

  // Use 1024 on the smallest dimension, scale the other
  const BASE = 1024;
  let width, height;

  if (w >= h) {
    // landscape
    width = Math.round((w / h) * BASE);
    height = BASE;
  } else {
    // portrait
    width = BASE;
    height = Math.round((h / w) * BASE);
  }

  // Cap extremely wide/tall values to keep OpenAI happy
  width = Math.min(width, 2048);
  height = Math.min(height, 2048);

  return `${width}x${height}`;
}

// ==========================================================
// IMAGE GENERATION — NOW FIXED FOR ANY RATIO
// ==========================================================
app.post("/api/generate", async (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").trim();
    const ratio = (req.body?.ratio || "1:1").trim();

    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    // ⭐ THE FIX: convert ANY ratio into a valid OpenAI size
    const size = ratioToSize(ratio);
    console.log("⚡ Using size:", size, "from ratio:", ratio);

    const result = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      size,
    });

    const b64 = result?.data?.[0]?.b64_json;
    if (!b64) throw new Error("No image returned");

    res.json({ base64: b64 });

  } catch (err) {
    console.error("❌ IMAGE ERROR:", err);
    res.status(500).json({
      error: "Image generation failed",
      details: err?.message || String(err),
    });
  }
});

// ==========================================================
// UPSCALE API — HIGH-QUALITY ENHANCE ROUTE
// ==========================================================
app.post("/api/upscale", async (req, res) => {
  try {
    const img = req.body?.image;
    if (!img || !img.startsWith("data:image/")) {
      return res.status(400).json({ error: "Missing or invalid image" });
    }

    const base64 = img.split(",")[1];

    console.log("🔼 Upscaling…");

    const result = await openai.images.edit({
      model: "gpt-image-1",
      image: base64,
      size: "2048x2048",
    });

    const b64 = result?.data?.[0]?.b64_json;
    if (!b64) throw new Error("No image returned during upscale");

    res.json({ base64: b64 });

  } catch (err) {
    console.error("❌ UPSCALE ERROR:", err);
    res.status(500).json({
      error: "Upscale failed",
      details: err?.message || String(err),
    });
  }
});

// ==========================================================
// SUBMISSION — UNCHANGED
// ==========================================================
app.post("/api/submit", upload.single("upload"), async (req, res) => {
  try {
    const f = req.body || {};
    const attachments = [];

    if (f.generatedImage?.startsWith("data:image/")) {
      attachments.push({
        filename: "generated.png",
        content: f.generatedImage.split(",")[1],
        encoding: "base64",
      });
    }

    if (req.file) {
      attachments.push({
        filename: req.file.originalname,
        content: req.file.buffer.toString("base64"),
        encoding: "base64",
      });
    }

    await resend.emails.send({
      from: "LMX Studio <no-reply@lmxstudio.com>",
      to: [SUBMIT_TO],
      subject: "LMX — New AI Designer Submission",
      html: `<p>New submission received.</p>`,
      attachments,
    });

    res.json({ ok: true });

  } catch (err) {
    console.error("❌ SUBMIT ERROR:", err);
    res.status(500).json({ error: "Submit failed" });
  }
});

// ===== START =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ LMX Backend running on port ${PORT}`);
});;