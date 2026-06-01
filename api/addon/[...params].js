// api/addon/[...params].js
// Handles all Stremio addon routes:
//   GET /api/addon/{token}/manifest.json
//   GET /api/addon/{token}/catalog/{type}/{id}.json
//
// Vercel rewrites map path segments to p1, p2, p3, p4 query params.

const { getWatchHistory } = require('../../lib/trakt');
const { getRecommendations } = require('../../lib/ai');
const { enrichRecommendations } = require('../../lib/cinemeta');

// --- Cache ---
// Stores { ts, metas } per `${token}:movie` and `${token}:series`
const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;      // 30 min for successful results
const CACHE_TTL_ERROR_MS = 60 * 1000;     // 1 min for empty/failed results — retry soon
// Unauthorized errors are cached for a while — no point hammering Trakt with a dead token
const CACHE_TTL_UNAUTH_MS = 5 * 60 * 1000;

// Deduplication map: token -> Promise<void>
// If two catalog requests (movie + series) arrive simultaneously for the same
// token, only ONE Trakt+AI pipeline runs; the second waits on the same promise.
const inflight = new Map();

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function buildManifest() {
  return {
    id: 'community.ai-recommendations-trakt',
    version: '1.0.0',
    name: 'AI Recommendations',
    description:
      'Personalized movie & series recommendations powered by Mistral AI, based on your Trakt watch history.',
    resources: ['catalog'],
    types: ['movie', 'series'],
    catalogs: [
      {
        type: 'movie',
        id: 'ai_recommendations_movies',
        name: 'AI Picks — Movies',
        extra: [{ name: 'skip' }],
      },
      {
        type: 'series',
        id: 'ai_recommendations_series',
        name: 'AI Picks — Series',
        extra: [{ name: 'skip' }],
      },
    ],
    behaviorHints: {
      configurable: false,
      configurationRequired: false,
    },
  };
}

/**
 * Builds a fake catalog meta item that prompts the user to re-authenticate.
 * This shows up as a card in the Stremio catalog row.
 *
 * @param {string} reAuthUrl - the URL the user should visit to re-connect Trakt
 */
function buildReAuthMeta(reAuthUrl) {
  return {
    id: 'trakt:reauth',
    type: 'movie',
    name: '⚠ Trakt token expired — tap to re-connect',
    description:
      `Your Trakt access token has expired. Visit ${reAuthUrl} to reconnect your Trakt account and reinstall the addon.`,
    poster: 'https://walter.trakt.tv/hotlink-ok/public/trakt-icon-red.png',
    background: 'https://walter.trakt.tv/hotlink-ok/public/trakt-icon-red.png',
    links: [{ name: 'Reconnect Trakt', category: 'Reconnect', url: reAuthUrl }],
  };
}

/**
 * Runs the full Trakt → AI → Cinemeta pipeline for BOTH movie and series
 * simultaneously, then populates the cache for both types.
 * Returns a Promise that resolves when both are cached.
 */
function buildBothCatalogs(token, reAuthUrl) {
  // If already in-flight for this token, return the existing promise
  if (inflight.has(token)) return inflight.get(token);

  const promise = (async () => {
    let history;
    try {
      history = await getWatchHistory(token);
    } catch (err) {
      console.error('Trakt history error:', err.message);
      if (err.isUnauthorized) {
        console.error('Trakt token invalid or refresh failed — surfacing re-auth prompt to user.');
        const reAuthMeta = buildReAuthMeta(reAuthUrl);
        const errEntry = { ts: Date.now(), metas: [reAuthMeta], error: true, unauthorized: true };
        cache.set(`${token}:movie`, errEntry);
        cache.set(`${token}:series`, { ...errEntry, metas: [{ ...reAuthMeta, type: 'series' }] });
      } else {
        // Transient error — short TTL so we retry soon
        const errEntry = { ts: Date.now(), metas: [], error: true };
        cache.set(`${token}:movie`, errEntry);
        cache.set(`${token}:series`, errEntry);
      }
      return;
    }

    const [movieRecs, seriesRecs] = await Promise.all([
      getRecommendations(history, 'movie', 20).catch((err) => {
        console.error('AI movie error:', err.message);
        return null;
      }),
      getRecommendations(history, 'series', 20).catch((err) => {
        console.error('AI series error:', err.message);
        return null;
      }),
    ]);

    // Enrich both in parallel
    const [movieMetas, seriesMetas] = await Promise.all([
      movieRecs !== null ? enrichRecommendations(movieRecs).catch(() => null) : Promise.resolve(null),
      seriesRecs !== null ? enrichRecommendations(seriesRecs).catch(() => null) : Promise.resolve(null),
    ]);

    const now = Date.now();
    // Only cache with full TTL if we got real results; use short TTL on failure
    cache.set(`${token}:movie`, movieMetas !== null && movieMetas.length > 0
      ? { ts: now, metas: movieMetas }
      : { ts: now, metas: [], error: true }
    );
    cache.set(`${token}:series`, seriesMetas !== null && seriesMetas.length > 0
      ? { ts: now, metas: seriesMetas }
      : { ts: now, metas: [], error: true }
    );
  })().finally(() => {
    inflight.delete(token);
  });

  inflight.set(token, promise);
  return promise;
}

async function handleCatalog(token, catalogId, reAuthUrl, res) {
  const recType = catalogId.includes('movie') ? 'movie' : 'series';
  const cacheKey = `${token}:${recType}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    const ttl = cached.unauthorized ? CACHE_TTL_UNAUTH_MS
      : cached.error ? CACHE_TTL_ERROR_MS
      : CACHE_TTL_MS;
    if (Date.now() - cached.ts < ttl) {
      if (!cached.error) {
        res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600');
      }
      return res.status(200).json({ metas: cached.metas });
    }
  }

  // Build (or wait for an in-flight build) for both catalogs at once.
  // Token refresh (if needed) happens inside buildBothCatalogs → getWatchHistory.
  await buildBothCatalogs(token, reAuthUrl);

  const result = cache.get(cacheKey);
  if (result && !result.error) {
    res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600');
  }
  return res.status(200).json({ metas: result ? result.metas : [] });
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { p1, p2, p3, p4 } = req.query;

  if (!p1 || !p2) {
    return res.status(404).json({ error: 'Not found' });
  }

  const token = decodeURIComponent(p1);

  // Build the re-auth URL pointing to the addon homepage
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const reAuthUrl = `${protocol}://${host}`;

  if (p2 === 'manifest.json') {
    return res.status(200).json(buildManifest());
  }

  if (p2 === 'catalog' && p3 && p4) {
    const catalogId = p4.replace(/\.json$/, '');
    return handleCatalog(token, catalogId, reAuthUrl, res);
  }

  return res.status(404).json({ error: 'Not found' });
};
