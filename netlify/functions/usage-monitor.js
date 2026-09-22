// Fix #5: an early-warning check instead of only finding out when a
// customer complains. Runs on its own every hour (see exports.config
// below), counts how many generations happened in the last hour, and
// writes an alert row if that crosses a threshold. This is detection,
// not delivery: it does not yet email or message anyone, because that
// needs picking a notification channel first (see README). For now,
// check the system_alerts table in the Supabase Table Editor.

const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const HOURLY_THRESHOLD = parseInt(
  process.env.HOURLY_USAGE_ALERT_THRESHOLD || "200",
  10
);

exports.handler = async () => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { count, error } = await supabaseAdmin
    .from("usage_log")
    .select("*", { count: "exact", head: true })
    .gte("created_at", oneHourAgo);

  if (error) {
    console.error("usage-monitor: could not read usage_log:", error.message);
    return { statusCode: 200, body: "monitor error, see function logs" };
  }

  if ((count || 0) >= HOURLY_THRESHOLD) {
    await supabaseAdmin.from("system_alerts").insert({
      kind: "usage_spike",
      message: `${count} generations in the last hour (threshold ${HOURLY_THRESHOLD}). Check Anthropic spend and Markifact credits.`,
    });
  }

  return { statusCode: 200, body: `checked, ${count || 0} in the last hour` };
};

// Netlify Scheduled Functions: this makes the function run on its own,
// no manual trigger needed. Syntax reference: https://docs.netlify.com/functions/scheduled-functions/
exports.config = {
  schedule: "@hourly",
};
