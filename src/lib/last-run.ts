/** Per-lab "last launched" timestamps, kept locally so rows can show recency. */

const KEY = (id: string) => `cyberctf.lastrun.${id}`;

export function setLastRun(id: string) {
  try {
    localStorage.setItem(KEY(id), String(Date.now()));
  } catch {
    /* ignore */
  }
}

export function getLastRun(id: string): number | null {
  try {
    const v = localStorage.getItem(KEY(id));
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

export function formatAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
