// Generates the 50 static lesson pages + the lessons index into public/lessons/.
//   node scripts/build-lessons.mjs
import { readdirSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LESSONS, LEVELS } from './lessons-data.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'lessons');
mkdirSync(outDir, { recursive: true });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const file = (i) => `${pad(i + 1)}-${LESSONS[i].slug}`;
const strip = (html) => html.replace(/<[^>]+>/g, '');
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%234f46e5'/%3E%3Crect x='6' y='8' width='9' height='5' rx='2' fill='%23fff'/%3E%3Crect x='17' y='13' width='9' height='5' rx='2' fill='%23fcd34d'/%3E%3Crect x='6' y='19' width='9' height='5' rx='2' fill='%2386efac'/%3E%3C/svg%3E";

const topbar = `<header class="topbar">
    <a class="brand" href="../"><span class="logo"><i></i><i></i><i></i></span> SQL Visualizer</a>
    <nav><a href="./">📚 All lessons</a><a href="../">▶ Playground</a></nav>
  </header>`;

function page(i) {
  const l = LESSONS[i];
  const prev = LESSONS[i - 1], next = LESSONS[i + 1];
  const lvl = LEVELS[l.level].name;
  const data = JSON.stringify({ n: i + 1, slug: l.slug, sql: l.sql }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(l.title)} · SQL lesson ${i + 1}/50 — SQL Visualizer</title>
  <meta name="description" content="${esc(l.blurb)} Watch the query's rows move, filter and join — SQL lesson ${i + 1} of 50 (${lvl})." />
  <link rel="icon" href="${FAVICON}" />
  <link rel="stylesheet" href="../css/app.css" />
</head>
<body class="lesson-page">
  ${topbar}
  <main class="app">
    <div class="lesson">
      <aside class="panel lesson-side">
        <div class="crumbs"><span class="lvl ${l.level}">${lvl}</span><span>Lesson ${i + 1} of ${LESSONS.length}</span></div>
        <div class="lesson-progress"><i style="width:${Math.round(((i + 1) / LESSONS.length) * 100)}%"></i></div>
        <h1>${esc(l.title)}</h1>
        <p class="muted">${esc(l.blurb)}</p>
        <h2>The idea</h2>
        ${l.concept}
        <h2>What to watch</h2>
        <ul>${l.watch.map((w) => `<li>${w}</li>`).join('')}</ul>
        ${l.tip ? `<div class="callout tip"><b>Tip.</b> ${l.tip}</div>` : ''}
        ${l.warn ? `<div class="callout warn"><b>Careful.</b> ${l.warn}</div>` : ''}
        <div class="callout"><b>Your turn.</b> The query is live — edit it and press <b>Run</b>. Colours tell you which table each cell came from. Use <b>Reset data</b> to undo any INSERT / UPDATE / DELETE.</div>
        <nav class="lesson-nav">
          ${prev ? `<a href="${file(i - 1)}"><small>← Previous</small>${esc(prev.title)}</a>` : '<a href="./"><small>← All lessons</small>Lesson index</a>'}
          ${next ? `<a class="next" href="${file(i + 1)}"><small>Next →</small>${esc(next.title)}</a>` : '<a class="next" href="../"><small>You finished! →</small>Open the playground</a>'}
        </nav>
      </aside>

      <div class="lesson-main">
        <div class="panel editor-panel">
          <div class="toolbar">
            <button class="btn primary" id="btn-run" title="Ctrl/⌘ + Enter">▶ Run</button>
            <button class="btn" id="btn-reset" title="Restore all tables, then replay">↺ Reset data &amp; replay</button>
            <button class="btn" id="btn-restore" title="Put the lesson's original query back">Original query</button>
            <span class="spacer"></span>
            <label class="muted" style="display:flex;gap:6px;align-items:center;font-size:12.5px"><input type="checkbox" id="chk-all" /> show all tables</label>
            <a class="btn" id="open-playground" href="../">Open in playground ↗</a>
          </div>
          <div id="editor"></div>
        </div>
        <div class="panel tables-panel">
          <div class="panel-head"><h2>Tables used</h2><span class="hint">Every row wears its table's colour.</span></div>
          <div id="strip"></div>
        </div>
        <section class="panel output-panel"><div id="output"></div></section>
      </div>
    </div>
    <noscript><p class="pad">This lesson animates SQL with JavaScript — please enable it.</p></noscript>
  </main>
  <script type="application/json" id="lesson-data">${data}</script>
  <script type="module" src="../js/lesson.js"></script>
</body>
</html>
`;
}

function index() {
  const blocks = Object.entries(LEVELS).map(([key, lv]) => {
    const cards = LESSONS.map((l, i) => [l, i]).filter(([l]) => l.level === key)
      .map(([l, i]) => `<a class="lcard ${key}" href="${file(i)}"><span class="no">${i + 1}</span><span><b>${esc(l.title)}</b><small>${esc(l.blurb)}</small></span></a>`).join('\n      ');
    const count = LESSONS.filter((l) => l.level === key).length;
    return `<section class="lvl-block"><h2><span class="lvl ${key}">${lv.name}</span> ${count} lessons</h2><p>${esc(lv.blurb)}</p><div class="cards">
      ${cards}
    </div></section>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>50 SQL lessons — SQL Visualizer</title>
  <meta name="description" content="50 animated SQL lessons from SELECT to window functions. Watch real table rows move, join and filter." />
  <link rel="icon" href="${FAVICON}" />
  <link rel="stylesheet" href="../css/app.css" />
</head>
<body>
  ${topbar}
  <main class="app">
    <div class="hero"><h1>50 SQL lessons you can watch</h1><p>Every lesson runs a real query on a small shop database and animates the rows: they fly out of their tables, join, fall away when filtered, and settle into the result. Start at 1 or jump to what you need.</p></div>
    ${blocks}
  </main>
</body>
</html>
`;
}

for (const f of readdirSync(outDir)) if (/^\d\d-.*\.html$/.test(f) || f === 'index.html') unlinkSync(join(outDir, f));
LESSONS.forEach((_, i) => writeFileSync(join(outDir, `${file(i)}.html`), page(i)));
writeFileSync(join(outDir, 'index.html'), index());
console.log(`wrote ${LESSONS.length} lessons + index to public/lessons/`);
void strip;
