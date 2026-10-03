/** Per-machine launcher preferences, kept locally. */

const EXEGOL_KEY = "cyberctf.exegol.image";

export const DEFAULT_EXEGOL_IMAGE = "nwodtuhs/exegol:free";

/** Common Exegol images; the field is free text so any tag/registry still works. */
export const EXEGOL_PRESETS: { image: string; label: string; note: string }[] = [
  { image: "nwodtuhs/exegol:free", label: "Free", note: "Smallest full toolbox" },
  { image: "nwodtuhs/exegol:light", label: "Light", note: "Minimal, quickest to pull" },
  { image: "nwodtuhs/exegol:full", label: "Full", note: "Everything (very large)" },
  { image: "nwodtuhs/exegol:ad", label: "Active Directory", note: "AD-focused tooling" },
  { image: "nwodtuhs/exegol:web", label: "Web", note: "Web pentest tooling" },
];

export function getExegolImage(): string {
  try {
    return localStorage.getItem(EXEGOL_KEY) || DEFAULT_EXEGOL_IMAGE;
  } catch {
    return DEFAULT_EXEGOL_IMAGE;
  }
}

export function setExegolImage(image: string) {
  try {
    localStorage.setItem(EXEGOL_KEY, image.trim() || DEFAULT_EXEGOL_IMAGE);
  } catch {
    /* ignore */
  }
}
