// Query executor. Evaluates SELECT queries and (optionally) reports a trace of
// every pipeline stage so the UI can animate the real rows moving.
import { SqlError } from './tokenizer.js';
import { fmt, fmtNum } from './format.js';
import { MAX_CHIPS, rowKey, capped, relChips, laneCols } from './trace.js';

const PENDING = '…'; // shown in a window column before that value has been computed

const MAX_ROWS = 20000;
const AGG = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'STRING_AGG']);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---------------------------------------------------------------- values
const isNull = (v) => v === null || v === undefined;

export function num(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (v.trim() !== '' && !Number.isNaN(n)) return n;
  }
  return NaN;
}

export function cmpSql(a, b) {
  if (isNull(a) || isNull(b)) return null;
  if (typeof a === 'boolean') a = a ? 1 : 0;
  if (typeof b === 'boolean') b = b ? 1 : 0;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  const na = num(a), nb = num(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function truth(v) {
  if (isNull(v)) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const n = num(v);
  return Number.isNaN(n) ? false : n !== 0;
}

const and3 = (a, b) => (a === false || b === false ? false : a === null || b === null ? null : true);
const or3 = (a, b) => (a === true || b === true ? true : a === null || b === null ? null : false);
const not3 = (a) => (a === null ? null : !a);
const roundFix = (x) => (Number.isFinite(x) ? Math.round(x * 1e9) / 1e9 : x);
const keyOf = (vals) => JSON.stringify(vals);

const likeCache = new Map();
function likeRe(pat) {
  let re = likeCache.get(pat);
  if (!re) {
    const src = String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
    re = new RegExp('^' + src + '$', 'is');
    likeCache.set(pat, re);
  }
  return re;
}

// ---------------------------------------------------------------- scopes
function colIndex(cols) {
  if (cols._ix) return cols._ix;
  const m = new Map();
  const put = (k, i) => { const a = m.get(k); if (a) a.push(i); else m.set(k, [i]); };
  cols.forEach((c, i) => {
    const n = c.name.toLowerCase();
    if (!c.hidden) put(n, i);
    if (c.tbl) put(c.tbl.toLowerCase() + '.' + n, i);
  });
  Object.defineProperty(cols, '_ix', { value: m, enumerable: false });
  return m;
}

function lookupCol(scope, table, name) {
  const key = table ? table.toLowerCase() + '.' + name.toLowerCase() : name.toLowerCase();
  for (let s = scope; s; s = s.parent) {
    const idx = colIndex(s.cols).get(key);
    if (idx) {
      if (idx.length > 1) {
        const owners = idx.map((i) => s.cols[i].tbl).filter(Boolean).join(' and ');
        throw new SqlError(`Column "${name}" is ambiguous${owners ? ` (it exists in ${owners})` : ''} — write it as table.${name}`);
      }
      return [s, idx[0]];
    }
  }
  throw new SqlError(`Unknown column "${table ? table + '.' : ''}${name}"`);
}

const mkEnv = (cols, v, ctx, outer) => ({ scope: { cols, v, parent: outer }, ctx, group: null, gcols: null, win: null, wi: 0 });

// ---------------------------------------------------------------- expression walkers
function children(e) {
  switch (e.t) {
    case 'bin': return [e.l, e.r];
    case 'un': case 'isnull': case 'istf': case 'cast': return [e.e];
    case 'between': return [e.e, e.lo, e.hi];
    case 'in': return [e.e, ...(e.list || [])];
    case 'like': return [e.e, e.pat];
    case 'case': return [e.operand, ...e.whens.flatMap((w) => [w.c, w.r]), e.else].filter(Boolean);
    case 'fn': return [...e.args, ...(e.over ? [...e.over.partitionBy, ...e.over.orderBy.map((o) => o.expr)] : [])];
    default: return [];
  }
}

function containsAgg(e) {
  if (e.t === 'fn' && !e.over && AGG.has(e.name)) return true;
  return children(e).some(containsAgg);
}

function collectWindows(e, acc = []) {
  if (e.t === 'fn' && e.over) acc.push(e);
  children(e).forEach((c) => collectWindows(c, acc));
  return acc;
}

// ---------------------------------------------------------------- evaluation
export function ev(e, env) {
  switch (e.t) {
    case 'num': case 'str': case 'bool': return e.v;
    case 'null': return null;
    case 'col': {
      const [s, i] = lookupCol(env.scope, e.table, e.name);
      return s.v[i];
    }
    case 'colidx': return env.scope.v[e.i];
    case 'un': {
      const x = ev(e.e, env);
      if (e.op === 'NOT') return not3(truth(x));
      if (isNull(x)) return null;
      return e.op === '-' ? -num(x) : num(x);
    }
    case 'bin': return evBin(e, env);
    case 'isnull': { const x = ev(e.e, env); return e.not ? !isNull(x) : isNull(x); }
    case 'istf': { const t = truth(ev(e.e, env)); const r = t === e.val; return e.not ? !r : r; }
    case 'between': {
      const x = ev(e.e, env), lo = ev(e.lo, env), hi = ev(e.hi, env);
      const a = cmpSql(x, lo), b = cmpSql(x, hi);
      const r = and3(a === null ? null : a >= 0, b === null ? null : b <= 0);
      return e.not ? not3(r) : r;
    }
    case 'in': {
      const x = ev(e.e, env);
      let list;
      if (e.query) {
        const res = env.ctx.sub(e.query, env.scope);
        if (res.cols.length !== 1) throw new SqlError('A subquery used with IN must return exactly one column');
        list = res.rows.map((r) => r.v[0]);
      } else list = e.list.map((x2) => ev(x2, env));
      if (isNull(x)) return list.length ? null : e.not ? true : false;
      let sawNull = false, found = false;
      for (const y of list) {
        if (isNull(y)) { sawNull = true; continue; }
        if (cmpSql(x, y) === 0) { found = true; break; }
      }
      const r = found ? true : sawNull ? null : false;
      return e.not ? not3(r) : r;
    }
    case 'like': {
      const x = ev(e.e, env), p = ev(e.pat, env);
      if (isNull(x) || isNull(p)) return null;
      const r = likeRe(String(p)).test(typeof x === 'number' ? fmtNum(x) : String(x));
      return e.not ? !r : r;
    }
    case 'case': {
      if (e.operand) {
        const o = ev(e.operand, env);
        for (const w of e.whens) if (cmpSql(o, ev(w.c, env)) === 0) return ev(w.r, env);
      } else {
        for (const w of e.whens) if (truth(ev(w.c, env)) === true) return ev(w.r, env);
      }
      return e.else ? ev(e.else, env) : null;
    }
    case 'fn': return evFn(e, env);
    case 'exists': {
      const res = env.ctx.sub(e.query, env.scope);
      const r = res.rows.length > 0;
      return e.not ? !r : r;
    }
    case 'sub': {
      const res = env.ctx.sub(e.query, env.scope);
      if (res.cols.length !== 1) throw new SqlError('A scalar subquery must return exactly one column');
      if (res.rows.length > 1) throw new SqlError(`A scalar subquery returned ${res.rows.length} rows; it must return at most one`);
      return res.rows.length ? res.rows[0].v[0] : null;
    }
    case 'cast': return evCast(ev(e.e, env), e.type);
    default: throw new SqlError('Unsupported expression: ' + e.t);
  }
}

function evCast(x, type) {
  if (isNull(x)) return null;
  if (['INT', 'INTEGER', 'BIGINT', 'SMALLINT'].includes(type)) { const n = num(x); return Number.isNaN(n) ? null : Math.trunc(n); }
  if (['REAL', 'FLOAT', 'DOUBLE', 'NUMERIC', 'DECIMAL'].includes(type)) { const n = num(x); return Number.isNaN(n) ? null : n; }
  return typeof x === 'number' ? fmtNum(x) : String(x);
}

function evBin(e, env) {
  const op = e.op;
  if (op === 'AND') {
    const a = truth(ev(e.l, env));
    if (a === false) return false;
    return and3(a, truth(ev(e.r, env)));
  }
  if (op === 'OR') {
    const a = truth(ev(e.l, env));
    if (a === true) return true;
    return or3(a, truth(ev(e.r, env)));
  }
  const l = ev(e.l, env), r = ev(e.r, env);
  switch (op) {
    case '=': { const c = cmpSql(l, r); return c === null ? null : c === 0; }
    case '<>': { const c = cmpSql(l, r); return c === null ? null : c !== 0; }
    case '<': { const c = cmpSql(l, r); return c === null ? null : c < 0; }
    case '>': { const c = cmpSql(l, r); return c === null ? null : c > 0; }
    case '<=': { const c = cmpSql(l, r); return c === null ? null : c <= 0; }
    case '>=': { const c = cmpSql(l, r); return c === null ? null : c >= 0; }
    case '||': return isNull(l) || isNull(r) ? null : fmt(l) + fmt(r);
    default: {
      if (isNull(l) || isNull(r)) return null;
      const a = num(l), b = num(r);
      if (Number.isNaN(a) || Number.isNaN(b)) throw new SqlError(`Cannot do arithmetic on "${fmt(Number.isNaN(a) ? l : r)}" — it is not a number`);
      if (op === '+') return a + b;
      if (op === '-') return a - b;
      if (op === '*') return a * b;
      if (op === '/') return b === 0 ? null : a / b;
      if (op === '%') return b === 0 ? null : a % b;
      throw new SqlError('Unknown operator ' + op);
    }
  }
}

function aggFinal(name, vals, star, distinct, sep) {
  if (name === 'COUNT') {
    if (star) return vals.length;
    let v = vals.filter((x) => !isNull(x));
    if (distinct) v = [...new Map(v.map((x) => [keyOf(x), x])).values()];
    return v.length;
  }
  let v = vals.filter((x) => !isNull(x));
  if (distinct) v = [...new Map(v.map((x) => [keyOf(x), x])).values()];
  if (!v.length) return null;
  switch (name) {
    case 'SUM': return roundFix(v.reduce((s, x) => s + num(x), 0));
    case 'AVG': return roundFix(v.reduce((s, x) => s + num(x), 0) / v.length);
    case 'MIN': return v.reduce((a, b) => (cmpSql(b, a) < 0 ? b : a));
    case 'MAX': return v.reduce((a, b) => (cmpSql(b, a) > 0 ? b : a));
    case 'GROUP_CONCAT': case 'STRING_AGG': return v.map(fmt).join(sep ?? ',');
    default: throw new SqlError('Unknown aggregate ' + name);
  }
}

function computeAgg(e, rows, env) {
  if (e.star && e.name !== 'COUNT') throw new SqlError(`${e.name}(*) is not valid — only COUNT(*) can use *`);
  if (!e.star && e.args.length < 1) throw new SqlError(`${e.name}() needs an argument`);
  const sub = { ...env, group: null, win: null };
  const vals = e.star ? rows.map(() => 1) : rows.map((r) => ev(e.args[0], { ...sub, scope: { cols: env.gcols, v: r.v, parent: env.scope.parent } }));
  const sep = e.args[1] ? ev(e.args[1], env) : undefined;
  return aggFinal(e.name, vals, e.star, e.distinct, sep);
}

function evFn(e, env) {
  const name = e.name;
  if (e.over) {
    const arr = env.win && env.win.get(e);
    if (!arr) throw new SqlError(`Window function ${name}() OVER (...) can only be used in the SELECT list or ORDER BY`);
    return arr[env.wi];
  }
  if (AGG.has(name)) {
    if (!env.group) throw new SqlError(`Aggregate ${name}() is not allowed here. Aggregates can't be used in WHERE or ON — filter on them with HAVING instead.`);
    return computeAgg(e, env.group, env);
  }
  if (['ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE'].includes(name)) {
    throw new SqlError(`${name}() is a window function — it needs an OVER (...) clause`);
  }
  return scalarFn(name, e.args.map((a) => ev(a, env)));
}

function dateParts(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  return m ? m.slice(1).map(Number) : null;
}

function scalarFn(name, a) {
  const arity = (n) => { if (a.length < n) throw new SqlError(`${name}() needs ${n} argument${n > 1 ? 's' : ''}`); };
  switch (name) {
    case 'UPPER': arity(1); return isNull(a[0]) ? null : fmt(a[0]).toUpperCase();
    case 'LOWER': arity(1); return isNull(a[0]) ? null : fmt(a[0]).toLowerCase();
    case 'LENGTH': case 'LEN': arity(1); return isNull(a[0]) ? null : fmt(a[0]).length;
    case 'TRIM': arity(1); return isNull(a[0]) ? null : fmt(a[0]).trim();
    case 'LTRIM': arity(1); return isNull(a[0]) ? null : fmt(a[0]).trimStart();
    case 'RTRIM': arity(1); return isNull(a[0]) ? null : fmt(a[0]).trimEnd();
    case 'SUBSTR': case 'SUBSTRING': {
      arity(2);
      if (isNull(a[0])) return null;
      const s = fmt(a[0]);
      let start = num(a[1]);
      const len = a[2] === undefined ? undefined : num(a[2]);
      start = start > 0 ? start - 1 : start < 0 ? Math.max(s.length + start, 0) : 0;
      return len === undefined ? s.slice(start) : s.substr(start, len);
    }
    case 'REPLACE': arity(3); return a.some(isNull) ? null : fmt(a[0]).split(fmt(a[1])).join(fmt(a[2]));
    case 'INSTR': arity(2); return a.some(isNull) ? null : fmt(a[0]).indexOf(fmt(a[1])) + 1;
    case 'CONCAT': return a.filter((x) => !isNull(x)).map(fmt).join('');
    case 'ABS': arity(1); return isNull(a[0]) ? null : Math.abs(num(a[0]));
    case 'ROUND': {
      arity(1);
      if (isNull(a[0])) return null;
      const d = a[1] === undefined ? 0 : num(a[1]);
      const f = 10 ** d;
      return Math.round((num(a[0]) + Number.EPSILON) * f) / f;
    }
    case 'CEIL': case 'CEILING': arity(1); return isNull(a[0]) ? null : Math.ceil(num(a[0]));
    case 'FLOOR': arity(1); return isNull(a[0]) ? null : Math.floor(num(a[0]));
    case 'SQRT': arity(1); return isNull(a[0]) ? null : Math.sqrt(num(a[0]));
    case 'POWER': case 'POW': arity(2); return a.some(isNull) ? null : num(a[0]) ** num(a[1]);
    case 'MOD': arity(2); return a.some(isNull) || num(a[1]) === 0 ? null : num(a[0]) % num(a[1]);
    case 'COALESCE': arity(1); return a.find((x) => !isNull(x)) ?? null;
    case 'IFNULL': case 'NVL': arity(2); return isNull(a[0]) ? a[1] : a[0];
    case 'NULLIF': arity(2); return cmpSql(a[0], a[1]) === 0 ? null : a[0];
    case 'IIF': arity(3); return truth(a[0]) === true ? a[1] : a[2];
    case 'LEAST': { const v = a.filter((x) => !isNull(x)); return v.length && a.length === v.length ? v.reduce((x, y) => (cmpSql(y, x) < 0 ? y : x)) : null; }
    case 'GREATEST': { const v = a.filter((x) => !isNull(x)); return v.length && a.length === v.length ? v.reduce((x, y) => (cmpSql(y, x) > 0 ? y : x)) : null; }
    case 'YEAR': { arity(1); const p = dateParts(a[0]); return p ? p[0] : null; }
    case 'MONTH': { arity(1); const p = dateParts(a[0]); return p ? p[1] : null; }
    case 'DAY': { arity(1); const p = dateParts(a[0]); return p ? p[2] : null; }
    case 'DATEDIFF': {
      arity(2);
      const x = dateParts(a[0]), y = dateParts(a[1]);
      if (!x || !y) return null;
      return Math.round((Date.UTC(x[0], x[1] - 1, x[2]) - Date.UTC(y[0], y[1] - 1, y[2])) / 864e5);
    }
    default: throw new SqlError(`Unknown function ${name}()`);
  }
}

// ---------------------------------------------------------------- sorting
function sortIdx(n, keyRows, specs) {
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => {
    for (let k = 0; k < specs.length; k++) {
      const x = keyRows[a][k], y = keyRows[b][k];
      const an = isNull(x), bn = isNull(y);
      if (an || bn) {
        if (an && bn) continue;
        const nullFirst = specs[k].nulls ? specs[k].nulls === 'first' : !specs[k].desc;
        return an ? (nullFirst ? -1 : 1) : (nullFirst ? 1 : -1);
      }
      let c = cmpSql(x, y);
      if (specs[k].desc) c = -c;
      if (c) return c;
    }
    return a - b;
  });
  return idx;
}

// ---------------------------------------------------------------- window functions
function computeWindows(wins, envs, rec = null) {
  const map = new Map();
  for (const w of wins) {
    if (map.has(w)) continue;
    const spec = w.over;
    const res = new Array(envs.length).fill(null);
    const parts = new Map();
    envs.forEach((env, i) => {
      const k = keyOf(spec.partitionBy.map((p) => ev(p, env)));
      const a = parts.get(k);
      if (a) a.push(i); else parts.set(k, [i]);
    });
    for (const idxs of parts.values()) {
      const keyRows = idxs.map((i) => spec.orderBy.map((o) => ev(o.expr, envs[i])));
      const order = sortIdx(idxs.length, keyRows, spec.orderBy);
      const sorted = order.map((p) => idxs[p]);
      const okeys = order.map((p) => keyRows[p]);
      const same = (a, b) => okeys[a].every((x, k) => (isNull(x) && isNull(okeys[b][k])) || cmpSql(x, okeys[b][k]) === 0);
      const len = sorted.length;
      const rpart = rec ? { sorted, okeys, per: new Array(len).fill(null) } : null;
      if (rpart) { const l = rec.get(w); if (l) l.push(rpart); else rec.set(w, [rpart]); }
      const peerStart = (p) => { while (p > 0 && same(p, p - 1)) p--; return p; };
      const peerEnd = (p) => { while (p < len - 1 && same(p, p + 1)) p++; return p; };
      const argAt = (k, p) => ev(w.args[k], envs[sorted[p]]);
      let rank = 0, dense = 0;
      for (let p = 0; p < len; p++) {
        const gi = sorted[p];
        switch (w.name) {
          case 'ROW_NUMBER': res[gi] = p + 1; break;
          case 'RANK': if (p === 0 || !same(p, p - 1)) rank = p + 1; res[gi] = rank; break;
          case 'DENSE_RANK': if (p === 0 || !same(p, p - 1)) dense++; res[gi] = dense; break;
          case 'NTILE': {
            const n = num(ev(w.args[0], envs[gi]));
            const base = Math.floor(len / n), rem = len % n;
            let acc = 0, bucket = 1;
            for (; bucket <= n; bucket++) { acc += base + (bucket <= rem ? 1 : 0); if (p < acc) break; }
            res[gi] = bucket;
            break;
          }
          case 'LAG': case 'LEAD': {
            const off = w.args[1] ? num(ev(w.args[1], envs[gi])) : 1;
            const t = w.name === 'LAG' ? p - off : p + off;
            if (rpart) rpart.per[p] = { t: t >= 0 && t < len ? t : null, off };
            res[gi] = t >= 0 && t < len ? argAt(0, t) : (w.args[2] ? ev(w.args[2], envs[gi]) : null);
            break;
          }
          default: {
            // aggregates & FIRST/LAST_VALUE use a frame
            let lo = 0, hi = len - 1;
            const f = spec.frame;
            if (f) {
              const rangeLike = f.unit === 'RANGE';
              const b = (bd, isStart) => {
                if (bd.k === 'unb') return bd.d === 'PRECEDING' ? 0 : len - 1;
                if (bd.k === 'cur') return rangeLike ? (isStart ? peerStart(p) : peerEnd(p)) : p;
                return bd.d === 'PRECEDING' ? p - bd.n : p + bd.n;
              };
              lo = b(f.start, true); hi = b(f.end, false);
            } else if (spec.orderBy.length) hi = peerEnd(p);
            lo = Math.max(lo, 0); hi = Math.min(hi, len - 1);
            if (rpart) rpart.per[p] = { lo, hi };
            if (w.name === 'FIRST_VALUE') res[gi] = lo <= hi ? argAt(0, lo) : null;
            else if (w.name === 'LAST_VALUE') res[gi] = lo <= hi ? argAt(0, hi) : null;
            else if (AGG.has(w.name)) {
              const vals = [];
              for (let q = lo; q <= hi; q++) vals.push(w.star ? 1 : argAt(0, q));
              res[gi] = aggFinal(w.name, vals, w.star, w.distinct);
            } else throw new SqlError(`${w.name}() cannot be used as a window function`);
          }
        }
      }
    }
    map.set(w, res);
  }
  return map;
}

// ---------------------------------------------------------------- relations
function nullsRow(n) { return new Array(n).fill(null); }
const uniq = (arr) => [...new Set(arr)];

function sourceRel(node, st) {
  const label = node.alias || node.name;
  if (st.aliases.has(label.toLowerCase())) {
    throw new SqlError(`"${label}" appears twice in FROM. Give each copy its own alias (e.g. ${node.name} AS a ... ${node.name} AS b).`);
  }
  st.aliases.add(label.toLowerCase());
  const cte = st.ctx.ctes.get(node.name.toLowerCase());
  if (cte) {
    return {
      kind: 'cte',
      cols: cte.cols.map((c) => ({ tbl: label, name: c.name, base: c.base || null })),
      rows: cte.rows.map((r, i) => ({ v: r.v, p: [`${label}:${i}`], h: r.h || [], ck: r.ck })),
    };
  }
  const t = st.ctx.db.getTable(node.name);
  if (!t) {
    const names = [...st.ctx.db.tables.values()].map((x) => x.name).join(', ');
    throw new SqlError(`Table "${node.name}" does not exist. Available tables: ${names}`);
  }
  return {
    kind: 'table',
    table: t.name,
    cols: t.cols.map((c) => ({ tbl: label, name: c.name, base: t.name })),
    rows: t.rows.map((r) => ({ v: r.v, p: [`${label}:${r.rid}`], h: [`${t.name}#${r.rid}`] })),
  };
}

function evalSimple(node, st) {
  if (node.type === 'table') return sourceRel(node, st);
  const label = node.alias;
  if (st.aliases.has(label.toLowerCase())) throw new SqlError(`"${label}" appears twice in FROM. Use a different alias.`);
  st.aliases.add(label.toLowerCase());
  const res = (st.derived && st.derived.get(node)) || execQuery(node.query, st.ctx, st.outer, null);
  return {
    kind: 'derived',
    cols: res.cols.map((c) => ({ tbl: label, name: c.name, base: c.base || null })),
    rows: res.rows.map((r, i) => ({ v: r.v, p: [`${label}:${i}`], h: r.h || [], ck: r.ck })),
  };
}

function fromLabel(node) {
  if (node.type === 'table') return node.alias && node.alias.toLowerCase() !== node.name.toLowerCase() ? `${node.name} AS ${node.alias}` : node.name;
  return node.alias;
}

const JOIN_WORDS = {
  inner: 'Only rows that find a partner survive. Rows with no match on either side are discarded.',
  left: 'Every LEFT row survives. Left rows with no partner are kept and padded with NULLs on the right.',
  right: 'Every RIGHT row survives. Right rows with no partner are kept and padded with NULLs on the left.',
  full: 'Every row from BOTH sides survives. Rows with no partner are kept and padded with NULLs.',
  cross: 'No condition: every left row is paired with every right row (a Cartesian product).',
};

function doJoin(L, R, node, st) {
  const kind = node.kind;
  let cols = L.cols.concat(R.cols);
  let test = null;
  if (node.using) {
    const hidden = new Set();
    const pairs = node.using.map((name) => {
      const li = L.cols.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
      const ri = R.cols.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
      if (li < 0 || ri < 0) throw new SqlError(`USING (${name}) needs a column called "${name}" on both sides of the join`);
      hidden.add(L.cols.length + ri);
      return [li, L.cols.length + ri];
    });
    cols = L.cols.concat(R.cols).map((c, i) => (hidden.has(i) ? { ...c, hidden: true } : c));
    test = (v) => pairs.every(([a, b]) => cmpSql(v[a], v[b]) === 0);
  } else if (node.on) {
    test = (v) => truth(ev(node.on, mkEnv(cols, v, st.ctx, st.outer))) === true;
  }
  const out = [];
  const rMatched = new Set();
  const rn = R.cols.length, ln = L.cols.length;
  for (const l of L.rows) {
    let matched = false;
    const lk = rowKey(l);
    for (let ri = 0; ri < R.rows.length; ri++) {
      const r = R.rows[ri];
      const v = l.v.concat(r.v);
      if (test && !test(v)) continue;
      matched = true;
      rMatched.add(ri);
      out.push({ v, p: l.p.concat(r.p), h: uniq(l.h.concat(r.h)), lk, rk: rowKey(r) });
      if (out.length > MAX_ROWS) throw new SqlError(`The join produced more than ${MAX_ROWS.toLocaleString()} rows — check your ON condition.`);
    }
    if (!matched && (kind === 'left' || kind === 'full')) out.push({ v: l.v.concat(nullsRow(rn)), p: l.p.slice(), h: l.h, lk });
  }
  if (kind === 'right' || kind === 'full') {
    R.rows.forEach((r, ri) => {
      if (!rMatched.has(ri)) out.push({ v: nullsRow(ln).concat(r.v), p: r.p.slice(), h: r.h, rk: rowKey(r) });
    });
  }
  return { cols, rows: out, matched: rMatched.size, comparisons: L.rows.length * R.rows.length };
}

// ---------------------------------------------------------------- SELECT
function expandItems(items, cols) {
  const out = [];
  for (const it of items) {
    if (it.star) {
      const sel = cols.map((c, i) => [c, i]).filter(([c]) => !c.hidden && (!it.table || (c.tbl && c.tbl.toLowerCase() === it.table.toLowerCase())));
      if (it.table && !sel.length) throw new SqlError(`Unknown table "${it.table}" in ${it.table}.*`);
      if (!cols.length) throw new SqlError('SELECT * needs a FROM clause');
      for (const [c, i] of sel) out.push({ expr: { t: 'colidx', i }, name: c.name, base: c.base || null, text: c.name, star: true, tbl: c.tbl });
      continue;
    }
    const e = it.expr;
    let name = it.alias;
    let base = null;
    if (e.t === 'col') {
      const idx = colIndex(cols).get(e.table ? e.table.toLowerCase() + '.' + e.name.toLowerCase() : e.name.toLowerCase());
      if (idx && idx.length === 1) base = cols[idx[0]].base || null;
      if (!name) name = e.name;
    }
    if (!name) name = it.text;
    out.push({ expr: e, name, base, text: it.text, alias: it.alias });
  }
  return out;
}

function resolveGroupExpr(g, items, cols) {
  if (g.t === 'num' && Number.isInteger(g.v)) {
    if (g.v < 1 || g.v > items.length) throw new SqlError(`GROUP BY ${g.v} is out of range — the SELECT list has ${items.length} columns`);
    return items[g.v - 1].expr;
  }
  if (g.t === 'col' && !g.table) {
    const own = colIndex(cols).get(g.name.toLowerCase());
    if (!own) {
      const it = items.find((x) => x.alias && x.alias.toLowerCase() === g.name.toLowerCase());
      if (it) return it.expr;
    }
  }
  return g;
}

function checkGrouped(e, gx, cols) {
  const sig = keyOf(e);
  if (gx.some((g) => keyOf(g) === sig)) return;
  if (e.t === 'fn' && !e.over && AGG.has(e.name)) return;
  if (e.t === 'col' || e.t === 'colidx') {
    let idx;
    if (e.t === 'colidx') idx = e.i;
    else {
      const m = colIndex(cols).get(e.table ? e.table.toLowerCase() + '.' + e.name.toLowerCase() : e.name.toLowerCase());
      if (!m) return; // outer (correlated) reference: constant for the group
      idx = m[0];
    }
    const ok = gx.some((g) => {
      if (g.t === 'colidx') return g.i === idx;
      if (g.t !== 'col') return false;
      const m = colIndex(cols).get(g.table ? g.table.toLowerCase() + '.' + g.name.toLowerCase() : g.name.toLowerCase());
      return m && m[0] === idx;
    });
    if (!ok) {
      const nm = e.t === 'col' ? (e.table ? e.table + '.' : '') + e.name : cols[idx].name;
      throw new SqlError(`Column "${nm}" must appear in the GROUP BY clause or be used inside an aggregate function (COUNT, SUM, AVG, MIN, MAX). Otherwise SQL can't know which of the grouped rows' value to show.`);
    }
    return;
  }
  children(e).forEach((c) => checkGrouped(c, gx, cols));
}

// ---------------------------------------------------------------- compact columns
function usedNames(exprs, cols) {
  const used = new Set();
  const note = (e) => {
    if (e.t === 'col') used.add(e.name.toLowerCase());
    else if (e.t === 'colidx') used.add(cols[e.i].name.toLowerCase());
    children(e).forEach(note);
  };
  exprs.forEach(note);
  return used;
}

// lane columns where only the columns the query really uses are visible (keeps wide rows readable)
function compactCols(cols, exprs) {
  const u = usedNames(exprs, cols);
  return laneCols(cols).map((c) => ({ ...c, hidden: c.hidden || !u.has(c.name.toLowerCase()) }));
}

// ---------------------------------------------------------------- window function animation
const WIN_EXPLAIN = {
  ROW_NUMBER: '**ROW_NUMBER** numbers the rows 1, 2, 3… in window order. It never ties.',
  RANK: '**RANK** gives tied rows the same number and then skips ahead (1, 1, 3…).',
  DENSE_RANK: '**DENSE_RANK** gives tied rows the same number but never skips (1, 1, 2…).',
  NTILE: '**NTILE(n)** deals the rows into n buckets of (nearly) equal size.',
  LAG: '**LAG** reads a value from an earlier row.',
  LEAD: '**LEAD** reads a value from a later row.',
  FIRST_VALUE: '**FIRST_VALUE** reads the first row of the window.',
  LAST_VALUE: '**LAST_VALUE** reads the last row of the window.',
  SUM: "**SUM** adds up the rows inside each row's window.",
  AVG: "**AVG** averages the rows inside each row's window.",
  COUNT: "**COUNT** counts the rows inside each row's window.",
  MIN: "**MIN** takes the smallest value inside each row's window.",
  MAX: "**MAX** takes the largest value inside each row's window.",
};

function frameWords(spec) {
  if (spec.frame) {
    const m = /(ROWS|RANGE)[\s\S]*/i.exec(spec.text || '');
    return m ? m[0].replace(/\)\s*$/, '').replace(/\s+/g, ' ').trim() : 'a custom frame';
  }
  return spec.orderBy.length ? 'from the first row down to this row (and its ties)' : 'the whole partition';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function windowFrames(T, rel, envs, wins, rec, winVals, exprs) {
  const rows = rel.rows;
  const baseCols = compactCols(rel.cols, exprs);
  const specs = new Map();
  wins.forEach((w) => {
    const k = keyOf([w.over.partitionBy, w.over.orderBy, w.over.frame]);
    const l = specs.get(k);
    if (l) { if (!l.includes(w)) l.push(w); } else specs.set(k, [w]);
  });
  const extraCols = []; // columns holding window values, accumulated over specs
  const extraVals = rows.map(() => []);
  let specNo = 0;

  for (const fns of specs.values()) {
    specNo++;
    const spec = fns[0].over;
    const byFirst = (a, b) => Math.min(...a.sorted) - Math.min(...b.sorted);
    const parts = rec.get(fns[0]).slice().sort(byFirst);
    // every function has its own per-row detail (neighbour / frame), same partition order for all
    const perOf = (f, part, p) => rec.get(f).slice().sort(byFirst)[parts.indexOf(part)].per[p];
    const tag = specs.size > 1 ? ` (window ${specNo} of ${specs.size})` : '';
    const fnCols = fns.map((f) => ({ name: f.label || f.name, base: null, tbl: null, hidden: false }));
    const done = fns.map(() => new Set());
    const pLabel = (part) => (spec.partitionBy.length ? spec.partitionBy.map((e) => fmt(ev(e, envs[part.sorted[0]]))).join(' · ') : 'all rows');
    const scopeCols = (withFn) => baseCols.concat(extraCols, withFn ? fnCols : []);
    const valsOf = (gi, withFn, isDone) => rows[gi].v.concat(extraVals[gi], withFn ? fns.map((f, k) => (isDone(k, gi) ? winVals.get(f)[gi] : PENDING)) : []);
    const windowOrder = (part) => (spec.orderBy.length ? part.sorted : part.sorted.slice().sort((a, b) => a - b));

    // one frame: lanes = partitions, rows arranged by o.order(part)
    const build = (o) => {
      const lanes = [];
      const chips = [];
      let shown = 0, total = 0;
      for (const part of parts) {
        const idxs = o.order(part);
        total += idxs.length;
        const lane = lanes.length;
        lanes.push({ label: pLabel(part), note: plural(idxs.length, 'row'), cols: scopeCols(o.withFn) });
        for (const gi of idxs) {
          if (shown >= MAX_CHIPS) break;
          shown++;
          const c = { key: rowKey(rows[gi]), lane, vals: valsOf(gi, o.withFn, o.isDone || (() => false)), h: rows[gi].h };
          const fl = o.flag && o.flag(part, gi);
          if (fl) c.flag = fl;
          if (o.hl) c.hl = o.hl;
          chips.push(c);
        }
      }
      T.frame({
        stage: 'WINDOW', title: o.title, short: o.short, code: spec.text || '', layout: spec.partitionBy.length ? 'wrap' : 'single',
        caption: o.caption, lanes, chips, hidden: Math.max(0, total - shown), in: rows.length, out: rows.length,
      });
    };

    // 1) PARTITION BY
    if (spec.partitionBy.length) {
      build({
        title: `PARTITION BY${tag}`, short: 'PARTITION', order: (part) => part.sorted.slice().sort((a, b) => a - b),
        caption: `Window functions look at related rows. **PARTITION BY** splits the ${rows.length} rows into ${plural(parts.length, 'independent partition')} — but, unlike GROUP BY, no rows are merged or removed.`,
      });
    }
    // 2) ORDER BY inside each partition
    if (spec.orderBy.length) {
      build({
        title: `ORDER BY in window${tag}`, short: 'WINDOW ORDER', order: (part) => part.sorted,
        caption: `Inside ${spec.partitionBy.length ? 'each partition' : 'the window'} the rows are put in the window's own ORDER BY order. This order belongs to the window function only — the query's own ORDER BY (if any) comes later.`,
      });
    }

    // 3) walk-throughs for functions that look at neighbouring rows
    const P0 = parts[0];
    fns.forEach((f, k) => {
      if (!(AGG.has(f.name) || ['LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE'].includes(f.name))) return;
      const len = P0.sorted.length;
      const picks = f.name === 'LAG' ? [0, 1] : f.name === 'LEAD' ? [len - 2, len - 1] : [0, 1, 2];
      const samples = [...new Set(picks.filter((p) => p >= 0 && p < len))];
      for (const p of samples) {
        const per = perOf(f, P0, p);
        const gi = P0.sorted[p];
        done[k].add(gi);
        const inWin = new Set();
        let cap;
        if (f.name === 'LAG' || f.name === 'LEAD') {
          const dir = f.name === 'LAG' ? 'back' : 'ahead';
          if (per.t !== null) inWin.add(P0.sorted[per.t]);
          cap = per.t !== null
            ? `Row ${p + 1} of ${len} (blue): **${f.label}** looks ${plural(per.off, 'row')} ${dir} to row ${per.t + 1} (green) and copies its value → **${fmt(winVals.get(f)[gi])}**.`
            : `Row ${p + 1} of ${len} (blue): there is no row ${per.off} ${dir}, so **${f.label}** returns **${fmt(winVals.get(f)[gi])}**${f.args[2] ? ' (the default you supplied)' : ' because there is nothing to read there'}.`;
        } else {
          for (let q = per.lo; q <= per.hi; q++) inWin.add(P0.sorted[q]);
          const n = Math.max(0, per.hi - per.lo + 1);
          cap = `Row ${p + 1} of ${len} (blue). Its window is ${frameWords(spec)}: ${plural(n, 'row')} (green, rows ${per.lo + 1}–${per.hi + 1}). **${f.label}** over just those rows → **${fmt(winVals.get(f)[gi])}**.`;
        }
        build({
          title: `${f.label} · row ${p + 1}`, short: `${f.name} · row ${p + 1}`, withFn: true, order: windowOrder,
          isDone: (kk, g) => done[kk].has(g),
          flag: (part, g) => (part !== P0 ? 'dim' : g === gi ? 'cur' : inWin.has(g) ? 'frame' : undefined),
          caption: cap,
        });
      }
    });

    // 4) compute everything
    const newIdx = fns.map((_, k) => baseCols.length + extraCols.length + k);
    const rankish = fns.some((f) => f.name === 'RANK' || f.name === 'DENSE_RANK');
    const tied = (part, g) => {
      const p = part.sorted.indexOf(g);
      const eq = (a, b) => part.okeys[a].every((x, kk) => (isNull(x) && isNull(part.okeys[b][kk])) || cmpSql(x, part.okeys[b][kk]) === 0);
      return (p > 0 && eq(p, p - 1)) || (p < part.sorted.length - 1 && eq(p, p + 1));
    };
    const names = [...new Set(fns.map((f) => f.name))];
    build({
      title: `Compute${tag}`, short: 'COMPUTE', withFn: true, order: windowOrder, isDone: () => true, hl: newIdx,
      flag: rankish ? (part, g) => (spec.orderBy.length && tied(part, g) ? 'frame' : undefined) : undefined,
      caption: `${fns.length === 1 ? 'The window column is' : 'The window columns are'} now filled in for every row. ${names.map((n) => WIN_EXPLAIN[n]).filter(Boolean).join(' ')}${rankish ? ' Green rows are tied on the ORDER BY value.' : ''}`,
    });
    fns.forEach((f, k) => { extraCols.push(fnCols[k]); rows.forEach((_, gi) => extraVals[gi].push(winVals.get(f)[gi])); });
  }
}

// ---------------------------------------------------------------- CTE / derived-table animation
// A CTE or derived table is a mini query. Its own pipeline plays first (frames tagged with a scope and a
// key prefix so they never clash with the main query), then its result is parked on a dashed "shelf"
// lane until the main query's rows grow out of it.
function tagFrames(T, f0, sh0, prefix, scope, name) {
  const frames = T.frames.slice(f0);
  const keys = new Set(frames.flatMap((f) => f.chips.map((c) => c.key)));
  const pk = (k) => (keys.has(k) ? prefix + k : k);
  for (const f of frames) {
    f.scope = scope;
    f.short = `${name} ▸ ${f.short || (f.title.length > 22 ? f.stage : f.title)}`;
    for (const c of f.chips) {
      if (c.from) c.from = c.from.map(pk);
      if (c.absorb) c.absorb = c.absorb.map(pk);
      c.key = prefix + c.key;
    }
  }
  for (const sh of T.shelves.slice(sh0)) sh.chips = sh.chips.map((c) => ({ ...c, key: prefix + c.key }));
}

function collectDerived(from, acc = []) {
  if (from.type === 'join') { collectDerived(from.left, acc); collectDerived(from.right, acc); } else if (from.type === 'subquery') acc.push(from);
  return acc;
}

// run() must return { cols, rows:[{ v, h, p | fk }] }. Returns the same shape with rows carrying `ck`
// (the key of their chip on the shelf) so later frames can grow out of them.
function runPrelude(T, name, kind, run) {
  const f0 = T.frames.length, s0 = T.steps.length, sh0 = T.shelves.length;
  const t0 = now();
  const res = run();
  const prefix = `${name}/`;
  const scope = kind === 'cte' ? `CTE ${name}` : `Subquery ${name}`;
  tagFrames(T, f0, sh0, prefix, scope, name);
  for (let i = s0; i < T.steps.length; i++) if (!T.steps[i].scope) T.steps[i].scope = scope;
  const rows = res.rows.map((r, i) => ({ ...r, ck: prefix + (r.fk ?? (r.p && r.p[0]) ?? `row${i}`) }));
  const cols = laneCols(res.cols);
  const chips = capped(rows).map((r) => ({ key: r.ck, lane: 0, vals: r.v, h: r.h || [] }));
  const what = kind === 'cte' ? 'CTE' : 'derived table';
  T.frame({
    stage: 'WITH', scope, short: `${name} ✔`, title: `${name} is ready`, code: kind === 'cte' ? `WITH ${name} AS (…)` : `(…) ${name}`,
    caption: `The ${what} **${name}** has finished: ${rows.length} row${rows.length === 1 ? '' : 's'}. It now exists as a temporary table (dashed box) that the main query can read like any other table.`,
    lanes: [{ label: `${name} · ${what} result`, cols, shelf: true }], chips, hidden: Math.max(0, rows.length - MAX_CHIPS), in: rows.length, out: rows.length,
  });
  T.shelves.push({ name: `${name} · ${what}`, cols, chips: chips.map((c) => ({ ...c })), readyIdx: T.frames.length - 1 });
  T.steps.push({ stage: kind === 'cte' ? 'WITH' : 'SUBQUERY', detail: `${name} → ${rows.length} row${rows.length === 1 ? '' : 's'}${res.iterations ? ' (recursive)' : ''}`, rowsIn: 0, rowsOut: rows.length, ms: Math.round((now() - t0) * 100) / 100 });
  return { ...res, rows };
}

// recursive CTE: one frame per round so you can watch the hierarchy grow
function recursiveFrames(T, name, cols, rounds) {
  const lc = laneCols(cols);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const acc = [];
  rounds.forEach((rows, k) => {
    const prev = k > 0 ? rounds[k - 1].length : 0;
    const mk = (r, lane, flag) => ({ key: r.fk, lane, vals: r.v, h: r.h || [], ...(flag ? { flag } : {}) });
    T.frame({
      stage: 'RECURSION', title: `Round ${k}`, short: `round ${k}`, code: k === 0 ? 'anchor query' : 'recursive query', layout: 'side',
      caption: k === 0
        ? `**Round 0 — the anchor.** The first query runs once and seeds the result with ${plural(rows.length, 'row')}.`
        : `**Round ${k}.** The recursive part is joined with the ${plural(prev, 'row')} found in round ${k - 1} and finds ${plural(rows.length, 'new row')} — the next level down.`,
      lanes: [{ label: `${name} so far`, note: plural(acc.length, 'row'), cols: lc }, { label: `round ${k}`, note: `${plural(rows.length, 'new row')}`, cols: lc }],
      chips: [...capped(acc).map((r) => mk(r, 0)), ...capped(rows).map((r) => mk(r, 1, 'new'))],
      hidden: Math.max(0, acc.length - MAX_CHIPS) + Math.max(0, rows.length - MAX_CHIPS), in: prev, out: rows.length,
    });
    acc.push(...rows);
  });
  T.frame({
    stage: 'RECURSION', title: 'No new rows — stop', short: 'stop', code: '', layout: 'side',
    caption: `**Round ${rounds.length}** finds no new rows, so the recursion stops. The CTE's result is everything collected: ${plural(acc.length, 'row')}.`,
    lanes: [{ label: `${name} so far`, note: plural(acc.length, 'row'), cols: lc }, { label: `round ${rounds.length}`, note: '0 new rows', cols: lc }],
    chips: capped(acc).map((r) => ({ key: r.fk, lane: 0, vals: r.v, h: r.h || [] })), hidden: Math.max(0, acc.length - MAX_CHIPS), in: 0, out: 0,
  });
}

function execSelect(core, q, ctx, outer, T) {
  const st = { ctx, outer, T, aliases: new Set(), derived: null };
  if (T && core.from) {
    // derived tables (subqueries in FROM) play their own pipeline first, then wait on the shelf
    for (const node of collectDerived(core.from)) {
      if (!st.derived) st.derived = new Map();
      st.derived.set(node, runPrelude(T, node.alias, 'subquery', () => execQuery(node.query, ctx, outer, T)));
    }
  }
  let t0 = now();
  const step = (stage, detail, rowsIn, rowsOut, extra = {}) => {
    if (!T) return;
    const n = now();
    T.step({ stage, detail, rowsIn, rowsOut, ms: Math.round((n - t0) * 100) / 100, ...extra });
    t0 = now();
  };

  // ---- FROM / JOIN
  let rel;
  if (core.from) rel = evalFrom(core.from, st, step);
  else {
    rel = { cols: [], rows: [{ v: [], p: ['const'], h: [] }] };
    step('FROM', 'No FROM clause: start from a single empty row.', 0, 1);
  }

  // ---- WHERE
  if (core.where) {
    const before = rel.rows;
    const kept = [];
    for (const r of before) if (truth(ev(core.where, mkEnv(rel.cols, r.v, ctx, outer))) === true) kept.push(r);
    rel = { cols: rel.cols, rows: kept };
    step('WHERE', core.whereText, before.length, kept.length, { dropped: before.length - kept.length });
    if (T) {
      T.frame({
        stage: 'WHERE', title: 'WHERE', code: core.whereText,
        caption: `Test every row against **${core.whereText}**. Rows where it is true stay; the others are thrown away — ${kept.length} kept, ${before.length - kept.length} dropped.`,
        lanes: [{ label: 'rows still in play', cols: laneCols(rel.cols) }],
        chips: relChips(kept), hidden: Math.max(0, kept.length - MAX_CHIPS), in: before.length, out: kept.length,
      });
    }
  }

  // ---- SELECT list, grouping
  const items = expandItems(core.items, rel.cols);
  const orderItems = q.orderBy || [];
  const wins = [...items.map((i) => i.expr), ...orderItems.map((o) => o.expr)].flatMap((e) => collectWindows(e));
  const grouped = !!(core.groupBy && core.groupBy.length) || !!core.having || items.some((i) => containsAgg(i.expr)) || orderItems.some((o) => containsAgg(o.expr));
  const outCols = items.map((i) => ({ name: i.name, base: i.base }));
  const outLane = [{ label: 'result', cols: laneCols(outCols) }];

  let out; // [{key, v, h, env, absorb}]
  const colsForLane = rel.cols;

  if (grouped) {
    const gx = (core.groupBy || []).map((g) => resolveGroupExpr(g, items, rel.cols));
    for (const g of gx) if (containsAgg(g)) throw new SqlError('Aggregate functions are not allowed in GROUP BY');
    items.forEach((i) => checkGrouped(i.expr, gx, rel.cols));
    if (core.having) checkGrouped(core.having, gx, rel.cols);
    orderItems.forEach((o) => { if (o.expr.t !== 'num') { try { checkGrouped(o.expr, gx, rel.cols); } catch (err) { /* alias refs are resolved later */ if (!(o.expr.t === 'col' && !o.expr.table)) throw err; } } });

    const groups = new Map();
    for (const r of rel.rows) {
      const env = mkEnv(rel.cols, r.v, ctx, outer);
      const kv = gx.map((g) => ev(g, env));
      const k = keyOf(kv);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { rows: [], kv }));
      g.rows.push(r);
    }
    if (!gx.length && !groups.size) groups.set('', { rows: [], kv: [] });
    const glist = [...groups.values()];
    const nullRow = nullsRow(rel.cols.length);
    glist.forEach((g, i) => {
      g.key = 'g:' + i;
      g.h = uniq(g.rows.flatMap((r) => r.h));
      g.env = { scope: { cols: rel.cols, v: g.rows.length ? g.rows[0].v : nullRow, parent: outer }, ctx, group: g.rows, gcols: rel.cols, win: null, wi: 0 };
    });
    step('GROUP BY', core.groupText || 'whole table is one group', rel.rows.length, glist.length, { groups: glist.length });

    if (T) {
      const lanes = [];
      const chips = [];
      // buckets only show the columns the query actually uses, so they stay compact
      const bucketCols = compactCols(rel.cols, [...items.map((x) => x.expr), ...gx, ...(core.having ? [core.having] : []), ...orderItems.map((o) => o.expr)]);
      for (const g of glist) {
        if (lanes.length >= 12) break; // keep the picture readable; the rest are summarised in the caption
        const lane = lanes.length;
        const label = gx.length ? g.kv.map(fmt).join(' · ') : 'all rows';
        const gc = [];
        for (const r of g.rows) { if (chips.length + gc.length >= MAX_CHIPS) break; gc.push({ key: rowKey(r), lane, vals: r.v, h: r.h }); }
        if (!gc.length && chips.length >= MAX_CHIPS) continue;
        lanes.push({ label, note: `${g.rows.length} row${g.rows.length === 1 ? '' : 's'}`, cols: bucketCols });
        chips.push(...gc);
      }
      T.frame({
        stage: 'GROUP BY', title: 'GROUP BY', code: core.groupText || '',
        caption: gx.length
          ? `Rows that share the same **${core.groupText}** are pooled into one bucket — ${glist.length} bucket${glist.length === 1 ? '' : 's'} from ${rel.rows.length} rows${glist.length > 12 ? ' (the first 12 are drawn)' : ''}.`
          : `An aggregate with no GROUP BY treats the whole table as a single bucket.`,
        layout: 'wrap', lanes, chips, hidden: Math.max(0, rel.rows.length - chips.length), in: rel.rows.length, out: glist.length,
      });
    }

    const project = (g) => items.map((i) => ev(i.expr, g.env));
    let kept = glist;
    let preProjected = null;
    if (!wins.length) {
      preProjected = new Map(glist.map((g) => [g, project(g)]));
      if (T) {
        T.frame({
          stage: 'AGGREGATE', title: 'Collapse buckets', code: items.map((i) => i.text).join(', '),
          caption: 'Each bucket collapses into ONE row. Aggregate functions (COUNT, SUM, AVG…) summarise the rows that were inside it.',
          lanes: outLane,
          chips: capped(glist).map((g) => ({ key: g.key, lane: 0, vals: preProjected.get(g), h: g.h, from: g.rows.map(rowKey).slice(0, MAX_CHIPS) })),
          hidden: Math.max(0, glist.length - MAX_CHIPS), in: glist.length, out: glist.length,
        });
      }
    }
    if (core.having) {
      kept = glist.filter((g) => truth(ev(core.having, g.env)) === true);
      step('HAVING', core.havingText, glist.length, kept.length, { dropped: glist.length - kept.length });
      if (T && preProjected) {
        T.frame({
          stage: 'HAVING', title: 'HAVING', code: core.havingText,
          caption: `HAVING filters whole buckets using their summarised values: **${core.havingText}** — ${kept.length} kept, ${glist.length - kept.length} dropped.`,
          lanes: outLane, chips: capped(kept).map((g) => ({ key: g.key, lane: 0, vals: preProjected.get(g), h: g.h })),
          hidden: Math.max(0, kept.length - MAX_CHIPS), in: glist.length, out: kept.length,
        });
      }
    }
    const envs = kept.map((g) => g.env);
    if (wins.length) {
      const map = computeWindows(wins, envs);
      envs.forEach((env, i) => { env.win = map; env.wi = i; });
    }
    out = kept.map((g) => ({ key: g.key, v: preProjected ? preProjected.get(g) : project(g), h: g.h, env: g.env, absorb: [], from: g.rows.map(rowKey).slice(0, MAX_CHIPS) }));
    step('SELECT', items.map((i) => i.text).join(', '), kept.length, out.length);
    if (T && wins.length) {
      T.frame({
        stage: 'SELECT', title: 'SELECT', code: items.map((i) => i.text).join(', '),
        caption: 'Buckets collapse into one row each and window functions are computed over the result.',
        lanes: outLane, chips: capped(out).map((o) => ({ key: o.key, lane: 0, vals: o.v, h: o.h, from: o.from })),
        hidden: Math.max(0, out.length - MAX_CHIPS), in: kept.length, out: out.length,
      });
    }
  } else {
    const envs = rel.rows.map((r) => mkEnv(rel.cols, r.v, ctx, outer));
    if (wins.length) {
      const rec = T && core.from ? new Map() : null;
      const map = computeWindows(wins, envs, rec);
      envs.forEach((env, i) => { env.win = map; env.wi = i; });
      if (rec) windowFrames(T, rel, envs, wins, rec, map, [...items.map((x) => x.expr), ...orderItems.map((o) => o.expr)]);
    }
    out = rel.rows.map((r, i) => ({ key: rowKey(r), v: items.map((it) => ev(it.expr, envs[i])), h: r.h, env: envs[i], absorb: [] }));
    step('SELECT', items.map((i) => i.text).join(', '), rel.rows.length, out.length);
    const pureStar = core.items.every((i) => i.star) && !wins.length;
    if (T && core.from && !pureStar) {
      T.frame({
        stage: 'SELECT', title: 'SELECT', code: items.map((i) => i.text).join(', '),
        caption: wins.length
          ? 'Rows return to their original order, each carrying its window value(s). Window functions never remove or merge rows — that is the difference from GROUP BY.'
          : 'SELECT picks (and computes) the output columns — columns you did not ask for are cut away.',
        lanes: outLane, chips: capped(out).map((o) => ({ key: o.key, lane: 0, vals: o.v, h: o.h })),
        hidden: Math.max(0, out.length - MAX_CHIPS), in: out.length, out: out.length,
      });
    }
  }
  void colsForLane;

  // ---- DISTINCT
  if (core.distinct) {
    const seen = new Map();
    const kept = [];
    for (const o of out) {
      const k = keyOf(o.v);
      const first = seen.get(k);
      if (first) first.absorb.push(o.key); else { seen.set(k, o); kept.push(o); }
    }
    step('DISTINCT', 'remove duplicate rows', out.length, kept.length, { dropped: out.length - kept.length });
    if (T) {
      T.frame({
        stage: 'DISTINCT', title: 'DISTINCT', code: 'DISTINCT',
        caption: `Identical rows are merged into one — ${out.length - kept.length} duplicate${out.length - kept.length === 1 ? '' : 's'} absorbed.`,
        lanes: outLane, chips: capped(kept).map((o) => ({ key: o.key, lane: 0, vals: o.v, h: o.h, absorb: o.absorb.slice(0, MAX_CHIPS) })),
        hidden: Math.max(0, kept.length - MAX_CHIPS), in: out.length, out: kept.length,
      });
    }
    out = kept;
  }

  // ---- ORDER BY
  if (orderItems.length) {
    const specs = orderItems.map((o) => ({ ...o, ref: resolveOrder(o, items) }));
    const keyRows = out.map((o) => specs.map((s) => (s.ref.k === 'out' ? o.v[s.ref.i] : ev(s.ref.e, o.env))));
    const idx = sortIdx(out.length, keyRows, specs);
    out = idx.map((i) => out[i]);
    step('ORDER BY', q.orderText, out.length, out.length);
    if (T) {
      T.frame({
        stage: 'ORDER BY', title: 'ORDER BY', code: q.orderText,
        caption: `Rows are re-sorted by **${q.orderText.replace(/^ORDER BY\s+/i, '')}** — watch them slide into position.`,
        lanes: outLane, chips: capped(out).map((o) => ({ key: o.key, lane: 0, vals: o.v, h: o.h })),
        hidden: Math.max(0, out.length - MAX_CHIPS), in: out.length, out: out.length,
      });
    }
  }

  // ---- LIMIT / OFFSET
  out = applyLimit(out, q, ctx, step, T, outLane);

  return { cols: outCols, rows: out.map((o) => ({ v: o.v, p: [o.key], h: o.h })) };
}

function resolveOrder(o, items) {
  const e = o.expr;
  if (e.t === 'num' && Number.isInteger(e.v)) {
    if (e.v < 1 || e.v > items.length) throw new SqlError(`ORDER BY ${e.v} is out of range — the SELECT list has ${items.length} columns`);
    return { k: 'out', i: e.v - 1 };
  }
  if (e.t === 'col' && !e.table) {
    const n = e.name.toLowerCase();
    let i = items.findIndex((x) => x.alias && x.alias.toLowerCase() === n);
    if (i < 0) i = items.findIndex((x) => x.name.toLowerCase() === n && x.expr.t !== 'colidx');
    if (i >= 0) return { k: 'out', i };
  }
  return { k: 'expr', e };
}

function applyLimit(out, q, ctx, step, T, lane) {
  if (q.limit == null && q.offset == null) return out;
  const cenv = mkEnv([], [], ctx, null);
  const lim = q.limit ? num(ev(q.limit, cenv)) : Infinity;
  const off = q.offset ? num(ev(q.offset, cenv)) : 0;
  if (Number.isNaN(lim) || lim < 0 || Number.isNaN(off) || off < 0) throw new SqlError('LIMIT and OFFSET must be non-negative numbers');
  const kept = out.slice(off, off + lim);
  step('LIMIT', q.limitText, out.length, kept.length, { dropped: out.length - kept.length });
  if (T) {
    T.frame({
      stage: 'LIMIT', title: 'LIMIT', code: q.limitText,
      caption: `${off ? `Skip the first ${off} row${off === 1 ? '' : 's'}, then ` : ''}keep ${Number.isFinite(lim) ? `at most ${lim}` : 'all'} — the rest are cut off.`,
      lanes: lane, chips: capped(kept).map((o) => ({ key: o.key, lane: 0, vals: o.v, h: o.h })),
      hidden: Math.max(0, kept.length - MAX_CHIPS), in: out.length, out: kept.length,
    });
  }
  return kept;
}

function evalFrom(node, st, step) {
  const T = st.T;
  if (node.type === 'join') {
    const L = evalFrom(node.left, st, step);
    const R = evalSimple(node.right, st);
    const label = fromLabel(node.right);
    const res = doJoin(L, R, node, st);
    const kind = node.kind;
    const word = kind === 'cross' ? 'CROSS JOIN' : kind === 'inner' ? 'INNER JOIN' : kind === 'left' ? 'LEFT JOIN' : kind === 'right' ? 'RIGHT JOIN' : 'FULL JOIN';
    step(word, `${label}${node.text ? ' ON ' + node.text.replace(/^USING /, 'USING ') : ''}`, L.rows.length, res.rows.length, { comparisons: res.comparisons, joinKind: kind });
    if (T) {
      const lcols = laneCols(L.cols), rcols = laneCols(R.cols);
      T.frame({
        stage: 'JOIN', title: `${word} ${label}`, code: `${word} ${label}${node.text ? ' ON ' + node.text : ''}`, layout: 'side',
        caption: `Bring **${label}** (${R.rows.length} rows) next to the ${L.rows.length} rows collected so far. Next, rows are matched${node.text ? ` where **${node.text}**` : ''}.`,
        lanes: [{ label: 'so far', cols: lcols }, { label, cols: rcols }],
        chips: [...relChips(L.rows, 0), ...relChips(R.rows, 1, R.kind === 'table')],
        hidden: Math.max(0, L.rows.length - MAX_CHIPS) + Math.max(0, R.rows.length - MAX_CHIPS), in: L.rows.length + R.rows.length, out: L.rows.length + R.rows.length,
      });
      const unmatchedL = res.rows.filter((r) => r.lk && !r.rk).length;
      const unmatchedR = res.rows.filter((r) => r.rk && !r.lk).length;
      const droppedL = kind === 'inner' ? L.rows.length - new Set(res.rows.filter((r) => r.lk && r.rk).map((r) => r.lk)).size : 0;
      const droppedR = kind === 'inner' || kind === 'left' ? R.rows.length - res.matched : 0;
      let stats = `${res.rows.length} row${res.rows.length === 1 ? '' : 's'} in the result.`;
      if (kind === 'inner') stats += ` ${droppedL} left and ${droppedR} right row${droppedR === 1 ? '' : 's'} found no partner and were dropped.`;
      if (kind === 'left') stats += ` ${unmatchedL} left row${unmatchedL === 1 ? '' : 's'} had no partner (kept with NULLs).`;
      if (kind === 'right') stats += ` ${unmatchedR} right row${unmatchedR === 1 ? '' : 's'} had no partner (kept with NULLs).`;
      if (kind === 'full') stats += ` ${unmatchedL} left-only and ${unmatchedR} right-only row${unmatchedR === 1 ? '' : 's'} kept with NULLs.`;
      T.frame({
        stage: 'JOIN', title: `${word} — match`, code: node.text ? `ON ${node.text}` : word, layout: 'single',
        caption: `${JOIN_WORDS[kind]} ${stats}`,
        lanes: [{ label: 'joined rows', cols: laneCols(res.cols) }],
        chips: capped(res.rows).map((r) => {
          const c = { key: rowKey(r), lane: 0, vals: r.v, h: r.h };
          if (r.lk && r.rk) c.from = [r.lk, r.rk];
          return c;
        }),
        hidden: Math.max(0, res.rows.length - MAX_CHIPS), in: L.rows.length + R.rows.length, out: res.rows.length,
      });
    }
    return { cols: res.cols, rows: res.rows, kind: 'joined' };
  }
  const rel = evalSimple(node, st);
  const label = fromLabel(node);
  step('FROM', label, rel.rows.length, rel.rows.length);
  if (T) {
    T.frame({
      stage: 'FROM', title: `FROM ${label}`, code: `FROM ${label}`,
      caption: rel.kind === 'table'
        ? `Start with every row of **${label}** (${rel.rows.length} rows). Each chip is a real row flying out of its table above.`
        : `Start with the ${rel.rows.length} rows produced by **${label}**.`,
      lanes: [{ label, cols: laneCols(rel.cols) }],
      chips: relChips(rel.rows, 0, rel.kind === 'table'),
      hidden: Math.max(0, rel.rows.length - MAX_CHIPS), in: rel.rows.length, out: rel.rows.length,
    });
  }
  return rel;
}

// ---------------------------------------------------------------- queries (CTEs, set operations)
function execBody(body, ctx, outer) {
  if (body.type === 'select') return execSelect(body, {}, ctx, outer, null);
  if (body.type === 'nested') return execQuery(body.query, ctx, outer, null);
  const L = execBody(body.left, ctx, outer);
  const R = execBody(body.right, ctx, outer);
  if (L.cols.length !== R.cols.length) {
    throw new SqlError(`${body.op} needs both queries to return the same number of columns (${L.cols.length} vs ${R.cols.length})`);
  }
  const k = (r) => keyOf(r.v);
  const lrows = L.rows.map((r, i) => ({ ...r, _src: [`L:${i}`] }));
  const rrows = R.rows.map((r, i) => ({ ...r, _src: [`R:${i}`] }));
  let rows;
  if (body.op === 'UNION') {
    if (body.all) rows = [...lrows, ...rrows];
    else {
      const m = new Map();
      for (const r of [...lrows, ...rrows]) { const e = m.get(k(r)); if (e) e._src.push(...r._src); else m.set(k(r), { ...r, _src: [...r._src] }); }
      rows = [...m.values()];
    }
  } else if (body.op === 'INTERSECT') {
    const rset = new Map();
    rrows.forEach((r) => { const e = rset.get(k(r)); if (e) e.push(...r._src); else rset.set(k(r), [...r._src]); });
    const m = new Map();
    for (const r of lrows) {
      if (!rset.has(k(r))) continue;
      const e = m.get(k(r));
      if (e) e._src.push(...r._src); else m.set(k(r), { ...r, _src: [...r._src, ...rset.get(k(r))] });
    }
    rows = [...m.values()];
  } else {
    const rset = new Set(rrows.map(k));
    const m = new Map();
    for (const r of lrows) {
      if (rset.has(k(r))) continue;
      const e = m.get(k(r));
      if (e) e._src.push(...r._src); else m.set(k(r), { ...r, _src: [...r._src] });
    }
    rows = [...m.values()];
  }
  return { cols: L.cols, rows, setInfo: { op: body.op, all: body.all, L, R } };
}

function resolveCte(c, ctx, recursive, T) {
  const name = c.name.toLowerCase();
  const rename = (cols) => cols.map((col, i) => ({ name: c.cols ? c.cols[i] || col.name : col.name, base: col.base || null }));
  const body = c.query.body;
  if (recursive && body.type === 'set' && body.op === 'UNION') {
    const anchor = execBody(body.left, ctx, null);
    const cols = rename(anchor.cols);
    const seen = new Set();
    const fresh = (rows) => rows.filter((r) => body.all || (!seen.has(keyOf(r.v)) && seen.add(keyOf(r.v))));
    let work = fresh(anchor.rows);
    const rounds = [];
    const stamp = (rows, k) => rows.map((r, i) => ({ v: r.v, h: r.h, fk: `R${k}:${i}` }));
    let total = work.length;
    rounds.push(stamp(work, 0));
    for (let iter = 0; work.length; iter++) {
      if (iter > 1000 || total > 5000) throw new SqlError('Recursive CTE did not stop (more than 1000 iterations / 5000 rows). Make sure the recursive part eventually returns no rows.');
      ctx.ctes.set(name, { cols, rows: work.map((r) => ({ v: r.v, h: r.h })) });
      const res = execBody(body.right, ctx, null);
      work = fresh(res.rows);
      total += work.length;
      if (work.length) rounds.push(stamp(work, iter + 1));
    }
    if (T) recursiveFrames(T, c.name, cols, rounds);
    return { cols, rows: rounds.flat(), iterations: true };
  }
  const res = execQuery(c.query, ctx, null, T);
  if (c.cols && c.cols.length !== res.cols.length) throw new SqlError(`CTE "${c.name}" lists ${c.cols.length} column names but its query returns ${res.cols.length}`);
  return { cols: rename(res.cols), rows: res.rows.map((r) => ({ v: r.v, h: r.h, p: r.p })) };
}

export function execQuery(q, ctx0, outer, T) {
  const ctx = { db: ctx0.db, ctes: new Map(ctx0.ctes) };
  ctx.sub = (query, scope) => execQuery(query, ctx, scope, null);
  for (const c of q.with) {
    const r = T ? runPrelude(T, c.name, 'cte', () => resolveCte(c, ctx, q.recursive, T)) : resolveCte(c, ctx, q.recursive, null);
    ctx.ctes.set(c.name.toLowerCase(), r);
  }
  if (q.body.type === 'select') return execSelect(q.body, q, ctx, outer, T);

  // compound query (UNION / INTERSECT / EXCEPT)
  const t0 = now();
  let res = execBody(q.body, ctx, outer);
  const setInfo = res.setInfo;
  let rows = res.rows;
  const cols = res.cols;
  if (q.orderBy) {
    const specs = q.orderBy.map((o) => {
      const e = o.expr;
      let i = -1;
      if (e.t === 'num' && Number.isInteger(e.v)) i = e.v - 1;
      else if (e.t === 'col' && !e.table) i = cols.findIndex((c) => c.name.toLowerCase() === e.name.toLowerCase());
      if (i < 0 || i >= cols.length) throw new SqlError('ORDER BY on a UNION / INTERSECT / EXCEPT must use a column name or position from the result');
      return { ...o, i };
    });
    const keyRows = rows.map((r) => specs.map((s) => r.v[s.i]));
    rows = sortIdx(rows.length, keyRows, specs).map((i) => rows[i]);
  }
  if (q.limit != null || q.offset != null) {
    const cenv = mkEnv([], [], ctx, null);
    const lim = q.limit ? num(ev(q.limit, cenv)) : Infinity;
    const off = q.offset ? num(ev(q.offset, cenv)) : 0;
    rows = rows.slice(off, off + lim);
  }
  if (T && setInfo) {
    T.step({ stage: setInfo.op + (setInfo.all ? ' ALL' : ''), detail: `${setInfo.L.rows.length} + ${setInfo.R.rows.length} rows combined`, rowsIn: setInfo.L.rows.length + setInfo.R.rows.length, rowsOut: rows.length, ms: Math.round((now() - t0) * 100) / 100 });
    const lcols = laneCols(setInfo.L.cols), rcols = laneCols(setInfo.R.cols);
    const mk = (rs, p, lane) => capped(rs).map((r, i) => ({ key: `${p}:${i}`, lane, vals: r.v, h: r.h || [] }));
    const word = { UNION: setInfo.all ? 'UNION ALL' : 'UNION', INTERSECT: 'INTERSECT', EXCEPT: 'EXCEPT' }[setInfo.op];
    const explain = {
      'UNION ALL': 'stacks both result sets on top of each other and keeps every row, duplicates included.',
      UNION: 'stacks both result sets and merges identical rows into one.',
      INTERSECT: 'keeps only the rows that appear in BOTH result sets.',
      EXCEPT: 'keeps rows from the first result set that do NOT appear in the second.',
    }[word];
    T.frame({
      stage: 'SETS', title: 'Two result sets', code: word, layout: 'side',
      caption: `Both queries run independently and produce their own rows. ${word} then combines them.`,
      lanes: [{ label: 'first query', cols: lcols }, { label: 'second query', cols: rcols }],
      chips: [...mk(setInfo.L.rows, 'L', 0), ...mk(setInfo.R.rows, 'R', 1)],
      in: setInfo.L.rows.length + setInfo.R.rows.length, out: setInfo.L.rows.length + setInfo.R.rows.length,
    });
    T.frame({
      stage: word, title: word, code: word, caption: `${word} ${explain} ${rows.length} row${rows.length === 1 ? '' : 's'} result.`,
      lanes: [{ label: 'combined result', cols: lcols }],
      chips: capped(rows).map((r, i) => ({ key: `U:${i}`, lane: 0, vals: r.v, h: r.h || [], from: r._src.slice(0, MAX_CHIPS) })),
      in: setInfo.L.rows.length + setInfo.R.rows.length, out: rows.length,
    });
  }
  return { cols, rows: rows.map((r, i) => ({ v: r.v, p: [`U:${i}`], h: r.h || [] })) };
}

export function makeCtx(db) {
  const ctx = { db, ctes: new Map() };
  ctx.sub = (query, scope) => execQuery(query, ctx, scope, null);
  return ctx;
}

// evaluate an expression that has no row context (INSERT VALUES, LIMIT ...)
export function evalConst(expr, ctx) {
  return ev(expr, mkEnv([], [], ctx, null));
}

// evaluate an expression against one table row (UPDATE / DELETE)
export function evalRow(expr, cols, v, ctx) {
  return ev(expr, mkEnv(cols, v, ctx, null));
}

export function relCols(table) {
  return table.cols.map((c) => ({ tbl: table.name, name: c.name, base: table.name }));
}
