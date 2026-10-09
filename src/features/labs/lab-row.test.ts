import { describe, expect, it } from "vitest";

import { cloudNames, localProviders, runPlaces, runtimeLabel, withArticle } from "@/features/labs/lab-row";
import { costEstimate } from "@/features/labs/cloud-panel";
import type { Lab } from "@/features/labs/use-labs";

const rt = (runtime: string, providers: string[]) => ({ runtime, providers, architectures: [] }) as unknown as NonNullable<Lab["runtime"]>;

describe("cloud labs", () => {
  it("run in a cloud account only", () => {
    const places = runPlaces(rt("CLOUD", ["aws", "gcp"]), "arm64");
    expect(places.filter((p) => p.available).map((p) => p.key)).toEqual(["cloud"]);
    expect(places.find((p) => p.key === "cloud")?.label).toBe("Your AWS or Google Cloud account");
    expect(localProviders(rt("CLOUD", ["aws"]), "arm64")).toEqual([]);
  });

  it("read as cloud, docker or vm", () => {
    expect(runtimeLabel(rt("CLOUD", ["aws"]))).toBe("cloud");
    expect(runtimeLabel(rt("DOCKER", ["docker"]))).toBe("docker");
    expect(runtimeLabel(rt("VM", ["virtualbox"]))).toBe("vm");
  });

  it("name their clouds", () => {
    expect(cloudNames(["aws"])).toBe("AWS");
    expect(cloudNames(["aws", "azure", "gcp"])).toBe("AWS, Azure or Google Cloud");
    expect(cloudNames(["docker"])).toBe("cloud");
    expect(withArticle("AWS")).toBe("an AWS");
    expect(withArticle("Google Cloud")).toBe("a Google Cloud");
  });

  it("estimate their cost from the lab's hourly figure", () => {
    expect(costEstimate(0.02, 4)).toBe("about $0.02 an hour (about $0.08 until it auto-stops in 4 h)");
    expect(costEstimate(0.5, 0)).toBe("about $0.50 an hour");
    expect(costEstimate(null, 4)).toBeNull();
  });
});
