import { type DockerEngine } from "@/lib/tauri";

// ---------- Container engine ----------

export type Engine = { id: DockerEngine; name: string; note: string; url: string; os: string[]; logo: string; tile?: boolean };
/** Docker-compatible engines, per OS. The recommended one gets the one-click install; others link out. */
export const ENGINES: Engine[] = [
  {
    id: "docker-desktop",
    name: "Docker Desktop",
    note: "The official app. Easiest to set up.",
    url: "https://www.docker.com/products/docker-desktop/",
    os: ["macos", "windows", "linux"],
    logo: "/brands/docker.svg",
  },
  {
    id: "docker-engine",
    name: "Docker Engine",
    note: "The native daemon, no desktop app.",
    url: "https://docs.docker.com/engine/install/",
    os: ["linux"],
    logo: "/brands/docker.svg",
  },
  {
    id: "orbstack",
    name: "OrbStack",
    note: "Fast and light on memory. Free for personal use.",
    url: "https://orbstack.dev/",
    os: ["macos"],
    logo: "/brands/orbstack.png",
    tile: true,
  },
  {
    id: "colima",
    name: "Colima",
    note: "Open source, command line only.",
    url: "https://github.com/abiosoft/colima",
    os: ["macos", "linux"],
    logo: "/brands/colima.png",
  },
];

/** Display name of a Docker-compatible engine. */
export const engineName = (id: DockerEngine) => (id === "podman" ? "Podman" : (ENGINES.find((e) => e.id === id)?.name ?? "Docker"));
