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
