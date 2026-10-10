const axios = require('axios');

// Each agent is a separate AiMicromind (Flowise) chatflow, configured via env.
const AGENTS = {
  cv: { name: 'CV Analyzer', env: 'CV_ANALYZER_URL' },
  job: { name: 'Job Analyzer', env: 'JOB_ANALYZER_URL' },
  matching: { name: 'Matching Agent', env: 'MATCHING_URL' },
  skillGap: { name: 'Skill Gap Agent', env: 'SKILLGAP_URL' },
  roadmap: { name: 'Roadmap Agent', env: 'ROADMAP_URL' },
  interview: { name: 'Interview Agent', env: 'INTERVIEW_URL' },
};

const FLOW_TIMEOUT_MS = Number(process.env.FLOW_TIMEOUT_MS) || 90000;

/**
 * Error carrying the HTTP status the API should answer with, so routes can
 * forward a clear message instead of a generic 500.
 */
class AppError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

function isConfigured(agentKey) {
  const url = process.env[AGENTS[agentKey].env];
  return !!url && !url.includes('REPLACE_ME');
}

function missingAgents() {
  return Object.keys(AGENTS).filter((key) => !isConfigured(key));
}

/**
 * Calls a single AiMicromind (Flowise) chatflow.
 * @param {string} agentKey - one of the keys of AGENTS
 * @param {string} question - the text sent as the "question" field
 * @param {string} [sessionId] - pass this to keep Buffer Memory context (used by the Interview Agent)
 * @returns {Promise<string>} the raw text reply from the flow
 */
async function callFlow(agentKey, question, sessionId) {
  const agent = AGENTS[agentKey];
  if (!isConfigured(agentKey)) {
    throw new AppError(
      `${agent.name} is not configured. Set ${agent.env} to its AiMicromind prediction URL.`,
      503
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

  let response;
  try {
    response = await axios.post(process.env[agent.env], payload, {
      headers,
      timeout: FLOW_TIMEOUT_MS,
    });
  } catch (err) {
    throw toAgentError(agent, err);
  }

  // Flowise typically replies as { text: "..." } but some setups return the
  // raw string or an object directly. Handle all three shapes.
  const data = response.data;
  let text;
  if (typeof data === 'string') text = data;
  else if (data && typeof data.text === 'string') text = data.text;
  else if (data && typeof data.answer === 'string') text = data.answer;
  else text = JSON.stringify(data);

  if (!text || !text.trim()) {
    throw new AppError(`${agent.name} returned an empty reply. Try again.`, 502);
  }
  return text;
}

function toAgentError(agent, err) {
  const status = err.response && err.response.status;
  console.error(`${agent.name} request failed:`, status || err.code, err.message);

  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    return new AppError(`${agent.name} took too long to respond. Try again in a moment.`, 504);
  }
  if (status === 401 || status === 403) {
    return new AppError(
      `${agent.name} rejected the request (HTTP ${status}). Check AIMICROMIND_API_KEY.`,
      502
    );
  }
  if (status === 404) {
    return new AppError(
      `${agent.name} flow was not found (HTTP 404). Check ${agent.env}.`,
      502
    );
  }
  if (status === 429) {
    return new AppError(`${agent.name} is rate limited. Wait a minute and try again.`, 503);
  }
  if (status) {
    return new AppError(`${agent.name} failed (HTTP ${status}). Try again shortly.`, 502);
  }
  return new AppError(`Could not reach ${agent.name}. Check your network and the flow URL.`, 502);
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

/** Calls an agent and parses its reply as JSON, with an agent-specific error. */
async function callFlowJSON(agentKey, question) {
  const raw = await callFlow(agentKey, question);
  try {
    return parseModelJSON(raw);
  } catch (err) {
    console.error(`${AGENTS[agentKey].name} returned non-JSON:`, raw.slice(0, 500));
    throw new AppError(
      `${AGENTS[agentKey].name} returned an unexpected format. Try again — if it keeps ` +
        'happening, make its System Message stricter about replying with JSON only.',
      502
    );
  }
}

module.exports = { AGENTS, AppError, callFlow, callFlowJSON, parseModelJSON, missingAgents };
