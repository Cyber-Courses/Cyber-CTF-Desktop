/** Whether this machine has enough RAM to run labs comfortably. */

export type RamLevel = "ok" | "tight" | "low";

export interface Capacity {
  level: RamLevel;
  totalGB: number;
  title: string;
  detail: string;
}

/**
 * Judge lab capacity from total RAM. Container labs plus Docker Desktop and a full
 * Exegol image want headroom; multi-VM labs want more. Rough bands:
 *  - >= 16 GB: comfortable
 *  - 8-16 GB: fine for container labs, heavy VM/full-image labs may be slow
 *  - < 8 GB: likely to struggle
 */
export function assessRam(memTotalBytes: number): Capacity {
  const totalGB = memTotalBytes / 1e9;
  if (totalGB >= 16)
    return { level: "ok", totalGB, title: "Ready for labs", detail: "Plenty of RAM for container labs and most VM labs." };
  if (totalGB >= 8)
    return { level: "tight", totalGB, title: "Enough for container labs", detail: "Heavy multi-VM labs or the full Exegol image may run slowly here." };
  return { level: "low", totalGB, title: "Low on RAM for labs", detail: "Labs may struggle on this machine. For heavier labs, run them in the cloud or on a home lab." };
}
