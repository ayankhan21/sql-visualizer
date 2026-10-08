// The "tables waiting on top": one coloured card per table, every row tinted with its table's colour.
import { fmt, esc } from '../sql/format.js';
import { syncPalette, tc } from './colors.js';

export class TableStrip {
  // opts.only: Set of lower-case table names to show (lessons show just the relevant ones)
  constructor(el, db, opts = {}) {
    this.el = el;
    this.db = db;
    this.opts = opts;
    this.rows = new Map();
    this.lit = new Set();
    this.order = [];
    el.classList.add('strip');
    this.render();
  }

  setOnly(set) {
    this.opts.only = set;
    this.render();
  }

  render() {
    syncPalette(this.db);
    const scroll = new Map();
    this.el.querySelectorAll('.tcard').forEach((c) => {
      const b = c.querySelector('.tbody');
      scroll.set(c.dataset.t, [b.scrollTop, b.scrollLeft]);
    });
    this.rows = new Map();
    this.lit = new Set();
    this.el.classList.remove('has-hl');
    const tables = this.sorted(this.db.list().filter((t) => !this.opts.only || this.opts.only.has(t.name.toLowerCase())));
    this.el.innerHTML = tables.map((t) => this.card(t)).join('') || '<p class="muted pad">No tables to show.</p>';
    this.el.querySelectorAll('tr[data-rk]').forEach((tr) => this.rows.set(tr.dataset.rk, tr));
    this.el.querySelectorAll('.tcard').forEach((c) => {
      const s = scroll.get(c.dataset.t);
      if (s) { const b = c.querySelector('.tbody'); b.scrollTop = s[0]; b.scrollLeft = s[1]; }
    });
  }

  // tables named in `order` come first (the ones the current query uses), the rest keep database order
  sorted(tables) {
    const pos = (t, i) => { const k = this.order.indexOf(t.name.toLowerCase()); return k < 0 ? 1000 + i : k; };
    return tables.map((t, i) => [t, pos(t, i)]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
  }

  // bring the tables a query touches to the front so the rows visibly leave from tables you can see
  focus(names) {
    this.order = [...names].map((n) => n.toLowerCase()).filter((n) => this.db.getTable(n));
    const cards = [...this.el.querySelectorAll('.tcard')];
    if (cards.length < 2) return;
    const first = new Map(cards.map((c) => [c, c.getBoundingClientRect()]));
    const byName = new Map(cards.map((c) => [c.dataset.t.toLowerCase(), c]));
    const want = this.sorted(this.db.list().filter((t) => byName.has(t.name.toLowerCase()))).map((t) => byName.get(t.name.toLowerCase()));
    if (want.every((c, i) => c === cards[i])) return;
    want.forEach((c) => this.el.appendChild(c));
    this.el.scrollLeft = 0;
    for (const c of want) {
      const dx = first.get(c).left - c.getBoundingClientRect().left;
      if (Math.abs(dx) > 1) c.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 520, easing: 'cubic-bezier(.22,.8,.2,1)' });
    }
  }

  clearOrder() { this.order = []; }

  card(t) {
    const cls = tc(t.name);
    const head = t.cols.map((c) => {
      const fk = c.fk ? `<i class="fk ${tc(c.fk.split('.')[0])}" title="Foreign key → ${esc(c.fk)}">→ ${esc(c.fk.split('.')[0])}</i>` : '';
      const pk = c.name.toLowerCase() === 'id' ? '<i class="pk" title="Primary key — unique id of each row">PK</i>' : '';
      return `<th title="${esc(c.name)} (${esc(c.type)})"><span>${esc(c.name)}</span>${pk}${fk}<small>${esc(c.type)}</small></th>`;
    }).join('');
    const body = t.rows.map((r) => `<tr data-rk="${esc(t.name)}#${r.rid}">${r.v.map((v) => `<td${v === null || v === undefined ? ' class="null"' : ''}>${esc(fmt(v))}</td>`).join('')}</tr>`).join('');
    return `<article class="tcard ${cls}" data-t="${esc(t.name)}">
      <header><span class="dot"></span><b>${esc(t.name)}</b><span class="count">${t.rows.length} row${t.rows.length === 1 ? '' : 's'}</span>${t.custom ? '<span class="badge-custom">yours</span>' : ''}</header>
      <div class="tbody"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    </article>`;
  }

  // light up the source rows that are currently "in play" and dim everything else
  highlight(keys) {
    const next = new Set(keys || []);
    this.lit.forEach((k) => { if (!next.has(k)) this.rows.get(k)?.classList.remove('hl'); });
    next.forEach((k) => { if (!this.lit.has(k)) this.rows.get(k)?.classList.add('hl'); });
    this.lit = next;
    this.el.classList.toggle('has-hl', next.size > 0);
  }

  clearHighlight() { this.highlight([]); }

  flash(changes) {
    if (!changes) return;
    const mark = (keys, cls) => keys.forEach((k) => {
      const tr = this.rows.get(k);
      if (!tr) return;
      tr.classList.add(cls);
      setTimeout(() => tr.classList.remove(cls), 2600);
    });
    mark(changes.inserted || [], 'flash-new');
    mark(changes.updated || [], 'flash-upd');
    (changes.schema || []).forEach((n) => {
      const c = this.el.querySelector(`.tcard[data-t="${CSS.escape(n)}"]`);
      if (c) { c.classList.add('flash-schema'); setTimeout(() => c.classList.remove('flash-schema'), 2600); }
    });
    // bring the first new/changed row into view inside its card
    const first = (changes.inserted || [])[0] || (changes.updated || [])[0];
    const tr = first && this.rows.get(first);
    if (tr) tr.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // screen position of a real table row — where flying chips take off from
  srcRect(key) {
    const tr = this.rows.get(key);
    if (!tr) return null;
    const card = tr.closest('.tbody');
    const r = tr.getBoundingClientRect();
    const b = card.getBoundingClientRect();
    const s = this.el.getBoundingClientRect();
    let { left, top, width } = { left: Math.max(r.left, b.left), top: r.top, width: Math.min(r.width, b.width) };
    if (r.bottom < b.top || r.top > b.bottom) top = r.bottom < b.top ? b.top : b.bottom - r.height;
    // table scrolled out of the strip sideways: take off from the strip's edge instead
    if (left + width > s.right) { width = Math.min(width, 140); left = s.right - width; }
    if (left < s.left) left = s.left;
    return { left, top, width, height: r.height };
  }
}
