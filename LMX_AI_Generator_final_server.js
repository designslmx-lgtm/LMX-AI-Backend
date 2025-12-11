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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
const resend = new Resend(process.env.RESEND_API_KEY || "");
const SUBMIT_TO = process.env.SUBMIT_TO || "lmxcustomize@gmail.com";

app.get("/", (req, res) => {
  res.send("LMX backend running");
});

app.post("/api/generate", async (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").trim();
    if (!prompt)
      return res.status(400).json({ error: "Missing prompt." });

    let result;

    // ALWAYS USE SUPPORTED SIZE
    const size = "1024x1024";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    result = await openai.images.generate(
      {
        model: "gpt-image-1",
        prompt,
        size,
        quality: "high",
      },
      { signal: controller.signal }
    );

    clearTimeout(timeout);

    const b64 = result?.data?.[0]?.b64_json;
    if (!b64) return res.status(500).json({ error: "No image returned." });

    res.json({ base64: `data:image/png;base64,${b64}` });
  } catch (err) {
    console.error("GEN_ERR:", err.message);
    res.status(500).json({ error: "Image generator unavailable." });
  }
});

app.post("/api/submit", upload.single("upload"), async (req, res) => {
  try {
    const f = req.body || {};
    const attachments = [];

    if (f.generatedImage?.startsWith("data:image/")) {
      const base64 = f.generatedImage.split(",")[1];
      attachments.push({
        filename: "generated.png",
        content: base64,
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

    const html = `
      <h2>New LMX Submission</h2>
      <p><b>Name:</b> ${f.name}</p>
      <p><b>Email:</b> ${f.email}</p>
      <p><b>Product:</b> ${f.product}</p>
      <p><b>Qty:</b> ${f.qty}</p>
      <p><b>Size:</b> ${f.size}</p>
      <p><b>Color:</b> ${f.color}</p>
      <p><b>Notes:</b> ${f.notes}</p>
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
    res.status(500).json({ error: "Submit failed." });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`LMX backend live on port ${PORT}`)
);