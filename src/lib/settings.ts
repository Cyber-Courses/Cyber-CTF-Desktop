import type { Provider } from "@/lib/tauri";

/** Per-machine launcher preferences, kept locally. */

const ATTACK_IMAGE_KEY = "cyberctf.attackbox.image";

/**
 * Default attack box: the Cyber CTF image (Kali with its standard toolset, published to
 * Docker Hub by the attack-box workflow). Exegol is licensed (free for personal use, paid
 * for pro/commercial), so it's only an opt-in preset.
 */
export const DEFAULT_ATTACK_IMAGE = "cyberctf/attack-box";

/** Common attack-box images; the field is free text so any tag/registry still works. */
/** `terms`: a short usage condition shown as a badge (e.g. Exegol's plan requirements).
 *  `large`: shown as "Large download" only when Docker Hub gives no size for the image. */
export const ATTACK_PRESETS: { image: string; label: string; note: string; large?: boolean; terms?: string }[] = [
  { image: "cyberctf/attack-box", label: "Cyber CTF", note: "Kali with its standard toolset, ready to use", large: true },
  { image: "kalilinux/kali-rolling", label: "Kali", note: "Official Kali base, add tools as needed" },
  { image: "parrotsec/security", label: "Parrot", note: "Parrot Security toolset" },
  {
    image: "nwodtuhs/exegol:free",
    label: "Exegol Free",
    note: "Exegol Community: full toolkit, updated after Full; for learning and personal use",
    terms: "Non-commercial use",
  },
  {
    image: "nwodtuhs/exegol:full",
    label: "Exegol Full",
    note: "The latest Exegol toolkit; needs an Exegol Pro, Team or Enterprise plan",
    large: true,
    terms: "Paid plan",
  },
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

const VM_PROVIDER_KEY = "cyberctf.vm.provider";

/** The hypervisor VM labs (and the VM test) run on, when several are installed. Null = automatic. */
export function getVmProvider(): Provider | null {
  try {
    return (localStorage.getItem(VM_PROVIDER_KEY) as Provider | null) || null;
  } catch {
    return null;
  }
}

export function setVmProvider(provider: Provider | null) {
  try {
    if (provider) localStorage.setItem(VM_PROVIDER_KEY, provider);
    else localStorage.removeItem(VM_PROVIDER_KEY);
  } catch {
    /* ignore */
  }
}

const TEST_KEY = "cyberctf.selftest.";

/** The last setup self-test result per kind, so the Machine page can show "tested 2 days ago". */
export interface LastTest {
  result: "ok" | "fail";
  at: number;
}

export function getLastTest(kind: "docker" | "vm"): LastTest | null {
  try {
    const raw = localStorage.getItem(TEST_KEY + kind);
    return raw ? (JSON.parse(raw) as LastTest) : null;
  } catch {
    return null;
  }
}

export function setLastTest(kind: "docker" | "vm", result: "ok" | "fail") {
  try {
    localStorage.setItem(TEST_KEY + kind, JSON.stringify({ result, at: Date.now() }));
  } catch {
    /* ignore */
  }
}

const AUTO_ATTACK_KEY = "cyberctf.attackbox.auto";

/** Start the attack box as soon as a local container lab is up (default on). */
export function getAutoAttackBox(): boolean {
  try {
    return localStorage.getItem(AUTO_ATTACK_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setAutoAttackBox(on: boolean) {
  try {
    localStorage.setItem(AUTO_ATTACK_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
}
