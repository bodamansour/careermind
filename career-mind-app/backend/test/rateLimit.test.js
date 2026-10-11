const test = require('node:test');
const assert = require('node:assert/strict');
const { rateLimit, envLimit } = require('../services/rateLimit');

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function call(limiter, ip) {
  const res = fakeRes();
  let passed = false;
  limiter({ ip }, res, () => { passed = true; });
  return { passed, res };
}

test('allows up to max requests per IP, then answers 429 with Retry-After', () => {
  let time = 0;
  const limiter = rateLimit({ windowMs: 60000, max: 2, message: 'slow down', now: () => time });

  assert.equal(call(limiter, '1.1.1.1').passed, true);
  assert.equal(call(limiter, '1.1.1.1').passed, true);
  time = 15000;
  const blocked = call(limiter, '1.1.1.1');
  assert.equal(blocked.passed, false);
  assert.equal(blocked.res.statusCode, 429);
  assert.deepEqual(blocked.res.body, { error: 'slow down' });
  assert.equal(blocked.res.headers['Retry-After'], '45');

  // Other visitors are counted separately.
  assert.equal(call(limiter, '2.2.2.2').passed, true);
});

test('the count resets when the window ends', () => {
  let time = 0;
  const limiter = rateLimit({ windowMs: 1000, max: 1, message: 'x', now: () => time });
  assert.equal(call(limiter, 'a').passed, true);
  assert.equal(call(limiter, 'a').passed, false);
  time = 1000;
  assert.equal(call(limiter, 'a').passed, true);
});

test('max 0 disables the limit', () => {
  const limiter = rateLimit({ windowMs: 1000, max: 0, message: 'x' });
  for (let i = 0; i < 5; i++) assert.equal(call(limiter, 'a').passed, true);
});

test('envLimit reads non-negative integers and ignores bad values', () => {
  process.env.TEST_LIMIT = '25';
  assert.equal(envLimit('TEST_LIMIT', 10), 25);
  process.env.TEST_LIMIT = '0';
  assert.equal(envLimit('TEST_LIMIT', 10), 0);
  for (const bad of ['', 'abc', '-1', '2.5']) {
    process.env.TEST_LIMIT = bad;
    assert.equal(envLimit('TEST_LIMIT', 10), 10);
  }
  delete process.env.TEST_LIMIT;
  assert.equal(envLimit('TEST_LIMIT', 10), 10);
});
