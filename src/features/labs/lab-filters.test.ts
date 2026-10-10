import { describe, expect, it } from "vitest";

import { filterLabs, NO_FILTERS, type LabFilters } from "@/features/labs/lab-filters";
import type { Lab } from "@/features/labs/use-labs";

const lab = (id: string, p: Partial<Lab> = {}): Lab => ({
  id,
  slug: id,
  title: id,
  description: null,
  question: null,
  difficulty: 1,
  category: "Web",
  runtime: { runtime: "DOCKER", architectures: [], providers: [] },
  skills: [],
  ...p,
});

const labs = [
  lab("sqli", { title: "SQL injection", skills: [{ id: "s", name: "Databases" }] }),
  lab("ad", { title: "Domain", category: "Active Directory", difficulty: 3, runtime: { runtime: "VM", architectures: [], providers: [] } }),
  lab("cloud", { title: "Bucket", difficulty: 2, runtime: { runtime: "DOCKER", architectures: [], providers: ["aws"] as never } }),
  lab("bare", { runtime: null }),
];
const running = new Set(["ad"]);
const solved = new Set(["sqli"]);
const ids = (f: Partial<LabFilters>) => filterLabs(labs, { ...NO_FILTERS, ...f }, (l) => running.has(l.id), solved).map((l) => l.id);

describe("filterLabs", () => {
  it("keeps everything with no filter", () => {
    expect(ids({})).toEqual(["sqli", "ad", "cloud", "bare"]);
  });
  it("searches titles, categories and skills, ignoring case and spaces", () => {
    expect(ids({ query: "  active " })).toEqual(["ad"]);
    expect(ids({ query: "DATABASES" })).toEqual(["sqli"]);
  });
  it("filters by runtime, CLOUD meaning labs that run on AWS", () => {
    expect(ids({ runtime: "VM" })).toEqual(["ad"]);
    expect(ids({ runtime: "DOCKER" })).toEqual(["sqli", "cloud"]);
    expect(ids({ runtime: "CLOUD" })).toEqual(["cloud"]);
  });
  it("filters by level", () => {
    expect(ids({ difficulty: 2 })).toEqual(["cloud"]);
  });
  it("filters by status, to do being neither solved nor running", () => {
    expect(ids({ status: "running" })).toEqual(["ad"]);
    expect(ids({ status: "solved" })).toEqual(["sqli"]);
    expect(ids({ status: "todo" })).toEqual(["cloud", "bare"]);
  });
});
