const axios = require('axios');

/**
 * Calls a single AiMicromind (Flowise) chatflow.
 * @param {string} url - the flow's prediction API URL
 * @param {string} question - the text sent as the "question" field
 * @param {string} [sessionId] - pass this to keep Buffer Memory context (used by the Interview Agent)
 * @returns {Promise<string>} the raw text reply from the flow
 */
async function callFlow(url, question, sessionId) {
  if (!url || url.includes('REPLACE_ME')) {
    throw new Error(
      `Missing flow URL. Set the correct value in your .env file for this agent.`
    );
  }

  const payload = { question };
  if (sessionId) {
    payload.overrideConfig = { sessionId };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.AIMICROMIND_API_KEY) {
    headers.Authorization = `Bearer ${process.env.AIMICROMIND_API_KEY}`;
  }

  const response = await axios.post(url, payload, { headers, timeout: 60000 });

  // Flowise typically replies as { text: "..." } but some setups return the
  // raw string or an object directly. Handle all three shapes.
  const data = response.data;
  if (typeof data === 'string') return data;
  if (data && typeof data.text === 'string') return data.text;
  if (data && typeof data.answer === 'string') return data.answer;
  return JSON.stringify(data);
}

/**
 * Extracts a JSON object/array from a model reply that might be:
 * - clean JSON
 * - JSON wrapped in ```json ... ``` fences
 * - JSON with extra prose around it
 */
function parseModelJSON(raw) {
  if (raw == null) throw new Error('Empty response from agent.');

  // 1. Try straight parse
  try {
    return JSON.parse(raw);
  } catch (_) {
    /* fall through */
  }

  // 2. Strip markdown code fences if present
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_) {
      /* fall through */
    }
  }

  // 3. Grab the first {...} or [...] block found in the text
  const braceMatch = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[1]);
    } catch (_) {
      /* fall through */
    }
  }

  throw new Error('Could not parse JSON from agent response: ' + raw.slice(0, 200));
}

/**
 * Turns a model-produced score into a number between 0 and 100.
 * Models sometimes return scores as strings ("85") or with a "%" sign,
 * which would break the readiness math in the frontend.
 * @returns {number|null} the score, or null when it isn't a usable number
 */
function toScore(value) {
  if (typeof value === 'string') value = value.trim().replace(/%$/, '');
  if (value === '' || value == null || typeof value === 'boolean') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

const EVALUATION_SCORES = [
  'technical_score',
  'communication_score',
  'completeness_score',
  'overall_score',
];

/**
 * Detects the Interview Agent's final JSON evaluation and normalizes its scores.
 * @returns {object|null} the evaluation with numeric scores, or null if `parsed`
 *   isn't a final evaluation (no usable overall_score)
 */
function normalizeEvaluation(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (toScore(parsed.overall_score) == null) return null;

  const evaluation = { ...parsed };
  for (const key of EVALUATION_SCORES) evaluation[key] = toScore(parsed[key]);
  for (const key of ['strengths', 'areas_to_improve']) {
    evaluation[key] = Array.isArray(parsed[key]) ? parsed[key].map(String) : [];
  }
  return evaluation;
}

module.exports = { callFlow, parseModelJSON, toScore, normalizeEvaluation };
