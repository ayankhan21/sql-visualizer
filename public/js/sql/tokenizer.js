// SQL tokenizer. Produces id / num / str / op / p (punctuation) / eof tokens.

export class SqlError extends Error {
  constructor(message, pos = null) {
    super(message);
    this.name = 'SqlError';
    this.pos = pos;
  }
}

const NUM = /(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/y;
const IDENT = /[A-Za-z_][A-Za-z0-9_$]*/y;
const OPS = ['<=', '>=', '<>', '!=', '||', '=', '<', '>', '+', '-', '*', '/', '%'];

export function tokenize(sql) {
  const toks = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    const pos = i;
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
      NUM.lastIndex = i;
      const m = NUM.exec(sql);
      i = NUM.lastIndex;
      toks.push({ t: 'num', v: Number(m[0]), raw: m[0], pos, end: i });
      continue;
    }
    if (c === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= n) throw new SqlError('Unterminated string literal', pos);
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { s += "'"; i += 2; continue; }
          i++;
          break;
        }
        s += sql[i++];
      }
      toks.push({ t: 'str', v: s, raw: sql.slice(pos, i), pos, end: i });
      continue;
    }
    if (c === '"' || c === '`') {
      const e = sql.indexOf(c, i + 1);
      if (e < 0) throw new SqlError('Unterminated quoted identifier', pos);
      const v = sql.slice(i + 1, e);
      i = e + 1;
      toks.push({ t: 'id', v, u: v.toUpperCase(), q: true, raw: sql.slice(pos, i), pos, end: i });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      IDENT.lastIndex = i;
      const m = IDENT.exec(sql);
      i = IDENT.lastIndex;
      toks.push({ t: 'id', v: m[0], u: m[0].toUpperCase(), q: false, raw: m[0], pos, end: i });
      continue;
    }
    if ('(),.;'.includes(c)) {
      i++;
      toks.push({ t: 'p', v: c, raw: c, pos, end: i });
      continue;
    }
    const op = OPS.find((o) => sql.startsWith(o, i));
    if (op) {
      i += op.length;
      toks.push({ t: 'op', v: op, raw: op, pos, end: i });
      continue;
    }
    throw new SqlError(`Unexpected character "${c}"`, pos);
  }
  toks.push({ t: 'eof', v: '', raw: '', pos: n, end: n });
  return toks;
}
