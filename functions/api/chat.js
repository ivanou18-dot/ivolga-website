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

const TROUBLESHOOTER_SYSTEM_PROMPT = `You are the Senior Workshop Hardware Troubleshooter for Ivolga Co. (makers of Pixel2Path Studio & CAD Vault at ivolgaco.com).
You diagnose real-world fabrication failures across 5 workshop categories:
1. 3D Printers (FDM & Resin — Bambu Studio, OrcaSlicer, PrusaSlicer, UltiMaker Cura, Pikaslice, Klipper/Marlin)
2. Laser Engravers & Cutters (Diode, CO2, Fiber — LightBurn, xTool Creative Space, Glowforge)
3. Vinyl Cutting Plotters (Cricut Design Space, Silhouette Studio, Graphtec, Roland)
4. Steel-Rule Clicker Dies & Leather Presses (die-board kerf, press tonnage, corner tear-out, stitch holes)
5. CNC Routers & Brass Stamp Dies (Vectric VCarve/Aspire, Fusion 360, V-bit stepover, Z-zero, feeds & speeds)

RESEARCH & DIAGNOSTIC RULES:
- Inspect every uploaded photo carefully (layer lines, seam scars, holes, nozzle/extruder hardware, burn kerf, blade drag, or CAD preview).
- Use Google Search to verify exact slicer setting names, printer-specific quirks, extruder types (Bowden vs. Direct Drive), and mobile/niche app defaults (for example, checking whether an app like Pikaslice defaults to 2.85mm filament instead of 1.75mm).
- NEVER repeat fixes the user says they already tried (e.g., if they already did a cold pull or tested multiple spools, skip those and move straight to deeper mechanical, thermal/heat-creep, nozzle wear, or slicer-mismatch causes).

STRICT "SIMPLE WORDS" OUTPUT FORMAT:
1. Plain-English Cause (1 to 2 short sentences at the top): Explain what is physically happening in simple everyday words (for example: "Your printer is suddenly starving for plastic mid-print" or "Tiny steam bubbles from damp filament are popping inside the hot nozzle"). Avoid unexplained jargon.
2. Ranked Action Steps (2 to 4 bullet points, most likely fix first):
   Format every bullet as:
   - **Short Action Title:** Simple instruction with exact numbers/settings to try (e.g., \`0.2 mm to 0.4 mm\` Z-hop, \`15%–25%\` Infill/Perimeter Overlap, \`0.5 mm to 1.5 mm\` Direct-Drive retraction, \`50°C\` for \`4–6 hours\`).
3. Keep It Short & Scannable: No long essays, no robotic filler greetings, and no safety boilerplate unless there is a genuine burn/fire/mechanical hazard.
4. At Most 1 Clarifying Question: Only ask ONE short question at the very end if a missing detail (like which slicer app or printer model they use) would change the fix.
5. Smart Geometry Cross-Check (ONLY when caused by source file geometry): Mention Pixel2Path Studio (https://app.ivolgaco.com) or the Official User Guide (https://ivolgaco.com/guide.html) ONLY when the visible defect comes from sub-spec artwork/CAD geometry (such as 3D stamp walls thinner than 0.45mm vanishing in the slicer, small vinyl letters under 0.75mm lifting during weeding, missing 1.6mm stencil holding bridges, open DXF paths, or unmirrored stamp text). Do NOT pitch software when the problem is purely mechanical or slicer-related.`;

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  let allowOrigin = "https://ivolgaco.com";
  if (
    origin === "https://ivolgaco.com" ||
    origin === "https://www.ivolgaco.com" ||
    /^https:\/\/[a-z0-9-]+\.ivolga-website\.pages\.dev$/i.test(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
  ) {
    allowOrigin = origin;
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
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

  const envLicense = String(env.LICENSE_KEY || "").trim().toUpperCase();
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
  const supabaseUrl = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const supabaseKey = String(env.SUPABASE_KEY || "").trim();
  if (!supabaseUrl || !supabaseKey) {
    return {
      ok: false,
      status: 500,
      error: "Server configuration missing SUPABASE_URL or SUPABASE_KEY in Cloudflare Pages settings."
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
  const daypassLimit = Math.max(1, parseInt(env.DAYPASS_CHAT_LIMIT || "20", 10) || 20);
  const monthlyLimit = Math.max(1, parseInt(env.MONTHLY_CHAT_LIMIT || "100", 10) || 100);
  const turnsLimit = isMonthly ? monthlyLimit : daypassLimit;

  const nowMs = Date.now();
  const expMs = row.expires_at ? Date.parse(String(row.expires_at)) : NaN;

  if (!Number.isNaN(expMs) && nowMs > expMs) {
    // Optional seamless check if STRIPE_SECRET_KEY is configured in Cloudflare for Monthly subscribers
    const subId = String(row.stripe_sub_id || "").trim();
    const stripeKey = String(env.STRIPE_SECRET_KEY || "").trim();
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
  return jsonResponse(
    { ok: false, error: "Method Not Allowed. Send POST requests from ivolgaco.com/troubleshooter.html." },
    405,
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
    const geminiApiKey = String(env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "").trim();
    if (!geminiApiKey) {
      return jsonResponse(
        { ok: false, error: "Server missing GEMINI_API_KEY in Cloudflare Pages environment variables." },
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
            : `⚠️ You have used all ${check.turns_limit} Troubleshooter turns on this 24-Hr Pass. Upgrade to Studio Monthly ($25/mo) for ${env.MONTHLY_CHAT_LIMIT || 100} turns/month + Unlimited CAD Vault!`;
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
      const freeTrialTurns = Math.max(0, parseInt(env.FREE_TRIAL_TURNS || "0", 10) || 0);
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
    const rawImages = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES_PER_TURN) : [];

    if (!userMessage && rawImages.length === 0) {
      return jsonResponse(
        { ok: false, error: "Please describe the hardware issue or attach at least 1 photo." },
        400,
        corsHeaders
      );
    }

    const contextHeaderParts = [];
    if (machineCategory && !previousInteractionId) {
      contextHeaderParts.push(`Workshop Machine Category: ${machineCategory}`);
    }
    if (setupDetails && !previousInteractionId) {
      contextHeaderParts.push(`Hardware / Slicer / Material Setup: ${setupDetails}`);
    }

    const composedPrompt = [
      ...contextHeaderParts,
      userMessage || "Inspect the attached photo(s), identify what went wrong, and tell me how to fix it in simple words."
    ].join("\n");

    const contentBlocks = [{ type: "text", text: composedPrompt }];

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
        contentBlocks.push({
          type: "image",
          data: cleanBase64,
          mime_type: mimeType
        });
      }
    }

    // 3. Call Current Gemini Interactions API (`gemini-3.8-flash` + `google_search` grounding)
    const modelName = String(env.GEMINI_MODEL || "gemini-3.8-flash").trim();
    const interactionPayload = {
      model: modelName,
      system_instruction: TROUBLESHOOTER_SYSTEM_PROMPT,
      tools: [{ type: "google_search" }],
      generation_config: {
        max_output_tokens: 1100
      },
      input: contentBlocks
    };

    if (previousInteractionId && /^[a-zA-Z0-9._:-]{6,200}$/.test(previousInteractionId)) {
      interactionPayload.previous_interaction_id = previousInteractionId;
    }

    const geminiResp = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: {
        "x-goog-api-key": geminiApiKey,
        "Content-Type": "application/json",
        "Api-Revision": "2026-05-20"
      },
      body: JSON.stringify(interactionPayload)
    });

    if (!geminiResp.ok) {
      const errBody = await geminiResp.text().catch(() => "");
      console.error("Gemini Interactions API error:", geminiResp.status, errBody.slice(0, 400));
      return jsonResponse(
        {
          ok: false,
          error: "⚠️ AI diagnostic service encountered a temporary upstream error. Your turn was NOT deducted—please try again."
        },
        502,
        corsHeaders
      );
    }

    const geminiData = await geminiResp.json();
    const { interactionId, replyText, citations } = extractInteractionReply(geminiData);

    if (!replyText) {
      return jsonResponse(
        {
          ok: false,
          error: "⚠️ Could not read a clear answer for that input. Your turn was NOT deducted—try adding a brief description or clearer photo."
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
