import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../public/js/sql/db.js';
import { LESSONS } from '../scripts/lessons-data.mjs';

test('there are exactly 50 lessons with unique slugs', () => {
  assert.equal(LESSONS.length, 50);
  assert.equal(new Set(LESSONS.map((l) => l.slug)).size, 50);
  const by = (lv) => LESSONS.filter((l) => l.level === lv).length;
  assert.deepEqual([by('beginner'), by('intermediate'), by('advanced')], [16, 18, 16]);
});

LESSONS.forEach((l, i) => {
  test(`lesson ${i + 1} (${l.slug}) runs and animates`, () => {
    const db = new Database();
    const res = db.exec(l.sql).at(-1);
    assert.ok(res.trace.frames.length >= 1, 'has frames');
    for (const f of res.trace.frames) {
      const keys = f.chips.map((c) => c.key);
      assert.equal(new Set(keys).size, keys.length, `unique chip keys in frame "${f.title}"`);
    }
    if (res.kind === 'select') assert.ok(res.rows.length > 0, 'returns rows');
  });
});
