const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.OPENROUTER_API_KEY = 'test-key';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret';
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
process.env.CAREERMIND_API_KEY = 'hunter-key';
process.env.RATE_LIMIT_MATCHES_PER_HOUR = '0';
process.env.RATE_LIMIT_ANALYSES_PER_HOUR = '0';
process.env.RATE_LIMIT_RESCORES_PER_HOUR = '0';
for (const n of ['CV_ANALYZER_URL', 'JOB_ANALYZER_URL', 'MATCHING_URL', 'SKILLGAP_URL', 'ROADMAP_URL']) delete process.env[n];

const app = require('../server');
const prompts = require('../services/prompts');
const { setClient } = require('../services/db');
const { createFakeDb } = require('./support/fakeDb');

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function seed() {
  return {
    profiles: [
      { id: OWNER, email: 'Owner@Example.com', cv_profile: { name: 'Owner', skills: ['Node.js'] }, cv_updated_at: '2026-01-01T00:00:00Z' },
      { id: OTHER, email: 'other@example.com', cv_profile: { name: 'Other', skills: ['Python'] }, cv_updated_at: '2026-01-01T00:00:00Z' },
      { id: '33333333-3333-4333-8333-333333333333', email: 'nocv@example.com', cv_profile: null },
    ],
  };
}

function mockAgents(t, { seniority = 'intern' } = {}) {
  return t.mock.method(axios, 'post', async (url, body) => {
    const system = body.messages[0].content;
    let reply;
    if (system === prompts.JOB_ANALYZER) reply = { job_title: 'Automation Intern', seniority, required_skills: ['n8n', 'Node.js'] };
    else if (system === prompts.MATCHING) {
      const cv = JSON.parse(body.messages[1].content.split('\n')[1]);
      reply = cv.name === 'Owner'
        ? { job_match_score: '82', matching_skills: ['Node.js'], missing_skills: ['n8n'], summary: 'Good fit.' }
        : { job_match_score: 30, matching_skills: [], missing_skills: ['n8n', 'Node.js'] };
    } else if (system === prompts.CV_ANALYZER) reply = { name: 'New CV', skills: ['SQL'] };
    else if (system === prompts.SKILL_GAP) reply = { gaps: [{ skill: 'n8n', priority: 'high' }] };
    else if (system === prompts.ROADMAP) reply = { total_weeks: 1, weeks: [{ week_number: 1, focus: 'n8n', topics: ['basics'], project: 'a flow' }] };
    return { data: { choices: [{ message: { content: JSON.stringify(reply) } }] } };
  });
}

async function call(method, path, body, headers = {}) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  } finally {
    server.close();
  }
}

const JOB = {
  source: 'remotive',
  external_id: '123',
  title: 'Automation Intern',
  company: 'Acme',
  url: 'https://remotive.com/remote-jobs/software-dev/automation-intern-123?utm_source=feed',
  description: 'We need an intern who knows n8n and Node.js to build automations.',
};
const KEY = { 'x-api-key': 'hunter-key' };
const AUTH = { authorization: 'Bearer owner-token' };
const OTHER_AUTH = { authorization: 'Bearer other-token' };
const USERS = {
  'owner-token': { id: OWNER, email: 'owner@example.com' },
  'other-token': { id: OTHER, email: 'other@example.com' },
};
const hunt = (jobs, extra = {}) => call('POST', '/api/hunter/jobs', { report_for: 'owner@example.com', jobs, ...extra }, KEY);

// ---------- /api/hunter/jobs ----------

test('hunter API needs the key and a report_for account', async () => {
  setClient(createFakeDb(seed()));
  assert.equal((await call('POST', '/api/hunter/jobs', { report_for: 'owner@example.com', jobs: [JOB] }, { 'x-api-key': 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/hunter/jobs', { jobs: [JOB] }, KEY)).status, 400);
  assert.equal((await hunt([JOB], { report_for: 'nobody@example.com' })).status, 404);
  assert.equal((await hunt([JOB], { report_for: 'nocv@example.com' })).status, 409);
});

test('hunter API validates the jobs', async () => {
  setClient(createFakeDb(seed()));
  assert.equal((await hunt([])).status, 400);
  assert.equal((await hunt([{ ...JOB, description: 'short' }])).status, 400);
  assert.equal((await hunt(Array.from({ length: 11 }, (_, i) => ({ ...JOB, external_id: String(i) })))).status, 400);
});

test('a hunted job is stored once, scored by CareerMind for the owner only, and shows in their feed', async (t) => {
  const fake = createFakeDb(seed(), USERS);
  setClient(fake);
  const calls = mockAgents(t);

  const res = await hunt([JOB]);
  assert.equal(res.status, 200);
  assert.deepEqual({ scored: res.data.scored, failed: res.data.failed }, { scored: 1, failed: 0 });
  const [r] = res.data.results;
  assert.equal(r.score_status, 'scored');
  assert.equal(r.score, 82);
  assert.equal(r.meets_level, true);
  assert.deepEqual(r.missing_skills, ['n8n']);

  assert.equal(fake.tables.jobs.length, 1);
  assert.deepEqual(fake.tables.job_matches.map((m) => m.user_id), [OWNER]);
  assert.equal(fake.tables.job_matches[0].origin, 'job-hunter');

  // Same score in the app as in the hunter reply.
  const feed = await call('GET', '/api/me/jobs', undefined, AUTH);
  assert.equal(feed.data.jobs.length, 1);
  assert.equal(feed.data.jobs[0].score, 82);
  assert.equal(feed.data.jobs[0].job.source, 'remotive');
  // Another user doesn't get the owner's job.
  const other = await call('GET', '/api/me/jobs', undefined, OTHER_AUTH);
  assert.equal(other.data.jobs.length, 0);

  // Sending the same job again re-uses the stored analysis and score: no agent call.
  calls.mock.resetCalls();
  const again = await hunt([JOB]);
  assert.equal(again.data.results[0].score, 82);
  assert.equal(calls.mock.callCount(), 0);
  assert.equal(fake.tables.jobs.length, 1);
});

test('the same posting from another source (same URL) is merged, keeping both sources', async (t) => {
  const fake = createFakeDb(seed(), USERS);
  setClient(fake);
  mockAgents(t);
  await hunt([JOB]);
  const sameUrl = { ...JOB, source: 'weworkremotely', external_id: 'wwr-9', url: 'https://www.remotive.com/remote-jobs/software-dev/automation-intern-123/' };
  const res = await hunt([sameUrl]);
  assert.equal(fake.tables.jobs.length, 1);
  assert.equal(res.data.results[0].job_id, fake.tables.jobs[0].id);
  assert.equal(fake.tables.jobs[0].source, 'remotive');
  assert.deepEqual(fake.tables.jobs[0].sources, ['remotive', 'weworkremotely']);

  // A generic careers page is not used to merge different jobs.
  const generic = [
    { ...JOB, external_id: 'a', title: 'Job A', url: 'https://acme.com/careers' },
    { ...JOB, external_id: 'b', title: 'Job B', url: 'https://acme.com/careers' },
  ];
  await hunt(generic);
  assert.equal(fake.tables.jobs.length, 3);
});

test('urlKey ignores tracking parameters, www and trailing slashes', () => {
  const { urlKey } = require('../services/jobStore');
  assert.equal(urlKey('https://www.Example.com/jobs/42/?utm_source=x&ref=y'), 'example.com/jobs/42');
  assert.equal(urlKey('https://example.com/jobs?id=42&utm_medium=z'), 'example.com/jobs?id=42');
  assert.equal(urlKey('https://example.com/careers'), null);
  assert.equal(urlKey('javascript:alert(1)'), null);
});

test('a failed score is stored as failed with the error, never filled in by another engine', async (t) => {
  const fake = createFakeDb(seed(), USERS);
  setClient(fake);
  t.mock.method(axios, 'post', async (url, body) => {
    if (body.messages[0].content === prompts.JOB_ANALYZER) {
      return { data: { choices: [{ message: { content: JSON.stringify({ job_title: 'X', seniority: 'intern' }) } }] } };
    }
    const err = new Error('Request failed');
    err.response = { status: 429 };
    throw err;
  });

  const res = await hunt([JOB]);
  assert.equal(res.status, 200);
  const [r] = res.data.results;
  assert.equal(r.score_status, 'failed');
  assert.equal(r.score, null);
  assert.match(r.error, /rate limited/);
  assert.equal(fake.tables.job_matches[0].score_status, 'failed');
  assert.equal(fake.tables.job_matches[0].score, null);

  // The app shows it as failed (retryable), even with a score filter.
  const feed = await call('GET', '/api/me/jobs?min=70', undefined, AUTH);
  assert.equal(feed.data.jobs.length, 1);
  assert.equal(feed.data.jobs[0].score_status, 'failed');
});

test('a failed job is retried by the next hunt and by the retry button', async (t) => {
  const s = seed();
  const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000005';
  s.jobs = [{ id: jobId, source: 'remotive', external_id: '123', title: 'Automation Intern', description: JOB.description, analysis: { job_title: 'Automation Intern', seniority: 'intern' }, sources: ['remotive'] }];
  s.job_matches = [{ user_id: OWNER, job_id: jobId, score: null, score_status: 'failed', score_error: 'timeout', status: 'saved', scored_at: '2026-10-01T00:00:00Z' }];
  const fake = createFakeDb(s, USERS);
  setClient(fake);
  mockAgents(t);

  const retry = await call('POST', `/api/me/jobs/${jobId}/score`, {}, AUTH);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.score_status, 'scored');
  assert.equal(retry.data.score, 82);
  assert.equal(fake.tables.job_matches[0].status, 'saved', 'the user status is kept');

  // Another user can't score a job that isn't in their list.
  assert.equal((await call('POST', `/api/me/jobs/${jobId}/score`, {}, OTHER_AUTH)).status, 404);
});

test('hunter API flags senior roles', async (t) => {
  setClient(createFakeDb(seed()));
  mockAgents(t, { seniority: 'senior' });
  const res = await hunt([JOB]);
  assert.equal(res.data.results[0].meets_level, false);
});

// ---------- /api/me ----------

test('me API requires a valid session', async () => {
  setClient(createFakeDb(seed(), USERS));
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', undefined, { authorization: 'Bearer bad' })).status, 401);
  const ok = await call('GET', '/api/me', undefined, AUTH);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.has_cv, true);
  assert.deepEqual(ok.data.cv.skills, ['Node.js']);
});

test('rescore only touches the user own jobs that are failed or older than the CV', async (t) => {
  const s = seed();
  const id = (i) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000001${i}`;
  s.jobs = Array.from({ length: 6 }, (_, i) => ({
    id: id(i), source: 'x', external_id: String(i), title: 'Job ' + i,
    description: 'A job description that is long enough.', analysis: { job_title: 'Job' }, created_at: new Date().toISOString(),
  }));
  s.job_matches = [
    { user_id: OWNER, job_id: id(0), score: 50, score_status: 'scored', scored_at: '2027-01-01T00:00:00Z', status: 'saved' }, // fresh
    { user_id: OWNER, job_id: id(1), score: 40, score_status: 'scored', scored_at: '2025-01-01T00:00:00Z', status: 'applied' }, // older than CV
    { user_id: OWNER, job_id: id(2), score: null, score_status: 'failed', scored_at: '2027-01-01T00:00:00Z', status: 'new' },
    { user_id: OTHER, job_id: id(3), score: null, score_status: 'failed', scored_at: '2025-01-01T00:00:00Z', status: 'new' },
  ];
  const fake = createFakeDb(s, USERS);
  setClient(fake);
  mockAgents(t);

  const res = await call('POST', '/api/me/rescore', {}, AUTH);
  assert.deepEqual(res.data, { scored: 2, failed: 0, remaining: 0 });
  const mine = (j) => fake.tables.job_matches.find((m) => m.user_id === OWNER && m.job_id === id(j));
  assert.equal(mine(1).score, 82);
  assert.equal(mine(1).status, 'applied', 'statuses survive a rescore');
  assert.equal(mine(2).score_status, 'scored');
  assert.equal(fake.tables.job_matches.find((m) => m.user_id === OTHER).score_status, 'failed', 'other users untouched');
  assert.equal(fake.tables.job_matches.length, 4, 'no new links are created');
});

test('status changes are saved and filter the feed', async () => {
  const s = seed();
  const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000009';
  s.jobs = [{ id: jobId, source: 'x', external_id: '9', title: 'Job', created_at: new Date().toISOString() }];
  s.job_matches = [{ user_id: OWNER, job_id: jobId, score: 70, score_status: 'scored', status: 'new' }];
  const fake = createFakeDb(s, USERS);
  setClient(fake);
  assert.equal((await call('PATCH', `/api/me/jobs/${jobId}`, { status: 'deleted' }, AUTH)).status, 400);
  assert.equal((await call('PATCH', '/api/me/jobs/not-a-uuid', { status: 'saved' }, AUTH)).status, 400);
  assert.equal((await call('PATCH', `/api/me/jobs/${jobId}`, { status: 'hidden' }, OTHER_AUTH)).status, 404);

  const ok = await call('PATCH', `/api/me/jobs/${jobId}`, { status: 'applied' }, AUTH);
  assert.equal(ok.status, 200);
  assert.equal(fake.tables.job_matches[0].status, 'applied');
  assert.equal((await call('GET', '/api/me/jobs?status=active', undefined, AUTH)).data.jobs.length, 0);
  assert.equal((await call('GET', '/api/me/jobs?status=applied', undefined, AUTH)).data.jobs.length, 1);
});

test('analyzing a feed job uses its stored score, links the analysis to the job, and the feed reopens it', async (t) => {
  const s = seed();
  const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000007';
  s.jobs = [{ id: jobId, source: 'x', external_id: '7', title: 'Automation Intern', description: 'A job description that is long enough.', analysis: { job_title: 'Automation Intern' }, url: 'https://e.com/jobs/7', created_at: new Date().toISOString() }];
  s.job_matches = [{ user_id: OWNER, job_id: jobId, score: 64, score_status: 'scored', scored_at: '2027-01-01T00:00:00Z', matching_skills: ['Node.js'], missing_skills: ['n8n'], status: 'new' }];
  const fake = createFakeDb(s, USERS);
  setClient(fake);
  const calls = mockAgents(t);

  const res = await call('POST', `/api/me/jobs/${jobId}/analyze`, {}, AUTH);
  assert.equal(res.status, 200);
  assert.equal(res.data.matching.job_match_score, 64, 'same score as the feed, not a new one');
  const matchingCalls = calls.mock.calls.filter((c) => c.arguments[1].messages[0].content === prompts.MATCHING);
  assert.equal(matchingCalls.length, 0);
  assert.equal(fake.tables.analyses[0].job_id, jobId);

  const feed = await call('GET', '/api/me/jobs', undefined, AUTH);
  assert.equal(feed.data.jobs[0].analysis_id, res.data.analysisId);

  const saved = await call('PUT', `/api/me/analyses/${res.data.analysisId}/interview`, { evaluation: { overall_score: '77', strengths: ['clear'] } }, AUTH);
  assert.equal(saved.status, 200);
  assert.equal(fake.tables.analyses[0].interview.overall_score, 77);
  // Another user can't analyze or read it.
  assert.equal((await call('POST', `/api/me/jobs/${jobId}/analyze`, {}, OTHER_AUTH)).status, 404);
  assert.equal((await call('GET', `/api/me/analyses/${res.data.analysisId}`, undefined, OTHER_AUTH)).status, 404);
});

test('a job saved from the site keeps its source and joins the same feed', async (t) => {
  const fake = createFakeDb(seed(), USERS);
  setClient(fake);
  mockAgents(t);
  const res = await call('POST', '/api/me/jobs', { title: 'Automation Intern', url: 'https://adzuna.com/details/555', description: 'We need an intern who knows n8n and Node.js.', source: 'adzuna' }, AUTH);
  assert.equal(res.status, 200);
  assert.equal(res.data.score, 82);
  assert.equal(fake.tables.jobs[0].source, 'adzuna');
  assert.equal(fake.tables.job_matches[0].origin, 'adzuna');
  const feed = await call('GET', '/api/me/jobs', undefined, AUTH);
  assert.equal(feed.data.jobs[0].job.source, 'adzuna');
});

test('config exposes only the public sign-in settings', async () => {
  const res = await call('GET', '/api/config');
  assert.deepEqual(res.data, { accounts: true, supabaseUrl: 'https://example.supabase.co', supabaseKey: 'sb_publishable_test' });
  assert.ok(!JSON.stringify(res.data).includes('test-secret'));
});
