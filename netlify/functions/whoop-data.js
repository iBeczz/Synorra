const BASE = 'https://api.prod.whoop.com/developer/v1';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

  let { access_token, refresh_token, expires_at } = body;

  if (!access_token) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing Whoop token' }) };
  }

  // Refresh if within 60 seconds of expiry
  if (Number(expires_at) < Date.now() / 1000 + 60) {
    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token,
        client_id: process.env.WHOOP_CLIENT_ID,
        client_secret: process.env.WHOOP_CLIENT_SECRET
      });
      const r = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const rd = await r.json();
      if (rd.access_token) {
        access_token = rd.access_token;
        refresh_token = rd.refresh_token;
        expires_at = Math.floor(Date.now() / 1000) + (rd.expires_in || 3600);
      } else {
        return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Token refresh failed — please reconnect Whoop' }) };
      }
    } catch (e) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Token refresh failed: ' + e.message }) };
    }
  }

  const authHeaders = { Authorization: `Bearer ${access_token}` };

  const fetchJson = async (path) => {
    const r = await fetch(`${BASE}${path}`, { headers: authHeaders });
    if (!r.ok) throw new Error(`Whoop API ${path} returned ${r.status}`);
    return r.json();
  };

  try {
    const [recoveryData, sleepData, cycleData] = await Promise.all([
      fetchJson('/recovery?limit=1').catch(() => null),
      fetchJson('/sleep?limit=1').catch(() => null),
      fetchJson('/cycle?limit=1').catch(() => null)
    ]);

    const recovery = recoveryData?.records?.[0];
    const sleep = sleepData?.records?.[0];
    const cycle = cycleData?.records?.[0];

    const result = {
      new_token: { access_token, refresh_token, expires_at }
    };

    if (recovery?.score_state === 'SCORED' && recovery.score) {
      const score = recovery.score.recovery_score;
      result.recovery_score = score;
      result.recovery_state = score >= 67 ? 'Optimal' : score >= 34 ? 'Good' : 'Poor';
      result.hrv_rmssd = recovery.score.hrv_rmssd_milli;
      result.resting_hr = recovery.score.resting_heart_rate;
    } else {
      result.recovery_state = recovery?.score_state === 'PENDING_SLEEP'
        ? 'Pending sleep' : 'Unscorable';
    }

    if (sleep?.score_state === 'SCORED' && sleep.score) {
      result.sleep_performance = sleep.score.sleep_performance_percentage;
      const durationMs = new Date(sleep.end) - new Date(sleep.start);
      const totalMins = Math.round(durationMs / 60000);
      result.sleep_duration_h = Math.floor(totalMins / 60);
      result.sleep_duration_m = totalMins % 60;
    }

    if (cycle?.score_state === 'SCORED' && cycle.score) {
      result.day_strain = cycle.score.strain;
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
