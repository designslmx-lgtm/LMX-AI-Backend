// LMX SYNTHETIC DESIGNER — BACKEND (UNIFIED ENGINE)
// Safe upgrade from your Railway backend. Same behavior, with added hooks
// for user context, credits, logging, styles, magic prompt, share links,
// captions/hashtags, and stronger safety / ban checks.

/* =================  CORE IMPORTS  ================= */

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
// Optional future wiring for billing and DB:
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// const { createClient } = require("@supabase/supabase-js");
// const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

/* =================  OPENAI CLIENT  ================= */

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY is not set. The generator will fail until you add it.");
}

// Text model for captions / hashtags (does NOT touch your image model)
const TEXT_MODEL = process.env.LMX_TEXT_MODEL || "gpt-4o-mini";

/* =================  APP SETUP  ================= */

const app = express();

app.use(
  cors({
    origin: "*", // you can lock to your domain later
    methods: ["POST", "OPTIONS", "GET"],
  })
);

// ===== STRIPE WEBHOOK ROUTE (RAW BODY) =====
// Must be BEFORE app.use(express.json(...))
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Stripe signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("Stripe event received:", event.type);

    // You will expand this switch later to handle:
    // - checkout.session.completed
    // - customer.subscription.created / updated / deleted
    // - invoice.paid / invoice.payment_failed
    // For now, just acknowledge receipt.
    return res.json({ received: true });
  }
);

// JSON body for normal routes
app.use(express.json({ limit: "10mb" }));

// Simple health check
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "LMX Synthetic Designer",
    status: "online",
  });
});

/* ============  RATIO → SIZE MAPPING  ============ */

// Frontend can send any of these ratios; we squeeze them into the closest OpenAI size.
function mapRatioToSize(ratio) {
  // OpenAI gpt-image-1 supports: 1024x1024, 1024x1792, 1792x1024
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

/* ============  BASIC SAFETY HOOK  ============ */

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

/* ============  STRONGER CONTENT FILTER  ============ */

// Returns { ok: boolean, code?: string, message?: string }
function runContentFilter(prompt) {
  if (!prompt) {
    return { ok: true };
  }
  const lower = prompt.toLowerCase();

  // Hard-block categories you do NOT want on your platform.
  const hardRules = [
    {
      code: "minor_sexual_content",
      words: [
        "child sexual",
        "underage sex",
        "teen sex",
        "teen porn",
        "14 year old",
        "15 year old",
        "16 year old",
        "minor nude",
        "minor pornography",
      ],
    },
    {
      code: "exploitative_content",
      words: [
        "csam",
        "child abuse material",
        "non-consensual intimate",
        "hidden camera in shower",
        "voyeur porn",
      ],
    },
    {
      code: "sexual_violence",
      words: [
        "rape",
        "sexual assault",
        "forced sex",
        "non-consensual sex",
      ],
    },
    {
      code: "bestiality",
      words: [
        "sex with animal",
        "bestiality",
        "zoophilia",
      ],
    },
    {
      code: "revenge_porn",
      words: [
        "revenge porn",
        "leak my ex nudes",
        "post my ex nude",
      ],
    },
  ];

  for (const rule of hardRules) {
    if (rule.words.some((w) => lower.includes(w))) {
      return {
        ok: false,
        code: rule.code,
        message: "Prompt blocked by LMX safety rules.",
      };
    }
  }

  // Keep the old simple hook as a fallback
  if (looksObviouslyBad(prompt)) {
    return {
      ok: false,
      code: "unsafe_keyword",
      message: "Prompt blocked by LMX safety rules.",
    };
  }

  return { ok: true };
}

/* ============  STYLE MAP (PRESETS)  ============ */

// Simple keys your UI can send in `style`
// Example: style: "anime", "cinematic", "realistic", etc.
const STYLE_MAP = {
  anime:
    "highly detailed anime illustration, cel-shaded, bold clean line art, expressive faces, vibrant colors, Japanese anime style",
  cinematic:
    "ultra realistic cinematic film still, dramatic lighting, volumetric light, shallow depth of field, 35mm lens, film-grade color grading",
  realistic:
    "photorealistic ultra detailed image, natural lighting, real-world textures, subtle imperfections, 8k resolution look",
  comic:
    "comic book illustration, bold black inks, halftone shading, dynamic poses, graphic novel panel style",
  watercolor:
    "soft watercolor painting, textured paper, flowing pigment edges, gentle gradients, hand-painted illustration",
  "3d":
    "high-end 3D render, physically-based materials, realistic reflections and shadows, studio lighting, CG artwork",
  pixel:
    "retro pixel art, low resolution sprite style, limited color palette, 16-bit video game look",
  sketch:
    "hand-drawn pencil sketch, loose linework, visible graphite texture, minimal shading, concept art style",
};

/* ============  USER CONTEXT AND CREDITS HOOKS  ============ */

// Pulls a user id + plan/tier from headers or body if available
function getUserContext(req) {
  const userId =
    (req.headers["x-lmx-user-id"] ||
      req.headers["x-user-id"] ||
      req.body?.userId ||
      "").toString().trim() || null;

  // Read plan / tier from request if frontend sends it
  const rawPlan =
    (req.headers["x-lmx-plan"] ||
      req.headers["x-user-plan"] ||
      req.body?.plan ||
      req.body?.tier ||
      "").toString().trim();

  let plan = rawPlan.toLowerCase();
  if (!plan) {
    plan = "free"; // default if nothing is sent
  }

  return {
    userId,           // string or null
    isGuest: !userId, // true when no id present
    plan,             // comes from frontend or defaults to "free"
  };
}

// Get client IP (best effort behind proxies)
function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) {
    return xf.split(",")[0].trim();
  }
  const ip = req.socket?.remoteAddress || null;
  return ip;
}

// Ban check: uses env lists
// LMX_BANNED_USER_IDS = "user1,user2"
// LMX_BANNED_IPS = "1.2.3.4,5.6.7.8"
function checkBan(userCtx, req) {
  const bannedUsersEnv = process.env.LMX_BANNED_USER_IDS || "";
  const bannedIpsEnv = process.env.LMX_BANNED_IPS || "";

  const bannedUserIds = bannedUsersEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const bannedIps = bannedIpsEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const clientIp = getClientIp(req);

  if (userCtx.userId && bannedUserIds.includes(userCtx.userId)) {
    return {
      banned: true,
      reason: "user_id_banned",
      detail: `User ${userCtx.userId} is banned.`,
      ip: clientIp || null,
    };
  }

  if (clientIp && bannedIps.includes(clientIp)) {
    return {
      banned: true,
      reason: "ip_banned",
      detail: `IP ${clientIp} is banned.`,
      ip: clientIp,
    };
  }

  return { banned: false };
}

// Credit or plan check before generation
// Reads credits from the request (headers/body):
// - x-lmx-credits / x-user-credits headers
// - req.body.credits / req.body.creditsRemaining
// If no credits number is provided, treats as unlimited (always allow).
async function checkCredits(userCtx, req) {
  try {
    const rawCredits =
      req.headers["x-lmx-credits"] ??
      req.headers["x-user-credits"] ??
      (req.body ? req.body.credits ?? req.body.creditsRemaining : null);

    // If nothing sent, do NOT block anything yet (unlimited mode)
    if (rawCredits === null || rawCredits === undefined) {
      return {
        ok: true,
        code: "no_limit_configured",
        message: "No credits value provided; treating as unlimited for now.",
      };
    }

    const creditsNumber = Number(rawCredits);

    // If not a valid number, also allow (to avoid accidental lockouts)
    if (Number.isNaN(creditsNumber)) {
      return {
        ok: true,
        code: "invalid_credits_value",
        message: "Credits value not a valid number; allowing request.",
      };
    }

    // If user still has credits > 0 → allow
    if (creditsNumber > 0) {
      return {
        ok: true,
        code: "has_credits",
        message: "User has remaining credits.",
        remaining: creditsNumber,
      };
    }

    // creditsNumber <= 0 → block
    return {
      ok: false,
      code: "no_credits",
      message: "You are out of credits.",
      remaining: 0,
    };
  } catch (err) {
    console.error("❌ checkCredits error:", err);
    // Fail-open: if something goes wrong, don't hard-block generation
    return {
      ok: true,
      code: "credits_check_error",
      message: "Credits check failed; allowing request to avoid lockout.",
    };
  }
}

// Log generation event for analytics and Library
async function logGeneration(userCtx, meta) {
  // For now just log to console.
  // Later you can insert into Supabase (lmx_generations table).
  try {
    console.log("📊 LMX generation", {
      userId: userCtx.userId || "guest",
      plan: userCtx.plan,
      ...meta,
    });

    // Example Supabase insert (disabled until you wire it):
    /*
    const { error } = await supabase
      .from("lmx_generations")
      .insert({
        user_id: userCtx.userId,
        plan: userCtx.plan,
        prompt: meta.prompt,
        magic_prompt: meta.magicPrompt,
        caption: meta.caption,
        hashtags: meta.hashtags,
        style: meta.style,
        ratio: meta.ratio,
        size: meta.size,
        model: meta.model,
        request_id: meta.requestId,
        image_url: meta.imageUrl,
        created_at: new Date().toISOString(),
      });

    if (error) {
      console.error("❌ Supabase logGeneration error:", error);
    }
    */
  } catch (err) {
    console.error("❌ logGeneration error:", err);
  }
}

// Utility for simple request ids
function makeRequestId() {
  return (
    "lmx_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  );
}

/* ============  CAPTION + HASHTAGS HELPER  ============ */

// Builds a social-friendly caption + hashtags for each frame.
// Never throws; if anything fails, it just returns empty strings.
async function buildCaptionAndTags({ prompt, magicPrompt }) {
  try {
    const basePrompt = magicPrompt || prompt || "";
    if (!basePrompt) {
      return { caption: "", hashtags: "" };
    }

    const completion = await client.chat.completions.create({
      model: TEXT_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are LMX Synthetic's caption engine. " +
            "Given a short description of an AI image, you return a JSON object with a punchy caption and 8–12 relevant hashtags. " +
            "Keep the caption under 120 characters, no emojis. Hashtags should be lower_case or camelCase, no spaces, each starting with '#'.",
        },
        {
          role: "user",
          content:
            `Image description: ${basePrompt}\n\n` +
            "Respond ONLY as valid JSON with this shape:\n" +
            `{"caption": "...", "hashtags": ["#tag1", "#tag2"]}`,
        },
      ],
      temperature: 0.7,
      max_tokens: 180,
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || "";

    let caption = "";
    let hashtags = "";

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        caption =
          typeof parsed.caption === "string" ? parsed.caption.trim() : "";
        if (Array.isArray(parsed.hashtags)) {
          hashtags = parsed.hashtags
            .filter((h) => typeof h === "string" && h.trim().length > 0)
            .join(" ");
        }
      }
    } catch (e) {
      // If parsing fails, just fall back to raw text as caption
      caption = raw;
      hashtags = "";
    }

    return {
      caption: caption || "",
      hashtags: hashtags || "",
    };
  } catch (err) {
    console.error("❌ buildCaptionAndTags error:", err);
    return { caption: "", hashtags: "" };
  }
}

/* ============  MAIN GENERATE ROUTE  ============ */

app.post("/lmx1/generate", async (req, res) => {
  const requestId = makeRequestId();
  const userCtx = getUserContext(req);
  const clientIp = getClientIp(req);

  // 1) Ban check
  const banResult = checkBan(userCtx, req);
  if (banResult.banned) {
    console.warn("⛔ Blocked banned user/ip", {
      requestId,
      userId: userCtx.userId || "guest",
      plan: userCtx.plan,
      ip: banResult.ip || clientIp || null,
      reason: banResult.reason,
    });

    return res.status(403).json({
      error: "banned",
      message: "Your account or IP is blocked from using this service.",
      code: banResult.reason,
      requestId,
    });
  }

  try {
    const {
      prompt: rawPrompt,
      style: rawStyle,   // style from UI (e.g. "anime", "cinematic", etc.)
      ratio: rawRatio,
      model: rawModel,
    } = req.body || {};

    const prompt = (rawPrompt || "").trim();
    const ratio = (rawRatio || "").trim() || "1:1";
    const model = (rawModel || "").trim() || "gpt-image-1";

    // ===== RESOLVE STYLE =====
    let styleKeyRaw = (rawStyle || "").toString().trim();
    let styleKey = styleKeyRaw.toLowerCase();
    let resolvedStyle = "";

    if (styleKey && STYLE_MAP[styleKey]) {
      // Use strong preset when it matches a key (anime / cinematic / realistic / etc.)
      resolvedStyle = STYLE_MAP[styleKey];
    } else if (styleKeyRaw) {
      // If it's not a known key, just use whatever text the UI sent
      resolvedStyle = styleKeyRaw;
    }

    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt." });
    }

    // 2) Content safety filter (stronger)
    const safety = runContentFilter(prompt);
    if (!safety.ok) {
      console.warn("⚠️ Blocked prompt by LMX safety rules.", {
        requestId,
        userId: userCtx.userId || "guest",
        plan: userCtx.plan,
        ip: clientIp || null,
        code: safety.code,
      });

      return res.status(400).json({
        error: "unsafe_content",
        message: safety.message || "Prompt blocked by LMX safety rules.",
        code: safety.code || "unsafe_content",
        requestId,
      });
    }

    // 3) Credits or plan check
    const creditCheck = await checkCredits(userCtx, req);
    if (!creditCheck.ok) {
      console.warn("⛔ Credits check blocked generation", {
        requestId,
        userId: userCtx.userId || "guest",
        reason: creditCheck.code,
        remaining: creditCheck.remaining ?? null,
      });

      // 402 Payment Required is perfect for "upgrade" or "buy tokens"
      return res.status(402).json({
        error: "no_credits",
        message: creditCheck.message || "You are out of credits.",
        code: creditCheck.code || "no_credits",
        remaining: creditCheck.remaining ?? 0,
        requestId,
      });
    }

    const size = mapRatioToSize(ratio);

    // Build the LMX flavored "magic" prompt
    const magicPrompt = [
      resolvedStyle ? `Style: ${resolvedStyle}.` : "",
      "LMX Synthetic Designer frame.",
      `Ratio hint: ${ratio}.`,
      prompt,
    ]
      .filter(Boolean)
      .join(" ");

    console.log("🖼  Generating image", {
      requestId,
      userId: userCtx.userId || "guest",
      plan: userCtx.plan,
      ip: clientIp || null,
      size,
      ratio,
      styleKey: styleKey || null,
      resolvedStyle: resolvedStyle || null,
      model,
    });

    // 4) Call OpenAI image model
    const response = await client.images.generate({
      model,
      prompt: magicPrompt,
      n: 1,
      size,
    });

    if (
      !response ||
      !response.data ||
      !response.data[0] ||
      !response.data[0].b64_json
    ) {
      console.error("❌ OpenAI returned no data:", { requestId, response });
      return res.status(500).json({ error: "no_image_data", requestId });
    }

    const base64 = response.data[0].b64_json;

    // Build a shareable data URL (never expires, can be used in <img src="...">)
    const imageUrl = `data:image/png;base64,${base64}`;

    // 5) Build caption + hashtags (non-blocking helper)
    const { caption, hashtags } = await buildCaptionAndTags({
      prompt,
      magicPrompt,
    });

    // 6) Log generation (for analytics and Library)
    await logGeneration(userCtx, {
      requestId,
      prompt,
      magicPrompt,
      caption,
      hashtags,
      style: resolvedStyle || "Auto",
      ratio,
      size,
      model,
      imageUrl,
      ip: clientIp || null,
    });

    // 7) Return everything to frontend
    return res.json({
      base64,
      imageUrl,              // shareable link string
      magicPrompt,           // full professional prompt used to generate
      caption,               // short caption for social
      hashtags,              // string of hashtags "#one #two ..."
      ratio,
      size,
      style: resolvedStyle || "Auto",
      model,
      requestId,
      userId: userCtx.userId || null,
      plan: userCtx.plan,
    });
  } catch (err) {
    console.error("🔥 /lmx1/generate error:", {
      requestId,
      error: err?.response?.data || err,
    });

    const status = err?.status || err?.response?.status || 500;

    return res.status(status).json({
      error: "server_error",
      message: err?.message || "Unexpected error in LMX backend.",
      requestId,
    });
  }
});

/* ============  REMIX ROUTE (LMX SYNTHETIC PROMPT)  ============ */

app.post("/lmx1/remix", async (req, res) => {
  const requestId = makeRequestId();
  const userCtx = getUserContext(req);
  const clientIp = getClientIp(req);

  // Gate remix to paid tiers if you want
  const allowedPlans = ["creator", "pro", "studio"];
  if (!allowedPlans.includes(userCtx.plan)) {
    return res.status(403).json({
      error: "plan_not_allowed",
      message: "Remix is only available on Creator and above.",
      requestId,
    });
  }

  const banResult = checkBan(userCtx, req);
  if (banResult.banned) {
    console.warn("⛔ Blocked banned user/ip (remix)", {
      requestId,
      userId: userCtx.userId || "guest",
      plan: userCtx.plan,
      ip: banResult.ip || clientIp || null,
      reason: banResult.reason,
    });

    return res.status(403).json({
      error: "banned",
      message: "Your account or IP is blocked from using this service.",
      code: banResult.reason,
      requestId,
    });
  }

  try {
    const {
      remixPrompt: rawRemixPrompt,
      basePrompt: rawBasePrompt,   // original frame description / original prompt
      style: rawStyle,
      ratio: rawRatio,
      model: rawModel,
    } = req.body || {};

    const remixPrompt = (rawRemixPrompt || "").trim();
    const basePrompt = (rawBasePrompt || "").trim();
    const ratio = (rawRatio || "").trim() || "1:1";
    const model = (rawModel || "").trim() || "gpt-image-1";

    if (!remixPrompt) {
      return res.status(400).json({ error: "Missing remixPrompt.", requestId });
    }

    // Safety on combined text
    const combinedForSafety = [basePrompt, remixPrompt].filter(Boolean).join(" ");
    const safety = runContentFilter(combinedForSafety);
    if (!safety.ok) {
      console.warn("⚠️ Blocked remix prompt by LMX safety rules.", {
        requestId,
        userId: userCtx.userId || "guest",
        plan: userCtx.plan,
        ip: clientIp || null,
        code: safety.code,
      });

      return res.status(400).json({
        error: "unsafe_content",
        message: safety.message || "Prompt blocked by LMX safety rules.",
        code: safety.code || "unsafe_content",
        requestId,
      });
    }

    const creditCheck = await checkCredits(userCtx, req);
    if (!creditCheck.ok) {
      console.warn("⛔ Credits check blocked remix", {
        requestId,
        userId: userCtx.userId || "guest",
        reason: creditCheck.code,
        remaining: creditCheck.remaining ?? null,
      });

      return res.status(402).json({
        error: "no_credits",
        message: creditCheck.message || "You are out of credits.",
        code: creditCheck.code || "no_credits",
        remaining: creditCheck.remaining ?? 0,
        requestId,
      });
    }

    // Style / ratio
    let styleKeyRaw = (rawStyle || "").toString().trim();
    let styleKey = styleKeyRaw.toLowerCase();
    let resolvedStyle = "";
    if (styleKey && STYLE_MAP[styleKey]) {
      resolvedStyle = STYLE_MAP[styleKey];
    } else if (styleKeyRaw) {
      resolvedStyle = styleKeyRaw;
    }

    const size = mapRatioToSize(ratio);

    const magicPromptParts = [
      "LMX Synthetic Designer remix frame.",
      basePrompt
        ? `Original frame description: ${basePrompt}.`
        : "Original frame already exists in the user's library.",
      resolvedStyle ? `Style: ${resolvedStyle}.` : "",
      `Ratio hint: ${ratio}.`,
      `Transform the existing image according to this instruction: ${remixPrompt}.`,
    ];

    const magicPrompt = magicPromptParts.filter(Boolean).join(" ");

    console.log("🎛  Remixing image", {
      requestId,
      userId: userCtx.userId || "guest",
      plan: userCtx.plan,
      ip: clientIp || null,
      size,
      ratio,
      styleKey: styleKey || null,
      resolvedStyle: resolvedStyle || null,
      model,
    });

    const response = await client.images.generate({
      model,
      prompt: magicPrompt,
      n: 1,
      size,
    });

    if (
      !response ||
      !response.data ||
      !response.data[0] ||
      !response.data[0].b64_json
    ) {
      console.error("❌ Remix: OpenAI returned no data:", { requestId, response });
      return res.status(500).json({ error: "no_image_data", requestId });
    }

    const base64 = response.data[0].b64_json;
    const imageUrl = `data:image/png;base64,${base64}`;

    const { caption, hashtags } = await buildCaptionAndTags({
      prompt: remixPrompt,
      magicPrompt,
    });

    await logGeneration(userCtx, {
      requestId,
      prompt: remixPrompt,
      basePrompt,
      magicPrompt,
      caption,
      hashtags,
      style: resolvedStyle || "Auto",
      ratio,
      size,
      model,
      imageUrl,
      ip: clientIp || null,
      isRemix: true,
    });

    return res.json({
      base64,
      imageUrl,
      magicPrompt,
      caption,
      hashtags,
      ratio,
      size,
      style: resolvedStyle || "Auto",
      model,
      requestId,
      userId: userCtx.userId || null,
      plan: userCtx.plan,
      isRemix: true,
    });
  } catch (err) {
    console.error("🔥 /lmx1/remix error:", {
      requestId,
      error: err?.response?.data || err,
    });

    const status = err?.status || err?.response?.status || 500;

    return res.status(status).json({
      error: "server_error",
      message: err?.message || "Unexpected error in LMX remix backend.",
      requestId,
    });
  }
});

/* ============  UPSCALE ROUTE  ============ */

app.post("/lmx1/upscale", async (req, res) => {
  const requestId = makeRequestId();
  const userCtx = getUserContext(req);
  const clientIp = getClientIp(req);

  const banResult = checkBan(userCtx, req);
  if (banResult.banned) {
    console.warn("⛔ Blocked banned user/ip (upscale)", {
      requestId,
      userId: userCtx.userId || "guest",
      plan: userCtx.plan,
      ip: banResult.ip || clientIp || null,
      reason: banResult.reason,
    });

    return res.status(403).json({
      error: "banned",
      message: "Your account or IP is blocked from using this service.",
      code: banResult.reason,
      requestId,
    });
  }

  try {
    const {
      basePrompt: rawBasePrompt,      // description of current frame
      upscalePrompt: rawUpscalePrompt, // optional extra instruction
      style: rawStyle,
      ratio: rawRatio,
      model: rawModel,
    } = req.body || {};

    const basePrompt = (rawBasePrompt || "").trim();
    const ratio = (rawRatio || "").trim() || "1:1";
    const model = (rawModel || "").trim() || "gpt-image-1";

    const upscaleInstruction =
      (rawUpscalePrompt || "").trim() ||
      "Recreate this frame as a sharper, more detailed, high-resolution version while preserving composition and subject.";

    if (!basePrompt) {
      return res.status(400).json({ error: "Missing basePrompt for upscale.", requestId });
    }

    const combinedForSafety = [basePrompt, upscaleInstruction].join(" ");
    const safety = runContentFilter(combinedForSafety);
    if (!safety.ok) {
      console.warn("⚠️ Blocked upscale prompt by LMX safety rules.", {
        requestId,
        userId: userCtx.userId || "guest",
        plan: userCtx.plan,
        ip: clientIp || null,
        code: safety.code,
      });

      return res.status(400).json({
        error: "unsafe_content",
        message: safety.message || "Prompt blocked by LMX safety rules.",
        code: safety.code || "unsafe_content",
        requestId,
      });
    }

    const creditCheck = await checkCredits(userCtx, req);
    if (!creditCheck.ok) {
      console.warn("⛔ Credits check blocked upscale", {
        requestId,
        userId: userCtx.userId || "guest",
        reason: creditCheck.code,
        remaining: creditCheck.remaining ?? null,
      });

      return res.status(402).json({
        error: "no_credits",
        message: creditCheck.message || "You are out of credits.",
        code: creditCheck.code || "no_credits",
        remaining: creditCheck.remaining ?? 0,
        requestId,
      });
    }

    let styleKeyRaw = (rawStyle || "").toString().trim();
    let styleKey = styleKeyRaw.toLowerCase();
    let resolvedStyle = "";
    if (styleKey && STYLE_MAP[styleKey]) {
      resolvedStyle = STYLE_MAP[styleKey];
    } else if (styleKeyRaw) {
      resolvedStyle = styleKeyRaw;
    }

    const size = mapRatioToSize(ratio);

    const magicPrompt = [
      "LMX Synthetic Designer upscale pass.",
      `Original frame description: ${basePrompt}.`,
      resolvedStyle ? `Style: ${resolvedStyle}.` : "",
      `Ratio hint: ${ratio}.`,
      upscaleInstruction,
      "Emphasize clean edges, fine details, high clarity, and subtle textures.",
    ]
      .filter(Boolean)
      .join(" ");

    console.log("🔍  Upscaling image", {
      requestId,
      userId: userCtx.userId || "guest",
      plan: userCtx.plan,
      ip: clientIp || null,
      size,
      ratio,
      styleKey: styleKey || null,
      resolvedStyle: resolvedStyle || null,
      model,
    });

    const response = await client.images.generate({
      model,
      prompt: magicPrompt,
      n: 1,
      size,
    });

    if (
      !response ||
      !response.data ||
      !response.data[0] ||
      !response.data[0].b64_json
    ) {
      console.error("❌ Upscale: OpenAI returned no data:", { requestId, response });
      return res.status(500).json({ error: "no_image_data", requestId });
    }

    const base64 = response.data[0].b64_json;
    const imageUrl = `data:image/png;base64,${base64}`;

    const { caption, hashtags } = await buildCaptionAndTags({
      prompt: upscaleInstruction,
      magicPrompt,
    });

    await logGeneration(userCtx, {
      requestId,
      prompt: upscaleInstruction,
      basePrompt,
      magicPrompt,
      caption,
      hashtags,
      style: resolvedStyle || "Auto",
      ratio,
      size,
      model,
      imageUrl,
      ip: clientIp || null,
      isUpscale: true,
    });

    return res.json({
      base64,
      imageUrl,
      magicPrompt,
      caption,
      hashtags,
      ratio,
      size,
      style: resolvedStyle || "Auto",
      model,
      requestId,
      userId: userCtx.userId || null,
      plan: userCtx.plan,
      isUpscale: true,
    });
  } catch (err) {
    console.error("🔥 /lmx1/upscale error:", {
      requestId,
      error: err?.response?.data || err,
    });

    const status = err?.status || err?.response?.status || 500;

    return res.status(status).json({
      error: "server_error",
      message: err?.message || "Unexpected error in LMX upscale backend.",
      requestId,
    });
  }
});

/* ============  BACKGROUND REMOVAL ROUTE  ============ */

app.post("/lmx1/remove-background", async (req, res) => {
  const requestId = makeRequestId();
  const userCtx = getUserContext(req);
  const clientIp = getClientIp(req);

  const banResult = checkBan(userCtx, req);
  if (banResult.banned) {
    console.warn("⛔ Blocked banned user/ip (remove-background)", {
      requestId,
      userId: userCtx.userId || "guest",
      plan: userCtx.plan,
      ip: banResult.ip || clientIp || null,
      reason: banResult.reason,
    });

    return res.status(403).json({
      error: "banned",
      message: "Your account or IP is blocked from using this service.",
      code: banResult.reason,
      requestId,
    });
  }

  try {
    const {
      basePrompt: rawBasePrompt,        // description of current frame
      bgInstruction: rawBgInstruction,  // optional, e.g. "pure white background"
      style: rawStyle,
      ratio: rawRatio,
      model: rawModel,
    } = req.body || {};

    const basePrompt = (rawBasePrompt || "").trim();
    const ratio = (rawRatio || "").trim() || "1:1";
    const model = (rawModel || "").trim() || "gpt-image-1";

    const bgInstruction =
      (rawBgInstruction || "").trim() ||
      "Remove the original background and place the main subject on a clean, simple background suitable for product or profile use.";

    if (!basePrompt) {
      return res.status(400).json({ error: "Missing basePrompt for background removal.", requestId });
    }

    const combinedForSafety = [basePrompt, bgInstruction].join(" ");
    const safety = runContentFilter(combinedForSafety);
    if (!safety.ok) {
      console.warn("⚠️ Blocked remove-background prompt by LMX safety rules.", {
        requestId,
        userId: userCtx.userId || "guest",
        plan: userCtx.plan,
        ip: clientIp || null,
        code: safety.code,
      });

      return res.status(400).json({
        error: "unsafe_content",
        message: safety.message || "Prompt blocked by LMX safety rules.",
        code: safety.code || "unsafe_content",
        requestId,
      });
    }

    const creditCheck = await checkCredits(userCtx, req);
    if (!creditCheck.ok) {
      console.warn("⛔ Credits check blocked remove-background", {
        requestId,
        userId: userCtx.userId || "guest",
        reason: creditCheck.code,
        remaining: creditCheck.remaining ?? null,
      });

      return res.status(402).json({
        error: "no_credits",
        message: creditCheck.message || "You are out of credits.",
        code: creditCheck.code || "no_credits",
        remaining: creditCheck.remaining ?? 0,
        requestId,
      });
    }

    let styleKeyRaw = (rawStyle || "").toString().trim();
    let styleKey = styleKeyRaw.toLowerCase();
    let resolvedStyle = "";
    if (styleKey && STYLE_MAP[styleKey]) {
      resolvedStyle = STYLE_MAP[styleKey];
    } else if (styleKeyRaw) {
      resolvedStyle = styleKeyRaw;
    }

    const size = mapRatioToSize(ratio);

    const magicPrompt = [
      "LMX Synthetic Designer background cleanup pass.",
      `Original frame description: ${basePrompt}.`,
      resolvedStyle ? `Style: ${resolvedStyle}.` : "",
      `Ratio hint: ${ratio}.`,
      bgInstruction,
      "Preserve the main subject cleanly and avoid halos or artifacts around the edges.",
    ]
      .filter(Boolean)
      .join(" ");

    console.log("🧼  Removing background", {
      requestId,
      userId: userCtx.userId || "guest",
      plan: userCtx.plan,
      ip: clientIp || null,
      size,
      ratio,
      styleKey: styleKey || null,
      resolvedStyle: resolvedStyle || null,
      model,
    });

    const response = await client.images.generate({
      model,
      prompt: magicPrompt,
      n: 1,
      size,
    });

    if (
      !response ||
      !response.data ||
      !response.data[0] ||
      !response.data[0].b64_json
    ) {
      console.error("❌ Remove-background: OpenAI returned no data:", {
        requestId,
        response,
      });
      return res.status(500).json({ error: "no_image_data", requestId });
    }

    const base64 = response.data[0].b64_json;
    const imageUrl = `data:image/png;base64,${base64}`;

    const { caption, hashtags } = await buildCaptionAndTags({
      prompt: bgInstruction,
      magicPrompt,
    });

    await logGeneration(userCtx, {
      requestId,
      prompt: bgInstruction,
      basePrompt,
      magicPrompt,
      caption,
      hashtags,
      style: resolvedStyle || "Auto",
      ratio,
      size,
      model,
      imageUrl,
      ip: clientIp || null,
      isBackgroundRemoval: true,
    });

    return res.json({
      base64,
      imageUrl,
      magicPrompt,
      caption,
      hashtags,
      ratio,
      size,
      style: resolvedStyle || "Auto",
      model,
      requestId,
      userId: userCtx.userId || null,
      plan: userCtx.plan,
      isBackgroundRemoval: true,
    });
  } catch (err) {
    console.error("🔥 /lmx1/remove-background error:", {
      requestId,
      error: err?.response?.data || err,
    });

    const status = err?.status || err?.response?.status || 500;

    return res.status(status).json({
      error: "server_error",
      message: err?.message || "Unexpected error in LMX background removal backend.",
      requestId,
    });
  }
});

/* ============  START SERVER  ============ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LMX Synthetic Designer backend running on port ${PORT}`);
});