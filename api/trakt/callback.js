// api/trakt/callback.js
// Handles the Trakt OAuth callback, exchanges the code for a token,
// and redirects to the Stremio install link with the token embedded in the addon URL.

const fetch = require('node-fetch');
const { createTokenParam, hasTokenStore } = require('../../lib/trakt');

module.exports = async function handler(req, res) {
  const { code } = req.query;

  if (!code) {
    res.status(400).send('Missing OAuth code');
    return;
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${protocol}://${host}`;

  try {
    const redirectUri = `${baseUrl}/api/trakt/callback`;
    console.log('Using redirect_uri:', redirectUri);

    const tokenRes = await fetch('https://api.trakt.tv/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': process.env.TRAKT_CLIENT_ID,
        'User-Agent': 'StremioAIRecommendations/1.0',
      },
      body: JSON.stringify({
        code,
        client_id: process.env.TRAKT_CLIENT_ID,
        client_secret: process.env.TRAKT_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error('Trakt token exchange failed:', tokenRes.status, errBody);
      res.setHeader('Content-Type', 'text/html');
      res.status(500).send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>OAuth Error</title>
  <style>
    body { font-family: sans-serif; background: #0f0f13; color: #eee; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #1a1a24; border-radius: 16px; padding: 2rem; max-width: 520px; width: 100%; }
    h1 { color: #e8002d; margin-bottom: 1rem; }
    p { color: #aaa; line-height: 1.6; margin-bottom: 0.75rem; }
    code { background: #111; padding: 0.2rem 0.4rem; border-radius: 4px; font-size: 0.85rem; word-break: break-all; }
    a { color: #7b8ce4; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Trakt OAuth Failed</h1>
    <p>The redirect URI sent to Trakt does not match what is registered in your Trakt app.</p>
    <p>Make sure your Trakt app's <strong>Redirect URI</strong> is set to exactly:</p>
    <p><code>${redirectUri}</code></p>
    <p>Go to <a href="https://trakt.tv/oauth/applications" target="_blank">trakt.tv/oauth/applications</a>, edit your app, and update the redirect URI to the value above, then try again.</p>
  </div>
</body>
</html>
      `);
      return;
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    // expires_in is in seconds. As of March 2025 Trakt tokens expire in 24 hours (86400s).
    // Always use the value from the response — do not hardcode.
    const expiresAtMs = Date.now() + tokenData.expires_in * 1000;

    // Prefer a stable KV-backed config id. Without KV, fall back to the original
    // no-DB behavior: embed the token bundle in the addon URL.
    const tokenParam = await createTokenParam(accessToken, refreshToken, expiresAtMs);
    const encodedToken = encodeURIComponent(tokenParam);
    const storageMode = hasTokenStore() ? 'secure server-side storage' : 'private addon URL';

    // Build the addon manifest URL (the token pair is passed as a path param)
    const manifestUrl = `${baseUrl}/api/addon/${encodedToken}/manifest.json`;

    // Redirect to Stremio with the install link
    const stremioLink = `stremio://${host}/api/addon/${encodedToken}/manifest.json`;

    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Install AI Recommendations Addon</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f0f13;
      color: #eee;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
    }
    .card {
      background: #1a1a24;
      border-radius: 16px;
      padding: 2.5rem;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    h1 { font-size: 1.6rem; margin-bottom: 0.5rem; color: #fff; }
    p { color: #aaa; margin-bottom: 1.5rem; font-size: 0.95rem; line-height: 1.5; }
    .btn {
      display: inline-block;
      background: #7b5ea7;
      color: #fff;
      text-decoration: none;
      padding: 0.85rem 2rem;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 1rem;
      transition: background 0.2s;
    }
    .btn:hover { background: #9a7dc5; }
    .manifest-url {
      font-size: 0.75rem;
      color: #666;
      word-break: break-all;
      margin-top: 1.5rem;
      background: #111;
      border-radius: 6px;
      padding: 0.75rem;
    }
    .success { color: #4caf8a; font-size: 1.1rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <p class="success">&#10003; Trakt connected successfully!</p>
    <h1>AI Recommendations</h1>
    <p>Your Trakt account has been linked using ${storageMode}. Click the button below to install the addon in Stremio.</p>
    <a class="btn" href="${stremioLink}">Install in Stremio</a>
    <p style="font-size:0.85rem;color:#777;">Or manually add this manifest URL in Stremio &rarr; Addons &rarr; Install from URL:</p>
    <div class="manifest-url">${manifestUrl}</div>
  </div>
</body>
</html>
    `);
  } catch (err) {
    console.error('Callback error:', err);
    res.status(500).send('Internal error during OAuth');
  }
};
