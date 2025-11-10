// LMX Studio — AI Image Designer backend (FINAL FIXED)
// ----------------------------------------------------
// Handles:
//   • POST /api/generate — calls OpenAI Image API
//   • POST /api/submit   — sends artwork via Resend
//
// Secrets stored as environment variables.
// ----------------------------------------------------

import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import { Resend } from "resend";
import OpenAI from "openai";

const app = express();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ===== CORS (allow only your site) =====
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN?.split(",") || "https://lmxstudio.com",
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ===== Initialize clients =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
const resend = new Resend(process.env.RESEND_API_KEY || "");
const SUBMIT_TO = process.env.SUBMIT_TO || "designslmx@gmail.com";

// ====== TEST ROUTE ======
app.get("/", (req, res) => {
  res.send("✅ LMX AI Backend is running!");
});

// ====== GENERATE IMAGE ======
app.post("/api/generate", async (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const result = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      size: "1024x1024",
    });

    const b64 = result.data?.[0]?.b64_json;
    if (!b64) return res.status(500).json({ error: "No image returned" });

    res.json({ base64: `data:image/png;base64,${b64}` });
  } catch (err) {
    console.error("❌ GENERATE_ERR:", err);
    res.status(500).json({ error: "Generator unavailable" });
  }
});

// ====== SUBMIT ORDER ======
app.post("/api/submit", upload.single("upload"), async (req, res) => {
  try {
    const f = req.body || {};
    const attachments = [];

    // Attach generated image
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

    // Attach uploaded file
    if (req.file) {
      attachments.push({
        filename: req.file.originalname,
        content: req.file.buffer.toString("base64"),
        encoding: "base64",
      });
    }

    // Email body
    const html = `
      <h2>New LMX AI Order</h2>
      <p><b>Name:</b> ${f.name || ""}</p>
      <p><b>Email:</b> ${f.email || ""}</p>
      <p><b>Product:</b> ${f.product || ""}</p>
      <p><b>Qty:</b> ${f.qty || ""}</p>
      <p><b>Size:</b> ${f.size || ""}</p>
      <p><b>Color:</b> ${f.color || ""}</p>
      <p><b>Notes:</b> ${f.notes || ""}</p>
    `;

    await resend.emails.send({
      from: "LMX Studio <no-reply@lmxstudio.com>",
      to: [SUBMIT_TO],
      subject: "LMX — New AI Designer Submission",
      html,
      attachments,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ SUBMIT_ERR:", err);
    res.status(500).json({ error: "Submit failed" });
  }
});

// ====== START SERVER ======
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ LMX backend listening on ${PORT}`));