const BASE = 'https://api.prod.whoop.com/developer/v2';

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

  let { access_token, refresh_token, expires_at, activity_start, activity_end } = body;

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
  const apiErrors = {};

  const safeGet = async (key, path) => {
    try {
      const r = await fetch(`${BASE}${path}`, { headers: h });
      if (!r.ok) {
        const errBody = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}${errBody ? ': ' + errBody.slice(0, 200) : ''}`);
      }
      return r.json();
    } catch (e) {
      apiErrors[key] = e.message;
      return null;
    }
  };

  // For the workout query, use the activity window ± 30 min to catch Whoop's own
  // start/stop time which may not align exactly with the Strava recording.
  let workoutPath = '/activity/workout?limit=10';
  if (activity_start) {
    const wStart = new Date(new Date(activity_start).getTime() - 30 * 60000).toISOString();
    const wEnd   = activity_end
      ? new Date(new Date(activity_end).getTime()   + 30 * 60000).toISOString()
      : new Date(new Date(activity_start).getTime() + 6 * 3600000).toISOString();
    workoutPath = `/activity/workout?limit=10&start=${wStart}&end=${wEnd}`;
  }

  const [recoveryRes, sleepRes, cycleRes, bodyRes, workoutRes] = await Promise.all([
    safeGet('recovery', '/recovery?limit=10'),
    safeGet('sleep',    '/activity/sleep?limit=14'),
    safeGet('cycle',    '/cycle?limit=3'),
    safeGet('body',     '/user/measurement/body'),
    safeGet('workout',  workoutPath)
  ]);

  const recoveries = recoveryRes?.records || [];
  const sleeps     = sleepRes?.records    || [];
  const cycles     = cycleRes?.records    || [];
  const workouts   = workoutRes?.records  || [];

  // Whoop returns records newest-first.
  // Pre-activity: most recent non-nap sleep that fully ended before the activity.
  // Post-activity: earliest non-nap sleep that started after the activity (the very next night).
  let preSleep  = null;
  let postSleep = null;

  if (activity_start) {
    const cutoff = new Date(activity_start);
    preSleep  = sleeps.find(s => !s.nap && new Date(s.end) <= cutoff) || null;
    postSleep = [...sleeps].reverse().find(s => !s.nap && new Date(s.start) > cutoff) || null;
  }
  if (!preSleep) preSleep = sleeps.find(s => !s.nap) || sleeps[0] || null;

  const preRecovery  = preSleep
    ? (recoveries.find(r => r.sleep_id === preSleep.id)  || recoveries[0] || null)
    : (recoveries[0] || null);
  const postRecovery = postSleep
    ? (recoveries.find(r => r.sleep_id === postSleep.id) || null)
    : null;

  // Prefer the cycle whose start date matches the activity date
  let cycle = cycles[0] || null;
  if (activity_start && cycles.length > 1) {
    const actDate = new Date(activity_start).toDateString();
    const match = cycles.find(c => new Date(c.start).toDateString() === actDate);
    if (match) cycle = match;
  }

  // Best-matching workout: highest overlap with the activity window
  let workout = null;
  if (activity_start && workouts.length) {
    const actStart = new Date(activity_start).getTime();
    const actEnd   = activity_end ? new Date(activity_end).getTime() : actStart + 3600000;
    let bestOverlap = 0;
    for (const w of workouts) {
      const wS = new Date(w.start).getTime();
      const wE = new Date(w.end).getTime();
      const overlap = Math.max(0, Math.min(actEnd, wE) - Math.max(actStart, wS));
      if (overlap > bestOverlap) { bestOverlap = overlap; workout = w; }
    }
    // Fallback: if no overlap (e.g. Whoop started a minute or two before Strava)
    // accept any workout within the window
    if (!workout) workout = workouts[0] || null;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  const buildSleep = (rec) => {
    if (!rec) return null;
    const scored = rec.score_state === 'SCORED';
    const ss     = scored ? rec.score : null;
    const stage  = ss?.stage_summary || {};
    const need   = ss?.sleep_needed  || {};

    const needBaseline = need.baseline_milli                ?? null;
    const needStrain   = need.need_from_recent_strain_milli ?? null;
    const needDebt     = need.need_from_sleep_debt_milli    ?? null;
    const needNap      = need.need_from_recent_nap_milli    ?? null;
    const totalNeeded  = (needBaseline||0) + (needStrain||0) + (needDebt||0) + (needNap||0);

    return {
      score_state:      rec.score_state,
      start:            rec.start,
      end:              rec.end,
      nap:              rec.nap,
      performance:      ss?.sleep_performance_percentage ?? null,
      efficiency:       ss?.sleep_efficiency_percentage  ?? null,
      consistency:      ss?.sleep_consistency_percentage ?? null,
      respiratory_rate: ss?.respiratory_rate             ?? null,
      in_bed_milli:     stage.total_in_bed_time_milli    ?? null,
      awake_milli:      stage.total_awake_time_milli     ?? null,
      light_milli:      stage.total_light_sleep_time_milli     ?? null,
      deep_milli:       stage.total_slow_wave_sleep_time_milli ?? null,
      rem_milli:        stage.total_rem_sleep_time_milli       ?? null,
      disturbances:     stage.disturbance_count  ?? null,
      cycles:           stage.sleep_cycle_count  ?? null,
      needed_milli:     totalNeeded > 0 ? totalNeeded : null,
      needed_baseline:  needBaseline,
      needed_strain:    needStrain,
      needed_debt:      needDebt,
      needed_nap:       needNap
    };
  };

  const buildRecovery = (rec) => {
    if (!rec) return null;
    const scored = rec.score_state === 'SCORED';
    const rs     = scored ? rec.score : null;
    const score  = rs?.recovery_score ?? null;
    return {
      score_state:      rec.score_state,
      score,
      state: score != null
        ? (score >= 67 ? 'Optimal' : score >= 34 ? 'Good' : 'Poor')
        : (rec.score_state === 'PENDING_SLEEP' ? 'Pending sleep' : 'Unscorable'),
      hrv_rmssd:        rs?.hrv_rmssd_milli    ?? null,
      resting_hr:       rs?.resting_heart_rate ?? null,
      spo2:             rs?.spo2_percentage    ?? null,
      skin_temp:        rs?.skin_temp_celsius  ?? null,
      user_calibrating: rs?.user_calibrating   ?? null
    };
  };

  const buildWorkout = (rec) => {
    if (!rec) return null;
    const scored = rec.score_state === 'SCORED';
    const ws     = scored ? rec.score : null;
    const zones  = ws?.zone_durations || {};
    return {
      score_state:      rec.score_state,
      sport_name:       rec.sport_name ?? null,
      start:            rec.start,
      end:              rec.end,
      strain:           ws?.strain             ?? null,
      avg_hr:           ws?.average_heart_rate ?? null,
      max_hr:           ws?.max_heart_rate     ?? null,
      kilojoule:        ws?.kilojoule          ?? null,
      percent_recorded: ws?.percent_recorded   ?? null,
      distance_meter:   ws?.distance_meter     ?? null,
      altitude_gain:    ws?.altitude_gain_meter ?? null,
      zone_zero_milli:  zones.zone_zero_milli  ?? null,
      zone_one_milli:   zones.zone_one_milli   ?? null,
      zone_two_milli:   zones.zone_two_milli   ?? null,
      zone_three_milli: zones.zone_three_milli ?? null,
      zone_four_milli:  zones.zone_four_milli  ?? null,
      zone_five_milli:  zones.zone_five_milli  ?? null
    };
  };

  const result = {
    new_token:     { access_token, refresh_token, expires_at },
    recovery:      buildRecovery(preRecovery),
    sleep:         buildSleep(preSleep),
    workout:       activity_start ? buildWorkout(workout)        : undefined,
    post_sleep:    activity_start ? buildSleep(postSleep)        : undefined,
    post_recovery: activity_start ? buildRecovery(postRecovery)  : undefined
  };

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

  if (bodyRes && !bodyRes.error) {
    result.body = {
      height_meter:    bodyRes.height_meter    ?? null,
      weight_kilogram: bodyRes.weight_kilogram ?? null,
      max_heart_rate:  bodyRes.max_heart_rate  ?? null
    };
  }

  if (Object.keys(apiErrors).length) result._errors = apiErrors;

  return { statusCode: 200, headers: cors, body: JSON.stringify(result) };
};
