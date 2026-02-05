// ============================================================
// LMX SYNTHETIC DESIGNER — UNIFIED BACKEND (RENDER)
// OpenAI + Supabase accounts + moderation + credits + bans
// ============================================================

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// ---------- ENV + CONSTANTS ----------

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGIN
  ? process.env.ALLOWED_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)
  : [
      "https://lmxsyntheticai.com",
      "https://www.lmxsyntheticai.com",
    ];

const FALLBACK_IMAGE_URL =
  process.env.FALLBACK_IMAGE_URL ||
  "https://lmxsyntheticai.com/media/fallback-safe.png";

const PREDATOR_FALLBACK_IMAGE_URL =
  process.env.PREDATOR_FALLBACK_IMAGE_URL ||
  "https://lmxsyntheticai.com/media/fallback-predator.png";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY is not set. Image calls will fail.");
}

// ---------- OPENAI (LAZY INIT) ----------

let openai = null;

function getOpenAI() {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

// ---------- SUPABASE CLIENT ----------

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      })
    : null;

// ---------- EXPRESS APP ----------

const app = express();

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-lmx-user-id", "x-lmx-user-email"],
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- BASIC HEALTH ----------

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "LMX Synthetic Designer Backend",
    status: "online",
  });
});

// ---------- SIMPLE RATIO MAP (OPENAI SIZES) ----------

// GPT-Image-1 supports: 1024x1024, 1024x1792 (tall), 1792x1024 (wide)
function mapRatioToSize(ratio) {
  const r = (ratio || "").trim();
  const tallSet = new Set(["4:5", "2:3", "9:16"]);
  const wideSet = new Set(["3:2", "16:9"]);

  if (tallSet.has(r)) return "1024x1792";
  if (wideSet.has(r)) return "1792x1024";
  return "1024x1024";
}

// ---------- VERY SIMPLE TEXT GUARD ----------

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

// ---------- MODERATION ----------

async function moderatePrompt(prompt) {
  try {
    const client = getOpenAI();
    const response = await client.moderations.create({
      model: "omni-moderation-latest",
      input: prompt,
    });

    const result = response?.results?.[0];
    if (!result) return { decision: "safe" };

    const cats = result.categories || {};

    if (cats["sexual/minors"]) return { decision: "block_minor" };
    if (cats.sexual) return { decision: "block_nsfw" };
    if (result.flagged) return { decision: "block_policy" };

    return { decision: "safe" };
  } catch (err) {
    console.warn("Moderation error, defaulting to policy block:", err.message);
    return { decision: "block_policy" };
  }
}

// ---------- IP BAN LIST (IN-MEMORY) ----------

const BANNED_IPS = new Set();

function getRequestIp(req) {
  return (
    req.headers["x-forwarded-for"] ||
    req.ip ||
    req.connection?.remoteAddress ||
    ""
  ).toString();
}

// ---------- SUPABASE HELPERS ----------

async function getOrCreateAccount(userId, email) {
  if (!supabase || !userId) return null;

  const { data: rows, error } = await supabase
    .from("lmx_accounts")
    .select("*")
    .eq("user_id", userId)
    .limit(1);

  if (error) {
    console.error("Supabase get account error:", error);
    return null;
  }

  let account = rows && rows[0] ? rows[0] : null;
  const today = new Date().toISOString().slice(0, 10);

  if (!account) {
    const insertPayload = {
      user_id: userId,
      email: email || null,
      plan_label: "Guest",
      daily_cap: 0, // 0 = no daily cap yet (unlimited until you set plans)
      daily_used: 0,
      tokens_balance: 0,
      last_reset_date: today,
    };

    const { data: created, error: insertErr } = await supabase
      .from("lmx_accounts")
      .insert(insertPayload)
      .select()
      .limit(1);

    if (insertErr) {
      console.error("Supabase create account error:", insertErr);
      return null;
    }

    account = created && created[0] ? created[0] : null;
  }

  if (account && account.last_reset_date !== today) {
    const { error: resetErr } = await supabase
      .from("lmx_accounts")
      .update({
        daily_used: 0,
        last_reset_date: today,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    if (resetErr) {
      console.error("Supabase daily reset error:", resetErr);
    }

    account.daily_used = 0;
    account.last_reset_date = today;
  }

  return account;
}

async function consumeCredit(account) {
  // 1 credit for anything that does anything
  if (!supabase || !account) return { ok: true, account };

  if (account.plan_label === "Banned") {
    return { ok: false, reason: "banned", account };
  }

  // If daily_cap > 0, enforce it. If 0 or null, unlimited for now.
  if (account.daily_cap && account.daily_cap > 0) {
    if (account.daily_used >= account.daily_cap) {
      return {
        ok: false,
        reason: "quota",
        remaining: 0,
        account,
      };
    }
  }

  const newUsed = (account.daily_used || 0) + 1;

  const { data, error } = await supabase
    .from("lmx_accounts")
    .update({
      daily_used: newUsed,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", account.user_id)
    .select()
    .limit(1);

  if (error) {
    console.error("Supabase consume credit error:", error);
    return { ok: true, account };
  }

  return { ok: true, account: data?.[0] || account };
}

async function banAccount(account, userId, email) {
  const now = new Date().toISOString();
  const id = userId || account?.user_id || null;

  if (!supabase || !id) return;

  try {
    const payload = {
      plan_label: "Banned",
      daily_cap: 0,
      daily_used: 0,
      tokens_balance: 0,
      updated_at: now,
    };

    await supabase
      .from("lmx_accounts")
      .update(payload)
      .eq("user_id", id);
  } catch (err) {
    console.error("Supabase ban account error:", err);
  }
}

// Helper to pull userId/email from headers/body/query
function extractUserFromRequest(req) {
  const body = req.body || {};
  const query = req.query || {};

  const userId =
    (req.headers["x-lmx-user-id"] || "").toString().trim() ||
    (body.userId || "").toString().trim() ||
    (query.userId || "").toString().trim();

  const email =
    (req.headers["x-lmx-user-email"] || "").toString().trim().toLowerCase() ||
    (body.email || "").toString().trim().toLowerCase() ||
    (query.email || "").toString().trim().toLowerCase();

  return { userId, email };
}

// ---------- STATUS ENDPOINT ----------

app.get("/lmx1/status", async (req, res) => {
  try {
    const { userId, email } = extractUserFromRequest(req);

    if (!supabase || !userId) {
      return res.json({
        mode: "guest",
        planLabel: "Guest",
        dailyCap: 0,
        dailyUsed: 0,
        creditsRemaining: null,
        tokens: 0,
        banned: false,
      });
    }

    const account = await getOrCreateAccount(userId, email);
    if (!account) {
      return res.json({
        mode: "guest",
        planLabel: "Guest",
        dailyCap: 0,
        dailyUsed: 0,
        creditsRemaining: null,
        tokens: 0,
        banned: false,
      });
    }

    const cap = account.daily_cap || 0;
    const used = account.daily_used || 0;
    const banned = account.plan_label === "Banned";

    res.json({
      mode: banned ? "banned" : "member",
      planLabel: account.plan_label || "Guest",
      dailyCap: cap,
      dailyUsed: used,
      creditsRemaining: cap ? Math.max(cap - used, 0) : null,
      tokens: account.tokens_balance || 0,
      banned,
    });
  } catch (err) {
    console.error("Status error:", err.message);
    res.status(500).json({ error: "Status failed" });
  }
});

// ---------- CORE GENERATE (DESIGNER) ----------

app.post("/lmx1/generate", async (req, res) => {
  const ip = getRequestIp(req);

  try {
    if (ip && BANNED_IPS.has(ip)) {
      return res.status(403).json({
        banned: true,
        reason: "ip_banned",
        fallbackImage: PREDATOR_FALLBACK_IMAGE_URL,
      });
    }

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
      return res.status(400).json({ error: "Missing prompt" });
    }

    // quick text sanity guard
    if (looksObviouslyBad(prompt)) {
      console.warn("⚠️ Blocked by simple filter:", prompt);
      return res.status(400).json({
        error: "unsafe_content",
        message: "Prompt blocked by LMX safety.",
      });
    }

    const { userId, email } = extractUserFromRequest(req);
    const account = await getOrCreateAccount(userId, email);

    if (account && account.plan_label === "Banned") {
      BANNED_IPS.add(ip);
      return res.status(403).json({
        banned: true,
        reason: "account_banned",
        fallbackImage: PREDATOR_FALLBACK_IMAGE_URL,
      });
    }

    // moderation pass
    const moderation = await moderatePrompt(prompt);
    if (moderation.decision === "block_minor") {
      console.warn("🚫 Predator / minors prompt detected, banning.");

      if (account || userId) {
        await banAccount(account, userId, email);
      }
      if (ip) BANNED_IPS.add(ip);

      // 1 credit for predators too (they lose it)
      if (account) {
        await consumeCredit(account);
      }

      return res.status(403).json({
        banned: true,
        reason: "predator",
        fallbackImage: PREDATOR_FALLBACK_IMAGE_URL,
      });
    }

    if (moderation.decision === "block_nsfw" || moderation.decision === "block_policy") {
      console.warn("🚫 NSFW / policy block triggered.");
      // here we do NOT consume credit (you can change later if you want)
      return res.status(200).json({
        blocked: true,
        reason: moderation.decision,
        fallbackImage: FALLBACK_IMAGE_URL,
      });
    }

    // SAFE → consume credit
    let creditsRemaining = null;
    if (account) {
      const creditResult = await consumeCredit(account);
      if (!creditResult.ok && creditResult.reason === "banned") {
        return res.status(403).json({
          banned: true,
          reason: "account_banned",
          fallbackImage: PREDATOR_FALLBACK_IMAGE_URL,
        });
      }
      if (!creditResult.ok && creditResult.reason === "quota") {
        const cap = account.daily_cap || 0;
        const used = account.daily_used || 0;
        return res.status(402).json({
          error: "quota",
          message: "Daily limit reached.",
          dailyCap: cap,
          dailyUsed: used,
          creditsRemaining: 0,
        });
      }

      const cap = creditResult.account.daily_cap || 0;
      const used = creditResult.account.daily_used || 0;
      creditsRemaining = cap ? Math.max(cap - used, 0) : null;
    }

    const size = mapRatioToSize(ratio);

    const parts = [
      style ? `Style: ${style}.` : "",
      "LMX Synthetic Designer frame.",
      `Ratio hint: ${ratio}.`,
      prompt,
    ].filter(Boolean);

    const finalPrompt = parts.join(" ");

    console.log("🖼  Generating image:", {
      size,
      ratio,
      style: style || "Auto",
      model,
      userId: userId || "guest",
    });

    const client = getOpenAI();
    const response = await client.images.generate({
      model,
      prompt: finalPrompt,
      n: 1,
      size,
    });

    if (!response?.data?.[0]?.b64_json) {
      console.error("❌ OpenAI returned no data:", response);
      return res.status(500).json({ error: "no_image_data" });
    }

    const base64 = response.data[0].b64_json;

    return res.json({
      blocked: false,
      base64,
      ratio,
      size,
      style: style || "Auto",
      model,
      creditsRemaining,
    });
  } catch (err) {
    console.error("🔥 /lmx1/generate error:", err?.response?.data || err);
    const status = err?.status || err?.response?.status || 500;
    return res.status(status).json({
      error: "server_error",
      message: err?.message || "Unexpected error in LMX backend.",
      fallbackImage: FALLBACK_IMAGE_URL,
    });
  }
});

// ---------- EDIT LAB — DESCRIBE THE CHANGE ----------
// NOTE: right now this behaves like a smart re-generation based on prompts.
// Later we can wire real image-edit flows if needed.

app.post("/lmx1/edit", async (req, res) => {
  const ip = getRequestIp(req);

  try {
    if (ip && BANNED_IPS.has(ip)) {
      return res.status(403).json({
        banned: true,
        reason: "ip_banned",
        fallbackImage: PREDATOR_FALLBACK_IMAGE_URL,
      });
    }

    const {
      originalPrompt: rawOriginalPrompt,
      describeChange: rawChange,
      chips,
      ratio: rawRatio,
      style: rawStyle,
      model: rawModel,
    } = req.body || {};

    const originalPrompt = (rawOriginalPrompt || "").trim();
    const describeChange = (rawChange || "").trim();
    const ratio = (rawRatio || "").trim() || "1:1";
    const style = (rawStyle || "").trim();
    const model = (rawModel || "").trim() || "gpt-image-1";

    if (!originalPrompt && !describeChange) {
      return res.status(400).json({
        error: "Missing edit description.",
      });
    }

    const changeText = [originalPrompt, describeChange].filter(Boolean).join(" ");
    if (looksObviouslyBad(changeText)) {
      return res.status(400).json({
        error: "unsafe_content",
        message: "Prompt blocked by LMX safety.",
      });
    }

    const { userId, email } = extractUserFromRequest(req);
    const account = await getOrCreateAccount(userId, email);

    if (account && account.plan_label === "Banned") {
      BANNED_IPS.add(ip);
      return res.status(403).json({
        banned: true,
        reason: "account_banned",
        fallbackImage: PREDATOR_FALLBACK_IMAGE_URL,
      });
    }

    const moderation = await moderatePrompt(changeText);
    if (moderation.decision === "block_minor") {
      console.warn("🚫 Predator / minors prompt (edit), banning.");

      if (account || userId) {
        await banAccount(account, userId, email);
      }
      if (ip) BANNED_IPS.add(ip);

      if (account) {
        await consumeCredit(account);
      }

      return res.status(403).json({
        banned: true,
        reason: "predator",
        fallbackImage: PREDATOR_FALLBACK_IMAGE_URL,
      });
    }

    if (moderation.decision === "block_nsfw" || moderation.decision === "block_policy") {
      console.warn("🚫 NSFW / policy block (edit).");
      return res.status(200).json({
        blocked: true,
        reason: moderation.decision,
        fallbackImage: FALLBACK_IMAGE_URL,
      });
    }

    // SAFE → consume one credit
    let creditsRemaining = null;
    if (account) {
      const creditResult = await consumeCredit(account);
      if (!creditResult.ok && creditResult.reason === "banned") {
        return res.status(403).json({
          banned: true,
          reason: "account_banned",
          fallbackImage: PREDATOR_FALLBACK_IMAGE_URL,
        });
      }
      if (!creditResult.ok && creditResult.reason === "quota") {
        const cap = account.daily_cap || 0;
        const used = account.daily_used || 0;
        return res.status(402).json({
          error: "quota",
          message: "Daily limit reached.",
          dailyCap: cap,
          dailyUsed: used,
          creditsRemaining: 0,
        });
      }

      const cap = creditResult.account.daily_cap || 0;
      const used = creditResult.account.daily_used || 0;
      creditsRemaining = cap ? Math.max(cap - used, 0) : null;
    }

    const size = mapRatioToSize(ratio);
    const chipText = Array.isArray(chips) && chips.length
      ? `Quick options: ${chips.join(", ")}.`
      : "";

    const parts = [
      style ? `Style: ${style}.` : "",
      "LMX Synthetic Designer edit of an existing frame.",
      originalPrompt ? `Original description: ${originalPrompt}.` : "",
      describeChange ? `Change requested: ${describeChange}.` : "",
      chipText,
    ].filter(Boolean);

    const finalPrompt = parts.join(" ");

    console.log("🧬 LMX Edit Lab:", {
      size,
      ratio,
      style: style || "Auto",
      model,
      userId: userId || "guest",
    });

    const client = getOpenAI();
    const response = await client.images.generate({
      model,
      prompt: finalPrompt,
      n: 1,
      size,
    });

    if (!response?.data?.[0]?.b64_json) {
      console.error("❌ OpenAI returned no data (edit):", response);
      return res.status(500).json({ error: "no_image_data" });
    }

    const base64 = response.data[0].b64_json;

    return res.json({
      blocked: false,
      base64,
      ratio,
      size,
      style: style || "Auto",
      model,
      creditsRemaining,
    });
  } catch (err) {
    console.error("🔥 /lmx1/edit error:", err?.response?.data || err);
    const status = err?.status || err?.response?.status || 500;
    return res.status(status).json({
      error: "server_error",
      message: err?.message || "Unexpected error in LMX Edit Lab.",
      fallbackImage: FALLBACK_IMAGE_URL,
    });
  }
});

// ---------- UPSCALE ENDPOINT (1 CREDIT) ----------
// For now this behaves like a "high-res" re-generation prompt.
// Later you can swap to a true image-upscale flow if needed.

app.post("/lmx1/upscale", async (req, res) => {
  const ip = getRequestIp(req);

  try {
    if (ip && BANNED_IPS.has(ip)) {
      return res.status(403).json({
        banned: true,
        reason: "ip_banned",
        fallbackImage: PREDATOR_FALLBACK_IMAGE_URL,
      });
    }

    const {
      ratio: rawRatio,
      style: rawStyle,
      model: rawModel,
      originalPrompt: rawOriginalPrompt,
    } = req.body || {};

    const ratio = (rawRatio || "").trim() || "1:1";
    const style = (rawStyle || "").trim();
    const model = (rawModel || "").trim() || "gpt-image-1";
    const originalPrompt = (rawOriginalPrompt || "").trim();

    if (!originalPrompt) {
      return res.status(400).json({
        error: "Missing original prompt for upscale.",
      });
    }

    const changeText = `Upscale request on: ${originalPrompt}`;
    if (looksObviouslyBad(changeText)) {
      return res.status(400).json({
        error: "unsafe_content",
        message: "Prompt blocked by LMX safety.",
      });
    }

    const { userId, email } = extractUserFromRequest(req);
    const account = await getOrCreateAccount(userId, email);

    if (account && account.plan_label === "Banned") {
      BANNED_IPS.add(ip);
      return res.status(403).json({
        banned: true,
        reason: "account_banned",
        fallbackImage: PREDATOR_FALLBACK_IMAGE_URL,
      });
    }

    const moderation = await moderatePrompt(changeText);
    if (moderation.decision === "block_minor") {
      console.warn("🚫 Predator / minors prompt (upscale), banning.");

      if (account || userId) {
        await banAccount(account, userId, email);
      }
      if (ip) BANNED_IPS.add(ip);

      if (account) {
        await consumeCredit(account);
      }

      return res.status(403).json({
        banned: true,
        reason: "predator",
        fallbackImage: PREDATOR_FALLBACK_IMAGE_URL,
      });
    }

    if (moderation.decision === "block_nsfw" || moderation.decision === "block_policy") {
      console.warn("🚫 NSFW / policy block (upscale).");
      return res.status(200).json({
        blocked: true,
        reason: moderation.decision,
        fallbackImage: FALLBACK_IMAGE_URL,
      });
    }

    // SAFE → consume one credit
    let creditsRemaining = null;
    if (account) {
      const creditResult = await consumeCredit(account);
      if (!creditResult.ok && creditResult.reason === "banned") {
        return res.status(403).json({
          banned: true,
          reason: "account_banned",
          fallbackImage: PREDATOR_FALLBACK_IMAGE_URL,
        });
      }
      if (!creditResult.ok && creditResult.reason === "quota") {
        const cap = account.daily_cap || 0;
        const used = account.daily_used || 0;
        return res.status(402).json({
          error: "quota",
          message: "Daily limit reached.",
          dailyCap: cap,
          dailyUsed: used,
          creditsRemaining: 0,
        });
      }

      const cap = creditResult.account.daily_cap || 0;
      const used = creditResult.account.daily_used || 0;
      creditsRemaining = cap ? Math.max(cap - used, 0) : null;
    }

    const size = mapRatioToSize(ratio);

    const parts = [
      style ? `Style: ${style}.` : "",
      "LMX Synthetic Designer upscale of an existing frame.",
      `Ratio hint: ${ratio}.`,
      `Make this look sharper, cleaner, higher fidelity, suitable for premium print or high-res usage.`,
      originalPrompt,
    ].filter(Boolean);

    const finalPrompt = parts.join(" ");

    console.log("⬆️  LMX Upscale:", {
      size,
      ratio,
      style: style || "Auto",
      model,
      userId: userId || "guest",
    });

    const client = getOpenAI();
    const response = await client.images.generate({
      model,
      prompt: finalPrompt,
      n: 1,
      size,
    });

    if (!response?.data?.[0]?.b64_json) {
      console.error("❌ OpenAI returned no data (upscale):", response);
      return res.status(500).json({ error: "no_image_data" });
    }

    const base64 = response.data[0].b64_json;

    return res.json({
      blocked: false,
      base64,
      ratio,
      size,
      style: style || "Auto",
      model,
      creditsRemaining,
    });
  } catch (err) {
    console.error("🔥 /lmx1/upscale error:", err?.response?.data || err);
    const status = err?.status || err?.response?.status || 500;
    return res.status(status).json({
      error: "server_error",
      message: err?.message || "Unexpected error in LMX Upscale.",
      fallbackImage: FALLBACK_IMAGE_URL,
    });
  }
});

// ---------- START SERVER ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LMX Synthetic Designer backend running on port ${PORT}`);
});