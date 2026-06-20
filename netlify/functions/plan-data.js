// Stores training plan data in a private GitHub Gist.
// Required env vars (set in Netlify dashboard):
//   GH_GIST_TOKEN  — GitHub personal access token with `gist` scope
//   GH_GIST_ID     — ID of the secret gist (from gist.github.com URL)

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

    const GIST_TOKEN = process.env.GH_GIST_TOKEN;
    const GIST_ID    = process.env.GH_GIST_ID;

    if (!GIST_TOKEN || !GIST_ID) {
      return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'Server not configured (missing GH_GIST_TOKEN or GH_GIST_ID env vars)' }) };
    }

    const token     = (event.headers['authorization'] || '').replace('Bearer ', '').trim();
    const athleteId = (event.headers['x-athlete-id'] || '').trim();

    if (!token || !athleteId || !/^\d+$/.test(athleteId)) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Auth required' }) };
    }

    const gistHeaders = {
      'Authorization': `token ${GIST_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    };

    const filename = `plan_${athleteId}.json`;

    if (event.httpMethod === 'GET') {
      const res  = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: gistHeaders });
      if (!res.ok) {
        const txt = await res.text();
        return { statusCode: 502, headers: cors, body: JSON.stringify({ error: `GitHub API error ${res.status}: ${txt}` }) };
      }
      const gist    = await res.json();
      const content = gist.files?.[filename]?.content;
      return { statusCode: 200, headers: cors, body: content || '{}' };
    }

    if (event.httpMethod === 'PUT') {
      const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: gistHeaders,
        body: JSON.stringify({ files: { [filename]: { content: event.body || '{}' } } })
      });
      if (!res.ok) {
        const txt = await res.text();
        return { statusCode: 502, headers: cors, body: JSON.stringify({ error: `GitHub API error ${res.status}: ${txt}` }) };
      }
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (e) {
    console.error('plan-data error:', e.message);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
