import { beforeEach, describe, expect, it, vi } from "vitest";

// The store imports `deployingLabs` (a Tauri invoke) only for the useDeployingLabs hook, which
// these tests don't exercise. Stub it so importing the store needs no Tauri runtime.
vi.mock("@/lib/tauri", () => ({ deployingLabs: async () => [] }));

// Fresh module state per test (the store is a module singleton).
async function freshStore() {
  vi.resetModules();
  return import("@/lib/deploy-store");
}

describe("deploy-store", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("keeps each lab's logs separate when two deploys run at once", async () => {
    // Regression: a single global slot let a second deploy's lines (e.g. an ESXi VM lab) show on
    // the first lab's (e.g. a Docker lab) page. Keyed per lab, each stream stays its own.
    const { beginDeploy, appendDeployLog, getDeploySnapshot } = await freshStore();
    beginDeploy("docker-lab");
    beginDeploy("esxi-lab");
    appendDeployLog("docker-lab", "Container web-1 Started");
    appendDeployLog("esxi-lab", "vagrant up --provider vmware_esxi failed");
    appendDeployLog("docker-lab", "Container web-1 Healthy");

    const { runs } = getDeploySnapshot();
    expect(runs["docker-lab"].logs).toEqual(["Container web-1 Started", "Container web-1 Healthy"]);
    expect(runs["esxi-lab"].logs).toEqual(["vagrant up --provider vmware_esxi failed"]);
    // The ESXi failure never leaks into the Docker lab's stream.
    expect(runs["docker-lab"].logs.some((l) => l.includes("esxi"))).toBe(false);
  });

  it("marks both labs busy while both deploy, and ends them independently", async () => {
    const { beginDeploy, endDeploy, getDeploySnapshot } = await freshStore();
    beginDeploy("a");
    beginDeploy("b");
    expect(getDeploySnapshot().runs.a.busy).toBe(true);
    expect(getDeploySnapshot().runs.b.busy).toBe(true);

    endDeploy("a");
    // Ending one lab leaves the other running, and keeps the ended lab's logs for the console.
    expect(getDeploySnapshot().runs.a.busy).toBe(false);
    expect(getDeploySnapshot().runs.b.busy).toBe(true);
  });

  it("beginDeploy clears only that lab's previous logs", async () => {
    const { beginDeploy, appendDeployLog, getDeploySnapshot } = await freshStore();
    beginDeploy("a");
    appendDeployLog("a", "first run line");
    appendDeployLog("b", "b stays");
    beginDeploy("a"); // a re-run
    expect(getDeploySnapshot().runs.a.logs).toEqual([]);
    expect(getDeploySnapshot().runs.a.busy).toBe(true);
    expect(getDeploySnapshot().runs.b.logs).toEqual(["b stays"]);
  });

  it("records a timestamp parallel to every log line", async () => {
    const { beginDeploy, appendDeployLog, getDeploySnapshot } = await freshStore();
    beginDeploy("a");
    appendDeployLog("a", "one");
    appendDeployLog("a", "two");
    const run = getDeploySnapshot().runs.a;
    expect(run.logs.length).toBe(2);
    expect(run.times.length).toBe(run.logs.length);
    expect(run.times.every((t) => typeof t === "number")).toBe(true);
  });

  it("ending a lab that never started is a no-op (no phantom run)", async () => {
    const { endDeploy, getDeploySnapshot } = await freshStore();
    endDeploy("never-started");
    expect(getDeploySnapshot().runs["never-started"]).toBeUndefined();
  });

  it("notifies subscribers on every change", async () => {
    const { beginDeploy, appendDeployLog, endDeploy, subscribeDeploy } = await freshStore();
    const cb = vi.fn();
    const unsub = subscribeDeploy(cb);
    beginDeploy("a");
    appendDeployLog("a", "x");
    endDeploy("a");
    expect(cb).toHaveBeenCalledTimes(3);
    unsub();
    appendDeployLog("a", "y");
    expect(cb).toHaveBeenCalledTimes(3); // no more calls after unsubscribe
  });
});
