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
  url: 'https://example.com/job/123',
  description: 'We need an intern who knows n8n and Node.js to build automations.',
};
const KEY = { 'x-api-key': 'hunter-key' };

test('hunter API needs the key', async () => {
  setClient(createFakeDb(seed()));
  const res = await call('POST', '/api/hunter/jobs', { jobs: [JOB] }, { 'x-api-key': 'nope' });
  assert.equal(res.status, 401);
});

test('hunter API validates the jobs', async () => {
  setClient(createFakeDb(seed()));
  assert.equal((await call('POST', '/api/hunter/jobs', { jobs: [] }, KEY)).status, 400);
  assert.equal((await call('POST', '/api/hunter/jobs', { jobs: [{ ...JOB, description: 'short' }] }, KEY)).status, 400);
  const many = Array.from({ length: 11 }, (_, i) => ({ ...JOB, external_id: String(i) }));
  assert.equal((await call('POST', '/api/hunter/jobs', { jobs: many }, KEY)).status, 400);
});

test('hunter API stores a job, analyzes it once and scores it for every user with a CV', async (t) => {
  const fake = createFakeDb(seed());
  setClient(fake);
  const calls = mockAgents(t);

  const res = await call('POST', '/api/hunter/jobs', { jobs: [JOB], report_for: 'owner@example.com' }, KEY);
  assert.equal(res.status, 200);
  assert.equal(res.data.users_scored, 2);
  const [r] = res.data.results;
  assert.equal(r.score, 82);
  assert.equal(r.meets_level, true);
  assert.deepEqual(r.missing_skills, ['n8n']);

  assert.equal(fake.tables.jobs.length, 1);
  assert.equal(fake.tables.job_matches.length, 2);
  const jobAnalyzerCalls = calls.mock.calls.filter((c) => c.arguments[1].messages[0].content === prompts.JOB_ANALYZER);
  assert.equal(jobAnalyzerCalls.length, 1);

  // Sending the same job again re-uses the stored analysis and scores.
  calls.mock.resetCalls();
  const again = await call('POST', '/api/hunter/jobs', { jobs: [JOB], report_for: 'owner@example.com' }, KEY);
  assert.equal(again.data.results[0].score, 82);
  assert.equal(calls.mock.callCount(), 0);
  assert.equal(fake.tables.jobs.length, 1);
});

test('hunter API flags senior roles', async (t) => {
  setClient(createFakeDb(seed()));
  mockAgents(t, { seniority: 'senior' });
  const res = await call('POST', '/api/hunter/jobs', { jobs: [JOB], report_for: 'owner@example.com' }, KEY);
  assert.equal(res.data.results[0].meets_level, false);
});

test('hunter API explains an unknown report_for account', async (t) => {
  setClient(createFakeDb(seed()));
  mockAgents(t);
  const res = await call('POST', '/api/hunter/jobs', { jobs: [JOB], report_for: 'nobody@example.com' }, KEY);
  assert.equal(res.status, 404);
  const noCv = await call('POST', '/api/hunter/jobs', { jobs: [JOB], report_for: 'nocv@example.com' }, KEY);
  assert.equal(noCv.status, 409);
});

// ---------- /api/me ----------

const AUTH = { authorization: 'Bearer owner-token' };
const USERS = { 'owner-token': { id: OWNER, email: 'owner@example.com' } };

test('me API requires a valid session', async () => {
  setClient(createFakeDb(seed(), USERS));
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', undefined, { authorization: 'Bearer bad' })).status, 401);
  const ok = await call('GET', '/api/me', undefined, AUTH);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.has_cv, true);
  assert.deepEqual(ok.data.cv.skills, ['Node.js']);
});

test('me API rescores only the jobs that need it, in small batches', async (t) => {
  const s = seed();
  s.jobs = Array.from({ length: 6 }, (_, i) => ({
    id: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i}`, source: 'x', external_id: String(i), title: 'Job ' + i,
    description: 'A job description that is long enough.', analysis: { job_title: 'Job' }, created_at: new Date().toISOString(),
  }));
  s.job_matches = [{ user_id: OWNER, job_id: s.jobs[0].id, score: 50, scored_at: '2027-01-01T00:00:00Z', status: 'saved' }];
  const fake = createFakeDb(s, USERS);
  setClient(fake);
  mockAgents(t);

  const first = await call('POST', '/api/me/rescore', {}, AUTH);
  assert.deepEqual(first.data, { scored: 4, failed: 0, remaining: 1 });
  const second = await call('POST', '/api/me/rescore', {}, AUTH);
  assert.deepEqual(second.data, { scored: 1, failed: 0, remaining: 0 });
  assert.equal(fake.tables.job_matches.find((m) => m.job_id === s.jobs[0].id).status, 'saved');
});

test('me API changes a job status and rejects bad values', async () => {
  const s = seed();
  const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000009';
  s.job_matches = [{ user_id: OWNER, job_id: jobId, score: 70, status: 'new' }];
  const fake = createFakeDb(s, USERS);
  setClient(fake);
  assert.equal((await call('PATCH', `/api/me/jobs/${jobId}`, { status: 'deleted' }, AUTH)).status, 400);
  assert.equal((await call('PATCH', '/api/me/jobs/not-a-uuid', { status: 'saved' }, AUTH)).status, 400);
  const ok = await call('PATCH', `/api/me/jobs/${jobId}`, { status: 'applied' }, AUTH);
  assert.equal(ok.status, 200);
  assert.equal(fake.tables.job_matches[0].status, 'applied');
});

test('me API analyzes a feed job with the saved CV and stores the analysis', async (t) => {
  const s = seed();
  const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000007';
  s.jobs = [{ id: jobId, source: 'x', external_id: '7', title: 'Automation Intern', description: 'A job description that is long enough.', analysis: null, url: 'https://e.com' }];
  const fake = createFakeDb(s, USERS);
  setClient(fake);
  mockAgents(t);

  const res = await call('POST', `/api/me/jobs/${jobId}/analyze`, {}, AUTH);
  assert.equal(res.status, 200);
  assert.equal(res.data.matching.job_match_score, 82);
  assert.equal(res.data.roadmap.weeks.length, 1);
  assert.ok(res.data.analysisId);
  assert.equal(fake.tables.analyses.length, 1);
  assert.equal(fake.tables.analyses[0].user_id, OWNER);

  const saved = await call('PUT', `/api/me/analyses/${res.data.analysisId}/interview`, { evaluation: { overall_score: '77', strengths: ['clear'] } }, AUTH);
  assert.equal(saved.status, 200);
  assert.equal(fake.tables.analyses[0].interview.overall_score, 77);
});

test('me API saves a pasted job and scores it', async (t) => {
  const fake = createFakeDb(seed(), USERS);
  setClient(fake);
  mockAgents(t);
  const res = await call('POST', '/api/me/jobs', { title: 'Automation Intern', description: 'We need an intern who knows n8n and Node.js.' }, AUTH);
  assert.equal(res.status, 200);
  assert.equal(res.data.score, 82);
  assert.equal(fake.tables.jobs[0].source, 'manual');
  assert.equal(fake.tables.job_matches.filter((m) => m.user_id === OWNER).length, 1);
});

test('config exposes only the public sign-in settings', async () => {
  const res = await call('GET', '/api/config');
  assert.deepEqual(res.data, { accounts: true, supabaseUrl: 'https://example.supabase.co', supabaseKey: 'sb_publishable_test' });
  assert.ok(!JSON.stringify(res.data).includes('test-secret'));
});
