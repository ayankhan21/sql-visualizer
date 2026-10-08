// Workbench = the output half of the page: Physical / Table / Analyze tabs plus the glue that
// makes the table strip react while a query runs. Used by the home page and by every lesson.
import { esc } from '../sql/format.js';
import { referencedTables } from '../sql/db.js';
import { StagePlayer } from './stage.js';
import { renderTable, renderAnalyze } from './results.js';

export class Workbench {
  constructor({ db, strip, editor = null, outEl, defaultTab = 'physical', onChange = null, runBtn = null }) {
    this.runBtn = runBtn;
    this.db = db;
    this.strip = strip;
    this.editor = editor;
    this.out = outEl;
    this.tab = defaultTab;
    this.results = [];
    this.cur = 0;
    this.pendingStrip = null;
    this.loaded = null;
    this.onChange = onChange;
    this.build();
  }

  build() {
    this.out.classList.add('wb');
    this.out.innerHTML = `
      <div class="wb-head">
        <div class="tabs" role="tablist">
          <button role="tab" data-tab="physical">Physical <span class="tab-sub">rows in motion</span></button>
          <button role="tab" data-tab="table">Table <span class="tab-sub">classic result</span></button>
          <button role="tab" data-tab="analyze">Analyze <span class="tab-sub">query flow</span></button>
        </div>
        <div class="stmts" hidden></div>
      </div>
      <div class="wb-error" hidden></div>
      <div class="wb-body">
        <div class="pane pane-physical"><div class="wb-empty">▶ Run a query — real rows fly out of the tables above and assemble into the result here.</div><div class="player"></div></div>
        <div class="pane pane-table"></div>
        <div class="pane pane-analyze"></div>
      </div>`;
    this.errEl = this.out.querySelector('.wb-error');
    this.stmtsEl = this.out.querySelector('.stmts');
    this.panes = {
      physical: this.out.querySelector('.pane-physical'),
      table: this.out.querySelector('.pane-table'),
      analyze: this.out.querySelector('.pane-analyze'),
    };
    this.emptyEl = this.out.querySelector('.wb-empty');
    this.player = new StagePlayer(this.out.querySelector('.player'), {
      srcRect: (k) => this.strip.srcRect(k),
      onFrame: (frame) => this.strip.highlight(new Set(frame.chips.flatMap((c) => c.h || []))),
      onEnd: () => this.flushStrip(),
      onPlayState: (on) => this.setBusy(on),
    });
    this.out.querySelector('.player').hidden = true;
    renderTable(this.panes.table, null);
    renderAnalyze(this.panes.analyze, null);
    this.out.querySelector('.tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) this.setTab(b.dataset.tab);
    });
    this.stmtsEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) { this.cur = Number(b.dataset.i); this.show(); }
    });
    this.setTab(this.tab, true);
  }

  // Run button shows a spinner while the query's animation is playing
  setBusy(on) {
    if (!this.runBtn) return;
    this.runBtn.classList.toggle('loading', on);
    this.runBtn.setAttribute('aria-busy', on ? 'true' : 'false');
    const label = this.runBtn.querySelector('.lbl');
    if (label) label.textContent = on ? 'Running…' : this.runBtn.dataset.label;
  }

  setTab(tab, silent = false) {
    this.tab = tab;
    this.out.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    Object.entries(this.panes).forEach(([k, p]) => { p.hidden = k !== tab; });
    if (tab !== 'physical') { this.player.pause(); this.flushStrip(); }
    // only animate if this result hasn't been shown in the player yet (e.g. it ran while another tab was open);
    // coming back to a result that already played leaves the player exactly where it was
    if (!silent && tab === 'physical' && this.results.length && this.results[this.cur] !== this.loaded) this.playCurrent();
  }

  flushStrip() {
    if (!this.pendingStrip) return;
    const ch = this.pendingStrip;
    this.pendingStrip = null;
    this.strip.render();
    this.strip.flash(ch);
    if (this.onChange) this.onChange();
  }

  showError(err) {
    this.errEl.hidden = false;
    this.errEl.innerHTML = `<b>${esc(err.name === 'SqlError' ? 'SQL error' : 'Error')}</b> ${esc(err.message)}`;
    if (this.editor) this.editor.setError(err.pos ?? null);
  }

  clearError() {
    this.errEl.hidden = true;
    if (this.editor) this.editor.setError(null);
  }

  // run SQL; returns true on success
  run(sql) {
    this.flushStrip();
    this.player.pause();
    this.setBusy(false);
    let results;
    try {
      results = this.db.exec(sql);
    } catch (err) {
      this.showError(err);
      if (!(err && err.name === 'SqlError')) console.error(err);
      return false;
    }
    this.clearError();
    if (this.strip.opts.reorder) {
      try { this.strip.focus(referencedTables(sql)); } catch (e) { /* unparsable already reported */ }
    }
    this.results = results;
    this.cur = results.length - 1;
    const merged = { inserted: [], updated: [], deleted: [], schema: [] };
    results.forEach((r) => { if (r.changes) Object.keys(merged).forEach((k) => merged[k].push(...r.changes[k])); });
    const changed = Object.values(merged).some((a) => a.length);
    if (changed) {
      this.pendingStrip = merged;
      // data changed: show the movement first, then update the tables when the animation ends
      if (this.tab !== 'physical' || !(results[this.cur].trace.frames.length)) this.flushStrip();
    }
    this.strip.clearHighlight();
    this.show();
    return true;
  }

  show() {
    const r = this.results[this.cur];
    this.emptyEl.hidden = true;
    this.out.querySelector('.player').hidden = false;
    this.renderStmts();
    renderTable(this.panes.table, r, { onTrace: (keys) => this.strip.highlight(keys) });
    renderAnalyze(this.panes.analyze, r);
    if (this.tab === 'physical') this.playCurrent();
    if (this.onChange) this.onChange(r);
  }

  playCurrent() {
    const r = this.results[this.cur];
    if (!r) return;
    this.loaded = r;
    this.player.load(r.trace.frames, { autoplay: true });
    if (!r.trace.frames.length) this.flushStrip();
  }

  renderStmts() {
    if (this.results.length < 2) { this.stmtsEl.hidden = true; return; }
    this.stmtsEl.hidden = false;
    this.stmtsEl.innerHTML = '<span>Statements:</span>' + this.results.map((r, i) => {
      const label = r.sql.replace(/\s+/g, ' ').slice(0, 26) + (r.sql.length > 26 ? '…' : '');
      return `<button data-i="${i}" class="${i === this.cur ? 'on' : ''}" title="${esc(r.sql)}">${i + 1}. ${esc(label)}</button>`;
    }).join('');
  }

  reset() {
    this.player.reset();
    this.loaded = null;
    this.setBusy(false);
    this.pendingStrip = null;
    this.db.reset();
    this.strip.clearOrder();
    this.strip.render();
    this.results = [];
    this.cur = 0;
    this.stmtsEl.hidden = true;
    this.clearError();
    this.out.querySelector('.player').hidden = true;
    this.emptyEl.hidden = false;
    renderTable(this.panes.table, null);
    renderAnalyze(this.panes.analyze, null);
    if (this.onChange) this.onChange(null);
  }
}
