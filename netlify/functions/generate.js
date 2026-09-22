const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

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
    .from("usage_limits")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (usageErr || !usage) {
    return { statusCode: 403, body: JSON.stringify({ error: "No usage record found for this account" }) };
  }

  const now = new Date();
  const periodStart = new Date(usage.period_start);
  const isNewMonth =
    now.getUTCFullYear() !== periodStart.getUTCFullYear() ||
    now.getUTCMonth() !== periodStart.getUTCMonth();
  const usedSoFar = isNewMonth ? 0 : usage.used_this_month;

  if (usedSoFar >= usage.monthly_limit) {
    return { statusCode: 429, body: JSON.stringify({ error: "Monthly limit reached for your plan. Upgrade or wait for the next cycle." }) };
  }

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
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens,
        messages: body.messages,
        ...(body.mcp_servers ? { mcp_servers: body.mcp_servers } : {}),
      }),
    });
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: "Could not reach Anthropic: " + e.message }) };
  }

  const data = await anthropicRes.json();

  if (!anthropicRes.ok) {
    return { statusCode: anthropicRes.status, body: JSON.stringify({ error: (data && data.error && data.error.message) || "Anthropic request failed" }) };
  }

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
