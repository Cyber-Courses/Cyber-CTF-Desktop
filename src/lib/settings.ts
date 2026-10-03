/** Per-machine launcher preferences, kept locally. */

const ATTACK_IMAGE_KEY = "cyberctf.attackbox.image";

/**
 * Default attack box: a simple Kali base. Exegol is licensed (free for personal use,
 * paid for pro/commercial), so it's only an opt-in preset until we have the Exegol
 * team's go-ahead to bundle it.
 */
export const DEFAULT_ATTACK_IMAGE = "kalilinux/kali-rolling";

/** Common attack-box images; the field is free text so any tag/registry still works. */
export const ATTACK_PRESETS: { image: string; label: string; note: string }[] = [
  { image: "kalilinux/kali-rolling", label: "Kali", note: "Official Kali base, add tools as needed" },
  { image: "parrotsec/security", label: "Parrot", note: "Parrot Security toolset" },
  { image: "nwodtuhs/exegol:free", label: "Exegol Free", note: "Needs an Exegol license for pro/commercial use" },
  { image: "nwodtuhs/exegol:full", label: "Exegol Full", note: "Large, needs an Exegol license" },
];

export function getAttackImage(): string {
  try {
    return localStorage.getItem(ATTACK_IMAGE_KEY) || DEFAULT_ATTACK_IMAGE;
  } catch {
    return DEFAULT_ATTACK_IMAGE;
  }
}

export function setAttackImage(image: string) {
  try {
    localStorage.setItem(ATTACK_IMAGE_KEY, image.trim() || DEFAULT_ATTACK_IMAGE);
  } catch {
    /* ignore */
  }
}
