// Recursive-descent SQL parser → plain AST objects.
import { tokenize, SqlError } from './tokenizer.js';

const RESERVED = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'ON', 'USING', 'AS', 'SET', 'VALUES', 'WHEN',
  'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'WITH', 'OVER', 'ASC', 'DESC', 'NULLS', 'BY', 'INTO', 'DISTINCT',
  'ALL', 'CASE', 'IN', 'IS', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS', 'NULL', 'TRUE', 'FALSE', 'PARTITION', 'ROWS',
  'RANGE', 'NATURAL',
]);

class Parser {
  constructor(sql) {
    this.sql = sql;
    this.t = tokenize(sql);
    this.i = 0;
  }

  get cur() { return this.t[this.i]; }
  peek(n = 1) { return this.t[Math.min(this.i + n, this.t.length - 1)]; }
  isKw(...w) { const t = this.cur; return t.t === 'id' && !t.q && w.includes(t.u); }
  isKwAt(n, ...w) { const t = this.peek(n); return t.t === 'id' && !t.q && w.includes(t.u); }
  acceptKw(...w) { if (this.isKw(...w)) return this.t[this.i++]; return null; }
  expectKw(w) { if (!this.acceptKw(w)) this.fail(`Expected ${w}`); }
  isP(c) { const t = this.cur; return (t.t === 'p' || t.t === 'op') && t.v === c; }
  acceptP(c) { if (this.isP(c)) { this.i++; return true; } return false; }
  expectP(c) { if (!this.acceptP(c)) this.fail(`Expected "${c}"`); }
  lastEnd() { return this.t[this.i - 1].end; }
  textFrom(pos) { return this.sql.slice(pos, this.lastEnd()).replace(/\s+/g, ' ').trim(); }

  fail(msg) {
    const t = this.cur;
    const where = t.t === 'eof' ? ' but the query ended' : ` near "${t.raw}"`;
    throw new SqlError(`${msg}${where}`, t.pos);
  }

  ident(what = 'a name') {
    const t = this.cur;
    if (t.t !== 'id') this.fail(`Expected ${what}`);
    if (!t.q && RESERVED.has(t.u)) this.fail(`Expected ${what}, but "${t.raw}" is a reserved keyword`);
    this.i++;
    return t.v;
  }

  // ---------- statements ----------
  statement() {
    if (this.isKw('SELECT', 'WITH') || this.isP('(')) return { type: 'select', query: this.query() };
    if (this.acceptKw('EXPLAIN')) {
      const analyze = !!this.acceptKw('ANALYZE');
      return { type: 'explain', analyze, query: this.query() };
    }
    if (this.isKw('INSERT')) return this.insert();
    if (this.isKw('UPDATE')) return this.update();
    if (this.isKw('DELETE')) return this.del();
    if (this.isKw('CREATE')) return this.create();
    if (this.isKw('DROP')) return this.drop();
    if (this.isKw('ALTER')) return this.alter();
    this.fail('Expected SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, ALTER TABLE or DROP TABLE');
  }

  insert() {
    this.expectKw('INSERT');
    this.expectKw('INTO');
    const table = this.ident('a table name');
    let cols = null;
    if (this.isP('(') && !this.isKwAt(1, 'SELECT', 'WITH')) {
      this.i++;
      cols = [];
      do { cols.push(this.ident('a column name')); } while (this.acceptP(','));
      this.expectP(')');
    }
    if (this.acceptKw('VALUES')) {
      const rows = [];
      do {
        this.expectP('(');
        const r = [];
        do { r.push(this.expr()); } while (this.acceptP(','));
        this.expectP(')');
        rows.push(r);
      } while (this.acceptP(','));
      return { type: 'insert', table, cols, rows };
    }
    if (this.isKw('SELECT', 'WITH') || this.isP('(')) return { type: 'insert', table, cols, query: this.query() };
    this.fail('Expected VALUES or SELECT');
  }

  update() {
    this.expectKw('UPDATE');
    const table = this.ident('a table name');
    this.expectKw('SET');
    const sets = [];
    do {
      const col = this.ident('a column name');
      if (!this.acceptP('=')) this.fail('Expected "="');
      sets.push({ col, expr: this.expr() });
    } while (this.acceptP(','));
    let where = null, whereText = null;
    if (this.acceptKw('WHERE')) { const s = this.cur.pos; where = this.expr(); whereText = this.textFrom(s); }
    return { type: 'update', table, sets, where, whereText };
  }

  del() {
    this.expectKw('DELETE');
    this.expectKw('FROM');
    const table = this.ident('a table name');
    let where = null, whereText = null;
    if (this.acceptKw('WHERE')) { const s = this.cur.pos; where = this.expr(); whereText = this.textFrom(s); }
    return { type: 'delete', table, where, whereText };
  }

  typeName() {
    const t = this.cur;
    if (t.t !== 'id') this.fail('Expected a column type (INT, TEXT, REAL, DATE ...)');
    this.i++;
    let name = t.u;
    if (this.acceptP('(')) { while (!this.isP(')') && this.cur.t !== 'eof') this.i++; this.expectP(')'); }
    if (name === 'DOUBLE' && this.isKw('PRECISION')) this.i++;
    return name;
  }

  columnDef() {
    const name = this.ident('a column name');
    const type = this.typeName();
    let def = null;
    let depth = 0;
    while (this.cur.t !== 'eof' && !(depth === 0 && (this.isP(',') || this.isP(')')))) {
      if (this.isP('(')) depth++;
      if (this.isP(')')) depth--;
      if (depth === 0 && this.acceptKw('DEFAULT')) { def = this.unary(); continue; }
      this.i++;
    }
    return { name, type, default: def };
  }

  create() {
    this.expectKw('CREATE');
    this.expectKw('TABLE');
    let ifNot = false;
    if (this.isKw('IF')) { this.i++; this.expectKw('NOT'); this.expectKw('EXISTS'); ifNot = true; }
    const name = this.ident('a table name');
    this.expectP('(');
    const cols = [];
    do { cols.push(this.columnDef()); } while (this.acceptP(','));
    this.expectP(')');
    return { type: 'create', name, cols, ifNot };
  }

  drop() {
    this.expectKw('DROP');
    this.expectKw('TABLE');
    let ifExists = false;
    if (this.isKw('IF')) { this.i++; this.expectKw('EXISTS'); ifExists = true; }
    return { type: 'drop', name: this.ident('a table name'), ifExists };
  }

  alter() {
    this.expectKw('ALTER');
    this.expectKw('TABLE');
    const table = this.ident('a table name');
    if (this.acceptKw('ADD')) {
      this.acceptKw('COLUMN');
      return { type: 'alter', table, action: 'add', col: this.columnDef() };
    }
    if (this.acceptKw('DROP')) {
      this.acceptKw('COLUMN');
      return { type: 'alter', table, action: 'drop', name: this.ident('a column name') };
    }
    if (this.acceptKw('RENAME')) {
      if (this.acceptKw('TO')) return { type: 'alter', table, action: 'rename-table', to: this.ident('a table name') };
      this.acceptKw('COLUMN');
      const from = this.ident('a column name');
      this.expectKw('TO');
      return { type: 'alter', table, action: 'rename-col', from, to: this.ident('a column name') };
    }
    this.fail('Expected ADD, DROP or RENAME');
  }

  // ---------- queries ----------
  query() {
    const q = { type: 'query', with: [], recursive: false, body: null, orderBy: null, limit: null, offset: null };
    if (this.acceptKw('WITH')) {
      q.recursive = !!this.acceptKw('RECURSIVE');
      do {
        const name = this.ident('a CTE name');
        let cols = null;
        if (this.acceptP('(')) {
          cols = [];
          do { cols.push(this.ident('a column name')); } while (this.acceptP(','));
          this.expectP(')');
        }
        this.expectKw('AS');
        this.expectP('(');
        const sub = this.query();
        this.expectP(')');
        q.with.push({ name, cols, query: sub });
      } while (this.acceptP(','));
    }
    q.body = this.setBody();
    const clauses = [];
    if (this.isKw('ORDER')) {
      const s = this.cur.pos;
      this.i++;
      this.expectKw('BY');
      q.orderBy = this.orderItems();
      q.orderText = this.textFrom(s);
      clauses.push({ k: 'ORDER BY', s });
    }
    if (this.isKw('LIMIT') || this.isKw('OFFSET')) {
      const s = this.cur.pos;
      if (this.acceptKw('LIMIT')) {
        q.limit = this.expr();
        if (this.acceptKw('OFFSET')) q.offset = this.expr();
        else if (this.acceptP(',')) { q.offset = q.limit; q.limit = this.expr(); }
      } else {
        this.i++;
        q.offset = this.expr();
      }
      q.limitText = this.textFrom(s);
      clauses.push({ k: 'LIMIT', s });
    }
    if (q.body.type === 'select') {
      q.body.clauses.push(...clauses);
      const all = q.body.clauses;
      const end = this.lastEnd();
      all.forEach((c, i) => { c.e = i + 1 < all.length ? all[i + 1].s : end; });
    }
    return q;
  }

  orderItems() {
    const items = [];
    do {
      const expr = this.expr();
      let desc = false;
      if (this.acceptKw('DESC')) desc = true; else this.acceptKw('ASC');
      let nulls = null;
      if (this.acceptKw('NULLS')) {
        if (this.acceptKw('FIRST')) nulls = 'first';
        else if (this.isKw('LAST')) { this.i++; nulls = 'last'; } else this.fail('Expected FIRST or LAST');
      }
      items.push({ expr, desc, nulls });
    } while (this.acceptP(','));
    return items;
  }

  setBody() {
    let left = this.setTerm();
    while (this.isKw('UNION', 'INTERSECT', 'EXCEPT')) {
      const op = this.t[this.i++].u;
      let all = false;
      if (this.acceptKw('ALL')) all = true; else this.acceptKw('DISTINCT');
      const right = this.setTerm();
      left = { type: 'set', op, all, left, right };
    }
    return left;
  }

  setTerm() {
    if (this.isP('(')) {
      this.i++;
      const q = this.query();
      this.expectP(')');
      return { type: 'nested', query: q };
    }
    return this.select();
  }

  select() {
    const s0 = this.cur.pos;
    this.expectKw('SELECT');
    const core = { type: 'select', distinct: false, items: [], from: null, where: null, groupBy: null, having: null, clauses: [], joins: [] };
    core.clauses.push({ k: 'SELECT', s: s0 });
    if (this.acceptKw('DISTINCT')) core.distinct = true; else this.acceptKw('ALL');
    do { core.items.push(this.item()); } while (this.acceptP(','));
    this.parseFromAndMore(core);
    return core;
  }

  parseFromAndMore(core) {
    if (this.isKw('FROM')) {
      core.clauses.push({ k: 'FROM', s: this.cur.pos });
      this.i++;
      core.from = this.from(core);
    }
    if (this.isKw('WHERE')) {
      core.clauses.push({ k: 'WHERE', s: this.cur.pos });
      this.i++;
      const s = this.cur.pos;
      core.where = this.expr();
      core.whereText = this.textFrom(s);
    }
    if (this.isKw('GROUP')) {
      core.clauses.push({ k: 'GROUP BY', s: this.cur.pos });
      this.i++;
      this.expectKw('BY');
      const s = this.cur.pos;
      core.groupBy = [];
      do { core.groupBy.push(this.expr()); } while (this.acceptP(','));
      core.groupText = this.textFrom(s);
    }
    if (this.isKw('HAVING')) {
      core.clauses.push({ k: 'HAVING', s: this.cur.pos });
      this.i++;
      const s = this.cur.pos;
      core.having = this.expr();
      core.havingText = this.textFrom(s);
    }
  }

  item() {
    if (this.isP('*')) { this.i++; return { star: true, table: null }; }
    if (this.cur.t === 'id' && this.peek().v === '.' && this.peek(2).v === '*' && this.peek(2).t === 'op') {
      const table = this.cur.v;
      this.i += 3;
      return { star: true, table };
    }
    const s = this.cur.pos;
    const expr = this.expr();
    const text = this.textFrom(s);
    let alias = null;
    if (this.acceptKw('AS')) {
      const t = this.cur;
      if (t.t === 'id' || t.t === 'str') { this.i++; alias = t.v; } else this.fail('Expected an alias');
    } else if ((this.cur.t === 'id' && (this.cur.q || !RESERVED.has(this.cur.u))) || this.cur.t === 'str') {
      alias = this.t[this.i++].v;
    }
    return { expr, alias, text };
  }

  from(core) {
    let left = this.factor();
    for (;;) {
      if (this.acceptP(',')) {
        const s = this.t[this.i - 1].pos;
        const right = this.factor();
        left = { type: 'join', kind: 'cross', left, right, on: null, using: null, text: '', s, e: this.lastEnd() };
        core.joins.push({ s, e: left.e });
        continue;
      }
      const s = this.cur.pos;
      let kind = null;
      if (this.acceptKw('CROSS')) { this.expectKw('JOIN'); kind = 'cross'; }
      else if (this.acceptKw('INNER')) { this.expectKw('JOIN'); kind = 'inner'; }
      else if (this.acceptKw('LEFT')) { this.acceptKw('OUTER'); this.expectKw('JOIN'); kind = 'left'; }
      else if (this.acceptKw('RIGHT')) { this.acceptKw('OUTER'); this.expectKw('JOIN'); kind = 'right'; }
      else if (this.acceptKw('FULL')) { this.acceptKw('OUTER'); this.expectKw('JOIN'); kind = 'full'; }
      else if (this.acceptKw('JOIN')) kind = 'inner';
      if (!kind) break;
      const right = this.factor();
      let on = null, using = null, text = '';
      if (kind !== 'cross') {
        if (this.acceptKw('ON')) { const os = this.cur.pos; on = this.expr(); text = this.textFrom(os); }
        else if (this.acceptKw('USING')) {
          const os = this.cur.pos;
          this.expectP('(');
          using = [];
          do { using.push(this.ident('a column name')); } while (this.acceptP(','));
          this.expectP(')');
          text = 'USING ' + this.textFrom(os);
        } else this.fail(`${kind.toUpperCase()} JOIN needs an ON condition (or USING)`);
      }
      left = { type: 'join', kind, left, right, on, using, text, s, e: this.lastEnd() };
      core.joins.push({ s, e: left.e });
    }
    return left;
  }

  factor() {
    if (this.isP('(')) {
      this.i++;
      const query = this.query();
      this.expectP(')');
      this.acceptKw('AS');
      const alias = this.cur.t === 'id' && (this.cur.q || !RESERVED.has(this.cur.u)) ? this.t[this.i++].v : 'subquery';
      return { type: 'subquery', query, alias };
    }
    const name = this.ident('a table name');
    let alias = null;
    if (this.acceptKw('AS')) alias = this.ident('an alias');
    else if (this.cur.t === 'id' && (this.cur.q || !RESERVED.has(this.cur.u))) alias = this.t[this.i++].v;
    return { type: 'table', name, alias };
  }

  // ---------- expressions ----------
  expr() { return this.or(); }

  or() {
    let l = this.and();
    while (this.acceptKw('OR')) l = { t: 'bin', op: 'OR', l, r: this.and() };
    return l;
  }

  and() {
    let l = this.not();
    while (this.acceptKw('AND')) l = { t: 'bin', op: 'AND', l, r: this.not() };
    return l;
  }

  not() {
    if (this.isKw('NOT') && !this.isKwAt(1, 'IN', 'BETWEEN', 'LIKE')) {
      this.i++;
      return { t: 'un', op: 'NOT', e: this.not() };
    }
    return this.cmp();
  }

  cmp() {
    let l = this.add();
    for (;;) {
      const t = this.cur;
      if (t.t === 'op' && ['=', '<>', '!=', '<', '>', '<=', '>='].includes(t.v)) {
        this.i++;
        l = { t: 'bin', op: t.v === '!=' ? '<>' : t.v, l, r: this.add() };
        continue;
      }
      if (this.isKw('IS')) {
        this.i++;
        const not = !!this.acceptKw('NOT');
        if (this.acceptKw('NULL')) { l = { t: 'isnull', e: l, not }; continue; }
        if (this.isKw('TRUE', 'FALSE')) { const val = this.t[this.i++].u === 'TRUE'; l = { t: 'istf', e: l, val, not }; continue; }
        this.fail('Expected NULL after IS');
      }
      let not = false;
      if (this.isKw('NOT') && this.isKwAt(1, 'IN', 'BETWEEN', 'LIKE')) { not = true; this.i++; }
      if (this.acceptKw('IN')) {
        this.expectP('(');
        if (this.isKw('SELECT', 'WITH')) {
          const query = this.query();
          this.expectP(')');
          l = { t: 'in', e: l, query, not };
        } else {
          const list = [];
          do { list.push(this.expr()); } while (this.acceptP(','));
          this.expectP(')');
          l = { t: 'in', e: l, list, not };
        }
        continue;
      }
      if (this.acceptKw('BETWEEN')) {
        const lo = this.add();
        this.expectKw('AND');
        const hi = this.add();
        l = { t: 'between', e: l, lo, hi, not };
        continue;
      }
      if (this.acceptKw('LIKE', 'ILIKE')) {
        l = { t: 'like', e: l, pat: this.add(), not };
        continue;
      }
      break;
    }
    return l;
  }

  add() {
    let l = this.mul();
    while (this.cur.t === 'op' && (this.cur.v === '+' || this.cur.v === '-')) {
      const op = this.t[this.i++].v;
      l = { t: 'bin', op, l, r: this.mul() };
    }
    return l;
  }

  mul() {
    let l = this.cat();
    while (this.cur.t === 'op' && ['*', '/', '%'].includes(this.cur.v)) {
      const op = this.t[this.i++].v;
      l = { t: 'bin', op, l, r: this.cat() };
    }
    return l;
  }

  cat() {
    let l = this.unary();
    while (this.cur.t === 'op' && this.cur.v === '||') {
      this.i++;
      l = { t: 'bin', op: '||', l, r: this.unary() };
    }
    return l;
  }

  unary() {
    if (this.cur.t === 'op' && (this.cur.v === '-' || this.cur.v === '+')) {
      const op = this.t[this.i++].v;
      return { t: 'un', op, e: this.unary() };
    }
    return this.primary();
  }

  primary() {
    const t = this.cur;
    if (t.t === 'num') { this.i++; return { t: 'num', v: t.v }; }
    if (t.t === 'str') { this.i++; return { t: 'str', v: t.v }; }
    if (this.isP('(')) {
      this.i++;
      if (this.isKw('SELECT', 'WITH')) {
        const query = this.query();
        this.expectP(')');
        return { t: 'sub', query };
      }
      const e = this.expr();
      this.expectP(')');
      return e;
    }
    if (t.t === 'id') {
      if (!t.q) {
        if (t.u === 'NULL') { this.i++; return { t: 'null' }; }
        if (t.u === 'TRUE') { this.i++; return { t: 'bool', v: true }; }
        if (t.u === 'FALSE') { this.i++; return { t: 'bool', v: false }; }
        if (t.u === 'CASE') return this.caseExpr();
        if (t.u === 'EXISTS') {
          this.i++;
          this.expectP('(');
          const query = this.query();
          this.expectP(')');
          return { t: 'exists', query };
        }
        if (t.u === 'CAST') {
          this.i++;
          this.expectP('(');
          const e = this.expr();
          this.expectKw('AS');
          const type = this.typeName();
          this.expectP(')');
          return { t: 'cast', e, type };
        }
      }
      if (this.peek().v === '(' && this.peek().t === 'p' && (t.q || !RESERVED.has(t.u))) return this.call();
      if (!t.q && RESERVED.has(t.u)) this.fail('Expected an expression');
      this.i++;
      if (this.isP('.') ) {
        this.i++;
        const c = this.cur;
        if (c.t !== 'id') this.fail('Expected a column name');
        this.i++;
        return { t: 'col', table: t.v, name: c.v };
      }
      return { t: 'col', table: null, name: t.v };
    }
    this.fail('Expected an expression');
  }

  caseExpr() {
    this.expectKw('CASE');
    let operand = null;
    if (!this.isKw('WHEN')) operand = this.expr();
    const whens = [];
    while (this.acceptKw('WHEN')) {
      const c = this.expr();
      this.expectKw('THEN');
      whens.push({ c, r: this.expr() });
    }
    if (!whens.length) this.fail('CASE needs at least one WHEN');
    let els = null;
    if (this.acceptKw('ELSE')) els = this.expr();
    this.expectKw('END');
    return { t: 'case', operand, whens, else: els };
  }

  call() {
    const start = this.cur.pos;
    const name = this.t[this.i++].u;
    this.expectP('(');
    const fn = { t: 'fn', name, args: [], distinct: false, star: false, over: null };
    if (this.isP('*')) { this.i++; fn.star = true; }
    else if (!this.isP(')')) {
      if (this.acceptKw('DISTINCT')) fn.distinct = true;
      do { fn.args.push(this.expr()); } while (this.acceptP(','));
    }
    this.expectP(')');
    // source text, kept non-enumerable so it never affects AST comparisons (GROUP BY checks)
    Object.defineProperty(fn, 'label', { value: this.textFrom(start), enumerable: false });
    if (this.isKw('OVER')) {
      const os = this.cur.pos;
      this.i++;
      fn.over = this.windowSpec();
      Object.defineProperty(fn.over, 'text', { value: this.textFrom(os), enumerable: false });
    }
    return fn;
  }

  windowSpec() {
    this.expectP('(');
    const w = { partitionBy: [], orderBy: [], frame: null };
    if (this.acceptKw('PARTITION')) {
      this.expectKw('BY');
      do { w.partitionBy.push(this.expr()); } while (this.acceptP(','));
    }
    if (this.acceptKw('ORDER')) {
      this.expectKw('BY');
      w.orderBy = this.orderItems();
    }
    if (this.isKw('ROWS', 'RANGE')) {
      const unit = this.t[this.i++].u;
      let start, end;
      if (this.acceptKw('BETWEEN')) {
        start = this.bound();
        this.expectKw('AND');
        end = this.bound();
      } else {
        start = this.bound();
        end = { k: 'cur' };
      }
      w.frame = { unit, start, end };
    }
    this.expectP(')');
    return w;
  }

  bound() {
    if (this.acceptKw('UNBOUNDED')) {
      const d = this.acceptKw('PRECEDING', 'FOLLOWING');
      if (!d) this.fail('Expected PRECEDING or FOLLOWING');
      return { k: 'unb', d: d.u };
    }
    if (this.acceptKw('CURRENT')) { this.expectKw('ROW'); return { k: 'cur' }; }
    if (this.cur.t !== 'num') this.fail('Expected a frame bound');
    const n = this.t[this.i++].v;
    const d = this.acceptKw('PRECEDING', 'FOLLOWING');
    if (!d) this.fail('Expected PRECEDING or FOLLOWING');
    return { k: 'off', n, d: d.u };
  }
}

export function parseSql(sql) {
  const p = new Parser(sql);
  const out = [];
  while (p.cur.t !== 'eof') {
    if (p.acceptP(';')) continue;
    const start = p.cur.pos;
    const st = p.statement();
    st.start = start;
    st.end = p.lastEnd();
    st.sql = sql.slice(start, st.end);
    out.push(st);
    if (p.cur.t !== 'eof' && !p.acceptP(';')) p.fail('Expected ";" or the end of the statement');
  }
  return out;
}
