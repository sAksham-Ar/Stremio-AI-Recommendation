// lib/cinemeta.js
// Looks up metadata (poster, IMDB ID, description) via the Cinemeta addon API.
// Cinemeta is the official Stremio metadata provider — no API key needed.

const fetch = require('node-fetch');
const { AbortController } = globalThis;

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const TIMEOUT_MS = 4000;
// Max simultaneous Cinemeta requests — avoids hammering the API and keeps
// total enrichment time bounded (4 concurrent × ~400ms each ≈ ~2s for 20 items)
const CONCURRENCY = 5;

/**
 * Search Cinemeta for a title and return its Stremio meta object.
 */
async function searchMeta(title, type) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const encoded = encodeURIComponent(title);
    const res = await fetch(
      `${CINEMETA_BASE}/catalog/${type}/top/search=${encoded}.json`,
      { signal: controller.signal }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.metas && data.metas.length > 0 ? data.metas[0] : null;
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(`Cinemeta search failed for "${title}":`, err.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run an array of async tasks with a max concurrency limit.
 */
async function pLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * Converts AI recommendation items into Stremio catalog meta objects.
 */
async function enrichRecommendations(recommendations) {
  const tasks = recommendations.map((rec) => async () => {
    const stremioType = rec.type === 'series' ? 'series' : 'movie';
    const meta = await searchMeta(rec.title, stremioType);

    if (meta) {
      return {
        ...meta,
        description: rec.reason
          ? `AI Pick: ${rec.reason}\n\n${meta.description || ''}`
          : meta.description,
      };
    }

    // Fallback minimal item (no poster — filtered below)
    return {
      id: `ai_rec:${stremioType}:${encodeURIComponent(rec.title)}`,
      type: stremioType,
      name: rec.title,
      description: rec.reason || '',
      releaseInfo: rec.year ? String(rec.year) : '',
      poster: null,
    };
  });

  const results = await pLimit(tasks, CONCURRENCY);
  // Only keep items with a real poster so broken tiles don't appear
  return results.filter((m) => m && m.id && m.poster);
}

module.exports = { enrichRecommendations };
