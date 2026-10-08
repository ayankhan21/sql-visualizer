// Modal editor for the ONE extra table you may add on top of the 10 built-in ones.
import { esc } from '../sql/format.js';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TYPES = ['INT', 'TEXT', 'REAL', 'DATE', 'BOOLEAN'];
const MAX_COLS = 8;

export class TableBuilder {
  constructor({ db, onChange }) {
    this.db = db;
    this.onChange = onChange;
    this.dlg = document.createElement('dialog');
    this.dlg.className = 'modal builder';
    document.body.appendChild(this.dlg);
    this.dlg.addEventListener('click', (e) => { if (e.target === this.dlg) this.dlg.close(); });
  }

  open() {
    const custom = this.db.customTable();
    if (custom) this.renderExisting(custom);
    else {
      this.name = 'my_table';
      this.cols = [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }, { name: 'score', type: 'INT' }];
      this.rows = [['1', 'Alpha', '90'], ['2', 'Beta', '75'], ['3', 'Gamma', '82']];
      this.renderForm();
    }
    this.dlg.showModal();
  }

  renderExisting(t) {
    this.dlg.innerHTML = `<form method="dialog"><h3>Your extra table</h3>
      <p>You already created <b>${esc(t.name)}</b> (${t.cols.length} columns, ${t.rows.length} rows). The playground allows <b>one</b> extra table on top of the 10 built-in ones — query it, change it with INSERT / UPDATE / DELETE / ALTER, or drop it to make another.</p>
      <div class="modal-actions"><button class="btn danger" type="button" data-a="drop">Drop ${esc(t.name)}</button><button class="btn" value="close">Close</button></div></form>`;
    this.dlg.querySelector('[data-a=drop]').addEventListener('click', () => {
      this.db.exec(`DROP TABLE ${t.name}`);
      this.dlg.close();
      this.onChange();
    });
  }

  renderForm(error = '') {
    const typeOpts = (sel) => TYPES.map((t) => `<option${t === sel ? ' selected' : ''}>${t}</option>`).join('');
    this.dlg.innerHTML = `<form method="dialog" class="bform"><h3>Create your extra table</h3>
      <p class="muted">Design a table, fill in up to 50 rows, and it joins the others (colour: magenta). You can then query and join it like any built-in table.</p>
      <label class="fld">Table name <input data-a="name" value="${esc(this.name)}" maxlength="30" /></label>
      <h4>Columns <small>(max ${MAX_COLS})</small></h4>
      <div class="cols">${this.cols.map((c, i) => `<div class="colrow"><input data-a="cname" data-i="${i}" value="${esc(c.name)}" maxlength="30" placeholder="column name" />
        <select data-a="ctype" data-i="${i}">${typeOpts(c.type)}</select>
        <button type="button" class="icon-btn" data-a="delcol" data-i="${i}" title="Remove column"${this.cols.length < 2 ? ' disabled' : ''}>✕</button></div>`).join('')}
        <button type="button" class="btn small" data-a="addcol"${this.cols.length >= MAX_COLS ? ' disabled' : ''}>+ Column</button></div>
      <h4>Rows <small>(${this.rows.length}/50)</small></h4>
      <div class="grid-wrap"><table class="grid"><thead><tr>${this.cols.map((c, i) => `<th data-col="${i}">${esc(c.name || '…')}</th>`).join('')}<th></th></tr></thead>
        <tbody>${this.rows.map((r, ri) => `<tr>${this.cols.map((c, ci) => `<td><input data-a="cell" data-r="${ri}" data-c="${ci}" value="${esc(r[ci] ?? '')}" /></td>`).join('')}<td><button type="button" class="icon-btn" data-a="delrow" data-r="${ri}" title="Remove row">✕</button></td></tr>`).join('')}</tbody></table></div>
      <div class="row-actions"><button type="button" class="btn small" data-a="addrow"${this.rows.length >= 50 ? ' disabled' : ''}>+ Row</button>
        <button type="button" class="btn small" data-a="sample"${this.rows.length >= 50 ? ' disabled' : ''}>+ 5 sample rows</button></div>
      <p class="form-err" ${error ? '' : 'hidden'}>${esc(error)}</p>
      <div class="modal-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button type="button" class="btn primary" data-a="create">Create table</button></div></form>`;
    const q = (s) => this.dlg.querySelector(s);
    this.dlg.querySelector('form').onsubmit = null;
    q('[data-a=name]').addEventListener('input', (e) => { this.name = e.target.value.trim(); });
    this.dlg.querySelectorAll('[data-a=cname]').forEach((el) => el.addEventListener('input', (e) => {
      this.cols[+el.dataset.i].name = e.target.value.trim();
      const th = this.dlg.querySelector(`th[data-col="${el.dataset.i}"]`);
      if (th) th.textContent = e.target.value.trim() || '…';
    }));
    this.dlg.querySelectorAll('[data-a=ctype]').forEach((el) => el.addEventListener('change', (e) => { this.cols[+el.dataset.i].type = e.target.value; }));
    this.dlg.querySelectorAll('[data-a=cell]').forEach((el) => el.addEventListener('input', (e) => { this.rows[+el.dataset.r][+el.dataset.c] = e.target.value; }));
    this.dlg.addEventListener('click', this.handler = this.handler || ((e) => this.click(e)));
  }

  click(e) {
    const b = e.target.closest('[data-a]');
    if (!b || !this.dlg.open) return;
    const a = b.dataset.a;
    if (a === 'addcol' && this.cols.length < MAX_COLS) { this.cols.push({ name: `col${this.cols.length + 1}`, type: 'TEXT' }); this.rows.forEach((r) => r.push('')); this.renderForm(); }
    else if (a === 'delcol') { const i = +b.dataset.i; this.cols.splice(i, 1); this.rows.forEach((r) => r.splice(i, 1)); this.renderForm(); }
    else if (a === 'addrow' && this.rows.length < 50) { this.rows.push(this.cols.map(() => '')); this.renderForm(); }
    else if (a === 'delrow') { this.rows.splice(+b.dataset.r, 1); this.renderForm(); }
    else if (a === 'sample') {
      for (let k = 0; k < 5 && this.rows.length < 50; k++) {
        const n = this.rows.length + 1;
        this.rows.push(this.cols.map((c) => ({ INT: String(n * 10), REAL: (n * 1.5).toFixed(1), DATE: `2025-0${(n % 9) + 1}-1${n % 9}`, BOOLEAN: n % 2 ? 'true' : 'false', TEXT: `item ${n}` }[c.type])));
      }
      this.renderForm();
    } else if (a === 'create') this.create();
  }

  create() {
    try {
      if (!NAME_RE.test(this.name || '')) throw new Error('Table name must start with a letter and use only letters, digits and underscores.');
      for (const c of this.cols) if (!NAME_RE.test(c.name || '')) throw new Error(`Column name "${c.name || ''}" is not valid (letters, digits, underscores; must not start with a digit).`);
      const rows = this.rows.map((r) => r.map((v, i) => {
        const s = String(v ?? '').trim();
        if (s === '' || s.toUpperCase() === 'NULL') return null;
        const t = this.cols[i].type;
        if (t === 'INT' || t === 'REAL') {
          if (Number.isNaN(Number(s))) throw new Error(`"${s}" is not a number (column ${this.cols[i].name}).`);
          return Number(s);
        }
        if (t === 'BOOLEAN') return ['true', '1', 'yes'].includes(s.toLowerCase());
        return s;
      }));
      this.db.createTable({ name: this.name, cols: this.cols.map((c) => ({ ...c })), rows });
      this.dlg.close();
      this.onChange();
    } catch (err) {
      this.renderForm(err.message);
    }
  }
}
