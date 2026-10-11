// Consistency checks between the workflow export and the docs/templates in
// this repo, without running n8n. Run: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const workflow = JSON.parse(read('workflow/job-hunter-all-in-one.json'));
const raw = JSON.stringify(workflow);
const schema = read('data-tables/schema.md');

/** Column names documented for a table in data-tables/schema.md. */
function documentedColumns(table) {
  const section = schema.split(`## ${table}`)[1].split('\n## ')[0];
  const fromTable = [...section.matchAll(/^\| ([a-z_ /]+) \|/gm)]
    .map((m) => m[1].trim())
    .filter((c) => c !== 'column')
    .flatMap((c) => c.split('/').map((s) => s.trim()));
  const fromList = [...section.matchAll(/`([a-z_]+)` (?:string|number|boolean|date)/g)].map((m) => m[1]);
  return new Set([...fromTable, ...fromList]);
}

test('every connection points at a node that exists', () => {
  const names = new Set(workflow.nodes.map((n) => n.name));
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    assert.ok(names.has(source), `unknown source node: ${source}`);
    for (const branches of Object.values(outputs)) {
      for (const branch of branches) {
        for (const target of branch || []) assert.ok(names.has(target.node), `unknown target: ${target.node}`);
      }
    }
  }
});

test('the export carries no instance-specific IDs or test data', () => {
  assert.equal(workflow.meta?.instanceId, undefined);
  assert.equal(workflow.id, undefined);
  assert.deepEqual(workflow.pinData ?? {}, {});
  for (const node of workflow.nodes) {
    for (const credential of Object.values(node.credentials || {})) {
      assert.equal(credential.id, undefined, `${node.name} still has a credential ID`);
    }
  }
});

test('no email address or phone number is hard-coded', () => {
  assert.doesNotMatch(raw, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  assert.doesNotMatch(raw, /(?<![\w-])\+?\d{11,15}(?![\w-])/);
});

test('every setting the workflow reads exists in the jh_settings template', () => {
  const columns = new Set(read('data-tables/jh_settings.csv').split('\n')[0].split(','));
  const used = new Set([
    ...[...raw.matchAll(/Load Settings[^']*'\)\.first\(\)\.json\.(\w+)/g)].map((m) => m[1]),
    ...[...raw.matchAll(/\bS\.(\w+)/g)].map((m) => m[1]),
  ]);
  assert.ok(used.size > 10, 'expected the workflow to read its settings');
  for (const field of used) assert.ok(columns.has(field), `setting missing from jh_settings.csv: ${field}`);
  assert.deepEqual(new Set(columns), documentedColumns('jh_settings'));
});

test('every column the workflow writes is documented in schema.md', () => {
  for (const node of workflow.nodes) {
    const table = node.parameters?.dataTableId?.value;
    const written = Object.keys(node.parameters?.columns?.value || {});
    if (!table || !written.length) continue;
    const documented = documentedColumns(table);
    for (const column of written) {
      assert.ok(documented.has(column), `${node.name} writes ${table}.${column}, which schema.md doesn't list`);
    }
  }
});

test("every $('Node') reference points at a node in the export", () => {
  const names = new Set(workflow.nodes.map((n) => n.name));
  // The Outlook node that sends application emails is not in this export (see
  // the README, "Auto-apply"). Remove it from this list once it is added back.
  const knownMissing = new Set(['Create Application Email']);
  const referenced = new Set([...raw.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  for (const name of referenced) {
    if (knownMissing.has(name)) {
      assert.ok(!names.has(name), `${name} is back in the export: remove it from knownMissing`);
      continue;
    }
    assert.ok(names.has(name), `the workflow reads $('${name}'), which isn't a node`);
  }
});
