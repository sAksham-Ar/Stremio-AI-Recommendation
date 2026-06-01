// lib/ai.js
// Uses Mistral AI to generate movie/series recommendations based on watch history.

const { Mistral } = require('@mistralai/mistralai');

// Free tier model - mistral-small-latest has a free tier on La Plateforme
const MODEL = 'mistral-small-latest';

/**
 * Given a watch history, asks Mistral to recommend titles.
 * @param {{
 *   recentMovies: string[],
 *   recentShows: string[],
 *   allWatchedMovies: Set<string>,
 *   allWatchedShows: Set<string>,
 * }} history
 * @param {'movie'|'series'} type
 * @param {number} count - number of recommendations to return
 * @returns {Promise<Array<{ title: string, year: number|null, type: 'movie'|'series', reason: string }>>}
 */
async function getRecommendations(history, type = 'movie', count = 20) {
  const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

  const movieList = history.recentMovies.slice(0, 30).join(', ') || 'none';
  const showList = history.recentShows.slice(0, 30).join(', ') || 'none';

  // Build a compact exclusion list from the full watched sets
  // Cap at 200 titles to stay within token limits
  const excludeMovies = [...history.allWatchedMovies].slice(0, 100).join(', ');
  const excludeShows = [...history.allWatchedShows].slice(0, 100).join(', ');

  let typeInstruction = '';
  if (type === 'movie') {
    typeInstruction = `Return ONLY movie recommendations. The "type" field must be "movie" for every item.`;
  } else {
    typeInstruction = `Return ONLY TV series/show recommendations. The "type" field must be "series" for every item.`;
  }

  const prompt = `You are a personalized movie and TV show recommendation engine.

The user has watched these movies recently (use for taste inference): ${movieList}
The user has watched these TV shows recently (use for taste inference): ${showList}

STRICT EXCLUSION — never recommend anything from these lists:
Movies already watched: ${excludeMovies || 'none'}
Shows already watched: ${excludeShows || 'none'}

Based on their taste, recommend exactly ${count} titles they have NOT watched.
${typeInstruction}

Rules:
- NEVER recommend any title that appears in the exclusion lists above.
- Prioritize hidden gems and critically acclaimed titles that match the user's taste.
- Each item must have a brief, specific reason (1 sentence) why it suits this user's taste.
- Return ONLY valid JSON — no markdown, no explanation, no code block.

Required JSON format (array of objects):
[
  {
    "title": "Exact Title",
    "year": 2021,
    "type": "movie",
    "reason": "One sentence why the user would love this."
  }
]

The "type" field must be exactly "movie" or "series".
The "year" field is the release year as a number, or null if unknown.`;

  const response = await client.chat.complete({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    maxTokens: 2000,
  });

  const raw = response.choices[0].message.content.trim();

  // Strip markdown code fences if the model wraps the JSON
  const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  let recommendations;
  try {
    recommendations = JSON.parse(jsonStr);
  } catch {
    console.error('Failed to parse AI response:', raw);
    throw new Error('AI returned invalid JSON');
  }

  if (!Array.isArray(recommendations)) {
    throw new Error('AI response is not an array');
  }

  // Server-side filter: remove anything that appears in the watched sets
  const watchedSet = type === 'movie' ? history.allWatchedMovies : history.allWatchedShows;
  const filtered = recommendations.filter(
    (r) => !watchedSet.has(r.title.toLowerCase())
  );

  return filtered.slice(0, count);
}

module.exports = { getRecommendations };
