const express = require('express');
const { randomUUID } = require('crypto');
const { AppError, callFlow, parseModelJSON } = require('../services/aimicromind');

const router = express.Router();

const MAX_ANSWER_LENGTH = 5000;
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

// Start a new mock interview session
router.post('/start', async (req, res, next) => {
  try {
    const { cv, job } = req.body || {};
    if (!cv || !job) throw new AppError('Run the analysis first — cv and job data are required.', 400);

    const sessionId = randomUUID();
    const question =
      `CV_DATA:\n${JSON.stringify(cv)}\n\n` +
      `JOB_DATA:\n${JSON.stringify(job)}\n\n` +
      `Start the interview.`;

    const reply = await callFlow('interview', question, sessionId);

    res.json({ sessionId, message: reply, isFinal: false });
  } catch (err) {
    next(err);
  }
});

// Send the candidate's answer, get the next question (or the final evaluation)
router.post('/message', async (req, res, next) => {
  try {
    const { sessionId } = req.body || {};
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!sessionId || !message) throw new AppError('sessionId and message are required.', 400);
    if (!UUID_RE.test(sessionId)) throw new AppError('Invalid interview session. Start a new interview.', 400);
    if (message.length > MAX_ANSWER_LENGTH) {
      throw new AppError(`Answer is too long (max ${MAX_ANSWER_LENGTH} characters).`, 400);
    }

    const reply = await callFlow('interview', message, sessionId);
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
