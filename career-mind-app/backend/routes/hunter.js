const express = require('express');
const { AppError } = require('../services/agents');
const { requireApiKey } = require('../services/auth');
const { db, check } = require('../services/db');
const engine = require('../services/engine');
const jobStore = require('../services/jobStore');

const router = express.Router();
router.use(requireApiKey);

const MAX_JOBS = 10;

const str = (value, max) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, max) : '');

function cleanJob(raw, i) {
  const job = raw && typeof raw === 'object' ? raw : {};
  const out = {
    source: str(job.source, 40).toLowerCase(),
    external_id: str(job.external_id, 300),
    title: str(job.title, 300),
    company: str(job.company, 200) || null,
    location: str(job.location, 200) || null,
    description: str(job.description, 20000),
    salary: str(job.salary, 200) || null,
    apply_email: str(job.apply_email, 200) || null,
    url: str(job.url, 2000) || null,
    posted_at: null,
  };
  const label = `jobs[${i}]`;
  if (!out.source || !out.external_id) throw new AppError(`${label}: source and external_id are required.`, 400);
  if (!out.title) throw new AppError(`${label}: title is required.`, 400);
  if (out.description.length < 30) throw new AppError(`${label}: description is required (at least 30 characters).`, 400);
  if (out.url && !/^https?:\/\//i.test(out.url)) out.url = null;
  const posted = job.posted_at ? new Date(job.posted_at) : null;
  if (posted && !Number.isNaN(posted.getTime())) out.posted_at = posted.toISOString();
  return out;
}

/**
 * POST /api/hunter/jobs  { report_for: "email", jobs: [...] }
 * Saves the jobs (de-duplicated by source id and URL), links them to the
 * Job Hunter owner's account, scores them with the CareerMind engine, and
 * returns one result per job: a score, or score_status "failed" with the error
 * (retried on the next run; no other engine fills in).
 */
router.post('/jobs', async (req, res, next) => {
  try {
    const body = req.body || {};
    const email = str(body.report_for, 200).toLowerCase();
    if (!email) throw new AppError('report_for (the email of your CareerMind account) is required.', 400);
    if (!Array.isArray(body.jobs) || body.jobs.length === 0) throw new AppError('jobs must be a non-empty array.', 400);
    if (body.jobs.length > MAX_JOBS) throw new AppError(`Send at most ${MAX_JOBS} jobs per request.`, 400);
    const jobs = body.jobs.map(cleanJob);

    const rows = check(
      await db().from('profiles').select('id, email, cv_profile, cv_updated_at').ilike('email', email).limit(1),
      'find the user'
    );
    const owner = rows[0];
    if (!owner) throw new AppError(`No CareerMind account uses ${email}. Sign up in the app first.`, 404);
    if (!owner.cv_profile) throw new AppError('That account has no CV yet. Upload it in the app (My jobs).', 409);

    const stored = await jobStore.upsertJobs(jobs);
    const matches = await jobStore.scoreJobsForUser(owner, stored, { origin: 'job-hunter' });

    const results = jobs.map((job, i) => {
      const row = stored[i];
      const m = matches[i] || {};
      const out = { source: job.source, external_id: job.external_id, job_id: row.id, score_status: m.score_status || 'failed' };
      if (out.score_status !== 'scored') return { ...out, score: null, error: m.score_error || 'Not scored.' };
      return {
        ...out,
        score: m.score,
        meets_level: engine.fitsEntryLevel(row.analysis),
        matching_skills: m.matching_skills || [],
        partial_match_skills: m.partial_match_skills || [],
        missing_skills: m.missing_skills || [],
        summary: m.summary || null,
      };
    });

    res.json({
      received: jobs.length,
      scored: results.filter((r) => r.score_status === 'scored').length,
      failed: results.filter((r) => r.score_status !== 'scored').length,
      results,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
