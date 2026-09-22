// Deployed at /.netlify/functions/ads, reachable as /api/ads.
//
// Real ad-library search, for public-data operations only (no customer
// account connection needed): TikTok and LinkedIn are confirmed by
// Markifact as "Connection: None", so they're on here. Meta is NOT yet
// enabled, that one hasn't been specifically confirmed, add it to
// SUPPORTED below once it is.
//
// Body: { platform: "tiktok" | "linkedin", q: "brand name", country?: "NG", limit?: 8 }
// Header: Authorization: Bearer <the user's Supabase access token>
//
// Has its own DAILY quota (markifact_daily_usage), separate from the
// Anthropic monthly one, per the daily-cap plan: resets every day, not a
// rolling window, so total usage per user stays predictable.

const { createClient } = require("@supabase/supabase-js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Add "meta": "meta_ads_library" here only once Markifact confirms it's
// also a no-connection public search, same as TikTok and LinkedIn.
const SUPPORTED = {
  tiktok: "tiktok_ads_library",
  linkedin: "linkedin_ads_library",
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // 1. Identify the user.
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

  // 2. Check the DAILY Markifact quota, separate pool from Anthropic's.
  const { data: usage, error: usageErr } = await supabaseAdmin
    .from("markifact_daily_usage")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (usageErr || !usage) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: "No ad-library usage record found for this account" }),
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const isNewDay = usage.day_start !== today;
  const usedToday = isNewDay ? 0 : usage.used_today;

  if (usedToday >= usage.daily_limit) {
    return {
      statusCode: 429,
      body: JSON.stringify({
        error: `Daily ad-library search limit reached (${usage.daily_limit}/day). Try again tomorrow.`,
      }),
    };
  }

  // 3. Parse the request and check the platform is one we've actually
  // confirmed is safe to call this way.
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad request body" }) };
  }

  const toolName = SUPPORTED[body.platform];
  if (!toolName) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error:
          "That platform isn't enabled yet. TikTok and LinkedIn ad-library search are live; Meta is pending one more confirmation from Markifact.",
      }),
    };
  }
  if (!body.q || !body.q.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing brand/keyword to search" }) };
  }

  // 4. Call Markifact's MCP server directly, server-side, with the Team key.
  let result;
  try {
    const transport = new StreamableHTTPClientTransport(
      new URL("https://api.markifact.com/mcp"),
      { requestInit: { headers: { Authorization: `Bearer ${process.env.MARKIFACT_API_KEY}` } } }
    );
    const client = new Client({ name: "content-copy-tool", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    result = await client.callTool({
      name: toolName,
      arguments: {
        q: body.q.trim(),
        active_status: body.active_status || "active",
        ...(body.country ? { country: body.country } : {}),
        limit: body.limit || 8,
      },
    });
    await client.close();
  } catch (e) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "Couldn't reach the ad library: " + e.message }),
    };
  }

  // 5. Only count it once the call actually succeeded.
  await supabaseAdmin
    .from("markifact_daily_usage")
    .update({ used_today: usedToday + 1, day_start: today })
    .eq("user_id", userId);

  return { statusCode: 200, body: JSON.stringify(result) };
};
