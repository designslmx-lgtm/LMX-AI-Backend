// LMX SYNTHETIC DESIGNER — BACKEND (RAILWAY)
// Replace your existing backend file with this (or merge routes if you already have an app)

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

// 1) OPENAI CLIENT
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY is not set. The generator will fail until you add it.");
}

// 2) BASIC APP SETUP
const app = express();

app.use(cors({
  origin: "*",          // lock this down later if you want
  methods: ["POST", "OPTIONS"],
}));
app.use(express.json({ limit: "10mb" }));

// Optional: simple health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "LMX Synthetic Designer", status: "online" });
});

// 3) RATIO → SIZE MAPPING
// Frontend can send any of these ratios; we squeeze them into the closest OpenAI size.
function mapRatioToSize(ratio) {
  // OpenAI gpt-image-1 (as of now) supports: 1024x1024, 1024x1792, 1792x1024
  // We group ratios into "square", "tall", "wide".
  const r = (ratio || "").trim();

  // Tall-ish → vertical
  const tallSet = new Set(["4:5", "2:3", "9:16"]);
  // Wide-ish → horizontal
  const wideSet = new Set(["3:2", "16:9"]);

  if (tallSet.has(r)) return "1024x1792";
  if (wideSet.has(r)) return "1792x1024";
  // Default / 1:1 / anything unknown
  return "1024x1024";
}

// 4) LIGHT PROMPT SANITY (OPTIONAL FILTERING HOOK)
// You can expand this later for custom safety rules.
function looksObviouslyBad(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const banned = [
    "csam",
    "child sexual",
    "child abuse",
    "exploitative minor",
    "revenge porn",
  ];
  return banned.some((w) => lower.includes(w));
}

// 5) MAIN GENERATE ROUTE
app.post("/lmx1/generate", async (req, res) => {
  try {
    const {
      prompt: rawPrompt,
      style: rawStyle,
      ratio: rawRatio,
      model: rawModel,
    } = req.body || {};

    const prompt = (rawPrompt || "").trim();
    const style  = (rawStyle || "").trim();
    const ratio  = (rawRatio || "").trim() || "1:1";
    const model  = (rawModel || "").trim() || "gpt-image-1";

    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt." });
    }

    // Quick text sanity guard (you still have OpenAI safety on top)
    if (looksObviouslyBad(prompt)) {
      console.warn("⚠️ Blocked prompt by simple filter.");
      return res.status(400).json({
        error: "unsafe_content",
        message: "Prompt blocked by LMX safety.",
      });
    }

    const size = mapRatioToSize(ratio);

    // Build the LMX-flavored prompt
    const finalPrompt = [
      style ? `Style: ${style}.` : "",
      `LMX Synthetic Designer frame.`,
      `Ratio hint: ${ratio}.`,
      prompt,
    ].filter(Boolean).join(" ");

    console.log("🖼  Generating image:", {
      size,
      ratio,
      style: style || "Auto",
      model,
    });

    // 6) CALL OPENAI
    const response = await client.images.generate({
      model,
      prompt: finalPrompt,
      n: 1,
      size,
      response_format: "b64_json",
    });

    if (!response || !response.data || !response.data[0] || !response.data[0].b64_json) {
      console.error("❌ OpenAI returned no data:", response);
      return res.status(500).json({ error: "no_image_data" });
    }

    const base64 = response.data[0].b64_json;

    // 7) RETURN BASE64 → FRONTEND BUILDS data URL + WATERMARK IF NEEDED
    return res.json({
      base64,
      ratio,
      size,
      style: style || "Auto",
      model,
    });

  } catch (err) {
    console.error("🔥 /lmx1/generate error:", err?.response?.data || err);

    const status = err?.status || err?.response?.status || 500;

    return res.status(status).json({
      error: "server_error",
      message: err?.message || "Unexpected error in LMX backend.",
    });
  }
});

// 8) START SERVER (Railway will set PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LMX Synthetic Designer backend running on port ${PORT}`);
});