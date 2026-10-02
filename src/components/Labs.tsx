"use client";

import { useEffect, useRef, useState } from "react";
import { useRequestedLab } from "@/lib/deep-link";
import { apiQuery, labLaunch, type Provider, type Runtime } from "@/lib/tauri";

interface Lab {
  id: string;
  runtime: Runtime;
  architectures: string[];
  providers: Provider[];
}

interface Challenge {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  question: string | null;
  difficulty: number;
  category: string;
  labs: Lab[];
}

const DIFFICULTY = ["", "Easy", "Medium", "Hard"];

export function Labs({ loggedIn, hostArch }: { loggedIn: boolean; hostArch: string }) {
  const [challenges, setChallenges] = useState<Challenge[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const logEnd = useRef<HTMLDivElement>(null);
  const requested = useRequestedLab();

  useEffect(() => {
    apiQuery<{ challenges: Challenge[] }>(
      `{ challenges(sort: [{ title: ASC }]) { id slug title description question difficulty category
         labs { id runtime architectures providers } } }`,
    )
      .then((d) => setChallenges(d.challenges))
      .catch((e) => setError(String(e)));
  }, [loggedIn]);

  useEffect(() => logEnd.current?.scrollIntoView({ block: "end" }), [logs]);

  // A cyberctf://labs/<slug> link: bring that lab into view (the player still clicks Start).
  useEffect(() => {
    if (requested && challenges) document.getElementById(`lab-${requested}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [requested, challenges]);

  async function launch(lab: Lab) {
    setRunning(lab.id);
    setLogs([]);
    try {
      // VM labs: first provider the lab supports; provider choice UI comes with settings.
      const provider = lab.runtime === "VM" ? (lab.providers[0] ?? null) : null;
      await labLaunch(lab.id, provider, (line) => setLogs((l) => [...l, line]));
      setLogs((l) => [...l, "✓ Lab is running"]);
    } catch (e) {
      setLogs((l) => [...l, `✗ ${String(e)}`]);
    } finally {
      setRunning(null);
    }
  }

  if (error) return <p className="text-red-400">{error}</p>;
  if (!challenges) return <p className="text-neutral-500">Loading labs…</p>;
  if (challenges.length === 0) return <p className="text-neutral-500">No labs published yet.</p>;
  const missing = requested && !challenges.some((c) => c.slug === requested);

  return (
    <div className="space-y-4">
      {missing && <p className="text-sm text-amber-400">The lab “{requested}” isn’t available.</p>}
      <ul className="space-y-3">
        {challenges.map((c) =>
          c.labs.map((lab) => {
            const native = lab.architectures.includes(hostArch);
            return (
              <li
                key={lab.id}
                id={`lab-${c.slug}`}
                className={`rounded border p-4 ${c.slug === requested ? "border-neutral-300 ring-1 ring-neutral-300" : "border-neutral-800"}`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="font-medium">{c.title}</h3>
                    <p className="text-sm text-neutral-400">{c.description}</p>
                    {c.question && <p className="mt-2 text-sm text-neutral-300">{c.question}</p>}
                    <p className="mt-2 text-xs text-neutral-500">
                      {c.category} · {DIFFICULTY[c.difficulty]} · {lab.runtime === "VM" ? "VM" : "Docker"}
                      {!native && " · emulated on this machine (slower)"}
                    </p>
                  </div>
                  <button
                    onClick={() => launch(lab)}
                    disabled={!loggedIn || running !== null}
                    title={loggedIn ? undefined : "Log in to start labs"}
                    className="shrink-0 rounded bg-neutral-100 px-3 py-1 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
                  >
                    {running === lab.id ? "Starting…" : "Start"}
                  </button>
                </div>
              </li>
            );
          }),
        )}
      </ul>
      {logs.length > 0 && (
        <pre className="max-h-64 overflow-auto rounded bg-neutral-900 p-3 text-xs text-neutral-300">
          {logs.join("\n")}
          <div ref={logEnd} />
        </pre>
      )}
    </div>
  );
}
