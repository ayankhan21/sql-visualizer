// StagePlayer: plays a trace as physical, animated row "chips".
//
// Each frame is a set of chips keyed by identity. Between two frames we diff by key (FLIP):
//   same key      -> the chip slides to its new place
//   new + src     -> a clone flies out of the real table row in the table strip
//   new + from    -> it grows out of its parent chips (a join / aggregation merging rows)
//   removed       -> it merges into the chip that absorbed it, or falls away (filtered out)
import { fmt, esc } from '../sql/format.js';
import { tc } from './colors.js';

const EASE = 'cubic-bezier(.22,.8,.2,1)';
const richText = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

function laneWidths(lane, chips) {
  const idx = lane.cols.map((c, i) => (c.hidden ? -1 : i)).filter((i) => i >= 0);
  const w = idx.map((i) => {
    let m = String(lane.cols[i].name).length;
    for (const c of chips) m = Math.max(m, fmt(c.vals[i]).length);
    return Math.max(52, Math.min(170, Math.round(m * 7.2 + 20)));
  });
  return { idx, w };
}

export class StagePlayer {
  // opts.srcRect(key) -> DOMRect|null   position of a real table row in the strip
  // opts.onFrame(frame, i)              called whenever a frame becomes current
  // opts.onEnd()                        called when the last frame has finished animating
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.frames = [];
    this.idx = -1;
    this.speed = 1;
    this.playing = false;
    this.nodes = new Map();
    this.anims = [];
    this.clones = [];
    this.token = 0;
    this.timer = null;
    this.build();
  }

  build() {
    this.root.classList.add('sp');
    this.root.innerHTML = `
      <div class="sp-bar">
        <div class="sp-ctl">
          <button class="icon-btn" data-a="restart" title="Restart">⏮</button>
          <button class="icon-btn" data-a="prev" title="Previous step">◀</button>
          <button class="icon-btn primary" data-a="play" title="Play / pause">⏸</button>
          <button class="icon-btn" data-a="next" title="Next step">▶</button>
          <label class="sp-speed" title="Animation speed">
            <span>Speed</span>
            <select data-a="speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select>
          </label>
        </div>
        <ol class="sp-steps"></ol>
      </div>
      <div class="sp-caption"><span class="sp-badge"></span><span class="sp-text"></span><code class="sp-code"></code></div>
      <div class="sp-scroll"><div class="sp-stage"><div class="lanes"></div><div class="fx"></div></div></div>`;
    this.$ = (s) => this.root.querySelector(s);
    this.stepsEl = this.$('.sp-steps');
    this.lanesEl = this.$('.lanes');
    this.fx = this.$('.fx');
    this.stage = this.$('.sp-stage');
    this.badge = this.$('.sp-badge');
    this.text = this.$('.sp-text');
    this.code = this.$('.sp-code');
    this.playBtn = this.$('[data-a=play]');
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'restart') this.goto(0, true, true);
      else if (a === 'prev') { this.pause(); this.goto(this.idx - 1, false); }
      else if (a === 'next') { this.pause(); this.goto(this.idx + 1, true); }
      else if (a === 'play') this.playing ? this.pause() : this.play();
      else if (a === 'step') { this.pause(); this.goto(Number(b.dataset.i), Math.abs(Number(b.dataset.i) - this.idx) === 1); }
    });
    this.$('[data-a=speed]').addEventListener('change', (e) => { this.speed = Number(e.target.value); });
  }

  // ------------------------------------------------------------ public API
  load(frames, { autoplay = true } = {}) {
    this.reset();
    this.frames = frames || [];
    this.renderSteps();
    this.root.classList.toggle('sp-empty', !this.frames.length);
    if (!this.frames.length) {
      this.lanesEl.innerHTML = '<div class="sp-none">This statement has no row movement to show — see the Table tab for its effect.</div>';
      this.badge.textContent = '';
      this.text.textContent = '';
      this.code.textContent = '';
      this.setPlayIcon(false);
      return;
    }
    this.idx = -1;
    this.playing = autoplay;
    this.setPlayIcon(autoplay);
    this.goto(0, true, autoplay);
  }

  play() {
    if (!this.frames.length) return;
    this.playing = true;
    this.setPlayIcon(true);
    if (this.idx >= this.frames.length - 1) this.goto(0, true, true);
    else this.schedule(200);
  }

  pause() {
    this.playing = false;
    clearTimeout(this.timer);
    this.setPlayIcon(false);
  }

  goto(i, animate = true, keepPlaying = false) {
    if (!this.frames.length) return;
    i = Math.max(0, Math.min(this.frames.length - 1, i));
    if (!keepPlaying && !this.playing) this.setPlayIcon(false);
    this.renderFrame(i, animate);
  }

  reset() {
    this.token++;
    clearTimeout(this.timer);
    this.cancelAnims();
    this.nodes.clear();
    this.lanesEl.replaceChildren();
    this.fx.replaceChildren();
    this.idx = -1;
    this.playing = false;
  }

  // ------------------------------------------------------------ internals
  setPlayIcon(playing) {
    this.playBtn.textContent = playing ? '⏸' : '▶';
    this.playBtn.title = playing ? 'Pause' : 'Play';
    if (this.opts.onPlayState) this.opts.onPlayState(playing);
  }

  renderSteps() {
    // collapse consecutive frames with the same stage so the stepper stays short
    this.stepsEl.innerHTML = this.frames
      .map((f, i) => `<li><button data-a="step" data-i="${i}" class="${f.final ? 'is-final' : ''}" title="${esc(f.caption.replace(/\*\*/g, ''))}">${esc(f.stage === 'RESULT' ? 'RESULT' : f.title.length > 22 ? f.stage : f.title)}</button></li>`)
      .join('');
  }

  markSteps() {
    [...this.stepsEl.querySelectorAll('button')].forEach((b, i) => {
      b.classList.toggle('on', i === this.idx);
      b.classList.toggle('done', i < this.idx);
    });
  }

  cancelAnims() {
    this.anims.forEach((a) => { try { a.cancel(); } catch (e) { /* ignore */ } });
    this.anims = [];
    this.clones.forEach((c) => c.remove());
    this.clones = [];
    this.nodes.forEach((el) => { el.style.visibility = ''; });
  }

  schedule(delay) {
    clearTimeout(this.timer);
    const tok = this.token;
    this.timer = setTimeout(() => {
      if (tok !== this.token || !this.playing) return;
      if (this.idx >= this.frames.length - 1) { this.finish(); return; }
      this.renderFrame(this.idx + 1, true);
    }, delay / this.speed);
  }

  finish() {
    this.playing = false;
    this.setPlayIcon(false);
    if (this.opts.onEnd) this.opts.onEnd();
  }

  makeChip() {
    const el = document.createElement('div');
    el.className = 'chip';
    return el;
  }

  fillChip(el, lane, chip, ww) {
    const cells = ww.idx.map((ci, k) => {
      const col = lane.cols[ci];
      const v = chip.vals[ci];
      const isNull = v === null || v === undefined;
      const hl = chip.hl && chip.hl.includes(ci) ? ' hl' : '';
      return `<span class="cell ${tc(col.base)}${isNull ? ' null' : ''}${hl}" style="width:${ww.w[k]}px" title="${esc(col.name)}: ${esc(fmt(v))}">${esc(fmt(v))}</span>`;
    }).join('');
    const sig = cells + (chip.flag || '');
    if (el._sig !== sig) { el.innerHTML = cells; el._sig = sig; }
    el.className = 'chip' + (chip.flag ? ' flag-' + chip.flag : '');
  }

  renderFrame(i, animate) {
    const frame = this.frames[i];
    const tok = ++this.token;
    clearTimeout(this.timer);
    this.cancelAnims();
    this.fx.replaceChildren();
    this.idx = i;
    this.markSteps();

    // ---- FIRST: where is everything now?
    const first = new Map();
    if (animate) this.nodes.forEach((el, k) => first.set(k, el.getBoundingClientRect()));
    const stageRect = this.stage.getBoundingClientRect();

    // ---- chips that leave
    const keys = new Set(frame.chips.map((c) => c.key));
    const removed = [];
    this.nodes.forEach((el, k) => { if (!keys.has(k)) removed.push([k, el]); });
    for (const [k, el] of removed) {
      this.nodes.delete(k);
      if (!animate) continue;
      const r = first.get(k);
      el.style.cssText = `position:absolute;left:${r.left - stageRect.left}px;top:${r.top - stageRect.top}px;width:${r.width}px;margin:0;`;
      this.fx.appendChild(el);
    }

    // ---- LAST: render the new arrangement
    const lanes = frame.lanes.length ? frame.lanes : [{ label: '', cols: [] }];
    this.lanesEl.className = 'lanes ' + (frame.layout || 'single') + (frame.final ? ' final' : '');
    this.stage.classList.toggle('wrapmode', frame.layout === 'wrap');
    this.lanesEl.replaceChildren();
    const created = new Set();
    lanes.forEach((lane, li) => {
      const laneChips = frame.chips.filter((c) => (c.lane || 0) === li);
      const ww = laneWidths(lane, laneChips);
      const laneEl = document.createElement('section');
      laneEl.className = 'lane';
      const head = ww.idx.map((ci, k) => `<span class="hcell ${tc(lane.cols[ci].base)}" style="width:${ww.w[k]}px" title="${esc(lane.cols[ci].name)}">${esc(lane.cols[ci].name)}</span>`).join('');
      laneEl.innerHTML = `<header class="lane-title"><b>${esc(lane.label || '')}</b>${lane.note ? `<em>${esc(lane.note)}</em>` : `<em>${laneChips.length ? laneChips.length + ' row' + (laneChips.length === 1 ? '' : 's') : ''}</em>`}</header>
        ${ww.idx.length ? `<div class="lane-cols">${head}</div>` : ''}<div class="lane-body"></div>`;
      const body = laneEl.querySelector('.lane-body');
      if (!laneChips.length) body.innerHTML = '<div class="lane-empty">no rows</div>';
      for (const chip of laneChips) {
        let el = this.nodes.get(chip.key);
        if (!el) { el = this.makeChip(); created.add(chip.key); this.nodes.set(chip.key, el); }
        this.fillChip(el, lane, chip, ww);
        body.appendChild(el);
      }
      this.lanesEl.appendChild(laneEl);
    });
    if (frame.hidden > 0) {
      const more = document.createElement('div');
      more.className = 'sp-more';
      more.textContent = `+ ${frame.hidden} more row${frame.hidden === 1 ? '' : 's'} not drawn (the Table tab shows them all)`;
      this.lanesEl.appendChild(more);
    }

    // ---- caption
    this.badge.textContent = frame.stage === 'RESULT' ? 'RESULT' : frame.stage;
    this.badge.dataset.stage = frame.stage;
    this.text.innerHTML = richText(frame.caption || '');
    this.code.textContent = frame.code || '';
    this.code.style.display = frame.code ? '' : 'none';
    if (this.opts.onFrame) this.opts.onFrame(frame, i);

    if (!animate) { this.afterAnim(tok, []); return; }

    // ---- INVERT + PLAY
    const D = 700 / this.speed;
    const anims = [];
    const lastRect = new Map();
    frame.chips.forEach((c) => lastRect.set(c.key, this.nodes.get(c.key).getBoundingClientRect()));
    const hasKey = (k) => lastRect.has(k);

    const target = new Map(); // removed key -> key of chip that absorbs it
    for (const c of frame.chips) {
      (c.from || []).forEach((p) => { if (!target.has(p) && !hasKey(p)) target.set(p, c.key); });
      (c.absorb || []).forEach((p) => { if (!target.has(p)) target.set(p, c.key); });
    }

    const run = (el, kf, opt) => {
      const a = el.animate(kf, { duration: D, easing: EASE, fill: 'both', ...opt });
      anims.push(a);
      this.anims.push(a);
      return a;
    };

    let flyIdx = 0;
    frame.chips.forEach((c, n) => {
      const el = this.nodes.get(c.key);
      const l = lastRect.get(c.key);
      const delay = Math.min(n * 14, 420) / this.speed;
      if (!created.has(c.key)) {
        const f = first.get(c.key);
        if (!f) return;
        const dx = f.left - l.left, dy = f.top - l.top;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) run(el, [{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'translate(0,0)' }], { delay: Math.min(delay, 160 / this.speed) });
        else if (c.flag === 'changed' || c.flag === 'hit' || c.flag === 'new') run(el, [{ transform: 'scale(1.04)' }, { transform: 'scale(1)' }], { duration: D * 0.7 });
        return;
      }
      // new chip
      const parent = (c.from || []).map((p) => first.get(p)).find(Boolean);
      const srcRect = c.src && this.opts.srcRect ? this.opts.srcRect(c.src) : null;
      if (srcRect) {
        // clone flies from the real table row (position:fixed so no container clips it)
        const clone = el.cloneNode(true);
        clone.classList.add('fly');
        clone.style.cssText = `position:fixed;left:${srcRect.left}px;top:${srcRect.top}px;width:${srcRect.width}px;height:${srcRect.height}px;margin:0;z-index:60;overflow:hidden;`;
        document.body.appendChild(clone);
        this.clones.push(clone);
        el.style.visibility = 'hidden';
        const dly = Math.min(flyIdx++ * 22, 650) / this.speed;
        const a = clone.animate(
          [
            { left: `${srcRect.left}px`, top: `${srcRect.top}px`, width: `${srcRect.width}px`, height: `${srcRect.height}px`, opacity: 0.85 },
            { left: `${l.left}px`, top: `${l.top}px`, width: `${l.width}px`, height: `${l.height}px`, opacity: 1 },
          ],
          { duration: D * 1.35, delay: dly, easing: EASE, fill: 'both' },
        );
        anims.push(a);
        this.anims.push(a);
        a.finished.then(() => { clone.remove(); el.style.visibility = ''; }).catch(() => {});
      } else if (parent) {
        const dx = parent.left - l.left, dy = parent.top - l.top;
        run(el, [{ transform: `translate(${dx}px,${dy}px) scale(.92)`, opacity: 0 }, { transform: 'translate(0,0) scale(1)', opacity: 1 }], { delay: delay * 0.6 });
      } else {
        run(el, [{ transform: 'translateY(14px) scale(.9)', opacity: 0 }, { transform: 'translateY(0) scale(1)', opacity: 1 }], { delay });
      }
    });

    for (const [k, el] of removed) {
      const tk = target.get(k);
      const tr = tk ? lastRect.get(tk) : null;
      const f = first.get(k);
      if (tr) {
        const dx = tr.left - f.left, dy = tr.top - f.top;
        const a = run(el, [{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${dx}px,${dy}px) scale(.9)`, opacity: 0.0 }], { easing: 'ease-in', duration: D * 0.95 });
        a.finished.then(() => el.remove()).catch(() => {});
      } else {
        el.classList.add('dying');
        const spin = (k.length % 2 ? 1 : -1) * 4;
        const a = run(el, [
          { transform: 'translate(0,0) rotate(0)', opacity: 1, offset: 0 },
          { transform: 'translate(0,0) rotate(0)', opacity: 1, offset: 0.25 },
          { transform: `translate(${spin * 3}px,70px) rotate(${spin}deg)`, opacity: 0, offset: 1 },
        ], { easing: 'ease-in', duration: D * 1.05 });
        a.finished.then(() => el.remove()).catch(() => {});
      }
    }

    this.afterAnim(tok, anims);
  }

  afterAnim(tok, anims) {
    const done = () => {
      if (tok !== this.token) return;
      this.fx.replaceChildren();
      if (this.idx >= this.frames.length - 1) {
        this.finish();
        return;
      }
      if (this.playing) this.schedule(this.frames[this.idx].chips.length > 25 ? 850 : 1100);
    };
    if (!anims.length) { setTimeout(done, 30); return; }
    Promise.allSettled(anims.map((a) => a.finished)).then(done);
  }
}
