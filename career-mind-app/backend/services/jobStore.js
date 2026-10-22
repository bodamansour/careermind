// Stores jobs and per-user matches in Supabase, analyzing each job once and
// scoring it against every user who has uploaded a CV.
const { db, check } = require('./db');
const engine = require('./engine');

const JOB_FIELDS = ['source', 'external_id', 'url', 'title', 'company', 'location', 'description', 'salary', 'apply_email', 'posted_at'];

/** Inserts or refreshes jobs by (source, external_id); keeps any saved analysis. */
async function upsertJobs(jobs) {
  if (!jobs.length) return [];
  const rows = jobs.map((job) => Object.fromEntries(JOB_FIELDS.map((f) => [f, job[f] ?? null])));
  return check(
    await db().from('jobs').upsert(rows, { onConflict: 'source,external_id' }).select('*'),
    'save jobs'
  );
}

/** Job Analyzer output for a stored job, computed once and cached in jobs.analysis. */
async function ensureAnalysis(job) {
  if (job.analysis) return job.analysis;
  const analysis = await engine.analyzeJob(engine.jobText(job));
  check(await db().from('jobs').update({ analysis }).eq('id', job.id), 'save the job analysis');
  job.analysis = analysis;
  return analysis;
}

async function usersWithCv(userId) {
  let query = db().from('profiles').select('id, email, cv_profile').not('cv_profile', 'is', null);
  if (userId) query = query.eq('id', userId);
  return check(await query, 'load profiles');
}

async function existingMatches(jobIds, userIds) {
  if (!jobIds.length || !userIds.length) return [];
  return check(
    await db().from('job_matches').select('*').in('job_id', jobIds).in('user_id', userIds),
    'load matches'
  );
}

function matchRow(userId, jobId, m) {
  return {
    user_id: userId,
    job_id: jobId,
    score: m.job_match_score,
    matching_skills: m.matching_skills,
    partial_match_skills: m.partial_match_skills,
    missing_skills: m.missing_skills,
    summary: m.summary,
    scored_at: new Date().toISOString(),
  };
}

/** Scores one stored job for one user and saves the match (status is kept). */
async function scoreFor(user, job) {
  const analysis = await ensureAnalysis(job);
  const m = await engine.match(user.cv_profile, analysis);
  const row = matchRow(user.id, job.id, m);
  check(await db().from('job_matches').upsert(row, { onConflict: 'user_id,job_id' }), 'save the match');
  return row;
}

/**
 * Scores the given stored jobs for every user with a CV (or one user), skipping
 * pairs already scored. Returns { [jobId]: { [userId]: matchRow } } plus errors.
 */
async function scoreJobs(jobs, { userId, concurrency = 3 } = {}) {
  const users = await usersWithCv(userId);
  const done = {};
  (await existingMatches(jobs.map((j) => j.id), users.map((u) => u.id))).forEach((m) => {
    (done[m.job_id] ||= {})[m.user_id] = m;
  });

  const pairs = [];
  jobs.forEach((job) => users.forEach((user) => {
    if (!done[job.id]?.[user.id]) pairs.push({ job, user });
  }));

  const errors = [];
  // Analyze each job first (once), so parallel users don't analyze it twice.
  await engine.mapLimit(jobs, concurrency, (job) => ensureAnalysis(job)).then((res) =>
    res.forEach((r, i) => !r.ok && errors.push({ job_id: jobs[i].id, error: r.error.message }))
  );
  const failedJobs = new Set(errors.map((e) => e.job_id));

  const todo = pairs.filter((p) => !failedJobs.has(p.job.id));
  const results = await engine.mapLimit(todo, concurrency, ({ user, job }) => scoreFor(user, job));
  results.forEach((r, i) => {
    const { job, user } = todo[i];
    if (r.ok) (done[job.id] ||= {})[user.id] = r.value;
    else errors.push({ job_id: job.id, user_id: user.id, error: r.error.message });
  });

  return { matches: done, errors, users };
}

module.exports = { upsertJobs, ensureAnalysis, scoreJobs, scoreFor, usersWithCv };
