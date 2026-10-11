const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

// Run every agent on the built-in LLM path with a fake key; axios.post is mocked below.
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.RATE_LIMIT_ANALYSES_PER_HOUR = '0';
process.env.RATE_LIMIT_INTERVIEW_MESSAGES_PER_HOUR = '0';
for (const name of ['CV_ANALYZER_URL', 'JOB_ANALYZER_URL', 'MATCHING_URL', 'SKILLGAP_URL', 'ROADMAP_URL', 'INTERVIEW_URL']) {
  delete process.env[name];
}

const app = require('../server');
const prompts = require('../services/prompts');

// Canned reply for each agent, picked by the system prompt the request carries.
function fakeReplies(matching) {
  const replies = new Map([
    [prompts.CV_ANALYZER, { name: 'Jane Doe', skills: ['Node.js'] }],
    [prompts.JOB_ANALYZER, { job_title: 'Backend Developer', required_skills: ['Node.js', 'SQL'] }],
    [prompts.MATCHING, matching],
    [prompts.SKILL_GAP, { gaps: [] }],
    [prompts.ROADMAP, { weeks: [] }],
  ]);
  return async (url, body) => {
    const reply = replies.get(body.messages[0].content);
    return { data: { choices: [{ message: { content: JSON.stringify(reply) } }] } };
  };
}

async function withServer(fn) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

function analysisForm() {
  const form = new FormData();
  const pdf = fs.readFileSync(path.join(__dirname, 'fixtures', 'cv.pdf'));
  form.append('cvFile', new Blob([pdf], { type: 'application/pdf' }), 'cv.pdf');
  form.append('jdText', 'Backend Developer: Node.js and SQL.');
  return form;
}

test('full analysis returns the job match score as a number when the model sends "85%"', async (t) => {
  t.mock.method(axios, 'post', fakeReplies({
    job_match_score: '85%',
    matching_skills: ['Node.js'],
    missing_skills: ['SQL'],
  }));

  await withServer(async (base) => {
    const res = await fetch(`${base}/api/full-analysis`, { method: 'POST', body: analysisForm() });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.matching.job_match_score, 85);
    assert.equal(data.cv.name, 'Jane Doe');
  });
});

test('full analysis reports a missing job match score as null, not 0', async (t) => {
  t.mock.method(axios, 'post', fakeReplies({ matching_skills: [], missing_skills: [] }));

  await withServer(async (base) => {
    const res = await fetch(`${base}/api/full-analysis`, { method: 'POST', body: analysisForm() });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).matching.job_match_score, null);
  });
});

test('interview message without the cv and job data is rejected before calling the model', async (t) => {
  const post = t.mock.method(axios, 'post', async () => {
    throw new Error('the model should not be called');
  });

  await withServer(async (base) => {
    const res = await fetch(`${base}/api/interview/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: '6f1c2a5e-1b2c-4d3e-8f90-123456789abc', message: 'My answer' }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /cv and job/);
    assert.equal(post.mock.callCount(), 0);
  });
});

test('API calls from another website are refused before any model call', async (t) => {
  const post = t.mock.method(axios, 'post', fakeReplies({ job_match_score: 80 }));

  await withServer(async (base) => {
    const res = await fetch(`${base}/api/full-analysis`, {
      method: 'POST',
      headers: { Origin: 'https://other-site.example' },
      body: analysisForm(),
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(post.mock.callCount(), 0);
  });
});

test('API calls from the app itself and from requests without an Origin still work', async (t) => {
  t.mock.method(axios, 'post', fakeReplies({ job_match_score: 80 }));

  await withServer(async (base) => {
    const sameSite = await fetch(`${base}/api/full-analysis`, {
      method: 'POST',
      headers: { Origin: base },
      body: analysisForm(),
    });
    assert.equal(sameSite.status, 200);

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
  });
});

test('origins listed in ALLOWED_ORIGINS may call the API and get CORS headers', async (t) => {
  t.mock.method(axios, 'post', fakeReplies({ job_match_score: 80 }));
  process.env.ALLOWED_ORIGINS = 'https://my-portfolio.example, https://other.example';
  t.after(() => delete process.env.ALLOWED_ORIGINS);

  await withServer(async (base) => {
    const res = await fetch(`${base}/api/full-analysis`, {
      method: 'POST',
      headers: { Origin: 'https://my-portfolio.example' },
      body: analysisForm(),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://my-portfolio.example');
  });
});
