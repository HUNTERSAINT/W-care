// Google Gemini client (free tier available: https://aistudio.google.com/apikey).
// Model names change often and old ones get retired, so we ask Google which flash models exist,
// remember the one that works, and skip models that are retired or overloaded for a while.
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

let listCache = null;          // { models, at }
let good = null;               // last model that answered successfully
const benched = new Map();     // model -> timestamp until which we skip it

const bench = (model, ms) => benched.set(model, Date.now() + ms);

async function listModels(apiKey) {
  if (listCache && Date.now() - listCache.at < 3600_000) return listCache.models;
  const res = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Could not list Gemini models (HTTP ${res.status})`);
  const data = await res.json();
  const names = (data.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => (m.name || '').replace(/^models\//, ''))
    .filter((n) => /^gemini-[\d.]+-flash(-lite)?$/.test(n));
  // Regular flash before lite, newest version first.
  names.sort((a, b) => {
    const rank = (n) => (n.includes('lite') ? 1 : 0);
    return rank(a) - rank(b) || b.localeCompare(a, undefined, { numeric: true });
  });
  if (!names.length) throw new Error('No Gemini flash model is available for this API key');
  listCache = { models: names, at: Date.now() };
  return names;
}

async function candidates(apiKey) {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];
  let list;
  try { list = await listModels(apiKey); } catch (e) { if (good) list = [good]; else throw e; }
  const alive = list.filter((m) => !(benched.get(m) > Date.now()));
  const pool = alive.length ? alive : list; // everything benched: try them all anyway
  const ordered = good && pool.includes(good) ? [good, ...pool.filter((m) => m !== good)] : pool;
  // At most 3 regular models plus 1 lite model as the fast last resort.
  const regular = ordered.filter((m) => !m.includes('lite')).slice(0, 3);
  const lite = ordered.filter((m) => m.includes('lite')).slice(0, 1);
  return [...regular, ...lite];
}

// Sends one request and returns the parsed JSON object the model produced.
export async function generateJson({ system, contents, schema, maxTokens = 1024, temperature = 0.4, timeoutMs = 15000 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  let lastError = 'unknown error';
  for (const model of await candidates(apiKey)) {
    const started = Date.now();
    try {
      const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: {
            temperature, maxOutputTokens: maxTokens, responseMimeType: 'application/json', responseSchema: schema,
            ...(/^gemini-2\.5-flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
        lastError = `HTTP ${res.status} from ${model}: ${detail}`;
        console.error(`gemini failed ${lastError}`);
        if (res.status === 404) { bench(model, 6 * 3600_000); if (good === model) good = null; continue; } // retired
        if ([429, 500, 503].includes(res.status)) { bench(model, 3 * 60_000); if (good === model) good = null; continue; } // busy
        throw new Error(lastError); // bad key / bad request: another model will not help
      }
      const data = await res.json();
      const cand = data.candidates?.[0];
      if (!cand || data.promptFeedback?.blockReason) {
        throw new Error(`Blocked by the AI provider (${data.promptFeedback?.blockReason || 'no answer'})`);
      }
      const raw = (cand.content?.parts || []).map((p) => p.text || '').join('').trim();
      let parsed;
      try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new Error('The AI returned an unreadable answer'); }
      good = model;
      console.log(`gemini ok model=${model} ${Date.now() - started}ms`);
      return parsed;
    } catch (e) {
      if (e.name === 'TimeoutError') {
        lastError = `${model}: timed out after ${Math.round(timeoutMs / 1000)}s`;
        console.error(`gemini error ${lastError}`);
        bench(model, 3 * 60_000); if (good === model) good = null;
        continue;
      }
      if (/^HTTP |Blocked by|unreadable answer/.test(e.message)) throw e;
      lastError = `${model}: ${e.message}`;
      console.error(`gemini error ${lastError}`);
    }
  }
  throw new Error(lastError);
}
