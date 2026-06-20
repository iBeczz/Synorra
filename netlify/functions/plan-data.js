const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Athlete-Id',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  // Client resolves athlete ID via apiFetchSafe (with proper token refresh).
  // We trust it here — this is a personal single-user app and plan data isn't sensitive.
  const token     = (event.headers['authorization'] || '').replace('Bearer ', '').trim();
  const athleteId = (event.headers['x-athlete-id'] || '').trim();

  if (!token || !athleteId || !/^\d+$/.test(athleteId)) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Auth required' }) };
  }

  const store = getStore('synorra-plans');
  const key   = `plan_v1_${athleteId}`;

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
