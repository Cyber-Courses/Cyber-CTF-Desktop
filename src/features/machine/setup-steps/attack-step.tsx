"use client";

import { useState } from "react";
import { Terminal } from "lucide-react";
import { ATTACK_PRESETS, DEFAULT_ATTACK_IMAGE, getAttackImage, getAutoAttackBox, setAttackImage, setAutoAttackBox } from "@/lib/settings";
import { type SystemReport } from "@/lib/tauri";
import { Choice, ChoiceGrid } from "@/features/machine/setup-steps/parts";
import { isDockerReady } from "@/features/machine/setup-steps/steps";

// ---------- Virtual machines ----------

// ---------- Attack machine ----------

/** Pick the attack box image (same setting as Settings → Attack box) and whether it starts with each lab. */
export function AttackStep({ report }: { report: SystemReport }) {
  const [image, setImage] = useState(() => getAttackImage());
  const [auto, setAuto] = useState(() => getAutoAttackBox());
  const presets = ATTACK_PRESETS;
  const custom = !presets.some((p) => p.image === image);
  const pick = (img: string) => {
    setAttackImage(img);
    setImage(img);
  };
  return (
    <div className="space-y-3">
      <ChoiceGrid>
        {presets.map((p) => (
          <Choice
            key={p.image}
            selected={image === p.image}
            onSelect={() => pick(p.image)}
            mark={
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
                <Terminal className="size-4 text-muted-foreground" />
              </span>
            }
            title={p.label}
            note={[p.note, p.large ? "large download" : null, p.terms].filter(Boolean).join(" · ")}
            badge={p.image === DEFAULT_ATTACK_IMAGE ? "recommended" : undefined}
          />
        ))}
      </ChoiceGrid>
      {custom && (
        <p className="text-left text-[12px] text-muted-foreground">
          Using a custom image from Settings: <span className="font-mono">{image}</span>
        </p>
      )}
      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5 text-left">
        <span>
          <span className="block text-[13px] font-medium">Start it with each lab</span>
          <span className="block text-[12px] text-muted-foreground">Otherwise launch it from the lab’s page when you need it.</span>
        </span>
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => {
            setAutoAttackBox(e.target.checked);
            setAuto(e.target.checked);
          }}
          className="size-4 accent-[var(--color-learn)]"
        />
      </label>
      {!isDockerReady(report) && (
        <p className="text-left text-[12px] text-muted-foreground">It runs on your container engine, so it works once one is set up.</p>
      )}
      <p className="text-left text-[12px] text-muted-foreground">The image downloads the first time a lab starts it.</p>
    </div>
  );
}
