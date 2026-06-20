const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  const stravaToken = authHeader?.replace('Bearer ', '').trim();
  if (!stravaToken) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Missing token' }) };
  }

  // Verify the Strava token and get the athlete ID to use as the storage key
  let athleteId;
  try {
    const r = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${stravaToken}` }
    });
    if (!r.ok) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Invalid Strava token' }) };
    const athlete = await r.json();
    athleteId = String(athlete.id);
  } catch {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Could not verify token' }) };
  }

  const store = getStore('synorra-plans');
  const key = `plan_v1_${athleteId}`;

  if (event.httpMethod === 'GET') {
    try {
      const data = await store.get(key, { type: 'json' });
      return { statusCode: 200, headers: cors, body: JSON.stringify(data || {}) };
    } catch {
      return { statusCode: 200, headers: cors, body: JSON.stringify({}) };
    }
  }

  if (event.httpMethod === 'PUT') {
    try {
      const data = JSON.parse(event.body || '{}');
      await store.set(key, JSON.stringify(data));
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    } catch {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Save failed' }) };
    }
  }

  return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
};
