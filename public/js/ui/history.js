// Last few successfully-run queries, kept in sessionStorage so a hard refresh keeps them
// (and closing the tab clears them).
const KEY = 'sqlviz.history.v1';
export const MAX_HISTORY = 5;

export function loadHistory() {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX_HISTORY) : [];
  } catch (e) {
    return []; // storage blocked or corrupt: behave as empty
  }
}

export function addHistory(sql) {
  const q = sql.trim();
  if (!q) return loadHistory();
  const next = [q, ...loadHistory().filter((x) => x !== q)].slice(0, MAX_HISTORY);
  try { sessionStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* storage full/blocked: ignore */ }
  return next;
}
