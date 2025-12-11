// ==========================================================
// LMX Studio — AI Image Designer Backend (FIXED FINAL BUILD)
// ----------------------------------------------------------
// • POST /api/generate — Updated OpenAI API format (NO ERRORS)
// • POST /api/submit   — Sends generated image + form via Resend
// ----------------------------------------------------------
// This version fixes the Render crash & OpenAI size errors.
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
    origin:
      process.env.ALLOWED_ORIGIN?.split(",") || [
        "https://lmxstudio.com",
        "https://www.lmxstudio.com",
      ],
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ===== API CLIENTS =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
const resend = new Resend(process.env.RESEND_API_KEY || "");
const SUBMIT_TO = process.env.SUBMIT_TO || "lmxcustomize@gmail.com";

// ===== HEALTH CHECK =====
app.get("/", (req, res) => {
  res.send("✅ LMX AI Backend is live and connected!");
});

// ===== IMAGE GENERATION (UPDATED FOR NEW OPENAI FORMAT) =====
app.post("/api/generate", async (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").trim();
    if (!prompt)
      return res.status(400).json({ error: "Missing prompt for generation." });

    console.log("🧠 Generating image for prompt:", prompt);

    let result;

    try {
      // FIRST ATTEMPT – bigger 1024x1024
      result = await openai.images.generate({
        model: "gpt-image-1",
        prompt,
        size: "1024x1024",
        quality: "high",
      });
    } catch (err) {
      console.warn("⚠️ Retrying at 512x512 due to error:", err.message);

      // SECOND ATTEMPT
      result = await openai.images.generate({
        model: "gpt-image-1",
        prompt,
        size: "512x512",
        quality: "high",
      });
    }

    const b64 = result?.data?.[0]?.b64_json;
    if (!b64) return res.status(500).json({ error: "No image returned." });

    res.json({ base64: `data:image/png;base64,${b64}` });
  } catch (err) {
    console.error("❌ GENERATE_ERR:", err);
    res.status(500).json({ error: "Image generator unavailable." });
  }
});

// ===== ORDER SUBMISSION (EMAIL + FILE ATTACHMENTS) =====
app.post("/api/submit", upload.single("upload"), async (req, res) => {
  try {
    const f = req.body || {};
    const attachments = [];

    // ---- Generated image ----
    const gen = f.generatedImage || "";
    if (gen.startsWith("data:image/")) {
      const base64 = gen.split(",")[1];
      if (base64)
        attachments.push({
          filename: "generated.png",
          content: base64,
          encoding: "base64",
        });
    }

    // ---- Uploaded File ----
    if (req.file) {
      attachments.push({
        filename: req.file.originalname,
        content: req.file.buffer.toString("base64"),
        encoding: "base64",
      });
    }

    // ---- Build Email ----
    const html = `
      <h2>🧩 New LMX AI Designer Submission</h2>
      <p><b>Name:</b> ${f.name || "N/A"}</p>
      <p><b>Email:</b> ${f.email || "N/A"}</p>
      <p><b>Product:</b> ${f.product || "N/A"}</p>
      <p><b>Qty:</b> ${f.qty || "N/A"}</p>
      <p><b>Size:</b> ${f.size || "N/A"}</p>
      <p><b>Color:</b> ${f.color || "N/A"}</p>
      <p><b>Notes:</b> ${f.notes || "None"}</p>
    `;

    await resend.emails.send({
      from: "LMX Studio <no-reply@lmxstudio.com>",
      to: [SUBMIT_TO],
      subject: "LMX — New AI Designer Submission",
      html,
      attachments,
    });

    console.log("📤 Email sent successfully to:", SUBMIT_TO);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ SUBMIT_ERR:", err);
    res.status(500).json({ error: "Submit failed." });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`✅ LMX backend running on port ${PORT}`)
);