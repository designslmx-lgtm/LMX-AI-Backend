import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import { Resend } from "resend";
import OpenAI from "openai";

/* ================================
   INIT
================================ */
const app = express();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));

/* ================================
   CORS
================================ */
app.use(
  cors({
    origin: [
      "https://lmxstudio.com",
      "https://www.lmxstudio.com"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

/* ================================
   API CLIENTS
================================ */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
const resend = new Resend(process.env.RESEND_API_KEY || "");
const SUBMIT_TO = process.env.SUBMIT_TO || "lmxcustomize@gmail.com";

/* ================================
   HEALTH CHECK
================================ */
app.get("/", (req, res) => {
  res.send("✅ LMX AI Backend is running");
});

/* ================================
   IMAGE GENERATE (FINAL PATCHED)
================================ */
app.post("/api/generate", async (req, res) => {
  try {
    const prompt = (req.body?.prompt || "").trim();
    if (!prompt)
      return res.status(400).json({ error: "Missing prompt." });

    console.log("🧠 Prompt:", prompt);

    // SAFE SUPPORTED SIZE
    const size = "1024x1024";

    let result;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 28000);

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
    } catch (err) {
      console.error("🔥 GENERATE TIMEOUT / ERROR", err.message);
      return res.status(500).json({ error: "Generator timeout. Try again." });
    }

    const b64 = result?.data?.[0]?.b64_json;
    if (!b64) return res.status(500).json({ error: "No image returned." });

    return res.json({ base64: `data:image/png;base64,${b64}` });
  } catch (err) {
    console.error("GEN_ERR:", err);
    return res.status(500).json({ error: "Image generator unavailable." });
  }
});

/* ================================
   SUBMIT ORDER (FINAL PATCHED)
================================ */
app.post("/api/submit", upload.single("upload"), async (req, res) => {
  try {
    const f = req.body || {};
    const attachments = [];

    // Generated image
    if (f.generatedImage?.startsWith("data:image/")) {
      const base64 = f.generatedImage.split(",")[1];
      attachments.push({
        filename: "generated.png",
        content: base64,
        encoding: "base64",
      });
    }

    // Uploaded file
    if (req.file) {
      attachments.push({
        filename: req.file.originalname,
        content: req.file.buffer.toString("base64"),
        encoding: "base64",
      });
    }

    // Email body
    const html = `
      <h2>New LMX Submission</h2>
      <p><b>Name:</b> ${f.name || "N/A"}</p>
      <p><b>Email:</b> ${f.email || "N/A"}</p>
      <p><b>Product:</b> ${f.product || "N/A"}</p>
      <p><b>Qty:</b> ${f.qty || "N/A"}</p>
      <p><b>Size:</b> ${f.size || "N/A"}</p>
      <p><b>Color:</b> ${f.color || "N/A"}</p>
      <p><b>Notes:</b> ${f.notes || "N/A"}</p>
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

/* ================================
   START SERVER
================================ */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🚀 LMX Backend Live on ${PORT}`)
);