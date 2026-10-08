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
    this.shelves = []; // finished CTE / derived results waiting for the main query to use them
  }

  frame(f) {
    this.frames.push({ id: this.frames.length, layout: 'single', lanes: [], chips: [], hidden: 0, ...f });
  }

  step(s) {
    this.steps.push(s);
  }
}

export const rowKey = (r) => r.p.join('+');

// Finished CTE / derived-table results stay on stage (dashed "shelf" lane) until the first frame
// whose chips grow out of them — that frame's `from` links make the shelf chips fly into the query.
export function applyShelves(T) {
  for (const sh of T.shelves) {
    const start = sh.startIdx ?? sh.readyIdx + 1;
    let end = sh.endIdx;
    if (end === undefined) {
      const keys = new Set(sh.chips.map((c) => c.key));
      end = T.frames.length;
      for (let i = start; i < T.frames.length; i++) {
        if (T.frames[i].chips.some((c) => c.from && c.from.some((k) => keys.has(k)))) { end = i; break; }
      }
    }
    for (let i = start; i < Math.min(end, T.frames.length); i++) {
      const f = T.frames[i];
      if (f.final) continue;
      const lane = f.lanes.length;
      f.lanes.push({ label: sh.name, note: sh.note ?? 'ready · waiting', cols: sh.cols, shelf: true });
      sh.chips.forEach((c) => f.chips.push({ ...c, lane }));
    }
  }
}

export function capped(rows) {
  return rows.length > MAX_CHIPS ? rows.slice(0, MAX_CHIPS) : rows;
}

// chips for a plain relation (rows shaped {v,p,h})
export function relChips(rows, lane = 0, withSrc = false) {
  return capped(rows).map((r) => {
    const c = { key: rowKey(r), lane, vals: r.v, h: r.h };
    if (r.ck) c.from = [r.ck]; // row of a finished CTE / derived table: grows out of that result
    else if (withSrc && r.h.length === 1) c.src = r.h[0];
    return c;
  });
}

export function laneCols(cols) {
  return cols.map((c) => ({ name: c.name, base: c.base || null, tbl: c.tbl || null, hidden: !!c.hidden }));
}
