import { describe, expect, it } from "vitest";

import { failedMachineStep } from "@/features/labs/deploy-steps";

describe("failedMachineStep", () => {
  it("is the machine Vagrant names in its failure", () => {
    const failure =
      "✗ `vagrant up --provider qemu` failed: An error occurred while executing multiple actions in parallel. Any errors that occurred are shown below. An error occurred while executing the action on the 'isoloom-controller' machine. Please handle this error then try again";
    expect(failedMachineStep(failure)).toBe("m:isoloom-controller");
  });

  it("is null when the failure names no machine", () => {
    expect(failedMachineStep("✗ this lab can't run there")).toBeNull();
  });
});
