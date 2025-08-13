// LMX Studio — AI Image Designer backend
//
// This Express server exposes two endpoints:
//   • POST /generate — calls the OpenAI Image API to create an image from a text prompt
//   • POST /submit   — emails the generated artwork and order details via Resend
//
// All secrets (OpenAI, Resend, Render, Submit address) are read from environment
// variables.  DO NOT hard‑code your API keys here.  Use the placeholders below in
// your .env file and replace them with your real keys when you’re ready to go live.

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

// Allow only your domains to call these endpoints.  Edit ALLOWED_ORIGIN in .env
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN?.split(",") || "*",
  })
);

// Initialise API clients using environment variables.  If the keys are missing,
// the clients will be initialised with empty strings, and requests will fail.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
const resend = new Resend(process.env.RESEND_API_KEY || "");

// Default email recipient – set SUBMIT_TO in your environment to override
const SUBMIT_TO = process.env.SUBMIT_TO || "YOUR_EMAIL_HERE";

/**
 * POST /generate
 *
 * Expects a JSON body: { prompt: "<your text prompt>" }
 * Returns: { base64: "data:image/png;base64,<encoded image>" }
 */
app.post("/generate", async (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const img = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      size: "2048x2048",
      response_format: "b64_json",
    });
    const b64 = img.data?.[0]?.b64_json;
    if (!b64) return res.status(500).json({ error: "No image returned" });

    return res.json({ base64: `data:image/png;base64,${b64}` });
  } catch (err) {
    console.error("GENERATE_ERR:", err);
    res.status(500).json({ error: "Generator unavailable" });
  }
});

/**
 * POST /submit
 *
 * Accepts form fields (multipart/form-data) including:
 *   name, email, product, qty, size, color, notes
 *   generatedImage (base64 string or URL)
 *   upload (optional file upload)
 *
 * Sends an email with order details and attachments via Resend.
 */
app.post("/submit", upload.single("upload"), async (req, res) => {
  try {
    const f = req.body || {};
    const attachments = [];

    // Attach generated image, either as base64 string or remote URL
    const gen = f.generatedImage || "";
    if (gen.startsWith("data:image/")) {
      const base64 = gen.split(",")[1];
      if (base64) attachments.push({ filename: "generated.png", content: base64, encoding: "base64" });
    } else if (/^https?:/.test(gen)) {
      const r = await fetch(gen);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        attachments.push({ filename: "generated.png", content: buf.toString("base64"), encoding: "base64" });
      }
    }

    // Attach uploaded file, if provided
    if (req.file) {
      attachments.push({ filename: req.file.originalname, content: req.file.buffer.toString("base64"), encoding: "base64" });
    }

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
    console.error("SUBMIT_ERR:", err);
    res.status(500).json({ error: "Submit failed" });
  }
});

// Launch the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LMX backend listening on ${PORT}`));