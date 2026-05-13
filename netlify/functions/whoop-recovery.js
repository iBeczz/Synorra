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

  const { token, nextToken } = body;
  if (!token) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing token' }) };
  }

  let url = `${BASE}/recovery?limit=25`;
  if (nextToken) url += `&nextToken=${encodeURIComponent(nextToken)}`;

  try {
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await resp.json();
    return { statusCode: resp.status, headers: cors, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
