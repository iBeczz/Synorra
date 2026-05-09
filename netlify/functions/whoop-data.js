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

  // Refresh token if expiring within 60s
  if (Number(expires_at) < Date.now() / 1000 + 60) {
    try {
      const p = new URLSearchParams({
        grant_type: 'refresh_token', refresh_token,
        client_id: process.env.WHOOP_CLIENT_ID,
        client_secret: process.env.WHOOP_CLIENT_SECRET
      });
      const r = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: p.toString()
      });
      const rd = await r.json();
      if (!rd.access_token) {
        return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Token refresh failed — please reconnect Whoop' }) };
      }
      access_token  = rd.access_token;
      refresh_token = rd.refresh_token;
      expires_at    = Math.floor(Date.now() / 1000) + (rd.expires_in || 3600);
    } catch (e) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Token refresh: ' + e.message }) };
    }
  }

  const h = { Authorization: `Bearer ${access_token}` };
  const get = async (path) => {
    const r = await fetch(`${BASE}${path}`, { headers: h });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  };

  try {
    const [recoveryRes, sleepRes, cycleRes, bodyRes] = await Promise.all([
      get('/recovery?limit=5').catch(() => null),
      get('/sleep?limit=10').catch(() => null),
      get('/cycle?limit=2').catch(() => null),
      get('/body_measurement').catch(() => null)
    ]);

    const recoveries = recoveryRes?.records || [];
    const sleeps     = sleepRes?.records    || [];
    const cycles     = cycleRes?.records    || [];

    // ── Find pre-activity sleep ──────────────────────────────────────────────
    // Use activity_start only to pick from *multiple* recent sleeps.
    // Do NOT filter recovery by updated_at — Whoop calculates recovery after
    // the user wakes up, so updated_at is often later than the activity start.
    let preSleep = null;
    if (activity_start) {
      const cutoff = new Date(activity_start);
      preSleep = sleeps.find(s => !s.nap && new Date(s.end) <= cutoff);
    }
    if (!preSleep) preSleep = sleeps.find(s => !s.nap) || sleeps[0] || null;

    // ── Find matching recovery ────────────────────────────────────────────────
    // Match via sleep_id first (most accurate), then fall back to latest.
    let preRecovery = preSleep
      ? (recoveries.find(r => r.sleep_id === preSleep.id) || recoveries[0])
      : recoveries[0] || null;

    // ── Find current cycle (post-activity / today's strain) ──────────────────
    // If there's an activity_start, prefer the cycle that started on that day.
    let cycle = cycles[0] || null;
    if (activity_start && cycles.length > 1) {
      const actDate = new Date(activity_start).toDateString();
      const match = cycles.find(c => new Date(c.start).toDateString() === actDate);
      if (match) cycle = match;
    }

    const result = { new_token: { access_token, refresh_token, expires_at } };

    // ── Recovery ─────────────────────────────────────────────────────────────
    if (preRecovery) {
      const scored = preRecovery.score_state === 'SCORED';
      const rs     = scored ? preRecovery.score : null;
      const score  = rs?.recovery_score ?? null;
      result.recovery = {
        score_state:      preRecovery.score_state,
        score,
        state: score != null
          ? (score >= 67 ? 'Optimal' : score >= 34 ? 'Good' : 'Poor')
          : (preRecovery.score_state === 'PENDING_SLEEP' ? 'Pending sleep' : 'Unscorable'),
        hrv_rmssd:        rs?.hrv_rmssd_milli      ?? null,
        resting_hr:       rs?.resting_heart_rate   ?? null,
        spo2:             rs?.spo2_percentage       ?? null,
        skin_temp:        rs?.skin_temp_celsius     ?? null,
        user_calibrating: rs?.user_calibrating      ?? null
      };
    }

    // ── Sleep ─────────────────────────────────────────────────────────────────
    if (preSleep) {
      const scored = preSleep.score_state === 'SCORED';
      const ss     = scored ? preSleep.score : null;
      const stage  = ss?.stage_summary || {};
      const need   = ss?.sleep_needed  || {};

      const needBaseline = need.baseline_milli                ?? null;
      const needStrain   = need.need_from_recent_strain_milli ?? null;
      const needDebt     = need.need_from_sleep_debt_milli    ?? null;
      const needNap      = need.need_from_recent_nap_milli    ?? null;

      const totalNeeded = (needBaseline || 0) + (needStrain || 0) +
                          (needDebt     || 0) + (needNap    || 0);

      result.sleep = {
        score_state:       preSleep.score_state,
        start:             preSleep.start,
        end:               preSleep.end,
        nap:               preSleep.nap,
        performance:       ss?.sleep_performance_percentage ?? null,
        efficiency:        ss?.sleep_efficiency_percentage  ?? null,
        consistency:       ss?.sleep_consistency_percentage ?? null,
        respiratory_rate:  ss?.respiratory_rate             ?? null,
        in_bed_milli:      stage.total_in_bed_time_milli    ?? null,
        awake_milli:       stage.total_awake_time_milli     ?? null,
        light_milli:       stage.total_light_sleep_time_milli     ?? null,
        deep_milli:        stage.total_slow_wave_sleep_time_milli ?? null,
        rem_milli:         stage.total_rem_sleep_time_milli       ?? null,
        disturbances:      stage.disturbance_count    ?? null,
        cycles:            stage.sleep_cycle_count    ?? null,
        needed_milli:      totalNeeded > 0 ? totalNeeded : null,
        needed_baseline:   needBaseline,
        needed_strain:     needStrain,
        needed_debt:       needDebt,
        needed_nap:        needNap
      };
    }

    // ── Cycle ─────────────────────────────────────────────────────────────────
    if (cycle?.score_state === 'SCORED' && cycle.score) {
      result.cycle = {
        strain:    cycle.score.strain,
        avg_hr:    cycle.score.average_heart_rate,
        max_hr:    cycle.score.max_heart_rate,
        kilojoule: cycle.score.kilojoule,
        start:     cycle.start,
        end:       cycle.end
      };
    }

    // ── Body measurements ─────────────────────────────────────────────────────
    if (bodyRes && !bodyRes.error) {
      result.body = {
        height_meter:    bodyRes.height_meter    ?? null,
        weight_kilogram: bodyRes.weight_kilogram ?? null,
        max_heart_rate:  bodyRes.max_heart_rate  ?? null
      };
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
