// ==========================================================
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
// RATIO MAP — SAFE MAPPINGS
// ==========================================================
const RATIO_MAP = {
  "1:1": "1024x1024",
  "4:5": "1024x1280",
  "2:3": "1024x1536",
  "3:2": "1536x1024",
  "16:9": "1536x864",
  "9:16": "864x1536",
};

// ==========================================================
// IMAGE GENERATION — WITH RATIO
// ==========================================================
app.post("/api/generate", async (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").trim();
    const ratio = (req.body?.ratio || "1:1").trim();

    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    const size = RATIO_MAP[ratio] || "1024x1024";

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
// FRONTEND will POST { image: "data:image/png;base64,..." }
app.post("/api/upscale", async (req, res) => {
  try {
    const img = req.body?.image;
    if (!img || !img.startsWith("data:image/")) {
      return res.status(400).json({ error: "Missing or invalid image" });
    }

    // Remove prefix so OpenAI can accept raw base64
    const base64 = img.split(",")[1];

    console.log("🔼 Upscaling…");

    const result = await openai.images.edit({
      model: "gpt-image-1",
      image: base64,
      size: "2048x2048", // high-res upscale
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
});