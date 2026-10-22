// The CareerMind matching engine, shared by the web app, the signed-in
// dashboard and the n8n automations, so a job gets the same score everywhere.
const { AppError, runJSONAgent, toScore } = require('./agents');

const list = (value) =>
  Array.isArray(value)
    ? value
        .map((s) => (s && typeof s === 'object' ? s.skill || s.name || '' : String(s ?? '')))
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

const analyzeCv = (cvText) => runJSONAgent('cv', cvText);
const analyzeJob = (jdText) => runJSONAgent('job', jdText);

/** Matching Agent, with the reply cleaned into a fixed shape. */
async function match(cv, job) {
  const raw = await runJSONAgent('matching', `CV_DATA:\n${JSON.stringify(cv)}\n\nJOB_DATA:\n${JSON.stringify(job)}`);
  return {
    job_match_score: toScore(raw.job_match_score),
    matching_skills: list(raw.matching_skills),
    partial_match_skills: list(raw.partial_match_skills),
    missing_skills: list(raw.missing_skills),
    summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 1000) : null,
  };
}

/** Skill Gap + Roadmap agents for an already matched CV and job. */
async function plan(job, matching) {
  const skillGap = await runJSONAgent(
    'skillGap',
    `missing_skills: ${JSON.stringify(matching.missing_skills || [])}\n` +
      `partial_match_skills: ${JSON.stringify(matching.partial_match_skills || [])}\n\n` +
      `JOB_DATA:\n${JSON.stringify(job)}`
  );
  const roadmap = await runJSONAgent('roadmap', JSON.stringify(skillGap));
  return { skillGap, roadmap };
}

/**
 * True when the role is open to an intern / junior / graduate. Unknown
 * seniority counts as a fit; the score still reflects the requirements.
 */
function fitsEntryLevel(job) {
  const level = String(job?.seniority || '').toLowerCase();
  if (['mid', 'senior', 'lead'].includes(level)) return false;
  const years = Number(job?.min_years_experience);
  return !(Number.isFinite(years) && years >= 2);
}

/** Plain-text job description built from the fields the automations send. */
function jobText(job) {
  return [
    `Title: ${job.title}`,
    job.company && `Company: ${job.company}`,
    job.location && `Location: ${job.location}`,
    job.salary && `Salary: ${job.salary}`,
    '',
    job.description || '',
  ]
    .filter((line) => line !== null && line !== undefined && line !== false)
    .join('\n')
    .slice(0, 20000);
}

/** Runs fn over items with at most `limit` running at once; keeps order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function requireCvProfile(profile) {
  if (!profile?.cv_profile) throw new AppError('Upload your CV first.', 409);
  return profile.cv_profile;
}

module.exports = { analyzeCv, analyzeJob, match, plan, fitsEntryLevel, jobText, mapLimit, requireCvProfile, list };
