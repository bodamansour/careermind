const express = require('express');
const { randomUUID } = require('crypto');
const { AppError, parseModelJSON, runInterviewTurn } = require('../services/agents');

const router = express.Router();

const MAX_ANSWER_LENGTH = 5000;
const MAX_HISTORY = 40;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toScore(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The agent's final message is a JSON evaluation. Detect it by trying to parse it.
// Models sometimes send scores as strings ("85"), so accept anything numeric.
function extractEvaluation(reply) {
  let parsed;
  try {
    parsed = parseModelJSON(reply);
  } catch (_) {
    return null; // not the final JSON yet - just a normal question/feedback message
  }
  if (!parsed || typeof parsed !== 'object' || toScore(parsed.overall_score) == null) return null;

  return {
    ...parsed,
    overall_score: toScore(parsed.overall_score),
    technical_score: toScore(parsed.technical_score),
    communication_score: toScore(parsed.communication_score),
    completeness_score: toScore(parsed.completeness_score),
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
    areas_to_improve: Array.isArray(parsed.areas_to_improve) ? parsed.areas_to_improve : [],
  };
}

// The built-in LLM is stateless, so the client sends back the conversation so far.
function validHistory(history) {
  if (history == null) return [];
  if (
    !Array.isArray(history) ||
    history.length > MAX_HISTORY ||
    !history.every(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.length <= MAX_ANSWER_LENGTH * 2
    )
  ) {
    throw new AppError('Invalid interview history. Start a new interview.', 400);
  }
  return history.map((m) => ({ role: m.role, content: m.content }));
}

function requireReply(reply) {
  if (!reply || !String(reply).trim()) {
    throw new AppError('Interview Agent returned an empty reply. Try sending your answer again.', 502);
  }
  return reply;
}

// Start a new mock interview session
router.post('/start', async (req, res, next) => {
  try {
    const { cv, job } = req.body || {};
    if (!cv || !job) throw new AppError('Run the analysis first — cv and job data are required.', 400);

    const sessionId = randomUUID();
    const reply = requireReply(await runInterviewTurn({ cv, job, sessionId }));

    res.json({ sessionId, message: reply, isFinal: false });
  } catch (err) {
    next(err);
  }
});

// Send the candidate's answer, get the next question (or the final evaluation)
router.post('/message', async (req, res, next) => {
  try {
    const { sessionId, cv, job } = req.body || {};
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!sessionId || !message) throw new AppError('sessionId and message are required.', 400);
    if (!UUID_RE.test(sessionId)) throw new AppError('Invalid interview session. Start a new interview.', 400);
    if (message.length > MAX_ANSWER_LENGTH) {
      throw new AppError(`Answer is too long (max ${MAX_ANSWER_LENGTH} characters).`, 400);
    }

    const history = validHistory(req.body.history);

    const reply = requireReply(await runInterviewTurn({ cv, job, sessionId, history, message }));
    const evaluation = extractEvaluation(reply);

    res.json({
      message: evaluation ? null : reply,
      isFinal: !!evaluation,
      evaluation,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
