"use client";

import { useState } from "react";
import { Segmented } from "@/components/ui/segmented";
import { getPortMode, setPortMode, type PortMode } from "@/lib/settings";
import { Row } from "@/features/settings/settings-layout";

/** Host ports for container labs on this machine: asked at each start, or a remembered choice. */
export function LabPortsRow({ onSaved }: { onSaved: () => void }) {
  const [mode, setMode] = useState<PortMode | null>(() => getPortMode());
  return (
    <Row
      title="Lab ports"
      description={
        mode === "default"
          ? "Each service on its own port, like CTFd on 8000. A start stops when another lab or app already holds one."
          : mode === "random"
            ? "Each service on a free random port. Never collides with another lab or app."
            : "Asks before each container lab starts on this machine: random free ports, or the lab's own."
      }
      control={
        <Segmented
          label="Lab ports"
          value={mode}
          onChange={(v) => {
            setPortMode(v);
            setMode(v);
            onSaved();
          }}
          options={[
            { value: null, label: "Ask" },
            { value: "random", label: "Random" },
            { value: "default", label: "Default" },
          ]}
        />
      }
    />
  );
}
