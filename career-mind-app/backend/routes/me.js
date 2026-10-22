// Signed-in user's dashboard API: their CV, their job feed, saved analyses.
const crypto = require('crypto');
const express = require('express');
const { AppError } = require('../services/agents');
const { requireUser } = require('../services/auth');
const { db, check } = require('../services/db');
const engine = require('../services/engine');
const jobStore = require('../services/jobStore');
const { upload, extractPdfText } = require('../services/pdf');

const router = express.Router();
router.use(requireUser);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['new', 'saved', 'applied', 'hidden'];
const RESCORE_BATCH = 4;
const FEED_DAYS = 30;

function uuidParam(value, what) {
  if (!UUID_RE.test(String(value || ''))) throw new AppError(`Invalid ${what}.`, 400);
  return value;
}

async function getProfile(userId) {
  const rows = check(await db().from('profiles').select('*').eq('id', userId).limit(1), 'load your profile');
  if (!rows[0]) throw new AppError('Profile not found. Sign out and sign in again.', 404);
  return rows[0];
}

function publicProfile(p) {
  const cv = p.cv_profile || {};
  return {
    email: p.email,
    full_name: p.full_name || cv.name || null,
    has_cv: !!p.cv_profile,
    cv_updated_at: p.cv_updated_at,
    cv: p.cv_profile ? { name: cv.name || null, current_title: cv.current_title || null, skills: engine.list(cv.skills).slice(0, 30) } : null,
  };
}

async function getJob(jobId) {
  const rows = check(await db().from('jobs').select('*').eq('id', jobId).limit(1), 'load the job');
  if (!rows[0]) throw new AppError('Job not found.', 404);
  return rows[0];
}

const since = (days) => new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

// ---------- Profile and CV ----------

router.get('/', async (req, res, next) => {
  try {
    res.json(publicProfile(await getProfile(req.user.id)));
  } catch (err) {
    next(err);
  }
});

router.post('/cv', upload.single('cvFile'), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('No CV file uploaded.', 400);
    const cvText = await extractPdfText(req.file.buffer);
    const cvProfile = await engine.analyzeCv(cvText);
    const rows = check(
      await db()
        .from('profiles')
        .update({ cv_text: cvText, cv_profile: cvProfile, cv_updated_at: new Date().toISOString() })
        .eq('id', req.user.id)
        .select('*'),
      'save your CV'
    );
    res.json(publicProfile(rows[0]));
  } catch (err) {
    next(err);
  }
});

// ---------- Job feed ----------

// GET /api/me/jobs?status=new&min=0  ->  scored jobs, best first
router.get('/jobs', async (req, res, next) => {
  try {
    const status = String(req.query.status || 'active');
    const min = Math.max(0, Math.min(100, Number(req.query.min) || 0));
    let query = db()
      .from('job_matches')
      .select('score, matching_skills, partial_match_skills, missing_skills, summary, status, scored_at, job:jobs!inner(id, source, title, company, location, url, salary, apply_email, posted_at, created_at)')
      .eq('user_id', req.user.id)
      .gte('job.created_at', since(FEED_DAYS))
      .gte('score', min)
      .order('score', { ascending: false, nullsFirst: false })
      .limit(150);
    if (status === 'active') query = query.in('status', ['new', 'saved']);
    else if (STATUSES.includes(status)) query = query.eq('status', status);
    else if (status !== 'all') throw new AppError('Unknown status filter.', 400);

    const rows = check(await query, 'load your jobs');
    res.json({ jobs: rows });
  } catch (err) {
    next(err);
  }
});

router.patch('/jobs/:jobId', async (req, res, next) => {
  try {
    const jobId = uuidParam(req.params.jobId, 'job');
    const status = req.body?.status;
    if (!STATUSES.includes(status)) throw new AppError(`status must be one of: ${STATUSES.join(', ')}.`, 400);
    const rows = check(
      await db().from('job_matches').update({ status }).eq('user_id', req.user.id).eq('job_id', jobId).select('job_id, status'),
      'update the job'
    );
    if (!rows.length) throw new AppError('Job not found in your list.', 404);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/me/jobs  { title, company?, location?, url?, description }  ->  save one job and score it
router.post('/jobs', async (req, res, next) => {
  try {
    const b = req.body || {};
    const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const job = {
      title: s(b.title, 300),
      company: s(b.company, 200) || null,
      location: s(b.location, 200) || null,
      url: /^https?:\/\//i.test(s(b.url, 2000)) ? s(b.url, 2000) : null,
      description: s(b.description, 20000),
      source: s(b.source, 40).toLowerCase() === 'adzuna' ? 'adzuna' : 'manual',
    };
    if (!job.title) throw new AppError('Job title is required.', 400);
    if (job.description.length < 30) throw new AppError('Paste the job description (at least 30 characters).', 400);
    job.external_id = job.url || crypto.createHash('sha256').update(`${job.title}\n${job.description}`).digest('hex').slice(0, 32);

    const profile = await getProfile(req.user.id);
    engine.requireCvProfile(profile);
    const [stored] = await jobStore.upsertJobs([job]);
    const match = await jobStore.scoreFor(profile, stored);
    res.json({ job_id: stored.id, score: match.score, missing_skills: match.missing_skills });
  } catch (err) {
    next(err);
  }
});

// POST /api/me/rescore  ->  scores a few recent jobs that are new or older than the CV.
// The app calls it repeatedly while `remaining` > 0 (short calls suit serverless limits).
router.post('/rescore', async (req, res, next) => {
  try {
    const profile = await getProfile(req.user.id);
    engine.requireCvProfile(profile);

    const jobs = check(
      await db().from('jobs').select('*').gte('created_at', since(FEED_DAYS)).order('created_at', { ascending: false }).limit(300),
      'load recent jobs'
    );
    const matches = check(
      await db().from('job_matches').select('job_id, scored_at').eq('user_id', profile.id),
      'load your matches'
    );
    const scoredAt = new Map(matches.map((m) => [m.job_id, m.scored_at]));
    const cvTime = profile.cv_updated_at ? new Date(profile.cv_updated_at).getTime() : 0;
    const stale = jobs.filter((j) => !scoredAt.has(j.id) || new Date(scoredAt.get(j.id)).getTime() < cvTime);

    const batch = stale.slice(0, RESCORE_BATCH);
    const results = await engine.mapLimit(batch, RESCORE_BATCH, (job) => jobStore.scoreFor(profile, job));
    const failed = results.filter((r) => !r.ok);
    if (failed.length) console.error('rescore failures:', failed.map((r) => r.error.message).join(' | '));
    if (batch.length && failed.length === batch.length) {
      throw new AppError(`Could not score jobs: ${failed[0].error.message}`, failed[0].error.status || 502);
    }

    res.json({ scored: results.length - failed.length, failed: failed.length, remaining: stale.length - batch.length });
  } catch (err) {
    next(err);
  }
});

// ---------- Full analysis with the saved CV ----------

async function saveAnalysis(userId, jobId, job, result) {
  const rows = check(
    await db()
      .from('analyses')
      .insert({
        user_id: userId,
        job_id: jobId,
        job_title: job?.job_title || null,
        match_score: result.matching.job_match_score,
        result,
      })
      .select('id'),
    'save the analysis'
  );
  return rows[0].id;
}

// POST /api/me/jobs/:jobId/analyze  ->  readout + plan for a job from the feed
router.post('/jobs/:jobId/analyze', async (req, res, next) => {
  try {
    const jobId = uuidParam(req.params.jobId, 'job');
    const profile = await getProfile(req.user.id);
    const cv = engine.requireCvProfile(profile);
    const stored = await getJob(jobId);
    const job = await jobStore.ensureAnalysis(stored);

    // Fresh match (and refresh the feed's score with it).
    const row = await jobStore.scoreFor(profile, stored);
    const matching = {
      job_match_score: row.score,
      matching_skills: row.matching_skills,
      partial_match_skills: row.partial_match_skills,
      missing_skills: row.missing_skills,
      summary: row.summary,
    };
    const { skillGap, roadmap } = await engine.plan(job, matching);
    const result = { cv, job, matching, skillGap, roadmap };
    const analysisId = await saveAnalysis(profile.id, jobId, job, result);
    res.json({ ...result, analysisId, jobId, posting: { url: stored.url, company: stored.company } });
  } catch (err) {
    next(err);
  }
});

// POST /api/me/analyze  { jdText }  ->  the scan, using the saved CV
router.post('/analyze', async (req, res, next) => {
  try {
    const jdText = typeof req.body?.jdText === 'string' ? req.body.jdText.trim() : '';
    if (!jdText) throw new AppError('Job description text is required.', 400);
    if (jdText.length > 20000) throw new AppError('Job description is too long (max 20000 characters).', 400);

    const profile = await getProfile(req.user.id);
    const cv = engine.requireCvProfile(profile);
    const job = await engine.analyzeJob(jdText);
    const matching = await engine.match(cv, job);
    const { skillGap, roadmap } = await engine.plan(job, matching);
    const result = { cv, job, matching, skillGap, roadmap };
    const analysisId = await saveAnalysis(profile.id, null, job, result);
    res.json({ ...result, analysisId });
  } catch (err) {
    next(err);
  }
});

// ---------- Saved analyses ----------

router.get('/analyses', async (req, res, next) => {
  try {
    const rows = check(
      await db()
        .from('analyses')
        .select('id, job_id, job_title, match_score, interview, created_at')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false })
        .limit(50),
      'load your analyses'
    );
    res.json({
      analyses: rows.map((a) => ({ ...a, interview_score: a.interview?.overall_score ?? null, interview: undefined })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/analyses/:id', async (req, res, next) => {
  try {
    const id = uuidParam(req.params.id, 'analysis');
    const rows = check(
      await db().from('analyses').select('*').eq('user_id', req.user.id).eq('id', id).limit(1),
      'load the analysis'
    );
    if (!rows[0]) throw new AppError('Analysis not found.', 404);
    const a = rows[0];
    res.json({ ...a.result, analysisId: a.id, jobId: a.job_id, interview: a.interview });
  } catch (err) {
    next(err);
  }
});

router.put('/analyses/:id/interview', async (req, res, next) => {
  try {
    const id = uuidParam(req.params.id, 'analysis');
    const e = req.body?.evaluation;
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new AppError('evaluation is required.', 400);
    const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Math.min(100, Number(v))) : null);
    const strs = (v) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 500)).slice(0, 20) : []);
    const interview = {
      technical_score: num(e.technical_score),
      communication_score: num(e.communication_score),
      completeness_score: num(e.completeness_score),
      overall_score: num(e.overall_score),
      strengths: strs(e.strengths),
      areas_to_improve: strs(e.areas_to_improve),
    };
    const rows = check(
      await db().from('analyses').update({ interview }).eq('user_id', req.user.id).eq('id', id).select('id'),
      'save the interview'
    );
    if (!rows.length) throw new AppError('Analysis not found.', 404);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
