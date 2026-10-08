// Value formatting shared by the engine (string concatenation) and the UI.

export function fmtNum(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  // trim floating point noise (0.1 + 0.2 -> 0.3) but keep real decimals
  return String(Math.round(n * 1e6) / 1e6);
}

export function fmt(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
