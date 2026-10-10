import { describe, expect, it } from "vitest";

import { rowPhase } from "@/features/labs/lab-row-state";
import type { LabStatus } from "@/lib/tauri";

const status = (p: Partial<LabStatus>) => ({ running: false, parked: null, ...p }) as LabStatus;
const phase = (p: Partial<Parameters<typeof rowPhase>[0]>) => rowPhase({ status: status({}), busy: false, deploying: false, solved: false, ...p });

describe("rowPhase", () => {
  it("puts an operation of this session first, even on a running lab", () => {
    expect(phase({ busy: true, status: status({ running: true }) })).toBe("busy");
  });
  it("reads a backend deploy as starting until the lab runs", () => {
    expect(phase({ deploying: true })).toBe("starting");
    expect(phase({ deploying: true, status: status({ running: true }) })).toBe("running");
  });
  it("tells a paused lab from a shut-down one", () => {
    expect(phase({ status: status({ parked: "pause" }) })).toBe("paused");
    expect(phase({ status: status({ parked: "shutdown" }) })).toBe("shutDown");
  });
  it("is solved or not started at rest", () => {
    expect(phase({ solved: true })).toBe("solved");
    expect(phase({ status: undefined })).toBe("notStarted");
  });
});
