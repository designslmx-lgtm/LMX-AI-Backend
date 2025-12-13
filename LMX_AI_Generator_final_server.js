// ==========================================================
// LMX Studio — AI Image Designer Backend (DEBUGGED BUILD)
// ----------------------------------------------------------
// • POST /api/generate — OpenAI Image API (instrumented)
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
// ===== IMAGE GENERATION (TRUTH MODE — NO GUESSING) =========
// ==========================================================
app.post("/api/generate", async (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").trim();
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt." });
    }

    console.log("🧠 PROMPT RECEIVED:", prompt);

    const result = await openai.images.generate({
      model: "gpt-image-1",
      prompt: prompt,
      size: "1024x1024",
      response_format: "b64_json",
    });

    console.log("🧪 RAW RESULT:", result);
    console.log("🧪 RESULT.DATA:", result?.data);

    if (!result || !result.data || !result.data[0]?.b64_json) {
      console.error("❌ NO IMAGE RETURNED FROM OPENAI");
      return res.status(500).json({
        error: "OpenAI returned no image",
        debug: result,
      });
    }

    const image = `data:image/png;base64,${result.data[0].b64_json}`;

    console.log("✅ IMAGE GENERATED — RETURNING TO FRONTEND");
    res.status(200).json({ image });

  } catch (err) {
    console.error("❌ OPENAI ERROR FULL:", err);
    res.status(500).json({
      error: "OpenAI image generation failed",
      message: err.message,
      stack: err.stack,
    });
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