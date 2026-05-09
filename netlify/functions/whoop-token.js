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

  const { code } = body;
  if (!code) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing authorization code' }) };
  }

  const clientId = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  const redirectUri = process.env.WHOOP_REDIRECT_URI || 'https://fitness-analysis-dashboard.netlify.app/';

  if (!clientId || !clientSecret) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Whoop credentials not configured on server' }) };
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret
    });

    const tokenRes = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const data = await tokenRes.json();

    if (!data.access_token) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({ error: data.error_description || data.error || 'Token exchange failed' })
      };
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600)
      })
    };
  } catch (err) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
