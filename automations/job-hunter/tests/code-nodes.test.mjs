// Runs the Code nodes of the workflow export with sample data, without n8n.
// Each node's jsCode is read from workflow/job-hunter-all-in-one.json and run
// with small stand-ins for $, $input, $now and DateTime.
// Run: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const workflow = JSON.parse(read('workflow/job-hunter-all-in-one.json'));
const code = (name) => workflow.nodes.find((n) => n.name === name).parameters.jsCode;

/** The jh_settings template row, with the types an n8n Data Table returns. */
function templateSettings() {
  const lines = read('data-tables/jh_settings.csv').trim().split('\n');
  const header = lines[0].split(',');
  // Split one CSV line, honouring "quoted, values" and "" escapes.
  const cells = [...lines[1].matchAll(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g)]
    .map((m) => m[1])
    .slice(0, header.length)
    .map((c) => (c.startsWith('"') ? c.slice(1, -1).replace(/""/g, '"') : c));
  const row = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  for (const k of ['remote_ok', 'auto_apply_enabled']) row[k] = row[k] === 'true';
  for (const k of ['min_salary', 'hours_window', 'max_daily_applications', 'auto_apply_threshold', 'report_min_score']) {
    row[k] = Number(row[k]);
  }
  return row;
}

/**
 * Runs a Code node. `nodes` maps node names to arrays of item json;
 * `input` is the json of the items coming into the node.
 */
function run(name, { nodes = {}, input = [] } = {}) {
  const $ = (node) => {
    if (!(node in nodes)) throw new Error(`Node '${node}' hasn't been executed`);
    const items = nodes[node].map((json) => ({ json }));
    return { all: () => items, first: () => items[0] };
  };
  const items = input.map((json) => ({ json }));
  const $input = { all: () => items, first: () => items[0], item: items[0] };
  const zoned = (ms) => ({
    setZone: () => zoned(ms),
    toFormat: () => new Date(ms).toISOString().slice(0, 10),
  });
  const DateTime = { fromMillis: zoned };
  const $now = zoned(Date.now());
  const fn = new Function('$', '$input', 'DateTime', '$now', code(name));
  return fn($, $input, DateTime, $now).map((i) => i.json);
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

// ---------- Normalize & Filter Jobs ----------

function normalize(sources, settings = {}) {
  return run('Normalize & Filter Jobs', {
    nodes: { 'Load Settings': [{ ...templateSettings(), ...settings }], ...sources },
  });
}

const remotive = (job) => ({
  'Fetch Remotive Jobs': [{
    jobs: [{
      id: 1, title: 'Junior Python Developer', company_name: 'Acme', candidate_required_location: 'Worldwide',
      salary: '', publication_date: hoursAgo(3), url: 'https://example.com/jobs/1',
      description: '<p>Python, SQL and Docker.</p>', tags: ['python'], ...job,
    }],
  }],
});

test('Normalize keeps a matching junior job and reads its skills', () => {
  const [job] = normalize(remotive({}));
  assert.equal(job.title, 'Junior Python Developer');
  assert.equal(job.work_mode, 'remote');
  assert.equal(job.is_fresh, true);
  assert.equal(job.job_key, 'remotive:1');
  assert.match(job.skills, /python/);
  assert.match(job.skills, /docker/);
  assert.equal(job.description, 'Python, SQL and Docker.');
});

test('Normalize drops excluded titles, titles without a keyword, and old jobs', () => {
  assert.equal(normalize(remotive({ title: 'Senior Python Developer' })).length, 0);
  assert.equal(normalize(remotive({ title: 'Office Assistant' })).length, 0);
  assert.equal(normalize(remotive({ publication_date: hoursAgo(24 * 31) })).length, 0);
  assert.equal(normalize(remotive({ publication_date: 'not a date' })).length, 0);
  // Whole words only: "detail" must not match the keyword "ai".
  assert.equal(normalize(remotive({ title: 'Retail Python Specialist' })).length, 1);
  assert.equal(normalize(remotive({ title: 'Retail Specialist' })).length, 0);
});

test('Normalize accepts remote jobs only for the configured regions', () => {
  assert.equal(normalize(remotive({ candidate_required_location: 'USA Only' })).length, 0);
  assert.equal(normalize(remotive({ candidate_required_location: 'EMEA' })).length, 1);
  assert.equal(normalize(remotive({ candidate_required_location: 'Worldwide' }), { remote_ok: false }).length, 0);
});

test('Normalize accepts on-site jobs in the configured locations', () => {
  const arbeitnow = (location) => ({
    'Fetch Arbeitnow Jobs': [{
      data: [{
        slug: 'ai-intern', title: 'AI Intern', company_name: 'Nile', location, remote: false,
        created_at: Math.floor(Date.now() / 1000) - 3600, url: 'https://example.com/a', description: 'n8n',
      }],
    }],
  });
  const [job] = normalize(arbeitnow('Cairo, Egypt'));
  assert.equal(job.work_mode, 'onsite');
  assert.equal(normalize(arbeitnow('Berlin')).length, 0);
});

test('Normalize keeps one copy of the same job posted on two boards', () => {
  const jobs = normalize({
    ...remotive({}),
    'Fetch RemoteOK Jobs': [
      { legal: 'notice without id or position' },
      {
        id: 9, position: 'Junior Python Developer', company: 'Acme', location: 'Worldwide',
        date: hoursAgo(2), url: 'https://example.com/r/9', description: 'python',
      },
    ],
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].fetched_total, 2);
});

test('Normalize reads salary ranges and the apply email', () => {
  const [job] = normalize(remotive({
    salary: '$50k - $70k per year',
    description: 'Send your CV to Jobs@Acme.io. Questions: privacy@acme.io',
  }));
  assert.deepEqual(
    [job.salary_min, job.salary_max, job.salary_currency, job.salary_period],
    [50000, 70000, 'USD', 'year']
  );
  assert.equal(job.apply_email, 'jobs@acme.io');

  const [monthly] = normalize(remotive({ salary: '15,000 - 20,000 EGP / month' }));
  assert.deepEqual([monthly.salary_min, monthly.salary_currency, monthly.salary_period], [15000, 'EGP', 'month']);
});

test('Normalize marks jobs older than hours_window as not fresh', () => {
  const [job] = normalize(remotive({ publication_date: hoursAgo(30) }));
  assert.equal(job.is_fresh, false);
});

// ---------- Prepare Jobs For Scoring ----------

test('Prepare Jobs For Scoring refuses to run without a CV', () => {
  assert.throws(
    () => run('Prepare Jobs For Scoring', { nodes: { 'Load Settings': [{ ...templateSettings(), cv_text: ' ' }] } }),
    /cv_text is empty/
  );
});

test('Prepare Jobs For Scoring keeps unscored jobs once, best keyword match first', () => {
  const settings = { ...templateSettings(), cv_text: 'My CV' };
  const out = run('Prepare Jobs For Scoring', {
    nodes: { 'Load Settings': [settings] },
    input: [
      { id: 1, job_key: 'a', status: 'pending_score', title: 'Office job', description: 'x' },
      { id: 2, job_key: 'b', status: 'score_failed', title: 'Python automation intern', description: 'n8n' },
      { id: 3, job_key: 'b', status: 'score_failed', title: 'Python automation intern', description: 'n8n' },
      { id: 4, job_key: 'c', status: 'scored', title: 'Python', description: 'x' },
      { id: 5, job_key: 'd', status: 'pending_score', title: 'No description' },
    ],
  });
  assert.deepEqual(out.map((j) => j.row_id), [2, 1]);
});

// ---------- Plan Applications ----------

function plan({ settings = {}, jobs, scores, appliedToday = 0 }) {
  return run('Plan Applications', {
    nodes: {
      'Load Settings': [{ ...templateSettings(), ...settings }],
      'Prepare Jobs For Scoring': jobs,
      'Count Today Applications': appliedToday ? Array.from({ length: appliedToday }, (_, i) => ({ id: i + 1 })) : [{}],
    },
    input: scores.map((output) => (output ? { output } : { error: 'Gemini failed' })),
  });
}

test('Plan Applications sends strong matches to the manual list when auto-apply is off', () => {
  const out = plan({
    jobs: [
      { row_id: 1, title: 'A', apply_email: 'jobs@acme.io' },
      { row_id: 2, title: 'B', apply_email: '' },
      { row_id: 3, title: 'C' },
      { row_id: 4, title: 'D' },
    ],
    scores: [
      { score: 90, reason_ar: 'مناسب' },
      { score: '85', reason_ar: 'مناسب' },
      { score: 40, reason_ar: 'ضعيف' },
      null,
    ],
  });
  const byId = Object.fromEntries(out.map((j) => [j.row_id, j]));
  assert.deepEqual(out.map((j) => j.row_id), [1, 2, 3, 4]); // sorted by score
  assert.equal(byId[1].status, 'needs_manual');
  assert.match(byId[1].status_note, /jobs@acme\.io/);
  assert.equal(byId[2].status, 'needs_manual');
  assert.equal(byId[2].score, 85);
  assert.equal(byId[3].status, 'scored');
  assert.equal(byId[4].status, 'score_failed');
  assert.equal(byId[4].scored, false);
  assert.ok(out.every((j) => j.action !== 'auto_apply'));
});

test('Plan Applications keeps a strong match out of the manual list if it misses the level or salary', () => {
  const out = plan({
    settings: { min_salary: 10000, min_salary_currency: 'EGP', min_salary_period: 'month' },
    jobs: [
      { row_id: 1, title: 'Low pay', salary_min: 5000, salary_max: 8000, salary_currency: 'EGP', salary_period: 'month' },
      { row_id: 2, title: 'Too senior' },
      { row_id: 3, title: 'Other currency', salary_min: 100, salary_currency: 'USD', salary_period: 'month' },
    ],
    scores: [{ score: 95 }, { score: 95, meets_level: false }, { score: 95 }],
  });
  const byId = Object.fromEntries(out.map((j) => [j.row_id, j]));
  assert.equal(byId[1].status, 'scored');
  assert.match(byId[1].status_note, /الحد الأدنى/);
  assert.equal(byId[2].status, 'scored');
  assert.equal(byId[3].status, 'needs_manual'); // a different currency isn't compared
});

test('Plan Applications respects the daily auto-apply cap', () => {
  const out = plan({
    settings: { auto_apply_enabled: true, cv_pdf_url: 'https://example.com/cv.pdf', max_daily_applications: 2 },
    appliedToday: 1,
    jobs: [
      { row_id: 1, apply_email: 'a@example.com' },
      { row_id: 2, apply_email: 'b@example.com' },
    ],
    scores: [{ score: 90 }, { score: 88 }],
  });
  assert.deepEqual(out.map((j) => j.action), ['auto_apply', 'manual']);
  assert.match(out[1].status_note, /حد اليومي/);
});

// ---------- Build Report + Fit WhatsApp Limits ----------

function report(rows, news = []) {
  return run('Build Report', {
    nodes: {
      'Load Settings (Report)': [templateSettings()],
      'Get Jobs Last 30 Days': rows,
      'Fetch News EN': news,
      'Fetch News AR': [],
    },
  })[0];
}

const row = (i, extra = {}) => ({
  id: i, job_key: `k${i}`, source: 'remotive', title: `Job ${i}`, company: 'Acme',
  apply_url: `https://example.com/${i}`, is_fresh: true, found_at: hoursAgo(1),
  match_score: 70, status: 'scored', skills: 'python, sql', ...extra,
});

test('Build Report says salary data is insufficient below 5 postings', () => {
  const out = report([1, 2, 3, 4].map((i) => row(i, { salary_min: 1000, salary_max: 1000, salary_currency: 'USD', salary_period: 'month' })));
  assert.match(out.p6, /بيانات غير كافية: 4 إعلان/);
  assert.match(out.p5, /بيانات غير كافية/); // fewer than 10 postings for skills too
});

test('Build Report averages salaries per currency and period from 5 postings', () => {
  const rows = [1000, 2000, 3000, 4000, 5000].map((s, i) =>
    row(i + 1, { salary_min: s, salary_max: s, salary_currency: 'USD', salary_period: 'month' })
  );
  rows.push(row(9, { salary_min: 99999, salary_currency: 'EGP', salary_period: 'month' })); // other currency
  const out = report(rows);
  assert.match(out.p6, /متوسط 3,000 USD شهريًا \(من 5 إعلان/);
  assert.doesNotMatch(out.p6, /EGP/);
});

test('Build Report counts new good matches and skips duplicates and test rows', () => {
  const rows = [
    row(1, { match_score: 90 }),
    row(2, { match_score: 90, job_key: 'k1' }), // same job twice
    row(3, { match_score: 30 }),
    row(4, { match_score: 95, source: 'test' }),
    row(5, { match_score: 80, found_at: hoursAgo(48) }), // not new
    row(6, { status: 'needs_manual', match_score: 85 }),
  ];
  const out = report(rows);
  assert.equal(out.new_count, 2); // rows 1 and 6
  assert.equal(out.manual_count, 1);
  assert.equal(out.jobs_30d, 4); // rows 1, 3, 5, 6
});

test('WhatsApp template parameters have no line breaks and fit the length limits', () => {
  const rows = Array.from({ length: 12 }, (_, i) =>
    row(i + 1, { title: 'A very long job title '.repeat(10), match_score: 90, status: 'needs_manual' })
  );
  const news = [{ title: 'Big tech news in Egypt today - Source', link: 'https://example.com/n', isoDate: hoursAgo(2) }];
  const built = report(rows, news);
  const fitted = run('Fit WhatsApp Limits', { input: [built] })[0];
  const limits = { p1: 12, p2: 220, p3: 60, p4: 180, p5: 100, p6: 100, p7: 95 };
  for (const [key, max] of Object.entries(limits)) {
    assert.doesNotMatch(fitted[key], /[\r\n\t]| {4,}/, `${key} has a line break or 4+ spaces`);
    assert.ok(fitted[key].length <= max, `${key} is ${fitted[key].length} characters`);
    assert.ok(fitted[key].length > 0, `${key} is empty`);
  }
});

test('Full details stay under the WhatsApp limit without losing the skills, salary and news', () => {
  // A busy day: 10 new matches and 10 manual ones, each with an Arabic reason and a long link.
  const reason = 'الوظيفة مناسبة لأن الـCV فيه Python وn8n ومشاريع أتمتة، لكن ناقصه خبرة عملية في Docker. '.repeat(2);
  const rows = Array.from({ length: 20 }, (_, i) =>
    row(i + 1, {
      title: `Junior AI Automation Engineer (Python, n8n) ${i + 1}`,
      company: 'A Company With A Fairly Long Name',
      match_score: 90,
      match_reason: reason,
      status: i < 10 ? 'scored' : 'needs_manual',
      status_note: 'التقديم من موقع الجهة (نموذج أو تسجيل دخول)',
      apply_url: `https://jobs.example.com/apply/${'x'.repeat(80)}/${i + 1}?utm_source=remotive`,
    })
  );
  const news = [{ title: 'Big tech news in Egypt today - Source', link: 'https://example.com/n', isoDate: hoursAgo(2) }];
  const { full_text: text } = report(rows, news);

  assert.ok(text.length <= 4000, `full_text is ${text.length} characters`);
  assert.match(text, /📊 أكثر المهارات طلبًا/);
  assert.match(text, /💰 الرواتب/);
  assert.match(text, /Big tech news in Egypt today – Source \(\d{4}-\d{2}-\d{2}\) https:\/\/example\.com\/n$/);
  // Job lines are dropped whole, never cut in the middle of a link.
  for (const line of text.split('\n').filter((l) => l.includes('https://jobs.example.com'))) {
    assert.match(line, /\?utm_source=remotive$/, `cut line: ${line}`);
  }
  assert.match(text, /\n…\n/);
});

// ---------- Match Confirmations ----------

test('Match Confirmations reads replies, bounces and reference numbers', () => {
  const out = run('Match Confirmations', {
    nodes: {
      'Load Settings (Report)': [{ applicant_email: 'me@example.com' }],
      'Get Awaiting Confirmation': [
        { id: 1, gmail_thread_id: 'c1' },
        { id: 2, gmail_thread_id: 'c2' },
        { id: 3, gmail_thread_id: 'c3' },
      ],
      'Check Outlook Replies': [
        { conversationId: 'c1', from: { emailAddress: { address: 'hr@acme.io' } }, subject: 'Application received', bodyPreview: 'Reference: APP-1234', receivedDateTime: hoursAgo(1) },
        { conversationId: 'c2', from: { emailAddress: { address: 'postmaster@acme.io' } }, subject: 'Undeliverable' },
        { conversationId: 'c3', from: { emailAddress: { address: 'me@example.com' } }, subject: 'my own message' },
      ],
    },
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].status, 'applied_confirmed');
  assert.equal(out[0].confirmation_ref, 'APP-1234');
  assert.equal(out[1].status, 'needs_manual');
});

test('Match Confirmations does nothing while the Outlook node is disabled', () => {
  const out = run('Match Confirmations', {
    nodes: {
      'Load Settings (Report)': [{ applicant_email: 'me@example.com' }],
      'Get Awaiting Confirmation': [{ id: 1, gmail_thread_id: 'c1' }],
    },
  });
  assert.deepEqual(out, []);
});

// ---------- CareerMind skill-gap check ----------

test('Format Skill Gaps keeps the missing skills of each answered job and skips failed calls', () => {
  const out = run('Format Skill Gaps', {
    nodes: { 'Deep Check?': [{ row_id: 1 }, { row_id: 2 }, { row_id: 3 }] },
    input: [
      { job_match_score: 72, missing_skills: ['Docker'], partial_match_skills: ['SQL'] },
      { error: { message: 'timeout' } },
      { job_match_score: 90, missing_skills: [] },
    ],
  });
  assert.deepEqual(out, [
    { row_id: 1, careermind_score: 72, skill_gaps: 'Docker, SQL' },
    { row_id: 3, careermind_score: 90, skill_gaps: '' },
  ]);
});

test('Build Report shows the skill gaps next to a manual-application job', () => {
  const out = report([row(1, { status: 'needs_manual', match_score: 85, skill_gaps: 'Docker, SQL' })]);
  assert.match(out.full_text, /ناقصك: Docker, SQL/);
});
