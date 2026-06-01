// lib/trakt.js
// Fetches the user's watch history from the Trakt API.

const fetch = require('node-fetch');
const crypto = require('crypto');

const TRAKT_API_BASE = 'https://api.trakt.tv';
const TOKEN_STORE_PREFIX = 'trakt-token:';

// Common headers for all Trakt API requests.
// User-Agent is required — Cloudflare blocks requests without it from datacenter IPs.
const TRAKT_HEADERS = {
  'Content-Type': 'application/json',
  'trakt-api-version': '2',
  'trakt-api-key': process.env.TRAKT_CLIENT_ID,
  'User-Agent': 'StremioAIRecommendations/1.0',
};

// In-memory cache for refreshed access tokens keyed by refresh token.
// Avoids hammering the refresh endpoint on every request within
// the same serverless instance lifetime.
const refreshedTokenCache = new Map(); // refreshToken -> { accessToken, expiresAt }

function hasTokenStore() {
  return Boolean(getKvUrl() && getKvToken());
}

function getKvUrl() {
  return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
}

function getKvToken() {
  return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
}

async function kvRequest(path, options = {}) {
  if (!hasTokenStore()) {
    throw new Error('KV token store is not configured');
  }

  const baseUrl = getKvUrl().replace(/\/$/, '');
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getKvToken()}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    throw new Error(`KV request failed (${res.status}): ${await res.text()}`);
  }

  return res.json();
}

function tokenStoreKey(configId) {
  return `${TOKEN_STORE_PREFIX}${configId}`;
}

async function loadStoredToken(configId) {
  const data = await kvRequest(`/get/${encodeURIComponent(tokenStoreKey(configId))}`);
  if (!data || data.result == null) return null;
  return typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
}

async function saveStoredToken(configId, tokenBundle) {
  await kvRequest('', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', tokenStoreKey(configId), JSON.stringify(tokenBundle)]),
  });
}

/**
 * Parses the token parameter from the addon URL.
 *
 * Supported format: base64-encoded JSON { a: accessToken, r: refreshToken, e: expiresAtMs }
 * Legacy fallback: plain access token string.
 *
 * @param {string} tokenParam
 * @returns {{ accessToken: string, refreshToken: string|null, expiresAt: number|null }}
 */
function parseTokenParam(tokenParam) {
  try {
    const decoded = Buffer.from(tokenParam, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (parsed && parsed.a) {
      return {
        accessToken: parsed.a,
        refreshToken: parsed.r || null,
        expiresAt: parsed.e || null,
      };
    }
  } catch (_) {
    // Not base64 JSON — treat as legacy plain access token
  }
  return { accessToken: tokenParam, refreshToken: null, expiresAt: null };
}

/**
 * Encodes an access token, refresh token, and expiry into a single URL-safe base64 string.
 *
 * @param {string} accessToken
 * @param {string} refreshToken
 * @param {number} expiresAtMs  - Unix ms timestamp when the access token expires
 * @returns {string} base64-encoded token blob
 */
function encodeTokenPair(accessToken, refreshToken, expiresAtMs) {
  return Buffer.from(JSON.stringify({ a: accessToken, r: refreshToken, e: expiresAtMs })).toString('base64');
}

async function createTokenParam(accessToken, refreshToken, expiresAtMs) {
  const tokenBundle = { a: accessToken, r: refreshToken, e: expiresAtMs };

  if (!hasTokenStore()) {
    return encodeTokenPair(accessToken, refreshToken, expiresAtMs);
  }

  const configId = crypto.randomBytes(18).toString('base64url');
  await saveStoredToken(configId, tokenBundle);
  return `kv:${configId}`;
}

async function resolveTokenParam(tokenParam) {
  if (tokenParam.startsWith('kv:')) {
    const configId = tokenParam.slice(3);
    const stored = await loadStoredToken(configId);
    if (!stored || !stored.a) {
      const err = new Error('Stored Trakt token was not found; user must re-authenticate');
      err.isUnauthorized = true;
      throw err;
    }
    return {
      accessToken: stored.a,
      refreshToken: stored.r || null,
      expiresAt: stored.e || null,
      configId,
    };
  }

  return { ...parseTokenParam(tokenParam), configId: null };
}

/**
 * Uses a refresh token to obtain a new access token from Trakt.
 * Caches the result in-memory until the new token expires.
 *
 * NOTE: Requires User-Agent header — Cloudflare blocks datacenter requests without it.
 *
 * @param {string} refreshToken
 * @returns {Promise<{ accessToken: string, expiresAt: number }>}
 */
async function refreshAccessToken(refreshToken) {
  const cached = refreshedTokenCache.get(refreshToken);
  if (cached && Date.now() < cached.expiresAt - 60 * 1000) {
    return cached;
  }

  const res = await fetch(`${TRAKT_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: TRAKT_HEADERS,
    body: JSON.stringify({
      refresh_token: refreshToken,
      client_id: process.env.TRAKT_CLIENT_ID,
      client_secret: process.env.TRAKT_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Trakt token refresh failed (${res.status}): ${body}`);
    err.isUnauthorized = true;
    throw err;
  }

  const data = await res.json();
  // As of March 20, 2025 Trakt access tokens expire in 24 hours (86400s).
  // expires_in is dynamic — always use the value from the response.
  const expiresAt = Date.now() + data.expires_in * 1000;
  const result = { accessToken: data.access_token, refreshToken: data.refresh_token || refreshToken, expiresAt };
  refreshedTokenCache.set(refreshToken, result);
  return result;
}

async function refreshAndPersist(refreshToken, configId) {
  const refreshed = await refreshAccessToken(refreshToken);

  if (configId) {
    await saveStoredToken(configId, {
      a: refreshed.accessToken,
      r: refreshed.refreshToken || refreshToken,
      e: refreshed.expiresAt,
    });
  }

  return refreshed;
}

/**
 * Performs the four Trakt sync API calls with the given access token.
 *
 * @param {string} accessToken
 * @returns {Promise<Response[]>} array of four fetch responses
 */
async function fetchTraktHistory(accessToken) {
  const headers = { ...TRAKT_HEADERS, Authorization: `Bearer ${accessToken}` };

  // /sync/watched returns one entry per unique title (no pagination needed)
  // /sync/history is paginated and ordered by date — use for "recent taste"
  return Promise.all([
    fetch(`${TRAKT_API_BASE}/sync/watched/movies`, { headers }),
    fetch(`${TRAKT_API_BASE}/sync/watched/shows`, { headers }),
    fetch(`${TRAKT_API_BASE}/sync/history/movies?limit=50`, { headers }),
    fetch(`${TRAKT_API_BASE}/sync/history/shows?limit=50`, { headers }),
  ]);
}

/**
 * Returns ALL watched movies and shows using /sync/watched (complete list,
 * not paginated history). Also returns a recent slice for taste inference.
 *
 * Accepts a token parameter as a base64-encoded JSON blob (from encodeTokenPair)
 * or a legacy plain access token string.
 *
 * When a refresh token is present and the access token is expired or returns 401,
 * this function automatically refreshes and retries once.
 *
 * Throws err.isUnauthorized = true if the refresh token is also invalid
 * (user must re-authenticate).
 *
 * @param {string} tokenParam
 * @returns {{
 *   recentMovies: string[],        // last ~50 for taste inference
 *   recentShows: string[],         // last ~50 for taste inference
 *   allWatchedMovies: Set<string>, // every movie ever watched (lowercased)
 *   allWatchedShows: Set<string>,  // every show ever watched (lowercased)
 * }}
 */
async function getWatchHistory(tokenParam) {
  let { accessToken, refreshToken, expiresAt, configId } = await resolveTokenParam(tokenParam);

  const LABELS = ['watched/movies', 'watched/shows', 'history/movies', 'history/shows'];

  // Proactively refresh if the token is within 5 minutes of expiry
  const nearExpiry = expiresAt && Date.now() > expiresAt - 5 * 60 * 1000;
  if (nearExpiry && refreshToken) {
    console.log('Trakt access token near/past expiry — refreshing proactively...');
    ({ accessToken, refreshToken, expiresAt } = await refreshAndPersist(refreshToken, configId));
  }

  let responses = await fetchTraktHistory(accessToken);

  // If we get 401 and have a refresh token, try refreshing once
  const hasUnauthorized = responses.some((r) => r.status === 401 || r.status === 403);
  if (hasUnauthorized && refreshToken) {
    console.log('Trakt access token rejected — refreshing and retrying...');
    ({ accessToken, refreshToken, expiresAt } = await refreshAndPersist(refreshToken, configId));
    responses = await fetchTraktHistory(accessToken);
  }

  // Validate all responses after potential refresh
  for (let i = 0; i < responses.length; i++) {
    const res = responses[i];
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        const err = new Error(
          `Trakt ${LABELS[i]} unauthorized (${res.status}): ` +
          (refreshToken
            ? 'refresh token is also invalid — user must re-authenticate'
            : 'no refresh token available — user must re-authenticate')
        );
        err.isUnauthorized = true;
        throw err;
      }
      throw new Error(`Trakt ${LABELS[i]} fetch failed (${res.status}): ${await res.text()}`);
    }
  }

  const [watchedMovies, watchedShows, recentMovies, recentShows] =
    await Promise.all(responses.map((r) => r.json()));

  const allWatchedMovies = new Set(
    watchedMovies.map((e) => e.movie.title.toLowerCase())
  );
  const allWatchedShows = new Set(
    watchedShows.map((e) => e.show.title.toLowerCase())
  );

  const recentMovieTitles = [
    ...new Set(recentMovies.map((e) => e.movie.title)),
  ];
  const recentShowTitles = [
    ...new Set(recentShows.map((e) => e.show.title)),
  ];

  return {
    recentMovies: recentMovieTitles,
    recentShows: recentShowTitles,
    allWatchedMovies,
    allWatchedShows,
  };
}

/**
 * Returns the authenticated user's Trakt username.
 * Accepts the same token param format as getWatchHistory.
 *
 * @param {string} tokenParam
 */
async function getUsername(tokenParam) {
  const { accessToken } = await resolveTokenParam(tokenParam);
  const res = await fetch(`${TRAKT_API_BASE}/users/me`, {
    headers: { ...TRAKT_HEADERS, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return 'you';
  const data = await res.json();
  return data.username || 'you';
}

module.exports = {
  getWatchHistory,
  getUsername,
  encodeTokenPair,
  parseTokenParam,
  createTokenParam,
  hasTokenStore,
};
