// Stores jobs and per-user matches in Supabase. Every job is analyzed once and
// scored by the CareerMind engine only; a failed score is saved as a retryable
// "failed" state, never replaced by a score from another engine.
const { db, check } = require('./db');
const engine = require('./engine');

const JOB_FIELDS = ['source', 'external_id', 'url', 'title', 'company', 'location', 'description', 'salary', 'apply_email', 'posted_at'];
const TRACKING_PARAMS = /^(utm_\w+|ref|refs|referrer|source|src|gh_src|lever-source|fbclid|gclid|trk|trackingid)$/i;

/**
 * Normalized posting URL used to spot the same job from two sources, or null
 * when the URL is too generic to identify one job (e.g. https://acme.com/careers).
 */
function urlKey(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length < 2 && params.length === 0) return null;
  const query = params.length ? '?' + new URLSearchParams(params).toString() : '';
  return `${u.hostname.toLowerCase().replace(/^www\./, '')}/${segments.join('/')}${query}`.toLowerCase();
}

async function findOne(column, value) {
  const rows = check(await db().from('jobs').select('*').eq(column, value).limit(1), 'look up the job');
  return rows[0] || null;
}

/**
 * Saves jobs, de-duplicated by (source, external_id) and then by posting URL.
 * A job seen again keeps its id, first source and cached analysis; the new
 * source is added to `sources`. Returns the stored rows in input order.
 */
async function upsertJobs(jobs) {
  const out = [];
  for (const job of jobs) {
    const fields = Object.fromEntries(JOB_FIELDS.map((f) => [f, job[f] ?? null]));
    const key = urlKey(fields.url);

    let existing = null;
    const bySource = check(
      await db().from('jobs').select('*').eq('source', fields.source).eq('external_id', fields.external_id).limit(1),
      'look up the job'
    );
    existing = bySource[0] || (key ? await findOne('url_key', key) : null);

    if (existing) {
      const update = {};
      // Fill in what the stored copy is missing; never change its identity.
      for (const f of ['url', 'company', 'location', 'salary', 'apply_email', 'posted_at']) {
        if (!existing[f] && fields[f]) update[f] = fields[f];
      }
      if ((fields.description || '').length > (existing.description || '').length) update.description = fields.description;
      if (!existing.url_key && key) update.url_key = key;
      const sources = existing.sources || [existing.source];
      if (!sources.includes(fields.source)) update.sources = [...sources, fields.source];
      if (Object.keys(update).length) {
        const rows = check(await db().from('jobs').update(update).eq('id', existing.id).select('*'), 'update the job');
        existing = rows[0] || { ...existing, ...update };
      }
      out.push(existing);
    } else {
      const rows = check(
        await db().from('jobs').insert({ ...fields, url_key: key, sources: [fields.source] }).select('*'),
        'save the job'
      );
      out.push(rows[0]);
    }
  }
  return out;
}

/** Job Analyzer output for a stored job, computed once and cached in jobs.analysis. */
async function ensureAnalysis(job) {
  if (job.analysis) return job.analysis;
  const analysis = await engine.analyzeJob(engine.jobText(job));
  check(await db().from('jobs').update({ analysis }).eq('id', job.id), 'save the job analysis');
  job.analysis = analysis;
  return analysis;
}

/**
 * Scores one stored job for one user with the CareerMind engine and saves the
 * match. On failure the match is saved as score_status "failed" with the error
 * (score null) so the app and Job Hunter can retry it. The user's status
 * (saved / applied / hidden) is never touched. `origin` is set on new links only.
 */
async function scoreFor(user, job, { origin } = {}) {
  const base = { user_id: user.id, job_id: job.id, scored_at: new Date().toISOString() };
  if (origin) base.origin = origin;
  let row;
  try {
    const analysis = await ensureAnalysis(job);
    const m = await engine.match(user.cv_profile, analysis);
    if (m.job_match_score == null) throw new Error('The Matching Agent returned no score.');
    row = {
      ...base,
      score: m.job_match_score,
      score_status: 'scored',
      score_error: null,
      matching_skills: m.matching_skills,
      partial_match_skills: m.partial_match_skills,
      missing_skills: m.missing_skills,
      summary: m.summary,
    };
  } catch (err) {
    console.error(`Scoring job ${job.id} for user ${user.id} failed:`, err.message);
    row = {
      ...base,
      score: null,
      score_status: 'failed',
      score_error: String(err.message || 'Scoring failed.').slice(0, 300),
      matching_skills: [],
      partial_match_skills: [],
      missing_skills: [],
      summary: null,
    };
  }
  check(await db().from('job_matches').upsert(row, { onConflict: 'user_id,job_id' }), 'save the match');
  return row;
}

/** True when a stored match is still valid for the user's current CV. */
function isFresh(match, user) {
  if (!match || match.score_status !== 'scored') return false;
  if (!user.cv_updated_at) return true;
  return new Date(match.scored_at).getTime() >= new Date(user.cv_updated_at).getTime();
}

/**
 * Links the given stored jobs to one user and scores the ones that have no
 * fresh score yet. Returns the match row for every job, in input order.
 */
async function scoreJobsForUser(user, jobs, { origin, concurrency = 3 } = {}) {
  const ids = [...new Set(jobs.map((j) => j.id))];
  const existing = ids.length
    ? check(await db().from('job_matches').select('*').eq('user_id', user.id).in('job_id', ids), 'load matches')
    : [];
  const byJob = new Map(existing.map((m) => [m.job_id, m]));

  const todo = [...new Map(jobs.filter((j) => !isFresh(byJob.get(j.id), user)).map((j) => [j.id, j])).values()];
  const results = await engine.mapLimit(todo, concurrency, (job) =>
    scoreFor(user, job, { origin: byJob.has(job.id) ? undefined : origin })
  );
  results.forEach((r, i) => {
    if (r.ok) byJob.set(todo[i].id, { ...byJob.get(todo[i].id), ...r.value });
    else byJob.set(todo[i].id, { user_id: user.id, job_id: todo[i].id, score: null, score_status: 'failed', score_error: r.error.message });
  });
  return jobs.map((j) => byJob.get(j.id));
}

module.exports = { urlKey, upsertJobs, ensureAnalysis, scoreFor, scoreJobsForUser, isFresh };
