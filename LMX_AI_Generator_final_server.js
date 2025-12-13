// ==========================================================
// LMX Studio — AI Image Designer Backend (FINAL WORKING BUILD)
// ----------------------------------------------------------
// • POST /api/generate — OpenAI Image API (updated for SDK v4)
// • POST /api/submit   — Sends generated image + form via Resend
// ----------------------------------------------------------
// All secrets stored in environment variables.
// Author: Lawrence Michael (LMX Studio)
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

// ===== CORS CONFIG =====
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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);
const SUBMIT_TO = process.env.SUBMIT_TO || "designslmx@gmail.com";

// ===== HEALTH CHECK =====
app.get("/", (req, res) => {
  res.send("✅ LMX AI Backend is live and connected.");
});

// ==========================================================
// ===== IMAGE GENERATION (UPDATED FOR NEW OPENAI SDK) ======
// ==========================================================
app.post("/api/generate", async (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").trim();
    if (!prompt)
      return res.status(400).json({ error: "Missing prompt." });

    console.log("🧠 Generating image:", prompt);

    let result;

    // FIRST ATTEMPT — Standard 1024x1024
    try {
      result = await openai.images.generate({
        model: "gpt-image-1",
        prompt: prompt,
        size: "1024x1024",
        response_format: "b64_json",
        quality: "high",
      });
    } catch (err) {
      console.warn("⚠️ First attempt failed → retrying w/ auto size");

      result = await openai.images.generate({
        model: "gpt-image-1",
        prompt: prompt,
        size: "auto",
        response_format: "b64_json",
        quality: "high",
      });
    }

    const b64 = result?.data?.[0]?.b64_json;
    if (!b64) return res.status(500).json({ error: "No image returned." });

    console.log("✅ Image generated successfully");
    res.json({ base64: `data:image/png;base64,${b64}` });
  } catch (err) {
    console.error("❌ GENERATE_ERR:", err);
    res.status(500).json({ error: "Image generator unavailable." });
  }
});

// ==========================================================
// ===== ORDER SUBMISSION (UNCHANGED — STILL WORKING) =======
// ==========================================================
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
    } else if (/^https?:/.test(gen)) {
      const r = await fetch(gen);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        attachments.push({
          filename: "generated.png",
          content: buf.toString("base64"),
          encoding: "base64",
        });
      }
    }

    // ---- Uploaded physical file ----
    if (req.file) {
      attachments.push({
        filename: req.file.originalname,
        content: req.file.buffer.toString("base64"),
        encoding: "base64",
      });
    }

    // ---- Email HTML ----
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

    console.log("📤 Submission email sent to:", SUBMIT_TO);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ SUBMIT_ERR:", err);
    res.status(500).json({ error: "Submit failed." });
  }
});

// ===== SERVER START =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ LMX Backend running on port ${PORT}`);
});