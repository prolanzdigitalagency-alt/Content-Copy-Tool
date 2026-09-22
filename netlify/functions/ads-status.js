// GET /api/ads-status?runId=...&datasetId=...
// Header: Authorization: Bearer <the user's Supabase access token>
//
// The second half of the ad search. The app calls this every few seconds with
// the ticket it got from /api/ads until the results are ready.
// Returns { status: "running" } | { status: "done", items: [...] } | { status: "failed", error }

const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Must be signed in; the ticket is per-user work.
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: "Not signed in" }) };
  }
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: "Invalid session" }) };
  }

  const params = event.queryStringParameters || {};
  const runId = params.runId;
  const datasetId = params.datasetId;
  if (!runId || !datasetId) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing runId or datasetId" }) };
  }

  let runRes, runData;
  try {
    runRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${process.env.APIFY_TOKEN}`
    );
    runData = await runRes.json();
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: "Couldn't check the search: " + e.message }) };
  }

  const status = runData && runData.data && runData.data.status;
  if (!status) {
    return { statusCode: 502, body: JSON.stringify({ error: "Unexpected response while checking the search" }) };
  }

  if (status === "SUCCEEDED") {
    let items = [];
    try {
      const itemsRes = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${process.env.APIFY_TOKEN}&clean=true`
      );
      items = await itemsRes.json();
      if (!Array.isArray(items)) items = [];
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: "Couldn't fetch the results: " + e.message }) };
    }
    return { statusCode: 200, body: JSON.stringify({ status: "done", items }) };
  }

  if (["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "failed",
        error: "The ad search didn't complete. Try a broader keyword or the brand's exact page name.",
      }),
    };
  }

  // READY / RUNNING: still working, check back.
  return { statusCode: 200, body: JSON.stringify({ status: "running" }) };
};
