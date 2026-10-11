const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.OPENROUTER_API_KEY = 'test-key';
process.env.RATE_LIMIT_MATCHES_PER_HOUR = '0';
for (const name of ['CV_ANALYZER_URL', 'JOB_ANALYZER_URL', 'MATCHING_URL']) delete process.env[name];

const app = require('../server');
const prompts = require('../services/prompts');

const KEY = 'test-match-key';

function mockAgents(t) {
  const replies = new Map([
    [prompts.CV_ANALYZER, { name: 'Jane Doe', skills: ['Node.js'] }],
    [prompts.JOB_ANALYZER, { job_title: 'Automation Intern', required_skills: ['n8n', 'Node.js'] }],
    [prompts.MATCHING, { job_match_score: '78%', matching_skills: ['Node.js'], missing_skills: ['n8n'] }],
  ]);
  return t.mock.method(axios, 'post', async (url, body) => ({
    data: { choices: [{ message: { content: JSON.stringify(replies.get(body.messages[0].content)) } }] },
  }));
}

async function post(body, headers = {}) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/match`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  } finally {
    server.close();
  }
}

const body = { cvText: 'Jane Doe. Node.js projects.', jdText: 'Automation intern: n8n, Node.js.' };

test('match API is off when CAREERMIND_API_KEY is not set', async () => {
  delete process.env.CAREERMIND_API_KEY;
  const res = await post(body, { 'x-api-key': KEY });
  assert.equal(res.status, 503);
});

test('match API rejects a wrong key before calling the model', async (t) => {
  process.env.CAREERMIND_API_KEY = KEY;
  const calls = mockAgents(t);
  const res = await post(body, { 'x-api-key': 'wrong' });
  assert.equal(res.status, 401);
  assert.equal(calls.mock.callCount(), 0);
});

test('match API requires both texts', async () => {
  process.env.CAREERMIND_API_KEY = KEY;
  const res = await post({ cvText: 'x' }, { 'x-api-key': KEY });
  assert.equal(res.status, 400);
});

test('match API returns a numeric score and the skill lists', async (t) => {
  process.env.CAREERMIND_API_KEY = KEY;
  mockAgents(t);
  const res = await post(body, { 'x-api-key': KEY });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, {
    job_title: 'Automation Intern',
    candidate_name: 'Jane Doe',
    job_match_score: 78,
    matching_skills: ['Node.js'],
    partial_match_skills: [],
    missing_skills: ['n8n'],
  });
});
