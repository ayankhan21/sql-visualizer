// Trace = what the executor reports so the UI can animate it.
//
// A trace has `frames` (snapshots of "rows sitting on the stage") and `steps`
// (numbers for the Analyze view). The animator only needs to diff consecutive
// frames by chip key: same key => the chip slides, new key => it appears (from
// `src` table row or `from` parent chips), missing key => it falls away or merges.

export const MAX_CHIPS = 50;

export class Tracer {
  constructor() {
    this.frames = [];
    this.steps = [];
  }

  frame(f) {
    this.frames.push({ id: this.frames.length, layout: 'single', lanes: [], chips: [], hidden: 0, ...f });
  }

  step(s) {
    this.steps.push(s);
  }
}

export const rowKey = (r) => r.p.join('+');

export function capped(rows) {
  return rows.length > MAX_CHIPS ? rows.slice(0, MAX_CHIPS) : rows;
}

// chips for a plain relation (rows shaped {v,p,h})
export function relChips(rows, lane = 0, withSrc = false) {
  return capped(rows).map((r) => {
    const c = { key: rowKey(r), lane, vals: r.v, h: r.h };
    if (withSrc && r.h.length === 1) c.src = r.h[0];
    return c;
  });
}

export function laneCols(cols) {
  return cols.map((c) => ({ name: c.name, base: c.base || null, tbl: c.tbl || null, hidden: !!c.hidden }));
}
