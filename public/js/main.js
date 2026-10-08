// Home page: editor + tables on top, output (Physical / Table / Analyze) below.
import { Database } from './sql/db.js';
import { TableStrip } from './ui/tables.js';
import { Editor } from './ui/editor.js';
import { Workbench } from './ui/workbench.js';
import { TableBuilder } from './ui/builder.js';
import { tc } from './ui/colors.js';
import { esc } from './sql/format.js';
import { loadHistory, addHistory } from './ui/history.js';

const $ = (s) => document.querySelector(s);

const DEFAULT_SQL = `SELECT c.name, o.id AS order_id, o.status
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'delivered'
ORDER BY c.name
LIMIT 8;`;

const EXAMPLES = [
  ['Basics', [
    ['Pick columns', 'SELECT name, city FROM customers;'],
    ['Filter rows (WHERE)', "SELECT name, price FROM products\nWHERE price > 50 AND stock > 40\nORDER BY price DESC;"],
    ['Count per group', 'SELECT country, COUNT(*) AS customers\nFROM customers\nGROUP BY country\nORDER BY customers DESC;'],
  ]],
  ['Joins', [
    ['INNER JOIN', 'SELECT c.name, o.id, o.order_date\nFROM customers c\nINNER JOIN orders o ON o.customer_id = c.id\nORDER BY o.id\nLIMIT 10;'],
    ['LEFT JOIN (keep unmatched)', 'SELECT c.name, o.id AS order_id\nFROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id\nWHERE o.id IS NULL;'],
    ['RIGHT JOIN', 'SELECT d.name AS department, e.name AS employee\nFROM employees e\nRIGHT JOIN departments d ON e.dept_id = d.id\nORDER BY d.name;'],
    ['Self join (employee → manager)', 'SELECT e.name AS employee, m.name AS manager\nFROM employees e\nLEFT JOIN employees m ON e.manager_id = m.id;'],
    ['3 tables', 'SELECT c.name AS customer, p.name AS product, oi.quantity\nFROM order_items oi\nJOIN orders o ON oi.order_id = o.id\nJOIN customers c ON o.customer_id = c.id\nJOIN products p ON oi.product_id = p.id\nLIMIT 12;'],
  ]],
  ['Grouping & flow', [
    ['Revenue per category (HAVING)', 'SELECT cat.name AS category, SUM(oi.quantity * oi.unit_price) AS revenue\nFROM order_items oi\nJOIN products p ON oi.product_id = p.id\nJOIN categories cat ON p.category_id = cat.id\nGROUP BY cat.name\nHAVING SUM(oi.quantity * oi.unit_price) > 200\nORDER BY revenue DESC;'],
  ]],
  ['Advanced', [
    ['Subquery', 'SELECT name, price FROM products\nWHERE price > (SELECT AVG(price) FROM products);'],
    ['CTE', 'WITH big_orders AS (\n  SELECT order_id, SUM(quantity * unit_price) AS total\n  FROM order_items GROUP BY order_id\n)\nSELECT * FROM big_orders WHERE total > 150 ORDER BY total DESC;'],
    ['Window: RANK', 'SELECT name, dept_id, salary,\n  RANK() OVER (PARTITION BY dept_id ORDER BY salary DESC) AS rank_in_dept\nFROM employees;'],
    ['Recursive CTE (org chart)', 'WITH RECURSIVE chain(id, name, depth) AS (\n  SELECT id, name, 0 FROM employees WHERE manager_id IS NULL\n  UNION ALL\n  SELECT e.id, e.name, chain.depth + 1\n  FROM employees e JOIN chain ON e.manager_id = chain.id\n)\nSELECT * FROM chain ORDER BY depth, name;'],
  ]],
  ['Change data', [
    ['INSERT', "INSERT INTO categories (name) VALUES ('Pets');"],
    ['UPDATE', 'UPDATE products SET price = price * 1.1 WHERE category_id = 1;'],
    ['DELETE', "DELETE FROM orders WHERE status = 'cancelled';"],
    ['ALTER TABLE', 'ALTER TABLE customers ADD COLUMN vip BOOLEAN;'],
  ]],
];

const db = new Database();
const strip = new TableStrip($('#strip'), db, { reorder: true });
const editor = new Editor($('#editor'), { db, value: DEFAULT_SQL, onRun: () => run(), minRows: 3, maxRows: 7, placeholder: 'Write SQL here…  (Ctrl + Enter to run)' });
const builder = new TableBuilder({ db, onChange: () => { strip.render(); editor.paint(); updateCount(); } });

const wb = new Workbench({ db, strip, editor, outEl: $('#output'), runBtn: $('#btn-run'), defaultTab: 'physical', onChange: () => { updateCount(); editor.paint(); } });

function updateCount() {
  const n = db.list().length;
  $('#tcount').textContent = `${n} / ${db.limits.maxTables} tables`;
  $('#btn-create').textContent = db.customTable() ? '✎ Your table' : '＋ Create table';
}

function run() {
  if (wb.run(editor.value)) renderHistory(addHistory(editor.value));
}

// ---- query history (clock button): fills the editor, never runs by itself
const histBtn = $('#btn-history');
const histMenu = $('#history-menu');
function renderHistory(items = loadHistory()) {
  histMenu.innerHTML = items.length
    ? items.map((q, i) => `<li><button role="menuitem" data-i="${i}" title="${esc(q)}">${esc(q.replace(/\s+/g, ' '))}</button></li>`).join('')
    : '<li class="empty">No queries yet — run one and it shows up here.</li>';
  histMenu._items = items;
}
function toggleHistory(open) {
  histMenu.hidden = !open;
  histBtn.setAttribute('aria-expanded', String(open));
}
histBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleHistory(histMenu.hidden); });
histMenu.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  editor.value = histMenu._items[Number(b.dataset.i)];
  toggleHistory(false);
  editor.focus();
});
document.addEventListener('click', (e) => { if (!e.target.closest('.hist')) toggleHistory(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleHistory(false); });
renderHistory();

$('#btn-run').addEventListener('click', () => run());
$('#btn-reset').addEventListener('click', () => {
  wb.reset();
  editor.value = DEFAULT_SQL;
  updateCount();
});
$('#btn-create').addEventListener('click', () => builder.open());
$('#btn-clear').addEventListener('click', () => strip.clearHighlight());

const sel = $('#examples');
sel.innerHTML = '<option value="">Try an example…</option>' + EXAMPLES.map(([g, items]) => `<optgroup label="${esc(g)}">${items.map(([label, sql]) => `<option value="${esc(sql)}">${esc(label)}</option>`).join('')}</optgroup>`).join('');
sel.addEventListener('change', () => {
  if (!sel.value) return;
  editor.value = sel.value; // picking an example only fills the editor; press Run to execute it
  sel.value = '';
  editor.focus();
});

// ---- relations dialog
const relDlg = $('#relations');
$('#btn-relations').addEventListener('click', () => {
  const rels = db.relations();
  relDlg.querySelector('.rel-list').innerHTML = rels.map((r) => {
    const [tt, tcol] = r.to.split('.');
    return `<li><span class="pill ${tc(r.from)}">${esc(r.from)}.${esc(r.col)}</span><span class="arrow">→</span><span class="pill ${tc(tt)}">${esc(tt)}.${esc(tcol)}</span></li>`;
  }).join('');
  relDlg.showModal();
});
relDlg.addEventListener('click', (e) => { if (e.target === relDlg || e.target.closest('[data-close]')) relDlg.close(); });

const shared = new URLSearchParams(location.search).get('q'); // "Open in playground" from a lesson
if (shared) editor.value = shared;

updateCount();
// nothing runs on page load: a query runs only from the Run button or Ctrl+Enter
