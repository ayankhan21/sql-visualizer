// Each table owns one colour. Rows/cells that came from a table wear that colour everywhere
// (table strip, flying chips, result headers) so you can see where data came from.

let map = new Map();

export function syncPalette(db) {
  map = new Map(db.list().map((t) => [t.name.toLowerCase(), t.color]));
}

// css class for a base table name; `tcn` = neutral (computed / unknown source)
export function tc(base) {
  if (base === null || base === undefined) return 'tcn';
  const i = map.get(String(base).toLowerCase());
  return i === undefined ? 'tcn' : 'tc' + i;
}
