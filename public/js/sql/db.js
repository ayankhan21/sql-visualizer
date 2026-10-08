// In-memory database. Everything lives in JS memory only — a reload (or Reset) restores the seed.
import { SqlError } from './tokenizer.js';
import { parseSql } from './parser.js';
import { SEED, MAX_ROWS, MAX_TABLES } from './seed.js';
import { execQuery, makeCtx, evalConst, evalRow, relCols, num, truth } from './exec.js';
import { Tracer, MAX_CHIPS, capped, laneCols, applyShelves } from './trace.js';
import { fmtNum } from './format.js';

const INT_T = new Set(['INT', 'INTEGER', 'BIGINT', 'SMALLINT']);
const REAL_T = new Set(['REAL', 'FLOAT', 'DOUBLE', 'NUMERIC', 'DECIMAL']);
const isNull = (v) => v === null || v === undefined;

function coerce(col, v) {
  if (isNull(v)) return null;
  const t = col.type;
  if (INT_T.has(t)) {
    const n = num(v);
    if (Number.isNaN(n)) throw new SqlError(`"${v}" is not a valid number for column "${col.name}" (${t})`);
    return Math.trunc(n);
  }
  if (REAL_T.has(t)) {
    const n = num(v);
    if (Number.isNaN(n)) throw new SqlError(`"${v}" is not a valid number for column "${col.name}" (${t})`);
    return n;
  }
  if (t === 'BOOLEAN' || t === 'BOOL') return truth(v) === true;
  return typeof v === 'number' ? fmtNum(v) : String(v);
}

const typeLabel = (t) => (INT_T.has(t) ? 'INT' : REAL_T.has(t) ? 'REAL' : t === 'BOOL' ? 'BOOLEAN' : ['TEXT', 'DATE', 'BOOLEAN'].includes(t) ? t : 'TEXT');

export class Database {
  constructor() {
    this.limits = { maxRows: MAX_ROWS, maxTables: MAX_TABLES };
    this.reset();
  }

  reset() {
    this.tables = new Map();
    SEED.forEach((t, i) => {
      this.tables.set(t.name.toLowerCase(), {
        name: t.name,
        cols: t.cols.map((c) => ({ ...c })),
        rows: t.rows.map((r, j) => ({ rid: j + 1, v: r.slice() })),
        nextRid: t.rows.length + 1,
        custom: false,
        color: i,
      });
    });
  }

  list() { return [...this.tables.values()]; }
  getTable(name) { return this.tables.get(String(name).toLowerCase()); }
  customTable() { return this.list().find((t) => t.custom) || null; }
  canCreate() { return !this.customTable(); }

  relations() {
    const out = [];
    for (const t of this.list()) for (const c of t.cols) if (c.fk) out.push({ from: t.name, col: c.name, to: c.fk });
    return out;
  }

  need(name) {
    const t = this.getTable(name);
    if (!t) throw new SqlError(`Table "${name}" does not exist. Available tables: ${this.list().map((x) => x.name).join(', ')}`);
    return t;
  }

  // Create the single extra user table (used by the table-builder UI and CREATE TABLE).
  createTable({ name, cols, rows = [] }) {
    if (this.getTable(name)) throw new SqlError(`A table called "${name}" already exists`);
    if (this.customTable()) throw new SqlError(`You can create only ${this.limits.maxTables - SEED.length} extra table (${this.limits.maxTables} in total). Drop "${this.customTable().name}" first.`);
    if (!cols.length) throw new SqlError('A table needs at least one column');
    const seen = new Set();
    for (const c of cols) {
      const k = c.name.toLowerCase();
      if (seen.has(k)) throw new SqlError(`Duplicate column name "${c.name}"`);
      seen.add(k);
    }
    if (rows.length > this.limits.maxRows) throw new SqlError(`A table can hold at most ${this.limits.maxRows} rows`);
    const t = {
      name,
      cols: cols.map((c) => ({ name: c.name, type: typeLabel(String(c.type || 'TEXT').toUpperCase()), fk: null, default: c.default ?? null })),
      rows: [],
      nextRid: 1,
      custom: true,
      color: SEED.length,
    };
    rows.forEach((r) => t.rows.push({ rid: t.nextRid++, v: t.cols.map((c, i) => coerce(c, r[i] ?? null)) }));
    this.tables.set(name.toLowerCase(), t);
    return t;
  }

  // ---------------------------------------------------------------- run SQL
  exec(sql) {
    const stmts = parseSql(sql);
    if (!stmts.length) throw new SqlError('Type a query first');
    const snap = structuredClone(this.tables);
    const results = [];
    try {
      for (const st of stmts) results.push(this.run(st));
    } catch (e) {
      this.tables = snap; // statements run as one unit: a failure undoes the earlier ones
      throw e;
    }
    return results;
  }

  run(st) {
    switch (st.type) {
      case 'select': return this.runSelect(st, false);
      case 'explain': return this.runSelect(st, true);
      case 'insert': return this.runInsert(st);
      case 'update': return this.runUpdate(st);
      case 'delete': return this.runDelete(st);
      case 'create': return this.runCreate(st);
      case 'drop': return this.runDrop(st);
      case 'alter': return this.runAlter(st);
      default: throw new SqlError('Unsupported statement');
    }
  }

  runSelect(st, explain) {
    const T = new Tracer();
    const ctx = makeCtx(this);
    const res = execQuery(st.query, ctx, null, T);
    const n = res.rows.length;
    T.frame({
      stage: 'RESULT', title: 'RESULT', final: true, code: '',
      caption: n ? `Done — **${n} row${n === 1 ? '' : 's'}** × ${res.cols.length} column${res.cols.length === 1 ? '' : 's'}. These chips are the result table.` : 'Done — the query matched **no rows**.',
      lanes: [{ label: 'result', cols: laneCols(res.cols) }],
      chips: capped(res.rows).map((r) => ({ key: r.p[0], lane: 0, vals: r.v, h: r.h })),
      hidden: Math.max(0, n - MAX_CHIPS), in: n, out: n,
    });
    applyShelves(T);
    const body = st.query.body;
    const clauses = body.type === 'select' ? body.clauses.map((c) => ({ k: c.k, s: c.s - st.start, e: c.e - st.start })) : [];
    const joins = body.type === 'select' ? body.joins.map((j) => ({ s: j.s - st.start, e: j.e - st.start })) : [];
    const base = { sql: st.sql, trace: { frames: T.frames, steps: T.steps }, clauses, joins, distinct: body.type === 'select' && body.distinct };
    if (explain) {
      const rows = T.steps.map((s, i) => ({ v: [i + 1, s.stage, s.detail, s.rowsIn, s.rowsOut, s.ms], p: [`step:${i}`], h: [] }));
      return {
        ...base, kind: 'select', explain: true,
        columns: ['step', 'operation', 'detail', 'rows_in', 'rows_out', 'ms'].map((name) => ({ name, base: null })), rows,
      };
    }
    return { ...base, kind: 'select', columns: res.cols, rows: res.rows };
  }

  // ---------------------------------------------------------------- DML helpers
  tableChips(t, rows, extra = () => ({})) {
    return capped(rows).map((r) => ({ key: `${t.name}:${r.rid}`, lane: 0, vals: r.v, h: [`${t.name}#${r.rid}`], ...extra(r) }));
  }

  dmlResult(st, message, affected, changes, frames) {
    return { kind: 'dml', sql: st.sql, message, affected, changes, columns: [], rows: [], trace: { frames, steps: [] } };
  }

  checkPk(t, vals, ignoreRid = null) {
    const pk = t.cols.findIndex((c) => c.name.toLowerCase() === 'id');
    if (pk < 0) return;
    const id = vals[pk];
    if (isNull(id)) return;
    if (t.rows.some((r) => r.rid !== ignoreRid && r.v[pk] === id)) {
      throw new SqlError(`Duplicate id ${id} in "${t.name}" — every row's id must be unique (that's what lets other tables point to it).`);
    }
  }

  runInsert(st) {
    const t = this.need(st.table);
    const ctx = makeCtx(this);
    const idxs = st.cols
      ? st.cols.map((n) => {
        const i = t.cols.findIndex((c) => c.name.toLowerCase() === n.toLowerCase());
        if (i < 0) throw new SqlError(`Table "${t.name}" has no column "${n}". Columns: ${t.cols.map((c) => c.name).join(', ')}`);
        return i;
      })
      : t.cols.map((_, i) => i);
    let valueRows;
    if (st.rows) {
      valueRows = st.rows.map((r) => {
        if (r.length !== idxs.length) throw new SqlError(`INSERT lists ${idxs.length} column${idxs.length === 1 ? '' : 's'} but a row has ${r.length} value${r.length === 1 ? '' : 's'}`);
        return r.map((e) => evalConst(e, ctx));
      });
    } else {
      const res = execQuery(st.query, ctx, null, null);
      if (res.cols.length !== idxs.length) throw new SqlError(`INSERT lists ${idxs.length} columns but the SELECT returns ${res.cols.length}`);
      valueRows = res.rows.map((r) => r.v);
    }
    if (t.rows.length + valueRows.length > this.limits.maxRows) {
      throw new SqlError(`"${t.name}" can hold at most ${this.limits.maxRows} rows (keeps the animations smooth). It has ${t.rows.length} now; this INSERT adds ${valueRows.length}.`);
    }
    const before = t.rows.slice(-10);
    const added = [];
    const pk = t.cols.findIndex((c) => c.name.toLowerCase() === 'id');
    for (const vr of valueRows) {
      const row = t.cols.map((c) => (isNull(c.default) ? null : c.default));
      idxs.forEach((ci, k) => { row[ci] = coerce(t.cols[ci], vr[k]); });
      if (pk >= 0 && isNull(row[pk]) && INT_T.has(t.cols[pk].type)) row[pk] = t.rows.reduce((m, r) => Math.max(m, r.v[pk] || 0), 0) + 1;
      this.checkPk(t, row);
      const r = { rid: t.nextRid++, v: row };
      t.rows.push(r);
      added.push(r);
    }
    const frames = [
      {
        id: 0, stage: 'INSERT', title: `INSERT INTO ${t.name}`, code: '', layout: 'single', hidden: 0,
        caption: `Table **${t.name}** before the insert${t.rows.length - added.length > before.length ? ' (showing its last rows)' : ''}.`,
        lanes: [{ label: t.name, cols: laneCols(relCols(t)) }], chips: this.tableChips(t, before, () => ({ src: undefined })).map((c, i) => ({ ...c, src: c.h[0] })),
      },
      {
        id: 1, stage: 'INSERT', title: 'New rows appended', code: '', layout: 'single', hidden: 0,
        caption: `${added.length} new row${added.length === 1 ? '' : 's'} added to the **end** of ${t.name}.`,
        lanes: [{ label: t.name, cols: laneCols(relCols(t)) }],
        chips: [...this.tableChips(t, before), ...this.tableChips(t, added, () => ({ flag: 'new' }))],
      },
    ];
    return this.dmlResult(st, `${added.length} row${added.length === 1 ? '' : 's'} inserted into ${t.name}`, added.length, { inserted: added.map((r) => `${t.name}#${r.rid}`), updated: [], deleted: [], schema: [] }, frames);
  }

  matchRows(t, where) {
    const cols = relCols(t);
    const ctx = makeCtx(this);
    return t.rows.filter((r) => !where || truth(evalRow(where, cols, r.v, ctx)) === true);
  }

  runUpdate(st) {
    const t = this.need(st.table);
    const cols = relCols(t);
    const ctx = makeCtx(this);
    const sets = st.sets.map((s) => {
      const i = t.cols.findIndex((c) => c.name.toLowerCase() === s.col.toLowerCase());
      if (i < 0) throw new SqlError(`Table "${t.name}" has no column "${s.col}". Columns: ${t.cols.map((c) => c.name).join(', ')}`);
      return { i, expr: s.expr };
    });
    const matched = this.matchRows(t, st.where);
    const oldVals = new Map(matched.map((r) => [r.rid, r.v]));
    for (const r of matched) {
      const nv = r.v.slice();
      for (const s of sets) nv[s.i] = coerce(t.cols[s.i], evalRow(s.expr, cols, r.v, ctx));
      this.checkPk(t, nv, r.rid);
      r.v = nv;
    }
    const hit = new Set(matched.map((r) => r.rid));
    const hl = sets.map((s) => s.i);
    const lane = [{ label: t.name, cols: laneCols(relCols(t)) }];
    const frames = [
      {
        id: 0, stage: 'UPDATE', title: `UPDATE ${t.name}`, code: st.whereText || '', layout: 'single', hidden: 0, lanes: lane,
        caption: `Table **${t.name}** — ${t.rows.length} rows. UPDATE will visit each row and test ${st.whereText ? `**${st.whereText}**` : 'nothing (no WHERE → every row)'}.`,
        chips: this.tableChips(t, t.rows, (r) => ({ src: `${t.name}#${r.rid}`, vals: oldVals.get(r.rid) || r.v })),
      },
      {
        id: 1, stage: 'WHERE', title: 'WHERE', code: st.whereText || '', layout: 'single', hidden: 0, lanes: lane,
        caption: `${matched.length} row${matched.length === 1 ? '' : 's'} match${matched.length === 1 ? 'es' : ''} (highlighted); the others are left untouched.`,
        chips: this.tableChips(t, t.rows, (r) => ({ vals: oldVals.get(r.rid) || r.v, flag: hit.has(r.rid) ? 'hit' : 'dim' })),
      },
      {
        id: 2, stage: 'SET', title: 'SET', code: '', layout: 'single', hidden: 0, lanes: lane,
        caption: `The new values are written into the matching rows only.`,
        chips: this.tableChips(t, t.rows, (r) => (hit.has(r.rid) ? { flag: 'changed', hl } : { flag: 'dim' })),
      },
    ];
    return this.dmlResult(st, `${matched.length} row${matched.length === 1 ? '' : 's'} updated in ${t.name}`, matched.length,
      { inserted: [], updated: matched.map((r) => `${t.name}#${r.rid}`), deleted: [], schema: [] }, frames);
  }

  runDelete(st) {
    const t = this.need(st.table);
    const matched = this.matchRows(t, st.where);
    const hit = new Set(matched.map((r) => r.rid));
    const lane = [{ label: t.name, cols: laneCols(relCols(t)) }];
    const all = t.rows.slice();
    t.rows = t.rows.filter((r) => !hit.has(r.rid));
    const frames = [
      {
        id: 0, stage: 'DELETE', title: `DELETE FROM ${t.name}`, code: st.whereText || '', layout: 'single', hidden: 0, lanes: lane,
        caption: `Table **${t.name}** — ${all.length} rows. DELETE visits each row and tests ${st.whereText ? `**${st.whereText}**` : 'nothing (no WHERE → EVERY row goes)'}.`,
        chips: this.tableChips(t, all, (r) => ({ src: `${t.name}#${r.rid}` })),
      },
      {
        id: 1, stage: 'WHERE', title: 'WHERE', code: st.whereText || '', layout: 'single', hidden: 0, lanes: lane,
        caption: `${matched.length} row${matched.length === 1 ? '' : 's'} match — marked for deletion.`,
        chips: this.tableChips(t, all, (r) => ({ flag: hit.has(r.rid) ? 'hit' : 'dim' })),
      },
      {
        id: 2, stage: 'DELETE', title: 'Rows removed', code: '', layout: 'single', hidden: 0, lanes: lane,
        caption: `Marked rows are removed for good. ${t.rows.length} row${t.rows.length === 1 ? '' : 's'} remain.`,
        chips: this.tableChips(t, t.rows),
      },
    ];
    return this.dmlResult(st, `${matched.length} row${matched.length === 1 ? '' : 's'} deleted from ${t.name}`, matched.length,
      { inserted: [], updated: [], deleted: matched.map((r) => `${t.name}#${r.rid}`), schema: [] }, frames);
  }

  runCreate(st) {
    const ctx = makeCtx(this);
    if (this.getTable(st.name)) {
      if (st.ifNot) return this.dmlResult(st, `Table ${st.name} already exists — nothing to do`, 0, { inserted: [], updated: [], deleted: [], schema: [] }, []);
      throw new SqlError(`A table called "${st.name}" already exists`);
    }
    const cols = st.cols.map((c) => ({ name: c.name, type: c.type, default: c.default ? evalConst(c.default, ctx) : null }));
    const t = this.createTable({ name: st.name, cols });
    const frames = [{
      id: 0, stage: 'CREATE', title: `CREATE TABLE ${t.name}`, code: '', layout: 'single', hidden: 0,
      caption: `A brand-new empty table **${t.name}** with ${t.cols.length} column${t.cols.length === 1 ? '' : 's'}. This is your one extra table — add rows with INSERT.`,
      lanes: [{ label: t.name, cols: laneCols(relCols(t)) }], chips: [],
    }];
    return this.dmlResult(st, `Table ${t.name} created`, 0, { inserted: [], updated: [], deleted: [], schema: [t.name] }, frames);
  }

  runDrop(st) {
    const t = this.getTable(st.name);
    if (!t) {
      if (st.ifExists) return this.dmlResult(st, `Table ${st.name} does not exist — nothing to do`, 0, { inserted: [], updated: [], deleted: [], schema: [] }, []);
      throw new SqlError(`Table "${st.name}" does not exist`);
    }
    if (!t.custom) throw new SqlError(`"${t.name}" is one of the built-in tables and can't be dropped (the lessons rely on it). You can DELETE its rows or ALTER it — Reset brings everything back.`);
    this.tables.delete(t.name.toLowerCase());
    return this.dmlResult(st, `Table ${t.name} dropped`, 0, { inserted: [], updated: [], deleted: [], schema: [t.name] }, []);
  }

  runAlter(st) {
    const t = this.need(st.table);
    const lane = (cols) => [{ label: t.name, cols: laneCols(cols) }];
    const sample = t.rows.slice(0, 12);
    const beforeCols = relCols(t);
    const beforeVals = new Map(sample.map((r) => [r.rid, r.v]));
    let message;
    let hl = [];
    if (st.action === 'add') {
      if (t.cols.some((c) => c.name.toLowerCase() === st.col.name.toLowerCase())) throw new SqlError(`Column "${st.col.name}" already exists in ${t.name}`);
      const def = st.col.default ? evalConst(st.col.default, makeCtx(this)) : null;
      const col = { name: st.col.name, type: typeLabel(st.col.type), fk: null, default: def };
      t.cols.push(col);
      const v = isNull(def) ? null : coerce(col, def);
      t.rows.forEach((r) => { r.v = [...r.v, v]; });
      hl = [t.cols.length - 1];
      message = `Column ${col.name} added to ${t.name} (existing rows get ${isNull(v) ? 'NULL' : v})`;
    } else if (st.action === 'drop') {
      const i = t.cols.findIndex((c) => c.name.toLowerCase() === st.name.toLowerCase());
      if (i < 0) throw new SqlError(`Table "${t.name}" has no column "${st.name}"`);
      if (t.cols.length === 1) throw new SqlError('A table must keep at least one column');
      if (this.list().some((o) => o.cols.some((c) => c.fk && c.fk.toLowerCase() === `${t.name}.${t.cols[i].name}`.toLowerCase()))) {
        throw new SqlError(`"${t.name}.${t.cols[i].name}" is referenced by a foreign key in another table, so it can't be dropped.`);
      }
      t.cols.splice(i, 1);
      t.rows.forEach((r) => { r.v = r.v.filter((_, k) => k !== i); });
      message = `Column ${st.name} dropped from ${t.name}`;
    } else if (st.action === 'rename-col') {
      const i = t.cols.findIndex((c) => c.name.toLowerCase() === st.from.toLowerCase());
      if (i < 0) throw new SqlError(`Table "${t.name}" has no column "${st.from}"`);
      if (t.cols.some((c, k) => k !== i && c.name.toLowerCase() === st.to.toLowerCase())) throw new SqlError(`Column "${st.to}" already exists`);
      const old = `${t.name}.${t.cols[i].name}`.toLowerCase();
      for (const o of this.list()) for (const c of o.cols) if (c.fk && c.fk.toLowerCase() === old) c.fk = `${t.name}.${st.to}`;
      t.cols[i].name = st.to;
      hl = [i];
      message = `Column ${st.from} renamed to ${st.to}`;
    } else if (st.action === 'rename-table') {
      if (!t.custom) throw new SqlError(`"${t.name}" is a built-in table and can't be renamed. Only your own extra table can be renamed.`);
      if (this.getTable(st.to)) throw new SqlError(`A table called "${st.to}" already exists`);
      this.tables.delete(t.name.toLowerCase());
      t.name = st.to;
      this.tables.set(st.to.toLowerCase(), t);
      message = `Table renamed to ${st.to}`;
    }
    const after = t.rows.slice(0, 12);
    const frames = st.action === 'rename-table' ? [] : [
      {
        id: 0, stage: 'ALTER', title: `ALTER TABLE ${t.name}`, code: '', layout: 'single', hidden: 0, lanes: lane(beforeCols),
        caption: `Table **${t.name}** before the change (first ${sample.length} rows).`,
        chips: sample.map((r) => ({ key: `${t.name}:${r.rid}`, lane: 0, vals: beforeVals.get(r.rid), h: [`${t.name}#${r.rid}`], src: `${t.name}#${r.rid}` })),
      },
      {
        id: 1, stage: 'ALTER', title: 'Structure changed', code: '', layout: 'single', hidden: 0, lanes: lane(relCols(t)),
        caption: `${message}. ALTER changes the table's **structure**, not just its rows.`,
        chips: after.map((r) => ({ key: `${t.name}:${r.rid}`, lane: 0, vals: r.v, h: [`${t.name}#${r.rid}`], hl, flag: hl.length ? 'changed' : undefined })),
      },
    ];
    return this.dmlResult(st, message, 0, { inserted: [], updated: [], deleted: [], schema: [t.name] }, frames);
  }
}

export function referencedTables(sql) {
  // table names mentioned by a statement (used by lessons to decide which tables to display)
  const found = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === 'table' && n.name) found.add(n.name.toLowerCase());
    if ((n.type === 'insert' || n.type === 'update' || n.type === 'delete' || n.type === 'alter') && n.table) found.add(n.table.toLowerCase());
    Object.values(n).forEach(walk);
  };
  walk(parseSql(sql));
  return found;
}
