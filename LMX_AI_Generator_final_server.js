// LMX SYNTHETIC DESIGNER — BACKEND (UNIFIED ENGINE)
// Safe upgrade from your Railway backend. Same behavior, with added hooks
// for user context, credits, and logging.

/* =================  CORE IMPORTS  ================= */

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
// Optional future wiring for billing and DB:
// const Stripe = require("stripe");
// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// const { createClient } = require("@supabase/supabase-js");
// const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

/* =================  OPENAI CLIENT  ================= */

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY is not set. The generator will fail until you add it.");
}

/* =================  APP SETUP  ================= */

const app = express();

app.use(
  cors({
    origin: "*", // you can lock to your domain later
    methods: ["POST", "OPTIONS", "GET"],
  })
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

/* ============  SIMPLE SAFETY HOOK  ============ */

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

/* ============  USER CONTEXT AND CREDITS HOOKS  ============ */
/* These are safe stubs. They do not break your current flow.
   You can swap internals for Supabase later without
   touching the generate route logic again.                         */

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

// Credit or plan check before generation
// NOW reads credits from the request (headers/body):
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
        style: meta.style,
        ratio: meta.ratio,
        size: meta.size,
        model: meta.model,
        request_id: meta.requestId,
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

/* ============  MAIN GENERATE ROUTE  ============ */

app.post("/lmx1/generate", async (req, res) => {
  const requestId = makeRequestId();
  const userCtx = getUserContext(req);

  try {
    const {
      prompt: rawPrompt,
      style: rawStyle,
      ratio: rawRatio,
      model: rawModel,
    } = req.body || {};

    const prompt = (rawPrompt || "").trim();
    const style = (rawStyle || "").trim();
    const ratio = (rawRatio || "").trim() || "1:1";
    const model = (rawModel || "").trim() || "gpt-image-1";

    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt." });
    }

    // Quick text sanity guard (you still have OpenAI safety on top)
    if (looksObviouslyBad(prompt)) {
      console.warn("⚠️ Blocked prompt by simple filter.", { requestId });
      return res.status(400).json({
        error: "unsafe_content",
        message: "Prompt blocked by LMX safety.",
      });
    }

    // Credits or plan check
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
      });
    }

    const size = mapRatioToSize(ratio);

    // Build the LMX flavored prompt
    const finalPrompt = [
      style ? `Style: ${style}.` : "",
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
      size,
      ratio,
      style: style || "Auto",
      model,
    });

    // Call OpenAI
    const response = await client.images.generate({
      model,
      prompt: finalPrompt,
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
      return res.status(500).json({ error: "no_image_data" });
    }

    const base64 = response.data[0].b64_json;

    // Log generation (for analytics and Library)
    await logGeneration(userCtx, {
      requestId,
      prompt,
      style: style || "Auto",
      ratio,
      size,
      model,
    });

    // Return base64 to frontend. Your existing frontend dataURL logic still works.
    return res.json({
      base64,
      ratio,
      size,
      style: style || "Auto",
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

/* ============  START SERVER  ============ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LMX Synthetic Designer backend running on port ${PORT}`);
});