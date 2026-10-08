// A small SQL editor: <textarea> on top of a syntax-highlighted <pre>.
import { esc } from '../sql/format.js';
import { tc } from './colors.js';

const KW = new Set(('SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AS AND OR NOT IN IS NULL LIKE ILIKE '
  + 'BETWEEN EXISTS CASE WHEN THEN ELSE END DISTINCT ALL UNION INTERSECT EXCEPT WITH RECURSIVE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER '
  + 'ADD DROP COLUMN RENAME TO ASC DESC OVER PARTITION ROWS RANGE UNBOUNDED PRECEDING FOLLOWING CURRENT ROW NULLS FIRST LAST EXPLAIN ANALYZE TRUE FALSE DEFAULT IF CAST').split(' '));

const TOKEN = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([\s\S])/g;

export function highlightSql(src, { db, errPos = null } = {}) {
  let out = '';
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(src))) {
    const [txt, com, str, num, id, ws] = m;
    const start = m.index, end = start + txt.length;
    const err = errPos !== null && errPos >= start && errPos < end && !ws ? ' err' : '';
    if (ws) out += esc(txt);
    else if (com) out += `<span class="c${err}">${esc(txt)}</span>`;
    else if (str) out += `<span class="s${err}">${esc(txt)}</span>`;
    else if (num) out += `<span class="n${err}">${esc(txt)}</span>`;
    else if (id) {
      const u = txt.toUpperCase();
      const t = db && db.getTable(txt);
      if (KW.has(u)) out += `<span class="k${err}">${esc(txt)}</span>`;
      else if (t) out += `<span class="tn ${tc(t.name)}${err}">${esc(txt)}</span>`;
      else if (/^\s*\(/.test(src.slice(end, end + 3))) out += `<span class="f${err}">${esc(txt)}</span>`;
      else out += `<span class="${err.trim()}">${esc(txt)}</span>`;
    } else out += `<span class="${err.trim()}">${esc(txt)}</span>`;
  }
  if (errPos !== null && errPos >= src.length) out += '<span class="err end"> </span>';
  return out + '\n';
}

export class Editor {
  constructor(el, { db, value = '', onRun = null, minRows = 3, maxRows = 12, placeholder = '' } = {}) {
    this.el = el;
    this.db = db;
    this.onRun = onRun;
    this.minRows = minRows;
    this.maxRows = maxRows;
    this.errPos = null;
    el.classList.add('ed');
    el.innerHTML = '<pre class="ed-hl" aria-hidden="true"></pre><textarea class="ed-in" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>';
    this.pre = el.querySelector('pre');
    this.ta = el.querySelector('textarea');
    this.ta.placeholder = placeholder;
    this.ta.value = value;
    this.ta.addEventListener('input', () => { this.errPos = null; this.paint(); });
    this.ta.addEventListener('scroll', () => this.sync());
    this.ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.onRun && this.onRun(); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: en } = this.ta;
        this.ta.setRangeText('  ', s, en, 'end');
        this.paint();
      }
    });
    this.paint();
  }

  get value() { return this.ta.value; }

  set value(v) {
    this.ta.value = v;
    this.errPos = null;
    this.paint();
  }

  setError(pos) { this.errPos = pos; this.paint(); }
  focus() { this.ta.focus(); }

  sync() {
    this.pre.scrollTop = this.ta.scrollTop;
    this.pre.scrollLeft = this.ta.scrollLeft;
  }

  paint() {
    this.pre.innerHTML = highlightSql(this.ta.value, { db: this.db, errPos: this.errPos });
    const lines = this.ta.value.split('\n').length;
    this.el.style.setProperty('--rows', Math.max(this.minRows, Math.min(this.maxRows, lines + 0)));
    this.sync();
  }
}
