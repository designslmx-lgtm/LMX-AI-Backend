// ==========================================================
// LMX Studio — AI Image Designer Backend (FIXED & CLEAN)
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
// IMAGE GENERATION — ZERO INVALID PARAMS
// ==========================================================
app.post("/api/generate", async (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").trim();
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    console.log("🧠 Prompt:", prompt);

    const result = await openai.images.generate({
      model: "gpt-image-1",
      prompt: prompt,
      size: "1024x1024",
    });

    const b64 = result?.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error("No image returned from OpenAI");
    }

    res.json({
      base64: b64
    });

  } catch (err) {
    console.error("❌ IMAGE ERROR:", err);
    res.status(500).json({
      error: "Image generation failed",
      details: err?.message || String(err),
    });
  }
});

// ==========================================================
// SUBMISSION (UNCHANGED)
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