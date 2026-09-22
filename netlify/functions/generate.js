// Deployed at /.netlify/functions/generate, reachable as /api/generate
// via the redirect in netlify.toml.
//
// Body: { messages: [...], mcp_servers?: [...], max_tokens?: number, tool?: string }
// Header: Authorization: Bearer <the user's Supabase access token>
//
// This is the piece that makes the frontend safe: the Anthropic key never
// touches the browser, and every call is checked against that user's
// monthly limit before it's allowed to run.

const { createClient } = require("@supabase/supabase-js");

// service_role key, backend-only, never expose this to the frontend
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Fix #3/#4: when Anthropic is momentarily rate-limited (a busy moment with
// many users generating at once), retry with backoff instead of failing
// every request outright. Only retries on 429; any other error returns
// immediately since retrying won't help.
async function callAnthropicWithBackoff(payload, tries = 3) {
  const delays = [0, 500, 1500]; // ms before each attempt
  let res;
  for (let i = 0; i < tries; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i] + Math.random() * 200));
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
    if (res.status !== 429) return res;
  }
  return res; // out of retries, hand back the last 429 so the user sees a real reason
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // 0. Maintenance switch: refuse cleanly if we're mid-repair, before anything else.
  const { data: settings } = await supabaseAdmin
    .from("system_settings")
    .select("maintenance_mode, maintenance_message")
    .eq("id", 1)
    .single();
  if (settings && settings.maintenance_mode) {
    return {
      statusCode: 503,
      body: JSON.stringify({ maintenance: true, error: settings.maintenance_message }),
    };
  }

  // 1. Identify the user from their Supabase session token.
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: "Not signed in" }) };
  }
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: "Invalid session" }) };
  }
  const userId = userData.user.id;

  // 2. Check this user's quota before spending any money on their behalf.
  const { data: usage, error: usageErr } = await supabaseAdmin
    .from("usage_limits")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (usageErr || !usage) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: "No usage record found for this account" }),
    };
  }

  // Reset the counter if we've rolled into a new month.
  const now = new Date();
  const periodStart = new Date(usage.period_start);
  const isNewMonth =
    now.getUTCFullYear() !== periodStart.getUTCFullYear() ||
    now.getUTCMonth() !== periodStart.getUTCMonth();
  const usedSoFar = isNewMonth ? 0 : usage.used_this_month;

  if (usedSoFar >= usage.monthly_limit) {
    return {
      statusCode: 429,
      body: JSON.stringify({
        error: "Monthly limit reached for your plan. Upgrade or wait for the next cycle.",
      }),
    };
  }

  // 3. Do the actual work: call Anthropic with the server-side key.
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad request body" }) };
  }

  const model = body.model || "claude-sonnet-4-6";
  const max_tokens = body.max_tokens || 1000;

  let anthropicRes;
  try {
    anthropicRes = await callAnthropicWithBackoff({
      model,
      max_tokens,
      messages: body.messages,
      ...(body.tools ? { tools: body.tools } : {}),
      ...(body.mcp_servers ? { mcp_servers: body.mcp_servers } : {}),
    });
  } catch (e) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "Could not reach Anthropic: " + e.message }),
    };
  }

  const data = await anthropicRes.json();

  if (!anthropicRes.ok) {
    // Pass the real reason back so the frontend can show it honestly,
    // same pattern as the in-chat tools already do.
    return {
      statusCode: anthropicRes.status,
      body: JSON.stringify({
        error: (data && data.error && data.error.message) || "Anthropic request failed",
      }),
    };
  }

  // 4. Only count it against their quota once the call actually succeeded.
  await supabaseAdmin
    .from("usage_limits")
    .update({
      used_this_month: usedSoFar + 1,
      period_start: isNewMonth ? now.toISOString().slice(0, 10) : usage.period_start,
    })
    .eq("user_id", userId);

  await supabaseAdmin.from("usage_log").insert({
    user_id: userId,
    tool: body.tool || "unknown",
  });

  return { statusCode: 200, body: JSON.stringify(data) };
};
