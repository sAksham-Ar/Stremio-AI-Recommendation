# Stremio AI Recommendations


Vercel-hosted Stremio addon that recommends movies and series from your Trakt watch history using Mistral AI.

## Vercel environment variables

Required:

- `TRAKT_CLIENT_ID`
- `TRAKT_CLIENT_SECRET`
- `MISTRAL_API_KEY`

Recommended for reliable token refresh:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

The KV variables are created automatically when you connect Vercel KV. If you use Upstash Redis directly instead, these names are also supported:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

## Trakt OAuth redirect URI

Set your Trakt app redirect URI to:

```text
https://YOUR-VERCEL-DOMAIN/api/trakt/callback
```

## Token refresh behavior

With KV/Upstash configured, the installed Stremio manifest URL contains only a random `kv:<id>` config id. Access and refresh tokens are stored server-side, and rotated refresh tokens are persisted after refresh.

Without KV/Upstash, the addon falls back to embedding the token bundle in the private Stremio addon URL. This works, but it cannot persist rotated refresh tokens across Vercel serverless instances. If Trakt rotates the refresh token, the user may need to reconnect Trakt and reinstall the addon.

## Local development

```bash
npm install
npx vercel dev
```

Open:

```text
http://localhost:3000
```
