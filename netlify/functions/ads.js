// POST /api/ads  — STARTS an ad-library search (Apify) and returns a ticket.
// GET  /api/ads-status?runId=...&datasetId=...  — checks the ticket (see ads-status.js).

const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ACTORS = {
  meta: process.env.APIFY_META_ACTOR || "prodiger~facebook-ads-library-scraper-v2",
};

async function maintenanceBlock() {
  const { data } = await supabaseAdmin
    .from("system_settings")
    .select("maintenance_mode, maintenance_message")
    .eq("id", 1)
    .single();
  if (data && data.maintenance_mode) {
    return {
      statusCode: 503,
      body: JSON.stringify({ maintenance: true, error: data.maintenance_message }),
    };
  }
  return null;
}

function buildInput(platform, body) {
  const q = body.q.trim();
  if (platform === "meta") {
    return {
      query: [q],
      ...(body.country ? { country: String(body.country).toUpperCase() } : {}),
      activeStatus: body.active_status || "active",
      maxAds: Math.min(body.limit || 30, 100),
    };
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const blocked = await maintenanceBlock();
  if (blocked) return blocked;

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

  const { data: usage, error: usageErr } = await supabaseAdmin
    .from("markifact_daily_usage")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (usageErr || !usage) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: "No ad-search usage record found for this account" }),
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const isNewDay = usage.day_start !== today;
  const usedToday = isNewDay ? 0 : usage.used_today;

  if (usedToday >= usage.daily_limit) {
    return {
      statusCode: 429,
      body: JSON.stringify({
        error: `Daily ad-search limit reached (${usage.daily_limit}/day). Try again tomorrow.`,
      }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad request body" }) };
  }

  const actor = ACTORS[body.platform];
  if (!actor) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error:
          "Only Meta (Facebook/Instagram) ad search is enabled right now. TikTok and LinkedIn can be added once an actor is chosen and its input schema confirmed.",
      }),
    };
  }
  if (!body.q || !body.q.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing brand/keyword to search" }) };
  }
  if (!process.env.APIFY_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: "APIFY_TOKEN is not set on the server" }) };
  }

  const input = buildInput(body.platform, body);
  let startRes, startData;
  try {
    startRes = await fetch(
      `https://api.apify.com/v2/acts/${actor}/runs?token=${process.env.APIFY_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }
    );
    startData = await startRes.json();
  } catch (e) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "Couldn't start the ad search: " + e.message }),
    };
  }

  if (!startRes.ok || !startData || !startData.data) {
    const msg =
      (startData && startData.error && startData.error.message) || "HTTP " + startRes.status;
    return { statusCode: 502, body: JSON.stringify({ error: "Couldn't start the ad search: " + msg }) };
  }

  await supabaseAdmin
    .from("markifact_daily_usage")
    .update({ used_today: usedToday + 1, day_start: today })
    .eq("user_id", userId);

  return {
    statusCode: 202,
    body: JSON.stringify({
      runId: startData.data.id,
      datasetId: startData.data.defaultDatasetId,
      status: startData.data.status,
    }),
  };
};
