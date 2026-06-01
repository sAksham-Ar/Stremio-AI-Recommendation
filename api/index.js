// api/index.js
// Landing / configure page — renders an HTML page with a "Connect Trakt" button.

module.exports = async function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${protocol}://${host}`;

  const redirectUri = encodeURIComponent(`${baseUrl}/api/trakt/callback`);
  const traktAuthUrl = `https://trakt.tv/oauth/authorize?response_type=code&client_id=${process.env.TRAKT_CLIENT_ID}&redirect_uri=${redirectUri}`;
  const storageNote = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL)
    && (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)
    ? 'Your Trakt token is stored in your configured Vercel KV/Upstash Redis store so refreshes keep working.'
    : 'No database is configured, so your Trakt token is stored only in the private addon URL. Reinstall if Trakt refresh tokens rotate.';

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>AI Recommendations — Stremio Addon</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f13;
      color: #eee;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      background: #1a1a24;
      border-radius: 20px;
      padding: 3rem 2.5rem;
      max-width: 520px;
      width: 100%;
      text-align: center;
      box-shadow: 0 12px 48px rgba(0,0,0,0.6);
    }
    .logo {
      font-size: 3rem;
      margin-bottom: 1rem;
    }
    h1 {
      font-size: 1.8rem;
      font-weight: 700;
      color: #fff;
      margin-bottom: 0.5rem;
    }
    .subtitle {
      color: #888;
      font-size: 0.95rem;
      margin-bottom: 2rem;
      line-height: 1.6;
    }
    .features {
      text-align: left;
      margin-bottom: 2rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .feature {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      background: #111;
      border-radius: 10px;
      padding: 0.85rem 1rem;
    }
    .feature-icon { font-size: 1.2rem; flex-shrink: 0; }
    .feature-text { font-size: 0.9rem; color: #ccc; line-height: 1.4; }
    .btn {
      display: inline-block;
      background: linear-gradient(135deg, #e8002d, #c2001f);
      color: #fff;
      text-decoration: none;
      padding: 1rem 2.5rem;
      border-radius: 10px;
      font-size: 1.05rem;
      font-weight: 700;
      letter-spacing: 0.02em;
      transition: opacity 0.2s;
      width: 100%;
    }
    .btn:hover { opacity: 0.85; }
    .footer {
      margin-top: 2rem;
      font-size: 0.78rem;
      color: #555;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">&#x1F3AC;</div>
    <h1>AI Recommendations</h1>
    <p class="subtitle">
      Connect your Trakt account to get personalized movie &amp; series
      recommendations powered by Mistral AI — directly in Stremio.
    </p>
    <div class="features">
      <div class="feature">
        <span class="feature-icon">&#x1F4CA;</span>
        <span class="feature-text">Analyzes your Trakt watch history to understand your taste</span>
      </div>
      <div class="feature">
        <span class="feature-icon">&#x1F916;</span>
        <span class="feature-text">Mistral AI generates fresh recommendations every 30 minutes</span>
      </div>
      <div class="feature">
        <span class="feature-icon">&#x1F3AC;</span>
        <span class="feature-text">Appears as two catalog rows in Stremio: AI Picks — Movies &amp; Series</span>
      </div>
    </div>
    <a class="btn" href="${traktAuthUrl}">Connect with Trakt</a>
    <p class="footer">
      ${storageNote}
    </p>
  </div>
</body>
</html>
  `);
};
