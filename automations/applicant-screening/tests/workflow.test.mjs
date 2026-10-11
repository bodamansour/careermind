// Checks the Applicant Screening workflow without running n8n.
// Run: node --test tests/*.test.mjs   (Node.js 21 or newer)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const workflow = JSON.parse(read('workflow/applicant-screening.json'));
const raw = JSON.stringify(workflow);
const node = (name) => workflow.nodes.find((n) => n.name === name);
const names = new Set(workflow.nodes.map((n) => n.name));

const config = Object.fromEntries(
  node('Config').parameters.assignments.assignments.map((a) => [a.name, a.value])
);

/** Runs the Final Score Code node with a CareerMind reply. */
function finalScore(reply) {
  const nodes = {
    'Generate Applicant ID': { applicant_id: 'APP-1-1', name: 'Sara', email: 'sara@test.dev', job_id: 'J1', job_title: '', source: 'form' },
    Config: config,
  };
  const $ = (name) => ({ first: () => ({ json: nodes[name] }) });
  const $input = { item: { json: reply } };
  const $now = { toISO: () => '2026-10-11T12:00:00.000Z' };
  const fn = new Function('$', '$input', '$now', node('Final Score').parameters.jsCode);
  return fn($, $input, $now).json;
}

test('every connection and $() reference points at a real node', () => {
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    assert.ok(names.has(source), `unknown source: ${source}`);
    for (const branch of outputs.main) for (const t of branch) assert.ok(names.has(t.node), `unknown target: ${t.node}`);
  }
  for (const [, name] of raw.matchAll(/\$\('([^']+)'\)/g)) assert.ok(names.has(name), `unknown $('${name}')`);
});

test('the export carries no credential IDs or real sheet ID', () => {
  for (const n of workflow.nodes) {
    for (const c of Object.values(n.credentials || {})) assert.equal(c.id, undefined, `${n.name} has a credential ID`);
  }
  assert.match(raw, /YOUR_GOOGLE_SHEET_ID/);
});

test('the sheet columns match sheet-columns.csv', () => {
  const columns = read('sheet-columns.csv').trim().split(',');
  assert.deepEqual(Object.keys(node('Save to Sheet').parameters.columns.value), columns);
});

test('a CareerMind score above the strong threshold is STRONG, with skills listed', () => {
  const out = finalScore({ job_match_score: 82, matching_skills: ['n8n'], missing_skills: ['Docker'], partial_match_skills: ['SQL'], job_title: 'Automation Intern' });
  assert.equal(out.category, 'STRONG');
  assert.equal(out.match_score, 82);
  assert.equal(out.matching_skills, 'n8n');
  assert.equal(out.missing_skills, 'Docker, SQL');
  assert.equal(out.job_title, 'Automation Intern');
});

test('scores between the thresholds are POSSIBLE, below are WEAK', () => {
  assert.equal(finalScore({ job_match_score: config.possible_threshold }).category, 'POSSIBLE');
  assert.equal(finalScore({ job_match_score: config.possible_threshold - 1 }).category, 'WEAK');
});

test('a failed CareerMind call is saved for manual review, not scored as 0', () => {
  const out = finalScore({ error: { message: 'timeout' } });
  assert.equal(out.category, 'REVIEW');
  assert.equal(out.match_score, null);
});
