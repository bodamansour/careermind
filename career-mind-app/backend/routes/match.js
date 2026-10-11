const crypto = require('crypto');
const express = require('express');
const { AppError, runJSONAgent, toScore } = require('../services/agents');

const router = express.Router();

const MAX_TEXT = 20000;

// Server-to-server endpoint for the n8n automations (Job Hunter and Applicant
// Screening). It needs a shared key so the public demo can't be used to spend
// LLM credits; without CAREERMIND_API_KEY the endpoint is off.
function checkKey(req) {
  const expected = process.env.CAREERMIND_API_KEY || '';
  if (!expected) {
    throw new AppError('The match API is not enabled. Set CAREERMIND_API_KEY on the server.', 503);
  }
  const given = Buffer.from(String(req.get('x-api-key') || ''));
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    throw new AppError('Missing or wrong x-api-key header.', 401);
  }
}

function readText(body, field, label) {
  const value = typeof body[field] === 'string' ? body[field].trim() : '';
  if (!value) throw new AppError(`${label} is required (${field}).`, 400);
  if (value.length > MAX_TEXT) throw new AppError(`${label} is too long (max ${MAX_TEXT} characters).`, 400);
  return value;
}

const list = (value) => (Array.isArray(value) ? value.map(String) : []);

// POST /api/match  { cvText, jdText }  ->  match score and skill lists
router.post('/', async (req, res, next) => {
  try {
    checkKey(req);
    const body = req.body || {};
    const cvText = readText(body, 'cvText', 'CV text');
    const jdText = readText(body, 'jdText', 'Job description');

    const [cv, job] = await Promise.all([runJSONAgent('cv', cvText), runJSONAgent('job', jdText)]);
    const matching = await runJSONAgent(
      'matching',
      `CV_DATA:\n${JSON.stringify(cv)}\n\nJOB_DATA:\n${JSON.stringify(job)}`
    );

    res.json({
      job_title: job.job_title || null,
      candidate_name: cv.name || null,
      job_match_score: toScore(matching.job_match_score),
      matching_skills: list(matching.matching_skills),
      partial_match_skills: list(matching.partial_match_skills),
      missing_skills: list(matching.missing_skills),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
