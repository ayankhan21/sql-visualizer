import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../public/js/sql/db.js';

const run = (db, sql) => db.exec(sql).at(-1);
const rows = (db, sql) => run(db, sql).rows.map((r) => r.v);
const one = (db, sql) => rows(db, sql)[0][0];

test('seed: >= 10 tables, each <= 50 rows, foreign keys are valid', () => {
  const db = new Database();
  assert.ok(db.list().length >= 10);
  for (const t of db.list()) assert.ok(t.rows.length <= 50, `${t.name} has ${t.rows.length} rows`);
  for (const t of db.list()) {
    t.cols.forEach((c, ci) => {
      if (!c.fk) return;
      const [tt, tc] = c.fk.split('.');
      const target = db.getTable(tt);
      const ti = target.cols.findIndex((x) => x.name === tc);
      const ids = new Set(target.rows.map((r) => r.v[ti]));
      for (const r of t.rows) if (r.v[ci] !== null) assert.ok(ids.has(r.v[ci]), `${t.name}.${c.name}=${r.v[ci]} has no parent in ${c.fk}`);
    });
  }
});

test('joins: inner / left / right / full / cross', () => {
  const db = new Database();
  assert.equal(one(db, 'SELECT COUNT(*) FROM customers c JOIN orders o ON o.customer_id = c.id'), 40);
  assert.equal(one(db, 'SELECT COUNT(*) FROM customers c LEFT JOIN orders o ON o.customer_id = c.id'), 42);
  assert.deepEqual(rows(db, 'SELECT c.name FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE o.id IS NULL ORDER BY 1'), [['Sam Carter'], ['Tara Brooks']]);
  assert.equal(one(db, 'SELECT COUNT(*) FROM employees e RIGHT JOIN departments d ON e.dept_id = d.id'), 21);
  assert.equal(one(db, 'SELECT COUNT(*) FROM categories CROSS JOIN suppliers'), 36);
  const full = rows(db, 'SELECT d.name, e.name FROM departments d FULL JOIN employees e ON e.dept_id = d.id AND e.salary > 150000');
  assert.ok(full.some((r) => r[0] !== null && r[1] === null), 'department-only rows');
  assert.ok(full.some((r) => r[0] === null && r[1] !== null), 'employee-only rows');
});

test('self join needs aliases; duplicate alias is an error', () => {
  const db = new Database();
  assert.equal(one(db, 'SELECT COUNT(*) FROM employees e JOIN employees m ON e.manager_id = m.id'), 19);
  assert.throws(() => db.exec('SELECT * FROM employees JOIN employees ON 1 = 1'), /appears twice/);
});

test('NULL semantics', () => {
  const db = new Database();
  assert.equal(one(db, 'SELECT COUNT(*) FROM customers WHERE email = NULL'), 0);
  assert.equal(one(db, 'SELECT COUNT(*) FROM customers WHERE email IS NULL'), 1);
  assert.equal(one(db, 'SELECT COUNT(email) FROM customers'), 19);
  assert.equal(one(db, "SELECT COALESCE(email, 'x') FROM customers WHERE id = 19"), 'x');
  assert.equal(rows(db, 'SELECT 1 WHERE NULL IN (1, 2)').length, 0, 'NULL IN (...) is not true');
});

test('GROUP BY / HAVING / aggregates / strict grouping', () => {
  const db = new Database();
  assert.deepEqual(rows(db, "SELECT country, COUNT(*) FROM customers WHERE country IN ('USA','India') GROUP BY country ORDER BY country"), [['India', 2], ['USA', 3]]);
  assert.equal(rows(db, 'SELECT country FROM customers GROUP BY country HAVING COUNT(*) > 1').length, 2);
  assert.throws(() => db.exec('SELECT name, COUNT(*) FROM customers'), /GROUP BY/);
  assert.throws(() => db.exec('SELECT * FROM customers WHERE COUNT(*) > 1'), /HAVING/);
  assert.equal(one(db, 'SELECT COUNT(*) FROM orders WHERE id < 0'), 0);
  assert.equal(one(db, 'SELECT SUM(id) FROM orders WHERE id < 0'), null);
});

test('ORDER BY / LIMIT / DISTINCT', () => {
  const db = new Database();
  assert.deepEqual(rows(db, 'SELECT id FROM products ORDER BY price DESC LIMIT 2 OFFSET 1').map((r) => r[0]), [4, 10]);
  assert.equal(rows(db, 'SELECT DISTINCT country FROM customers').length, 17);
  assert.deepEqual(rows(db, 'SELECT name FROM employees ORDER BY manager_id, id LIMIT 1'), [['Maya Chen']], 'NULLs sort first ascending');
});

test('subqueries, CTE, recursive CTE, set operations', () => {
  const db = new Database();
  assert.equal(rows(db, 'SELECT name FROM customers WHERE id NOT IN (SELECT customer_id FROM orders)').length, 2);
  assert.equal(rows(db, 'SELECT c.name FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)').length, 18);
  assert.equal(one(db, 'WITH t AS (SELECT id FROM orders WHERE id <= 5) SELECT COUNT(*) FROM t'), 5);
  const depth = rows(db, 'WITH RECURSIVE c(id, d) AS (SELECT id, 0 FROM employees WHERE manager_id IS NULL UNION ALL SELECT e.id, c.d + 1 FROM employees e JOIN c ON e.manager_id = c.id) SELECT MAX(d) FROM c');
  assert.equal(depth[0][0], 3); // CEO -> CTO -> Eng manager -> engineers
  assert.deepEqual(rows(db, 'SELECT city FROM customers INTERSECT SELECT location FROM departments ORDER BY 1'), [['Chicago'], ['New York']]);
  assert.equal(rows(db, 'SELECT name FROM customers UNION SELECT name FROM customers').length, 20);
  assert.equal(rows(db, 'SELECT name FROM customers UNION ALL SELECT name FROM customers').length, 40);
});

test('window functions', () => {
  const db = new Database();
  const rn = rows(db, 'SELECT id, ROW_NUMBER() OVER (ORDER BY salary DESC) FROM employees ORDER BY 2 LIMIT 2');
  assert.deepEqual(rn, [[1, 1], [2, 2]]);
  const rk = rows(db, 'SELECT rating, RANK() OVER (ORDER BY rating DESC), DENSE_RANK() OVER (ORDER BY rating DESC) FROM reviews ORDER BY 2, 3');
  const maxRank = Math.max(...rk.map((r) => r[1])), maxDense = Math.max(...rk.map((r) => r[2]));
  assert.ok(maxRank > maxDense, 'RANK skips after ties, DENSE_RANK does not');
  const q = rows(db, 'SELECT quantity, SUM(quantity) OVER (ORDER BY id) FROM order_items WHERE id <= 3 ORDER BY id');
  assert.deepEqual(q.map((r) => r[1]), [q[0][0], q[0][0] + q[1][0], q[0][0] + q[1][0] + q[2][0]]);
  const mv = rows(db, 'SELECT id, AVG(id) OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) FROM order_items WHERE id <= 4 ORDER BY id');
  assert.deepEqual(mv.map((r) => r[1]), [1, 1.5, 2, 3]);
  const lag = rows(db, 'SELECT id, LAG(id) OVER (ORDER BY id) FROM departments ORDER BY id');
  assert.deepEqual(lag[0], [1, null]);
  assert.deepEqual(lag[1], [2, 1]);
});

test('DML + DDL, limits and reset', () => {
  const db = new Database();
  assert.equal(run(db, "INSERT INTO categories (name) VALUES ('Pets')").affected, 1);
  assert.equal(one(db, "SELECT id FROM categories WHERE name = 'Pets'"), 7);
  assert.equal(run(db, 'UPDATE products SET price = price * 2 WHERE id = 1').affected, 1);
  assert.equal(run(db, "DELETE FROM orders WHERE status = 'cancelled'").affected, 8);
  run(db, 'ALTER TABLE departments ADD COLUMN head TEXT');
  assert.equal(db.getTable('departments').cols.length, 5);
  run(db, 'ALTER TABLE departments RENAME COLUMN head TO boss');
  run(db, 'ALTER TABLE departments DROP COLUMN boss');
  assert.equal(db.getTable('departments').cols.length, 4);
  assert.throws(() => db.exec("INSERT INTO categories (id, name) VALUES (1, 'dup')"), /Duplicate id/);
  // 50-row cap: orders has 32 after the delete; adding 20 more must fail and leave the data intact
  const vals = Array.from({ length: 20 }, (_, i) => `(${100 + i}, 1, 10, '2025-01-01', 'pending')`).join(',');
  assert.throws(() => db.exec(`INSERT INTO orders VALUES ${vals}`), /at most 50 rows/);
  db.reset();
  assert.equal(one(db, 'SELECT COUNT(*) FROM orders'), 40);
  assert.equal(one(db, 'SELECT COUNT(*) FROM categories'), 6);
  assert.equal(db.getTable('departments').cols.length, 4);
});

test('a failing statement rolls back the whole batch', () => {
  const db = new Database();
  assert.throws(() => db.exec("INSERT INTO categories (name) VALUES ('A'); SELECT * FROM nope"), /does not exist/);
  assert.equal(one(db, 'SELECT COUNT(*) FROM categories'), 6);
});

test('exactly one extra table is allowed (11 total)', () => {
  const db = new Database();
  run(db, 'CREATE TABLE notes (id INT, text TEXT)');
  assert.equal(db.list().length, 11);
  assert.throws(() => db.exec('CREATE TABLE more (id INT)'), /only 1 extra table/);
  assert.throws(() => db.exec('DROP TABLE orders'), /built-in/);
  run(db, "INSERT INTO notes (text) VALUES ('hi')");
  assert.equal(one(db, 'SELECT COUNT(*) FROM notes n JOIN notes m ON n.id = m.id'), 1);
  run(db, 'DROP TABLE notes');
  assert.equal(db.list().length, 10);
});

test('errors carry a position and are readable', () => {
  const db = new Database();
  assert.throws(() => db.exec('SELECT nme FROM customers'), /Unknown column "nme"/);
  try { db.exec('SELECT * FROM customers WHERE'); assert.fail(); } catch (e) { assert.equal(e.name, 'SqlError'); assert.ok(e.pos >= 0); }
  assert.throws(() => db.exec('SELECT id FROM orders o JOIN customers c ON o.customer_id = c.id'), /ambiguous/);
});

test('trace: FROM chips fly from table rows, joins merge parents, WHERE drops rows', () => {
  const db = new Database();
  const r = run(db, "SELECT c.name FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.status = 'pending'");
  assert.deepEqual(r.trace.frames.map((f) => f.stage), ['FROM', 'JOIN', 'JOIN', 'WHERE', 'SELECT', 'RESULT']);
  const joined = r.trace.frames[2];
  assert.ok(joined.chips.every((c) => c.from && c.from.length === 2), 'every merged chip lists its two parents');
  assert.ok(r.trace.frames[3].chips.length < joined.chips.length);
  assert.ok(r.trace.frames[0].chips.every((c) => c.src && c.src.startsWith('customers#')));
});
