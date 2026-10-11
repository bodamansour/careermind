const test = require('node:test');
const assert = require('node:assert/strict');

const { parseModelJSON, toScore, normalizeEvaluation } = require('../services/aimicromind');
const { isPdf } = require('../services/pdf');
const { mapAdzunaResult } = require('../routes/jobs');

test('parseModelJSON reads clean, fenced and wrapped JSON', () => {
  assert.deepEqual(parseModelJSON('{"a":1}'), { a: 1 });
  assert.deepEqual(parseModelJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJSON('Here you go: {"a":1} thanks'), { a: 1 });
  assert.throws(() => parseModelJSON('no json here'), /Could not parse JSON/);
});

test('toScore accepts numbers and numeric strings, clamped to 0-100', () => {
  assert.equal(toScore(85), 85);
  assert.equal(toScore('85'), 85);
  assert.equal(toScore(' 72% '), 72);
  assert.equal(toScore(150), 100);
  assert.equal(toScore(-3), 0);
  assert.equal(toScore('n/a'), null);
  assert.equal(toScore(null), null);
  assert.equal(toScore(''), null);
});

test('normalizeEvaluation detects a final evaluation with string scores', () => {
  // Previously, "overall_score": "78" was not recognized as the final result.
  const evaluation = normalizeEvaluation({
    technical_score: '80',
    communication_score: 70,
    completeness_score: '75',
    overall_score: '78',
    strengths: ['clear answers'],
  });
  assert.equal(evaluation.overall_score, 78);
  assert.equal(evaluation.technical_score, 80);
  assert.deepEqual(evaluation.strengths, ['clear answers']);
  assert.deepEqual(evaluation.areas_to_improve, []);
});

test('normalizeEvaluation ignores normal interview messages', () => {
  assert.equal(normalizeEvaluation({ question: 'Tell me about yourself' }), null);
  assert.equal(normalizeEvaluation([1, 2]), null);
  assert.equal(normalizeEvaluation(null), null);
});

test('isPdf checks the file signature, not the file name', () => {
  assert.equal(isPdf(Buffer.from('%PDF-1.7\n...')), true);
  assert.equal(isPdf(Buffer.from('hello')), false);
  assert.equal(isPdf(undefined), false);
});

test('mapAdzunaResult strips markup and drops unsafe links', () => {
  const job = mapAdzunaResult({
    title: '<strong>AI</strong> Engineer',
    company: { display_name: 'Acme <b>Ltd</b>' },
    location: { display_name: 'London' },
    redirect_url: 'javascript:alert(1)',
  });
  assert.deepEqual(job, {
    title: 'AI Engineer',
    company: 'Acme Ltd',
    location: 'London',
    url: null,
  });
  assert.equal(
    mapAdzunaResult({ redirect_url: 'https://www.adzuna.co.uk/x' }).url,
    'https://www.adzuna.co.uk/x'
  );
  assert.equal(mapAdzunaResult({}).title, 'Untitled role');
});
