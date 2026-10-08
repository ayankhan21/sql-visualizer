# SQL Visualizer

Learn SQL by **watching real table rows move**. Rows fly out of their tables, merge when joined, fall away when filtered, and settle into the result. No backend: it is a static site served by a Cloudflare Worker.

**Live:** https://sql-visualizer.pact-ayan.workers.dev
**Lessons:** https://sql-visualizer.pact-ayan.workers.dev/lessons/

## What you get

- **Playground** (`/`): SQL editor on top, ten related tables beneath it, and the output area below. The output has three tabs:
  - **Physical**: the actual rows animate through each stage (FROM → JOIN → WHERE → GROUP BY → HAVING → SELECT → ORDER BY → LIMIT). Play, pause, step and change speed.
  - **Table**: the classic result grid. Click a row to see which source rows it came from.
  - **Analyze**: each clause numbered by when it really runs, row counts at every step, and notes on what to notice.
- **10 pre-populated tables** with foreign keys (customers, orders, order_items, products, categories, suppliers, employees, departments, reviews, shipments). Each table has its own colour, and its rows and cells keep it everywhere. Every table has at most 50 rows.
- **Query history**: the clock button beside Reset lists your last 5 successful queries (kept in `sessionStorage`, so a hard refresh keeps them and closing the tab clears them). Picking one fills the editor without running it.
- **Editable data**: INSERT, UPDATE, DELETE and ALTER work on the tables. Nothing is saved, so **Reset** or a hard refresh restores the original data.
- **One extra table**: create it with `CREATE TABLE` or the "Create table" form (11 tables maximum).
- **50 lessons** (16 beginner, 18 intermediate, 16 advanced) as individual static pages. Each auto-plays its query, and you can edit and re-run it.

## SQL supported

SELECT with DISTINCT, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT/OFFSET; INNER, LEFT, RIGHT, FULL and CROSS joins (and self joins); subqueries (IN, EXISTS, scalar, correlated, derived tables); CTEs including `WITH RECURSIVE`; UNION / INTERSECT / EXCEPT; CASE; window functions (ROW_NUMBER, RANK, DENSE_RANK, NTILE, LAG, LEAD, FIRST/LAST_VALUE, aggregates with frames); common scalar functions; INSERT, UPDATE, DELETE, CREATE TABLE, ALTER TABLE, DROP TABLE (your own table only), EXPLAIN.

Subqueries and CTEs are not animated step by step. The outer query is animated with their result already applied.

## How it works

The SQL engine is written from scratch (no SQL library) because the animation needs to know which rows moved where. While a query executes, the executor records a **trace**: a list of frames, each a set of row "chips" with identity keys. The animator diffs consecutive frames (FLIP technique with the Web Animations API):

- same key → the chip slides to its new place
- new chip with a source → a clone flies out of the real table row in the strip
- new chip with parents → it grows out of the rows that merged into it (a join or aggregate)
- removed chip → it merges into the row that absorbed it, or falls away

## Project layout

```
public/
  index.html, 404.html
  css/app.css
  js/sql/     tokenizer, parser, exec (query executor + traces), db, seed
  js/ui/      stage (animator), tables, editor, results, workbench, builder
  js/main.js  playground      js/lesson.js  lesson pages
  lessons/    generated static pages (do not edit by hand)
scripts/
  lessons-data.mjs   the 50 lessons (content + queries)
  build-lessons.mjs  generates public/lessons/*
test/                engine tests + every lesson query
wrangler.jsonc       Worker config (static assets from ./public)
```

## Commands

```
npm install
npm test                 # engine tests + all 50 lessons
npm run build:lessons    # regenerate public/lessons/* after editing lessons-data.mjs
npm run dev              # local at http://localhost:8787 (wrangler dev)
npm run deploy           # build lessons, then wrangler deploy
```

## Deploying

Authenticate once with `npx wrangler login`, then `npm run deploy`. The Worker name is `name` in `wrangler.jsonc` (currently `sql-visualizer`), which also decides the `*.workers.dev` URL. To use a custom domain, add a `routes` entry or attach one in the Cloudflare dashboard.

## Adding or changing a lesson

Edit `scripts/lessons-data.mjs`, run `npm run build:lessons` and `npm test` (the tests run every lesson query), then deploy.
