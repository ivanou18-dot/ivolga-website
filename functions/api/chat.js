/**
 * Ivolga Co. — AI Workshop Hardware Troubleshooter Backend
 * Cloudflare Pages Function: /api/chat  (functions/api/chat.js)
 *
 * Architecture & Safeguards:
 * 1. Dedicated Quota Columns: Reads/updates ONLY `chat_turns_used` and `chat_reset_at`
 *    on Supabase `access_passes` — never mutates `active_session_id` or `ai_credits_remaining`,
 *    so `app.ivolgaco.com` (`stamp_app.py`) sessions and CAD Vision credits stay 100% untouched.
 * 2. Master Key Bypass: Cryptographic SHA-256 constant-time check for owner admin key
 *    (plus optional `env.LICENSE_KEY`) enabling unlimited live photo testing with 0 DB writes.
 * 3. Current Gemini Interactions API (`/v1beta/interactions`, `Api-Revision: 2026-05-20`):
 *    Uses `gemini-3.8-flash` with Thinking + `google_search` grounding and server-side
 *    multi-turn chaining via `previous_interaction_id`.
 *
 * Required Cloudflare Pages Environment Variables:
 *   - GEMINI_API_KEY   : Google Gemini API key
 *   - SUPABASE_URL     : https://<project-ref>.supabase.co
 *   - SUPABASE_KEY     : Supabase service_role or API key (same as Render)
 *
 * Optional Cloudflare Pages Environment Variables:
 *   - GEMINI_MODEL         : Default "gemini-3.8-flash" (can set "gemini-4-argon")
 *   - DAYPASS_CHAT_LIMIT   : Default "20"  (turns per $8 24-Hr Craftsman Pass)
 *   - MONTHLY_CHAT_LIMIT   : Default "100" (turns per 30-day cycle on $25/mo Studio Monthly)
 *   - FREE_TRIAL_TURNS     : Default "0"   (0 = strictly TPS-XXXX-XXXX / Master Key only)
 *   - LICENSE_KEY          : Optional extra admin key
 *   - STRIPE_SECRET_KEY    : Optional fallback check if a Monthly pass `expires_at` lapsed
 */

// SHA-256 hex digest of owner master key (matches `_OWNER_KEY_HASH` in `app.py` — no plaintext in repo)
const OWNER_KEY_SHA256_HEX = "7d74a55ff1abe977e6d19033efba0565b5e98e841f1eb499d8d08b03efe65105";

// Automatically populated during Cloudflare's GitHub build step from `Settings → Builds → Variables and secrets` via `package.json`
const BUILD_ENV = /*__BUILD_ENV_START__*/{}/*__BUILD_ENV_END__*/;

function getEnvVar(env, key, fallback = "") {
  const fromRuntime = env && env[key] !== undefined && env[key] !== null ? String(env[key]).trim() : "";
  if (fromRuntime) return fromRuntime;
  const fromBuild = BUILD_ENV && BUILD_ENV[key] !== undefined && BUILD_ENV[key] !== null ? String(BUILD_ENV[key]).trim() : "";
  if (fromBuild) return fromBuild;
  return fallback;
}

const MAX_BODY_BYTES = 4_500_000; // ~4.5 MB JSON cap (client compresses photos to ~120 KB @ 1024px)
const MAX_IMAGES_PER_TURN = 3;
const MAX_TEXT_CHARS = 4000;
const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const DATACENTER_ASN_KEYWORDS = [
  "m247", "datacamp", "mullvad", "nord", "proton", "tzulo", "packethub",
  "digitalocean", "choopa", "vultr", "linode", "akamai connected cloud",
  "ovh", "hetzner", "contabo", "amazon", "amazonaws", "google cloud",
  "microsoft", "azure", "oracle", "cloudflare", "leaseweb", "cogent", "hostroyale"
];

const TROUBLESHOOTER_SYSTEM_PROMPT = `Give the best answer possible to the user's hardware failure in two or three sentences (four max only if essential) in simple everyday words, across 3D Printers, Laser Cutters, Vinyl Plotters, Clicker Dies, and CNC Routers.

DIAGNOSTIC & ANTI-GUESSING RULES:
1. Do NOT guess: If no photo was attached and the description is too vague, or if the uploaded photo is too blurry, dark, or cropped to be sure what failed, do not guess. Ask the user first for the exact photo angle or the one missing detail you need.
2. Scan the whole photo carefully before answering: Check machine parts in the corners and background (such as a white Bowden tube in a brass coupler, cooling fans, extruder type, nozzle buildup, belts, laser air assist, or slicer screen) and check where vertically the defect starts. Never mistake a solid bottom section sitting flat on the bed for a raft. If the base is flat on the bed, the middle turned into starved wispy pillars, and the top peeled up off that weak middle band, diagnose mid-print nozzle starvation (heat creep, burned or unseated Bowden tube gap, partial clog, or wrong 2.85mm filament setting in slicer), not bed warping.
3. Never repeat or mash together generic guesses: Do not repeat fixes the user already tried (or any advice visible in an uploaded screenshot), and do not combine five random textbook possibilities. Commit to the single sharpest fix, and if what they already tried should have fixed it, tell them right away what deeper mechanical check is left.
4. Use Google Search silently to verify exact machine quirks or slicer setting names when needed.
5. Only mention Pixel2Path Studio (https://app.ivolgaco.com) when the photo clearly shows a source CAD or vector geometry flaw (thin stamp walls vanishing in the slice, tiny vinyl letters lifting during weeding, missing stencil bridges, or open DXF paths). Never mention it on mechanical or thermal failures.

STRICT CASUAL HUMAN STYLE (CRITICAL):
- Write like an experienced, casual maker on Reddit helping another maker at the workbench.
- Jump straight into the physical fix in the very first sentence without repeating the user's question and without any greeting or intro.
- Mention specific visual details from their photo (colors, parts, and positions like "top left of your photo" or "the middle of that pink print") so they know you actually inspected it.
- NEVER use bold text, bullet points, numbered lists, headings, code blocks, or dashes of any kind (use plain commas and periods instead).`;

function cleanHumanReply(rawText) {
  return String(rawText || "")
    .replace(/^\s*---+\s*$/gm, "")
    .replace(/^\s*#{1,6}\s+.*$/gm, "")
    .replace(/\*\*(?:Plain-English Cause|Ranked Action Steps|One quick question|Quick question|The Fix|Root Cause)\s*:?\*\*\s*/gi, "")
    .replace(/^(?:Plain-English Cause|Ranked Action Steps|One quick question|Quick question|The Fix|Root Cause)\s*:\s*/gim, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`\n]{1,60})`/g, "$1")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\n{2,}/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

function jsonResponse(payload, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders
    }
  });
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function isMasterAdminKey(rawKey, env) {
  if (!rawKey || typeof rawKey !== "string") return false;
  const upper = rawKey.trim().toUpperCase();
  if (!upper) return false;

  const envLicense = getEnvVar(env, "LICENSE_KEY").toUpperCase();
  if (envLicense && timingSafeEqualStr(upper, envLicense)) {
    return true;
  }

  const hashHex = await sha256Hex(upper);
  return timingSafeEqualStr(hashHex, OWNER_KEY_SHA256_HEX);
}

function isValidTpsFormat(rawKey) {
  if (!rawKey || typeof rawKey !== "string") return false;
  const upper = rawKey.trim().toUpperCase();
  return upper.startsWith("TPS-") && upper.length >= 8 && upper.length <= 36 && /^[A-Z0-9-]+$/.test(upper);
}

function sbHeaders(supabaseKey, prefer = "return=representation") {
  return {
    "apikey": supabaseKey,
    "Authorization": `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
    "Prefer": prefer
  };
}

async function checkStripeSubscriptionActive(subId, stripeSecretKey) {
  if (!subId || !stripeSecretKey) return false;
  try {
    const resp = await fetch(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subId)}`,
      {
        method: "GET",
        headers: { "Authorization": `Bearer ${stripeSecretKey}` }
      }
    );
    if (!resp.ok) return false;
    const data = await resp.json();
    return data && data.status === "active";
  } catch {
    return false;
  }
}

async function patchChatQuotaFields(supabaseUrl, supabaseKey, upperKey, fieldsObj) {
  const url = `${supabaseUrl}/rest/v1/access_passes?passcode=eq.${encodeURIComponent(upperKey)}`;
  const resp = await fetch(url, {
    method: "PATCH",
    headers: sbHeaders(supabaseKey, "return=minimal"),
    body: JSON.stringify(fieldsObj)
  });
  return resp.ok;
}

/**
 * Verifies a customer `TPS-XXXX-XXXX` key against Supabase `access_passes`
 * WITHOUT reading or mutating `active_session_id` or `ai_credits_remaining`.
 */
async function verifyTpsPasscode(rawKey, env) {
  const supabaseUrl = getEnvVar(env, "SUPABASE_URL", "https://mwcqgoasmqjtgofernpn.supabase.co").replace(/\/+$/, "");
  const supabaseKey = getEnvVar(env, "SUPABASE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    return {
      ok: false,
      status: 500,
      error: "⚙️ Missing SUPABASE_KEY in Cloudflare Settings! Add SUPABASE_KEY under Settings → Builds → Variables and secrets, then click Save and trigger a New Deployment."
    };
  }

  const upperKey = rawKey.trim().toUpperCase();
  const selectCols = "passcode,plan_type,expires_at,stripe_sub_id,chat_turns_used,chat_reset_at,last_reset_at";
  const queryUrl = `${supabaseUrl}/rest/v1/access_passes?passcode=eq.${encodeURIComponent(upperKey)}&select=${selectCols}`;

  const resp = await fetch(queryUrl, {
    method: "GET",
    headers: sbHeaders(supabaseKey)
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    if (errTxt.includes("chat_turns_used")) {
      return {
        ok: false,
        status: 500,
        error: "Database migration pending: run supabase_troubleshooter_migration.sql in Supabase SQL Editor to add chat_turns_used."
      };
    }
    return { ok: false, status: 502, error: "Unable to reach pass database. Please try again in a moment." };
  }

  const rows = await resp.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ok: false,
      status: 401,
      error: "❌ Invalid Access Key. Double-check for typos (format: TPS-XXXX-XXXX) or grab a pass below."
    };
  }

  const row = rows[0];
  const planLabel = String(row.plan_type || "Active Studio Pass");
  const isMonthly = planLabel.toLowerCase().includes("month");
  const daypassLimit = Math.max(1, parseInt(getEnvVar(env, "DAYPASS_CHAT_LIMIT", "20"), 10) || 20);
  const monthlyLimit = Math.max(1, parseInt(getEnvVar(env, "MONTHLY_CHAT_LIMIT", "100"), 10) || 100);
  const turnsLimit = isMonthly ? monthlyLimit : daypassLimit;

  const nowMs = Date.now();
  const expMs = row.expires_at ? Date.parse(String(row.expires_at)) : NaN;

  if (!Number.isNaN(expMs) && nowMs > expMs) {
    // Optional seamless check if STRIPE_SECRET_KEY is configured in Cloudflare for Monthly subscribers
    const subId = String(row.stripe_sub_id || "").trim();
    const stripeKey = getEnvVar(env, "STRIPE_SECRET_KEY");
    const stillActiveSub = isMonthly && subId && stripeKey
      ? await checkStripeSubscriptionActive(subId, stripeKey)
      : false;

    if (!stillActiveSub) {
      return {
        ok: false,
        status: 403,
        error: isMonthly
          ? "⏰ This Studio Monthly Pass needs renewal (or open app.ivolgaco.com once with your key to auto-sync an active Stripe renewal)."
          : "⏰ This 24-Hr Craftsman Pass has expired. Grab a fresh $8 24-Hr Pass or $25/mo Studio Monthly Pass below."
      };
    }
  }

  let turnsUsed = Math.max(0, parseInt(row.chat_turns_used ?? 0, 10) || 0);
  const resetAnchorStr = row.chat_reset_at || row.last_reset_at || "";
  const resetAnchorMs = resetAnchorStr ? Date.parse(String(resetAnchorStr)) : NaN;

  // Automatic 30-day Troubleshooter quota renewal for Studio Monthly subscribers
  if (isMonthly && (Number.isNaN(resetAnchorMs) || nowMs - resetAnchorMs >= THIRTY_DAYS_MS)) {
    const nowIso = new Date(nowMs).toISOString();
    await patchChatQuotaFields(supabaseUrl, supabaseKey, upperKey, {
      chat_turns_used: 0,
      chat_reset_at: nowIso
    }).catch(() => {});
    turnsUsed = 0;
  }

  return {
    ok: true,
    valid: true,
    is_master: false,
    unlimited: false,
    passcode: upperKey,
    plan_label: planLabel,
    is_monthly: isMonthly,
    expires_at: row.expires_at || null,
    turns_used: turnsUsed,
    turns_limit: turnsLimit,
    turns_remaining: Math.max(0, turnsLimit - turnsUsed),
    supabase_url: supabaseUrl,
    supabase_key: supabaseKey
  };
}

function isLikelyDatacenterOrVpn(request) {
  const org = String(request.cf?.asOrganization || "").toLowerCase();
  if (!org) return false;
  return DATACENTER_ASN_KEYWORDS.some((kw) => org.includes(kw));
}

function extractInteractionReply(apiData) {
  let replyText = "";
  const citations = [];
  const seenUrls = new Set();

  if (Array.isArray(apiData?.steps)) {
    const modelChunks = [];
    for (const step of apiData.steps) {
      if (step?.type === "model_output" && Array.isArray(step.content)) {
        for (const block of step.content) {
          if (block?.type === "text" && typeof block.text === "string") {
            modelChunks.push(block.text);
          }
          if (Array.isArray(block?.annotations)) {
            for (const ann of block.annotations) {
              if (ann?.type === "url_citation" && ann.url && !seenUrls.has(ann.url)) {
                seenUrls.add(ann.url);
                citations.push({
                  title: String(ann.title || "Reference").slice(0, 80),
                  url: String(ann.url)
                });
              }
            }
          }
        }
      }
    }
    if (modelChunks.length > 0) {
      replyText = modelChunks.join("\n\n").trim();
    }
  }

  if (!replyText && typeof apiData?.output_text === "string") {
    replyText = apiData.output_text.trim();
  }

  if (!replyText && Array.isArray(apiData?.outputs)) {
    const legacyChunks = apiData.outputs
      .filter((o) => o?.type === "text" && typeof o.text === "string")
      .map((o) => o.text);
    replyText = legacyChunks.join("\n\n").trim();
  }

  return {
    interactionId: apiData?.id || null,
    replyText,
    citations: citations.slice(0, 4)
  };
}

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(context.request)
  });
}

export async function onRequestGet(context) {
  const env = context.env || {};
  const hasGeminiKey = Boolean(getEnvVar(env, "GEMINI_API_KEY") || getEnvVar(env, "GOOGLE_API_KEY"));
  const hasSupabaseUrl = Boolean(getEnvVar(env, "SUPABASE_URL", "https://mwcqgoasmqjtgofernpn.supabase.co"));
  const hasSupabaseKey = Boolean(getEnvVar(env, "SUPABASE_KEY"));

  return jsonResponse(
    {
      ok: true,
      endpoint: "/api/chat",
      status: hasGeminiKey ? "ready" : "missing_gemini_key",
      runtime_secrets_configured: {
        GEMINI_API_KEY: hasGeminiKey,
        SUPABASE_URL: hasSupabaseUrl,
        SUPABASE_KEY: hasSupabaseKey
      },
      how_to_fix_if_false: hasGeminiKey
        ? "All set! Open https://ivolgaco.com/troubleshooter.html to run live photo diagnostics."
        : "Upload package.json, wrangler.jsonc, troubleshooter.html, and functions/api/chat.js to GitHub, and make sure GEMINI_API_KEY is saved under Cloudflare Settings → Builds → Variables and secrets."
    },
    200,
    getCorsHeaders(context.request)
  );
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const corsHeaders = getCorsHeaders(request);

  try {
    const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
    if (contentLength > MAX_BODY_BYTES) {
      return jsonResponse(
        { ok: false, error: "Upload payload too large. Please attach up to 3 compressed photos." },
        413,
        corsHeaders
      );
    }

    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return jsonResponse(
        { ok: false, error: "Upload payload too large. Please attach up to 3 compressed photos." },
        413,
        corsHeaders
      );
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400, corsHeaders);
    }

    const action = String(body.action || "chat").trim().toLowerCase();
    const rawPasscode = String(body.passcode || "").trim();

    // =========================================================================
    // ACTION 1: READ-ONLY PASSCODE VERIFICATION (`action: "verify"`)
    // =========================================================================
    if (action === "verify") {
      if (!rawPasscode) {
        return jsonResponse({ ok: false, error: "Please enter your TPS-XXXX-XXXX Access Key." }, 400, corsHeaders);
      }

      if (await isMasterAdminKey(rawPasscode, env)) {
        return jsonResponse(
          {
            ok: true,
            valid: true,
            is_master: true,
            unlimited: true,
            plan_label: "Studio Master Key",
            expires_at: null,
            turns_used: 0,
            turns_limit: null,
            turns_remaining: null
          },
          200,
          corsHeaders
        );
      }

      if (!isValidTpsFormat(rawPasscode)) {
        return jsonResponse(
          { ok: false, error: "❌ Invalid Access Key format. Customer keys start with TPS-XXXX-XXXX." },
          401,
          corsHeaders
        );
      }

      const verified = await verifyTpsPasscode(rawPasscode, env);
      if (!verified.ok) {
        return jsonResponse({ ok: false, error: verified.error }, verified.status || 401, corsHeaders);
      }

      return jsonResponse(
        {
          ok: true,
          valid: true,
          is_master: false,
          unlimited: false,
          plan_label: verified.plan_label,
          is_monthly: verified.is_monthly,
          expires_at: verified.expires_at,
          turns_used: verified.turns_used,
          turns_limit: verified.turns_limit,
          turns_remaining: verified.turns_remaining
        },
        200,
        corsHeaders
      );
    }

    // =========================================================================
    // ACTION 2: MULTIMODAL HARDWARE TROUBLESHOOTING TURN (`action: "chat"`)
    // =========================================================================
    const geminiApiKey = getEnvVar(env, "GEMINI_API_KEY") || getEnvVar(env, "GOOGLE_API_KEY");
    if (!geminiApiKey) {
      return jsonResponse(
        {
          ok: false,
          error: "⚙️ Missing GEMINI_API_KEY! Make sure package.json is uploaded to the root of your GitHub repo and GEMINI_API_KEY is saved under Cloudflare Settings → Builds → Variables and secrets."
        },
        500,
        corsHeaders
      );
    }

    // 1. Validate Access Key & Quota Before Calling Gemini
    let isMaster = false;
    let tpsRecord = null;

    if (rawPasscode) {
      if (await isMasterAdminKey(rawPasscode, env)) {
        isMaster = true;
      } else if (isValidTpsFormat(rawPasscode)) {
        const check = await verifyTpsPasscode(rawPasscode, env);
        if (!check.ok) {
          return jsonResponse({ ok: false, requires_pass: true, error: check.error }, check.status || 401, corsHeaders);
        }
        if (check.turns_remaining <= 0) {
          const limitMsg = check.is_monthly
            ? `⚠️ You have used all ${check.turns_limit} monthly Troubleshooter turns for this billing cycle.`
            : `⚠️ You have used all ${check.turns_limit} Troubleshooter turns on this 24-Hr Pass. Upgrade to Studio Monthly ($25/mo) for ${getEnvVar(env, "MONTHLY_CHAT_LIMIT", "100")} turns/month + Unlimited CAD Vault!`;
          return jsonResponse(
            {
              ok: false,
              quota_exhausted: true,
              turns_used: check.turns_used,
              turns_limit: check.turns_limit,
              turns_remaining: 0,
              error: limitMsg
            },
            429,
            corsHeaders
          );
        }
        tpsRecord = check;
      } else {
        return jsonResponse(
          { ok: false, requires_pass: true, error: "❌ Invalid Access Key. Enter a valid TPS-XXXX-XXXX key or purchase a pass below." },
          401,
          corsHeaders
        );
      }
    } else {
      const freeTrialTurns = Math.max(0, parseInt(getEnvVar(env, "FREE_TRIAL_TURNS", "0"), 10) || 0);
      if (freeTrialTurns <= 0) {
        return jsonResponse(
          {
            ok: false,
            requires_pass: true,
            error: "🔒 Enter your active TPS-XXXX-XXXX Studio Access Key to upload photos and run live hardware diagnostics."
          },
          401,
          corsHeaders
        );
      }
      if (isLikelyDatacenterOrVpn(request)) {
        return jsonResponse(
          {
            ok: false,
            requires_pass: true,
            error: "🛡️ VPN or datacenter network detected. Disable VPN to use a free sample, or unlock immediately with your TPS-XXXX-XXXX Access Key."
          },
          403,
          corsHeaders
        );
      }
    }

    // 2. Validate & Assemble Multimodal Input Blocks
    const userMessage = String(body.message || "").trim().slice(0, MAX_TEXT_CHARS);
    const machineCategory = String(body.machine || "").trim().slice(0, 80);
    const setupDetails = String(body.setup || "").trim().slice(0, 220);
    const previousInteractionId = String(body.previous_interaction_id || "").trim();
    const rawHistory = Array.isArray(body.history) ? body.history.slice(-8) : [];
    const rawImages = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES_PER_TURN) : [];

    if (!userMessage && rawImages.length === 0) {
      return jsonResponse(
        { ok: false, error: "Please describe the hardware issue or attach at least 1 photo." },
        400,
        corsHeaders
      );
    }

    const contextHeaderParts = [];
    if (machineCategory && !previousInteractionId && rawHistory.length === 0) {
      contextHeaderParts.push(`Workshop Machine Category: ${machineCategory}`);
    }
    if (setupDetails && !previousInteractionId && rawHistory.length === 0) {
      contextHeaderParts.push(`Hardware / Slicer / Material Setup: ${setupDetails}`);
    }

    const composedPrompt = [
      ...contextHeaderParts,
      userMessage || "Inspect the attached photo(s), identify what went wrong, and tell me how to fix it in simple words."
    ].join("\n");

    const contentBlocks = [{ type: "text", text: composedPrompt }];
    const normalizedImages = [];

    for (const img of rawImages) {
      if (!img || typeof img.data !== "string") continue;
      const mimeType = String(img.mime_type || "image/jpeg").trim().toLowerCase();
      if (!ALLOWED_IMAGE_MIMES.has(mimeType)) {
        return jsonResponse(
          { ok: false, error: `Unsupported image type (${mimeType}). Use JPG, PNG, or WEBP.` },
          400,
          corsHeaders
        );
      }
      const cleanBase64 = img.data.includes(",") ? img.data.split(",")[1].trim() : img.data.trim();
      if (cleanBase64) {
        normalizedImages.push({ data: cleanBase64, mimeType });
        contentBlocks.push({
          type: "image",
          data: cleanBase64,
          mime_type: mimeType
        });
      }
    }

    // 3. Call Gemini API
    // Fast-path `:generateContent?key=...` (`gemini-2.5-flash` / `gemini-2.0-flash`, matching `app.py` line 4179 for `AQ.Ab8RN...` keys)
    let interactionId = null;
    let replyText = "";
    let citations = [];
    let lastApiErrStatus = 0;
    let lastApiErrSnippet = "";

    const historyContents = [];
    for (const h of rawHistory) {
      if (!h || typeof h.text !== "string" || !h.text.trim()) continue;
      historyContents.push({
        role: h.role === "model" ? "model" : "user",
        parts: [{ text: h.text.trim().slice(0, MAX_TEXT_CHARS) }]
      });
    }

    const currentParts = [{ text: composedPrompt }];
    for (const img of normalizedImages) {
      currentParts.push({
        inlineData: {
          mimeType: img.mimeType,
          data: img.data
        }
      });
    }
    historyContents.push({ role: "user", parts: currentParts });

    const preferredModel = getEnvVar(env, "GEMINI_MODEL", "gemini-2.5-pro");
    const generateContentAttempts = [
      { model: preferredModel, useSearch: true },
      { model: "gemini-2.5-flash", useSearch: true },
      { model: "gemini-2.5-flash", useSearch: false }
    ];

    for (const attempt of generateContentAttempts) {
      try {
        const gcPayload = {
          systemInstruction: { parts: [{ text: TROUBLESHOOTER_SYSTEM_PROMPT }] },
          contents: historyContents,
          generationConfig: {
            maxOutputTokens: 8192
          }
        };
        if (attempt.useSearch) {
          gcPayload.tools = [{ google_search: {} }];
        }

        const gcUrl = `https://generativelanguage.googleapis.com/v1beta/models/${attempt.model}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
        const gcResp = await fetch(gcUrl, {
          method: "POST",
          headers: {
            "x-goog-api-key": geminiApiKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(gcPayload)
        });

        if (!gcResp.ok) {
          lastApiErrStatus = gcResp.status;
          lastApiErrSnippet = (await gcResp.text().catch(() => "")).slice(0, 240);
          continue;
        }

        const gcData = await gcResp.json();
        const cand = gcData?.candidates?.[0];
        const textParts = (cand?.content?.parts || [])
          .filter((p) => !p?.thought && typeof p?.text === "string" && p.text.trim())
          .map((p) => p.text);

        if (textParts.length > 0) {
          replyText = cleanHumanReply(textParts.join("\n\n"));
          const groundingChunks = cand?.groundingMetadata?.groundingChunks || [];
          const seen = new Set();
          for (const ch of groundingChunks) {
            const webUrl = ch?.web?.uri;
            const webTitle = ch?.web?.title;
            if (webUrl && !seen.has(webUrl)) {
              seen.add(webUrl);
              citations.push({
                title: String(webTitle || "Reference").slice(0, 80),
                url: String(webUrl)
              });
            }
          }
          citations = citations.slice(0, 4);
          break;
        }
      } catch (e) {
        lastApiErrSnippet = String(e?.message || e);
      }
    }

    // Secondary attempt via `/v1beta/interactions` if needed
    if (!replyText) {
      const primaryModel = getEnvVar(env, "GEMINI_MODEL", "gemini-3.8-flash");
      const interactionPayload = {
        model: primaryModel,
        system_instruction: TROUBLESHOOTER_SYSTEM_PROMPT,
        tools: [{ type: "google_search" }],
        generation_config: {
          max_output_tokens: 4096
        },
        input: contentBlocks
      };

      if (previousInteractionId && /^[a-zA-Z0-9._:-]{6,200}$/.test(previousInteractionId)) {
        interactionPayload.previous_interaction_id = previousInteractionId;
      }

      try {
        const geminiResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/interactions?key=${encodeURIComponent(geminiApiKey)}`, {
          method: "POST",
          headers: {
            "x-goog-api-key": geminiApiKey,
            "Content-Type": "application/json",
            "Api-Revision": "2026-05-20"
          },
          body: JSON.stringify(interactionPayload)
        });

        if (geminiResp.ok) {
          const geminiData = await geminiResp.json();
          const extracted = extractInteractionReply(geminiData);
          interactionId = extracted.interactionId;
          replyText = cleanHumanReply(extracted.replyText);
          citations = extracted.citations;
        } else if (!lastApiErrStatus) {
          lastApiErrStatus = geminiResp.status;
          lastApiErrSnippet = (await geminiResp.text().catch(() => "")).slice(0, 240);
        }
      } catch (e) {
        if (!lastApiErrSnippet) lastApiErrSnippet = String(e?.message || e);
      }
    }

    if (!replyText) {
      let friendlyErr = "⚠️ AI diagnostic service returned an error. Your turn was NOT deducted.";
      if (lastApiErrStatus === 400 && lastApiErrSnippet.toLowerCase().includes("api_key_invalid")) {
        friendlyErr = "⚠️ Invalid GEMINI_API_KEY in Cloudflare Settings. Please verify the key and redeploy.";
      } else if (lastApiErrStatus === 429) {
        friendlyErr = "⏳ Gemini API rate limit reached on your API key. Wait 30 seconds and try again (turn NOT deducted).";
      } else if (lastApiErrStatus) {
        friendlyErr = `⚠️ Gemini API HTTP ${lastApiErrStatus}: ${lastApiErrSnippet.slice(0, 140)} (turn NOT deducted).`;
      }
      return jsonResponse(
        {
          ok: false,
          error: friendlyErr
        },
        502,
        corsHeaders
      );
    }

    // 4. Increment `chat_turns_used` ONLY After Successful Diagnosis (Master Key = 0 DB Writes)
    let updatedTurnsUsed = 0;
    let turnsLimit = null;
    let turnsRemaining = null;

    if (!isMaster && tpsRecord) {
      updatedTurnsUsed = tpsRecord.turns_used + 1;
      turnsLimit = tpsRecord.turns_limit;
      turnsRemaining = Math.max(0, turnsLimit - updatedTurnsUsed);

      await patchChatQuotaFields(
        tpsRecord.supabase_url,
        tpsRecord.supabase_key,
        tpsRecord.passcode,
        { chat_turns_used: updatedTurnsUsed }
      ).catch((err) => {
        console.error("Supabase chat_turns_used increment warning:", err);
      });
    }

    return jsonResponse(
      {
        ok: true,
        reply: replyText,
        interaction_id: interactionId,
        citations,
        is_master: isMaster,
        turns_used: updatedTurnsUsed,
        turns_limit: turnsLimit,
        turns_remaining: turnsRemaining
      },
      200,
      corsHeaders
    );
  } catch (err) {
    console.error("Troubleshooter /api/chat unhandled error:", err);
    return jsonResponse(
      { ok: false, error: "Unexpected server error while processing diagnosis. Please try again." },
      500,
      corsHeaders
    );
  }
}

/**
 * Standard Cloudflare Workers Entry Point (`wrangler.jsonc` -> `"main": "functions/api/chat.js"`)
 * Works with Cloudflare Workers Static Assets (`ivolga-website` Worker) as well as Cloudflare Pages.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cleanPath = url.pathname.replace(/\/+$/, "") || "/";

    if (cleanPath === "/api/chat") {
      const context = { request, env, ctx };
      if (request.method === "OPTIONS") {
        return onRequestOptions(context);
      }
      if (request.method === "POST") {
        return onRequestPost(context);
      }
      return onRequestGet(context);
    }

    // Block public access to config or backend source files even if .assetsignore is omitted
    const lowerPath = cleanPath.toLowerCase();
    if (
      lowerPath.startsWith("/functions/") ||
      lowerPath === "/wrangler.jsonc" ||
      lowerPath === "/package.json" ||
      lowerPath.endsWith(".sql")
    ) {
      return new Response("Not Found", { status: 404 });
    }

    // Serve static files via Cloudflare Workers Static Assets binding if request ever reaches Worker
    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};

