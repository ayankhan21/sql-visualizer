// Table view (classic result grid) and the Analyze view (how the query actually executed).
import { fmt, esc } from '../sql/format.js';
import { tc } from './colors.js';

const MAX_SHOWN = 200;

export function renderTable(el, result, { onTrace } = {}) {
  if (!result) { el.innerHTML = '<p class="muted pad">Run a query to see its result here.</p>'; return; }
  if (result.kind === 'dml') {
    const ch = result.changes || {};
    el.innerHTML = `<div class="msg ok"><b>✓ ${esc(result.message)}</b>
      <p>${ch.schema && ch.schema.length ? 'The table structure changed.' : 'The tables above now reflect the change.'} Nothing is saved anywhere — <b>Reset</b> or a page refresh brings the original data back.</p></div>`;
    return;
  }
  const cols = result.columns;
  const rows = result.rows;
  const shown = rows.slice(0, MAX_SHOWN);
  const head = cols.map((c) => `<th class="${tc(c.base)}" title="${c.base ? 'from ' + esc(c.base) : 'computed'}">${esc(c.name)}</th>`).join('');
  const body = shown.map((r, i) => `<tr data-i="${i}">${r.v.map((v, k) => `<td class="${tc(cols[k].base)}${v === null || v === undefined ? ' null' : ''}">${esc(fmt(v))}</td>`).join('')}</tr>`).join('');
  el.innerHTML = `<div class="rt-wrap"><table class="rt"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td class="empty" colspan="${cols.length}">No rows</td></tr>`}</tbody></table></div>
    <footer class="rt-foot"><b>${rows.length}</b> row${rows.length === 1 ? '' : 's'} · ${cols.length} column${cols.length === 1 ? '' : 's'}${rows.length > MAX_SHOWN ? ` · showing the first ${MAX_SHOWN}` : ''}
    <span class="muted"> — click a row to trace it back to the source rows it came from</span></footer>`;
  el.querySelectorAll('tbody tr[data-i]').forEach((tr) => {
    tr.addEventListener('click', () => {
      el.querySelectorAll('tr.sel').forEach((x) => x.classList.remove('sel'));
      tr.classList.add('sel');
      if (onTrace) onTrace(rows[Number(tr.dataset.i)].h || []);
    });
  });
}

const CLAUSE_HELP = {
  FROM: 'Choose the starting table and read all of its rows.',
  JOIN: 'Combine each row with matching rows from another table.',
  WHERE: 'Filter individual rows: only rows where the condition is true survive.',
  'GROUP BY': 'Pool rows that share a value into buckets.',
  HAVING: 'Filter whole buckets using aggregated values.',
  SELECT: 'Finally compute the output columns (and window functions).',
  'ORDER BY': 'Sort the surviving rows.',
  LIMIT: 'Cut the sorted rows down to the requested slice.',
};

function stepKind(stage) {
  return /JOIN$/.test(stage) ? 'JOIN' : stage;
}

export function renderAnalyze(el, result) {
  if (!result) { el.innerHTML = '<p class="muted pad">Run a query to see how it was executed.</p>'; return; }
  if (result.kind === 'dml') {
    el.innerHTML = `<div class="msg"><b>Analyze works on SELECT queries.</b><p>This statement changed data (${esc(result.message)}). Switch to the Physical tab to watch what it did to the rows, then run a SELECT to see the effect.</p></div>`;
    return;
  }
  const steps = result.trace.steps;
  const sql = result.sql;
  const max = Math.max(1, ...steps.flatMap((s) => [s.rowsIn || 0, s.rowsOut || 0]));

  // ---- clause chips: written order, numbered by execution order
  let clauseHtml = '';
  if (result.clauses.length) {
    const used = new Set();
    const mainNo = (i) => steps.slice(0, i + 1).filter((x) => !x.scope).length;
    const numFor = (kind, nth = 0) => {
      let seen = -1;
      for (let i = 0; i < steps.length; i++) {
        if (!steps[i].scope && stepKind(steps[i].stage) === kind) { seen++; if (seen === nth) { used.add(i); return mainNo(i); } }
      }
      return null;
    };
    const parts = [];
    const joins = result.joins.slice().sort((a, b) => a.s - b.s);
    for (const c of result.clauses) {
      if (c.k === 'FROM' && joins.length) {
        const end = Math.min(c.e, joins[0].s);
        parts.push({ s: c.s, k: 'FROM', text: sql.slice(c.s, end), n: numFor('FROM') });
        joins.forEach((j, i) => parts.push({ s: j.s, k: 'JOIN', text: sql.slice(j.s, j.e), n: numFor('JOIN', i) }));
      } else parts.push({ s: c.s, k: c.k, text: sql.slice(c.s, c.e), n: numFor(c.k) });
    }
    parts.sort((a, b) => a.s - b.s);
    clauseHtml = `<div class="an-block"><h4>Written order → execution order</h4>
      <p class="muted">You write SQL top to bottom, but the database runs the clauses in a different order. The bubble on each clause is when it actually runs.</p>
      <div class="clauses">${parts.map((p) => `<div class="clause k-${p.k.replace(' ', '')}"><i>${p.n ?? '–'}</i><code>${esc(p.text.trim().replace(/\s+/g, ' '))}</code><small>${esc(CLAUSE_HELP[p.k] || '')}</small></div>`).join('')}</div></div>`;
  }

  // ---- funnel
  const stepHtml = steps.map((s, i) => {
    const delta = (s.rowsOut ?? 0) - (s.rowsIn ?? 0);
    const note = [];
    if (s.comparisons) note.push(`${s.comparisons.toLocaleString()} row pairs compared`);
    if (s.groups !== undefined) note.push(`${s.groups} group${s.groups === 1 ? '' : 's'}`);
    if (s.dropped) note.push(`${s.dropped} dropped`);
    const no = s.scope ? '·' : steps.slice(0, i + 1).filter((x) => !x.scope).length;
    return `<li class="step${s.scope ? ' scoped' : ''}"><span class="n">${no}</span>
      <div class="sbody"><div class="shead">${s.scope ? `<span class="scope-tag">${esc(s.scope)}</span>` : ''}<b>${esc(s.stage)}</b><code>${esc(s.detail || '')}</code></div>
      <div class="bars"><span class="bar in" style="width:${((s.rowsIn || 0) / max) * 100}%"></span><span class="bar out" style="width:${((s.rowsOut || 0) / max) * 100}%"></span></div>
      <div class="snums"><span>${s.rowsIn ?? '–'} → <b>${s.rowsOut ?? '–'}</b> rows</span>${delta ? `<span class="${delta < 0 ? 'neg' : 'pos'}">${delta > 0 ? '+' : ''}${delta}</span>` : ''}${note.length ? `<span class="note">${esc(note.join(' · '))}</span>` : ''}<span class="ms">${s.ms} ms</span></div></div></li>`;
  }).join('');

  // ---- insights
  const tips = [];
  const joinSteps = steps.filter((s) => /JOIN$/.test(s.stage));
  for (const s of joinSteps) {
    if (s.joinKind === 'cross') tips.push(`<b>CROSS JOIN</b> paired every row with every row (${s.comparisons} pairs). It multiplies rows — only use it when you really want every combination.`);
    else if (s.rowsOut > s.rowsIn * 1.5 && s.rowsIn) tips.push(`The <b>${esc(s.stage)}</b> grew the row count (${s.rowsIn} → ${s.rowsOut}). That's a one-to-many relationship: one row on the left matched several on the right.`);
    else if (s.rowsOut < s.rowsIn) tips.push(`The <b>${esc(s.stage)}</b> shrank the row count (${s.rowsIn} → ${s.rowsOut}): rows without a partner were dropped. A LEFT JOIN would keep them.`);
  }
  const where = steps.find((s) => s.stage === 'WHERE');
  if (where && where.rowsIn) {
    const pct = Math.round((where.dropped / where.rowsIn) * 100);
    tips.push(`<b>WHERE</b> removed ${pct}% of the rows early. Filtering early makes every later step (joins, grouping, sorting) cheaper.`);
  }
  const grp = steps.find((s) => s.stage === 'GROUP BY');
  if (grp) tips.push(`<b>GROUP BY</b> collapsed ${grp.rowsIn} rows into ${grp.rowsOut} bucket${grp.rowsOut === 1 ? '' : 's'}.`);
  if (/select\s+(distinct\s+)?\*/i.test(sql) && !/count\(\s*\*/i.test(sql)) tips.push('<b>SELECT *</b> reads every column. In real databases, naming just the columns you need is faster and safer.');
  const lim = steps.find((s) => s.stage === 'LIMIT');
  if (lim && !steps.some((s) => s.stage === 'ORDER BY')) tips.push('<b>LIMIT without ORDER BY</b> returns an arbitrary slice — add ORDER BY so "the first N" means something.');
  if (!result.rows.length && !result.explain) tips.push('The result is <b>empty</b>. Check the filter values and the join keys; watch each step above for the place where rows hit 0.');
  if (!steps.some((s) => /JOIN$/.test(s.stage)) && steps.find((s) => s.stage === 'FROM' && s.rowsIn > 30) && !where) tips.push('There is no WHERE filter, so every row of the table flows through the whole pipeline.');

  el.innerHTML = `<div class="analyze">${clauseHtml}
    <div class="an-block"><h4>Execution pipeline</h4>
      <p class="muted">Each step shows rows going in (pale bar) and coming out (solid bar). This is the same flow the Physical tab animates.</p>
      <ol class="steps">${stepHtml}</ol></div>
    ${tips.length ? `<div class="an-block"><h4>What to notice</h4><ul class="tips">${tips.map((t) => `<li>${t}</li>`).join('')}</ul></div>` : ''}</div>`;
}
