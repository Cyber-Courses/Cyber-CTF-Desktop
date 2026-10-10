import { describe, expect, it } from "vitest";

import { deriveSteps, detectTarget, failedMachineStep } from "@/features/labs/deploy-log";
import type { T } from "@/lib/i18n";

// Labels as their message keys, so the tests read which step a line landed in.
const t = ((key: string) => key) as unknown as T;
const timed = (lines: string[]) => lines.map((line, i) => ({ line, at: i * 1000 }));
const steps = (lines: string[]) => deriveSteps(t, timed(lines)).map((s) => [s.id, s.label, s.rows.length]);

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

describe("detectTarget", () => {
  it("tells Vagrant, Terraform and Docker Compose output apart", () => {
    expect(detectTarget("Bringing machine 'dc01' up with 'virtualbox' provider...")).toBe("vagrant");
    expect(detectTarget("==> dc01: Importing base box")).toBe("vagrant");
    expect(detectTarget("Initializing the backend...")).toBe("terraform");
    expect(detectTarget("aws_instance.lab: Creating...")).toBe("terraform");
    expect(detectTarget(" Container web-1  Started")).toBe("docker");
    expect(detectTarget("hello")).toBe("unknown");
  });
});

describe("deriveSteps", () => {
  it("reads Docker Compose phases, after the download", () => {
    expect(
      steps(["Downloading lab", " Image web Pulling", " Network lab_default  Creating", " Container web-1  Started", " Container web-1  Healthy"]),
    ).toEqual([
      ["download", "labs.deploy.steps.download", 1],
      ["images", "labs.deploy.phases.images", 1],
      ["create", "labs.deploy.phases.create", 1],
      ["start", "labs.deploy.phases.start", 1],
      ["health", "labs.deploy.phases.health", 1],
    ]);
  });

  it("gives each Vagrant machine its own step, without the isoloom- prefix", () => {
    expect(steps(["Recovering the lab", "==> isoloom-dc01: Importing box", "==> isoloom-ws01: Booting", "    more ws01 output"])).toEqual([
      ["prepare", "labs.deploy.steps.prepareMachine", 1],
      ["m:isoloom-dc01", "dc01", 1],
      ["m:isoloom-ws01", "ws01", 2],
    ]);
  });

  it("reads Terraform's init, apply and host setup", () => {
    expect(
      steps(["Initializing the backend...", "aws_instance.lab: Creating...", "aws_instance.lab: Creation complete", "Waiting for the lab host", "other"]),
    ).toEqual([
      ["tf-init", "labs.deploy.steps.tfInit", 1],
      ["tf-apply", "labs.deploy.steps.tfApply", 2],
      ["tf-ready", "labs.deploy.steps.tfReady", 2],
    ]);
  });

  it("keeps unknown output in one preparing step", () => {
    expect(steps(["hello", "world"])).toEqual([["prepare", "labs.deploy.steps.preparing", 2]]);
  });
});
