"use client";

import { Segmented } from "@/components/ui/segmented";
import { APPEARANCES, useAppearance, type Appearance } from "@/lib/appearance";
import { Row, Section, useSavedFlash } from "@/features/settings/settings-layout";

const DESCRIPTIONS: Record<Appearance, string> = {
  dark: "Dark uses deep neutral greys, easy on the eyes.",
  black: "Black uses true black, for OLED screens.",
  light: "Light uses warm paper tones, for bright rooms.",
};

/** Dark / Black / Light. Applies at once here and in every other window (storage event). */
export function AppearanceSection() {
  const [mode, setMode] = useAppearance();
  const [saved, flash] = useSavedFlash();

  return (
    <Section title="Appearance" description="How the launcher looks. Saved on this computer." saved={saved}>
      <Row
        title="Theme"
        description={DESCRIPTIONS[mode]}
        control={
          <Segmented<Appearance>
            label="Theme"
            value={mode}
            options={APPEARANCES}
            onChange={(next) => {
              if (next === mode) return;
              setMode(next);
              flash();
            }}
          />
        }
      />
    </Section>
  );
}
