const axios = require('axios');
const prompts = require('./prompts');

// The 6 agents. Each one runs on the built-in LLM (OpenRouter) by default, or on
// an AiMicromind (Flowise) chatflow when its URL env variable is set.
const AGENTS = {
  cv: { name: 'CV Analyzer', env: 'CV_ANALYZER_URL', prompt: prompts.CV_ANALYZER },
  job: { name: 'Job Analyzer', env: 'JOB_ANALYZER_URL', prompt: prompts.JOB_ANALYZER },
  matching: { name: 'Matching Agent', env: 'MATCHING_URL', prompt: prompts.MATCHING },
  skillGap: { name: 'Skill Gap Agent', env: 'SKILLGAP_URL', prompt: prompts.SKILL_GAP },
  roadmap: { name: 'Roadmap Agent', env: 'ROADMAP_URL', prompt: prompts.ROADMAP },
  interview: { name: 'Interview Agent', env: 'INTERVIEW_URL', prompt: prompts.INTERVIEW },
};

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openrouter/free';
const TIMEOUT_MS = Number(process.env.FLOW_TIMEOUT_MS) || 90000;

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

function flowUrl(agentKey) {
  const url = (process.env[AGENTS[agentKey].env] || '').trim();
  return url && !url.includes('REPLACE_ME') ? url : null;
}

/** 'flow', 'llm' or null (not configured) for each agent. */
function agentMode(agentKey) {
  if (flowUrl(agentKey)) return 'flow';
  if (process.env.OPENROUTER_API_KEY) return 'llm';
  return null;
}

function missingAgents() {
  return Object.keys(AGENTS).filter((key) => !agentMode(key));
}

function notConfigured(agent) {
  return new AppError(
    `${agent.name} is not configured. Set OPENROUTER_API_KEY (free at openrouter.ai), ` +
      `or ${agent.env} to an AiMicromind flow URL.`,
    503
  );
}

// ---------- AiMicromind (Flowise) ----------

async function callFlow(agentKey, question, sessionId) {
  const agent = AGENTS[agentKey];
  const payload = { question };
  if (sessionId) payload.overrideConfig = { sessionId };

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.AIMICROMIND_API_KEY) {
    headers.Authorization = `Bearer ${process.env.AIMICROMIND_API_KEY}`;
  }

  let response;
  try {
    response = await axios.post(flowUrl(agentKey), payload, { headers, timeout: TIMEOUT_MS });
  } catch (err) {
    throw toAgentError(agent, err, { key: 'AIMICROMIND_API_KEY', url: agent.env });
  }

  // Flowise typically replies as { text: "..." } but some setups return the
  // raw string or an object directly. Handle all three shapes.
  const data = response.data;
  if (typeof data === 'string') return data;
  if (data && typeof data.text === 'string') return data.text;
  if (data && typeof data.answer === 'string') return data.answer;
  return JSON.stringify(data);
}

// ---------- Built-in LLM (OpenRouter) ----------

async function callLLM(agentKey, messages) {
  const agent = AGENTS[agentKey];
  let response;
  try {
    response = await axios.post(
      OPENROUTER_URL,
      {
        model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
        messages: [{ role: 'system', content: agent.prompt }, ...messages],
        temperature: agentKey === 'interview' ? 0.7 : 0.2,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Title': 'CareerMind AI',
        },
        timeout: TIMEOUT_MS,
      }
    );
  } catch (err) {
    throw toAgentError(agent, err, { key: 'OPENROUTER_API_KEY', url: 'OPENROUTER_MODEL' });
  }

  const data = response.data || {};
  if (data.error) {
    console.error(`${agent.name} LLM error:`, JSON.stringify(data.error).slice(0, 300));
    throw new AppError(`${agent.name} failed: the AI model returned an error. Try again shortly.`, 502);
  }
  return data.choices?.[0]?.message?.content || '';
}

function toAgentError(agent, err, names) {
  const status = err.response && err.response.status;
  console.error(`${agent.name} request failed:`, status || err.code, err.message);

  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    return new AppError(`${agent.name} took too long to respond. Try again in a moment.`, 504);
  }
  if (status === 401 || status === 403) {
    return new AppError(`${agent.name} rejected the request (HTTP ${status}). Check ${names.key}.`, 502);
  }
  if (status === 402) {
    return new AppError(`${agent.name}: the AI account is out of credits. Add credits or use a free model.`, 502);
  }
  if (status === 404) {
    return new AppError(`${agent.name} was not found (HTTP 404). Check ${names.url}.`, 502);
  }
  if (status === 429) {
    return new AppError(`${agent.name} is rate limited. Wait a minute and try again.`, 503);
  }
  if (status) {
    return new AppError(`${agent.name} failed (HTTP ${status}). Try again shortly.`, 502);
  }
  return new AppError(`Could not reach ${agent.name}. Check your network and try again.`, 502);
}

// ---------- Parsing ----------

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

// ---------- Public API ----------

/** Runs a single-shot agent (1-5) and returns its reply parsed as JSON. */
async function runJSONAgent(agentKey, input) {
  const agent = AGENTS[agentKey];
  const mode = agentMode(agentKey);
  if (!mode) throw notConfigured(agent);

  // One retry: models occasionally wrap or truncate their JSON.
  let raw = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    raw = mode === 'flow'
      ? await callFlow(agentKey, input)
      : await callLLM(agentKey, [{ role: 'user', content: input }]);
    try {
      return parseModelJSON(raw);
    } catch (_) {
      console.error(`${agent.name} returned non-JSON (attempt ${attempt}):`, String(raw).slice(0, 500));
    }
  }
  throw new AppError(`${agent.name} returned an unexpected format. Please try again.`, 502);
}

/**
 * One interview turn. AiMicromind flows keep the conversation in their own
 * Buffer Memory (by sessionId); the built-in LLM is stateless, so the client
 * sends the history and we rebuild the conversation each turn.
 * @param {object} opts { cv, job, sessionId, history: [{role, content}], message? }
 * @returns {Promise<string>} the agent's raw reply
 */
async function runInterviewTurn({ cv, job, sessionId, history = [], message }) {
  const agent = AGENTS.interview;
  const mode = agentMode('interview');
  if (!mode) throw notConfigured(agent);

  const opening =
    `CV_DATA:\n${JSON.stringify(cv)}\n\nJOB_DATA:\n${JSON.stringify(job)}\n\nStart the interview.`;

  if (mode === 'flow') return callFlow('interview', message || opening, sessionId);

  const messages = [{ role: 'user', content: opening }, ...history];
  if (message) messages.push({ role: 'user', content: message });

  const answers = messages.filter((m) => m.role === 'user').length - 1;
  if (answers >= prompts.INTERVIEW_QUESTIONS) {
    messages.push({ role: 'system', content: prompts.INTERVIEW_FINISH });
  }
  return callLLM('interview', messages);
}

module.exports = {
  AGENTS,
  AppError,
  agentMode,
  missingAgents,
  parseModelJSON,
  runJSONAgent,
  runInterviewTurn,
};
