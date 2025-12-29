/*
   LMX Studio — AI Image Designer Backend
   (FINAL RATIO-SAFE VERSION FOR GPT-IMAGE-1)
   ==========================================================
*/

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

// ===== CORS (UPDATED BY DIRECT DOMAIN SWAP ONLY) =====
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN?.split(",") || [
      "https://lmxsyntheticai.com",
      "https://www.lmxsyntheticai.com",
      "https://lmxsyntheticai.com/designer",
      "https://www.lmxsyntheticai.com/designer",
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

/* ==========================================================
   FINAL RATIO MAP (ONLY GPT-IMAGE-1 SAFE SIZES)
   ==========================================================

   GPT-IMAGE-1 accepts ONLY:

      1024x1024  (square)
      1024x1536  (tall)
      1536x1024  (wide)

   ALL ratios MUST map into one of these three.
   ========================================================== */

const RATIO_CANONICAL = {
  // square
  "1:1":  "1024x1024",

  // portrait → tall
  "4:5":  "1024x1536",
  "2:3":  "1024x1536",
  "9:16": "1024x1536",

  // landscape → wide
  "3:2":  "1536x1024",
  "16:9": "1536x1024",
};

// ==========================================================
// IMAGE GENERATION (FINAL VERSION, NO INVALID SIZES EVER)
// ==========================================================
app.post("/api/generate", async (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").trim();
    const ratio  = (req.body?.ratio  || "1:1").trim();

    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    // select canonical safe size
    const size = RATIO_CANONICAL[ratio] || "1024x1024";

    console.log("⚡ Incoming ratio:", ratio);
    console.log("⚡ Canonical size:", size);

    const result = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      size: size,         // ALWAYS valid now
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
// UPSCALE — SAFE 2048x2048 (ALLOWED SIZE)
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
});