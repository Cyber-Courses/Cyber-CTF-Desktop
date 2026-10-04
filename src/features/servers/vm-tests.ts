// ---------- last VM-test result, remembered per host (like the machine page) ----------

export type VmTest = { result: "ok" | "fail"; at: number };
const VMTEST_KEY = "cyberctf.server.vmtest";

export function loadVmTests(): Record<string, VmTest> {
  try {
    return JSON.parse(localStorage.getItem(VMTEST_KEY) || "{}");
  } catch {
    return {};
  }
}
export function saveVmTest(id: string, result: "ok" | "fail"): Record<string, VmTest> {
  const all = loadVmTests();
  all[id] = { result, at: Date.now() };
  try {
    localStorage.setItem(VMTEST_KEY, JSON.stringify(all));
  } catch {
    /* private window / blocked storage: the result just isn't remembered */
  }
  return all;
}
