// Minimal in-memory stand-in for the Supabase client, covering the query
// methods the routes use, including the feed's embedded "job:jobs!inner(...)"
// select and simple .or() filters.
const { randomUUID } = require('crypto');

const KEYS = { jobs: ['source', 'external_id'], job_matches: ['user_id', 'job_id'], profiles: ['id'], analyses: ['id'] };

function createFakeDb(seed = {}, users = {}) {
  const tables = { profiles: [], jobs: [], job_matches: [], analyses: [], ...structuredClone(seed) };
  const log = [];

  function query(table) {
    const filters = [];
    let op = 'select';
    let payload = null;
    let opts = {};
    let limit = null;
    let returning = false;
    let columns = '*';
    let order = null;
    const embedFilters = [];

    const rows = () => tables[table].filter((r) => filters.every((f) => f(r)));
    const q = {
      select(cols = '*') { if (op === 'select') columns = cols; else returning = true; return q; },
      eq(col, v) { filters.push((r) => r[col] === v); return q; },
      in(col, vs) { filters.push((r) => vs.includes(r[col])); return q; },
      not(col, operator, v) { filters.push((r) => (operator === 'is' && v === null ? r[col] != null : true)); return q; },
      ilike(col, v) { filters.push((r) => String(r[col] || '').toLowerCase() === String(v).toLowerCase()); return q; },
      gte(col, v) {
        if (col.includes('.')) embedFilters.push((r) => r[col.split('.')[0]] && r[col.split('.')[0]][col.split('.')[1]] >= v);
        else filters.push((r) => r[col] != null && r[col] >= v);
        return q;
      },
      or(expr) {
        const parts = expr.split(',').map((p) => {
          const [col, operator, ...rest] = p.split('.');
          const value = rest.join('.');
          if (operator === 'gte') return (r) => r[col] != null && r[col] >= Number(value);
          if (operator === 'eq') return (r) => String(r[col]) === value;
          throw new Error('fake or(): unsupported ' + p);
        });
        filters.push((r) => parts.some((f) => f(r)));
        return q;
      },
      order(col, o = {}) { order = { col, asc: o.ascending !== false }; return q; },
      limit(n) { limit = n; return q; },
      upsert(data, o = {}) { op = 'upsert'; payload = [].concat(data); opts = o; return q; },
      update(data) { op = 'update'; payload = data; return q; },
      insert(data) { op = 'insert'; payload = [].concat(data); return q; },
      then(resolve, reject) {
        try { resolve(run()); } catch (e) { reject(e); }
      },
    };

    function run() {
      log.push({ table, op, payload });
      if (op === 'select') {
        let out = rows().map((r) => ({ ...r }));
        const embed = /(\w+):(\w+)!inner/.exec(columns);
        if (embed) {
          const [, alias, other] = embed;
          out = out
            .map((r) => ({ ...r, [alias]: tables[other].find((o) => o.id === r[`${other.slice(0, -1)}_id`]) || null }))
            .filter((r) => r[alias] && embedFilters.every((f) => f(r)));
        }
        if (order) {
          out.sort((a, b) => {
            const x = a[order.col], y = b[order.col];
            if (x == null && y == null) return 0;
            if (x == null) return 1;
            if (y == null) return -1;
            return (x < y ? -1 : x > y ? 1 : 0) * (order.asc ? 1 : -1);
          });
        }
        return { data: limit ? out.slice(0, limit) : out, error: null };
      }
      if (op === 'update') {
        const hit = rows();
        hit.forEach((r) => Object.assign(r, payload));
        return { data: hit, error: null };
      }
      if (op === 'insert') {
        const added = payload.map((p) => ({ id: randomUUID(), created_at: new Date().toISOString(), analysis: null, ...p }));
        tables[table].push(...added);
        return { data: added, error: null };
      }
      // upsert
      const keys = (opts.onConflict || KEYS[table].join(',')).split(',');
      const out = payload.map((p) => {
        const found = tables[table].find((r) => keys.every((k) => r[k] === p[k]));
        if (found) return Object.assign(found, p);
        const row = { id: randomUUID(), created_at: new Date().toISOString(), analysis: null, status: 'new', origin: 'job-hunter', ...p };
        tables[table].push(row);
        return row;
      });
      return { data: out, error: null };
    }
    return q;
  }

  return {
    tables,
    log,
    from: (table) => query(table),
    auth: {
      async getUser(token) {
        const user = users[token];
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad token' } };
      },
    },
  };
}

module.exports = { createFakeDb };
