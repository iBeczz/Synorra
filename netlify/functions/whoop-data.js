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

  let { access_token, refresh_token, expires_at, activity_start } = body;

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
  const get = async (path) => {
    const r = await fetch(`${BASE}${path}`, { headers: authHeaders });
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
    return r.json();
  };

  try {
    // Fetch enough records to reliably find the pre-activity sleep
    const [sleepRes, recoveryRes, cycleRes] = await Promise.all([
      get('/sleep?limit=10').catch(() => null),
      get('/recovery?limit=7').catch(() => null),
      get('/cycle?limit=1').catch(() => null)
    ]);

    const sleeps     = sleepRes?.records     || [];
    const recoveries = recoveryRes?.records  || [];
    const cycle      = cycleRes?.records?.[0] || null;

    // Find the most recent non-nap sleep that ended before the activity start
    let preSleep = null;
    if (activity_start) {
      const cutoff = new Date(activity_start);
      preSleep = sleeps.find(s => !s.nap && new Date(s.end) <= cutoff);
    }
    // Fallback: just the most recent non-nap sleep
    if (!preSleep) preSleep = sleeps.find(s => !s.nap) || sleeps[0] || null;

    // Match recovery to that sleep via sleep_id, or fall back to most recent before activity
    let preRecovery = null;
    if (preSleep) {
      preRecovery = recoveries.find(r => r.sleep_id === preSleep.id);
    }
    if (!preRecovery && activity_start) {
      const cutoff = new Date(activity_start);
      preRecovery = recoveries.find(r => new Date(r.updated_at) <= cutoff);
    }
    if (!preRecovery) preRecovery = recoveries[0] || null;

    const result = { new_token: { access_token, refresh_token, expires_at } };

    // ── Recovery ──────────────────────────────────────────────────────────────
    if (preRecovery?.score_state === 'SCORED' && preRecovery.score) {
      const rs = preRecovery.score;
      const score = rs.recovery_score;
      result.recovery = {
        score,
        state: score >= 67 ? 'Optimal' : score >= 34 ? 'Good' : 'Poor',
        hrv_rmssd:  rs.hrv_rmssd_milli,
        resting_hr: rs.resting_heart_rate,
        spo2:       rs.spo2_percentage,
        skin_temp:  rs.skin_temp_celsius
      };
    } else if (preRecovery) {
      result.recovery = {
        state: preRecovery.score_state === 'PENDING_SLEEP' ? 'Pending sleep' : 'Unscorable'
      };
    }

    // ── Sleep ─────────────────────────────────────────────────────────────────
    if (preSleep?.score_state === 'SCORED' && preSleep.score) {
      const ss    = preSleep.score;
      const stage = ss.stage_summary  || {};
      const need  = ss.sleep_needed   || {};

      const totalNeeded =
        (need.baseline_milli                || 0) +
        (need.need_from_sleep_debt_milli    || 0) +
        (need.need_from_recent_strain_milli || 0) +
        (need.need_from_recent_nap_milli    || 0);

      result.sleep = {
        start:            preSleep.start,
        end:              preSleep.end,
        performance:      ss.sleep_performance_percentage,
        efficiency:       ss.sleep_efficiency_percentage,
        consistency:      ss.sleep_consistency_percentage,
        respiratory_rate: ss.respiratory_rate,
        in_bed_milli:     stage.total_in_bed_time_milli,
        awake_milli:      stage.total_awake_time_milli,
        light_milli:      stage.total_light_sleep_time_milli,
        deep_milli:       stage.total_slow_wave_sleep_time_milli,
        rem_milli:        stage.total_rem_sleep_time_milli,
        disturbances:     stage.disturbance_count,
        cycles:           stage.sleep_cycle_count,
        needed_milli:     totalNeeded > 0 ? totalNeeded : null
      };
    } else if (preSleep) {
      result.sleep = { state: preSleep.score_state || 'unavailable' };
    }

    // ── Today's cycle (strain + day-level HR) ─────────────────────────────────
    if (cycle?.score_state === 'SCORED' && cycle.score) {
      result.cycle = {
        strain:     cycle.score.strain,
        avg_hr:     cycle.score.average_heart_rate,
        max_hr:     cycle.score.max_heart_rate,
        kilojoule:  cycle.score.kilojoule,
        start:      cycle.start,
        end:        cycle.end
      };
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
