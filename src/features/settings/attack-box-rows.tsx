"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ATTACK_PRESETS, DEFAULT_ATTACK_IMAGE, getAttackImage, getAutoAttackBox, setAttackImage, setAutoAttackBox } from "@/lib/settings";
import { Row } from "@/features/settings/settings-layout";
import { RadioList, RadioRow } from "@/components/ui/radio-row";

/* ------------------------------------------------------------------ labs */

export function AttackBoxRows({ onSaved }: { onSaved: () => void }) {
  const [image, setImage] = useState(() => getAttackImage());
  const isPreset = ATTACK_PRESETS.some((p) => p.image === image);
  const [customOpen, setCustomOpen] = useState(!isPreset);
  const [draft, setDraft] = useState(isPreset ? "" : image);
  const [autoStart, setAutoStart] = useState(() => getAutoAttackBox());

  function choose(next: string) {
    const value = next.trim() || DEFAULT_ATTACK_IMAGE;
    setAttackImage(value);
    setImage(value);
    onSaved();
  }

  const customDirty = draft.trim() !== "" && draft.trim() !== image;

  return (
    <>
      <Row
        stacked
        title="Attack box image"
        description="Runs on each lab’s network as your toolbox. The first launch of an image downloads it, which can take a while."
      >
        <RadioList label="Attack box image" className="mt-3">
          {ATTACK_PRESETS.map((p) => (
            <RadioRow
              key={p.image}
              selected={!customOpen && image === p.image}
              onSelect={() => {
                setCustomOpen(false);
                choose(p.image);
              }}
              title={
                <>
                  {p.label}
                  {p.image === DEFAULT_ATTACK_IMAGE && <Badge>Default</Badge>}
                  {p.large && <Badge variant="outline">Large download</Badge>}
                  {p.terms && <Badge variant="warning">{p.terms}</Badge>}
                </>
              }
              subtitle={
                <>
                  <span className="font-mono">{p.image}</span> <span className="text-muted-foreground/60">·</span> {p.note}
                </>
              }
            />
          ))}
          <RadioRow selected={customOpen} onSelect={() => setCustomOpen(true)} title="Custom image" subtitle="Any Docker image or registry tag.">
            {customOpen && (
              <form
                className="mt-2.5 flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (customDirty) choose(draft);
                }}
              >
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  spellCheck={false}
                  placeholder="registry/image:tag"
                  className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 font-mono text-xs text-foreground outline-none focus:border-ring"
                />
                <Button type="submit" variant="outline" size="sm" disabled={!customDirty} onClick={(e) => e.stopPropagation()}>
                  Save
                </Button>
              </form>
            )}
          </RadioRow>
        </RadioList>
      </Row>

      <Row
        title="Start the attack box with the lab"
        description="Starts it as soon as a local container lab is up. You can still start or stop it from the lab."
        control={
          <Switch
            aria-label="Start the attack box with the lab"
            checked={autoStart}
            onCheckedChange={(on) => {
              setAutoAttackBox(on);
              setAutoStart(on);
              onSaved();
            }}
          />
        }
      />
    </>
  );
}
