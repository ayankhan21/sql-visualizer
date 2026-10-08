// Client for a lesson page: shows only the tables the lesson uses and auto-plays its query.
import { Database, referencedTables } from './sql/db.js';
import { TableStrip } from './ui/tables.js';
import { Editor } from './ui/editor.js';
import { Workbench } from './ui/workbench.js';

const $ = (s) => document.querySelector(s);
const cfg = JSON.parse(document.getElementById('lesson-data').textContent);

const db = new Database();

function usedTables(sql) {
  try {
    return new Set([...referencedTables(sql)].filter((n) => db.getTable(n)));
  } catch (e) {
    return null; // unparsable while editing: keep whatever is shown
  }
}

let only = usedTables(cfg.sql);
const strip = new TableStrip($('#strip'), db, { only });
const editor = new Editor($('#editor'), { db, value: cfg.sql, onRun: () => run(), minRows: 3, maxRows: 14 });
const wb = new Workbench({ db, strip, editor, outEl: $('#output'), defaultTab: 'physical', onChange: () => editor.paint() });

function run() {
  if (!$('#chk-all').checked) {
    const next = usedTables(editor.value);
    if (next && next.size) { only = next; strip.setOnly(only); }
  }
  wb.run(editor.value);
}

$('#btn-run').addEventListener('click', run);
$('#btn-reset').addEventListener('click', () => { wb.reset(); strip.setOnly($('#chk-all').checked ? null : only); run(); });
$('#btn-restore').addEventListener('click', () => { editor.value = cfg.sql; });
$('#chk-all').addEventListener('change', (e) => strip.setOnly(e.target.checked ? null : only));
$('#open-playground').addEventListener('click', (e) => {
  e.currentTarget.href = '../?q=' + encodeURIComponent(editor.value);
});

setTimeout(run, 450);
