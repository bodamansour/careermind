const express = require('express');
const { AppError } = require('../services/agents');
const { requireApiKey } = require('../services/auth');
const engine = require('../services/engine');

const router = express.Router();

const MAX_TEXT = 20000;

function readText(body, field, label) {
  const value = typeof body[field] === 'string' ? body[field].trim() : '';
  if (!value) throw new AppError(`${label} is required (${field}).`, 400);
  if (value.length > MAX_TEXT) throw new AppError(`${label} is too long (max ${MAX_TEXT} characters).`, 400);
  return value;
}

// Server-to-server endpoint for the n8n automations (Applicant Screening, and
// Job Hunter without an account). Needs the shared CAREERMIND_API_KEY.
// POST /api/match  { cvText, jdText }  ->  match score and skill lists
router.post('/', requireApiKey, async (req, res, next) => {
  try {
    const body = req.body || {};
    const cvText = readText(body, 'cvText', 'CV text');
    const jdText = readText(body, 'jdText', 'Job description');

    const [cv, job] = await Promise.all([engine.analyzeCv(cvText), engine.analyzeJob(jdText)]);
    const matching = await engine.match(cv, job);

    res.json({
      job_title: job.job_title || null,
      candidate_name: cv.name || null,
      job_match_score: matching.job_match_score,
      matching_skills: matching.matching_skills,
      partial_match_skills: matching.partial_match_skills,
      missing_skills: matching.missing_skills,
      meets_level: engine.fitsEntryLevel(job),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
