// Formatting shared across screens, so times and sizes read the same everywhere.

/** A running step's time: 0.4s, then 12s, then 1:05. */
export function formatDuration(ms: number) {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  return formatElapsed(ms);
}

/** Whole seconds: 42s, then 1:05. */
export function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago". */
export function formatAgo(at: number, now: number) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

const GB = 1e9;

/** 12 GB, 3.4 GB, 512 MB, 8 kB. */
export function formatBytes(b: number) {
  if (b >= GB) return `${(b / GB).toFixed(b >= 10 * GB ? 0 : 1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return `${Math.max(1, Math.round(b / 1e3))} kB`;
}

/** 3d 4h, 5h 12m, 42m. */
export function formatUptime(secs: number) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
