let getStore;
try {
  ({ getStore } = require('@netlify/blobs'));
} catch (e) {
  console.error('Failed to load @netlify/blobs:', e.message);
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Athlete-Id',
    'Content-Type': 'application/json'
  };

  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: cors, body: '' };
    }

    if (!getStore) {
      return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'Blobs unavailable' }) };
    }

    const token     = (event.headers['authorization'] || '').replace('Bearer ', '').trim();
    const athleteId = (event.headers['x-athlete-id'] || '').trim();

    if (!token || !athleteId || !/^\d+$/.test(athleteId)) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Auth required' }) };
    }

    // getStore(name) in @netlify/blobs v7+ is site-scoped (persists across deploys)
    const store = getStore('synorra-plans');
    const key   = `plan_v1_${athleteId}`;

    if (event.httpMethod === 'GET') {
      const data = await store.get(key, { type: 'json' });
      return { statusCode: 200, headers: cors, body: JSON.stringify(data || {}) };
    }

    if (event.httpMethod === 'PUT') {
      const data = JSON.parse(event.body || '{}');
      await store.set(key, JSON.stringify(data));
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (e) {
    console.error('plan-data error:', e.message, e.stack);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
