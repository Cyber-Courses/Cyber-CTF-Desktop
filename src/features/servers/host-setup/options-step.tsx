"use client";

import { ArrowLeft, Cloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { Field, Input, Nav, Select, Step } from "@/features/servers/host-setup/form";
import type { HostSetup } from "@/features/servers/host-setup/use-host-setup";

export function OptionsStep({ s }: { s: HostSetup }) {
  const { v, saving, error, mtdCost, set, text, connectionOk, back, saveAndTest } = s;
  return (
    <Step icon={Cloud} title="Lab settings" description="Name this account and choose when idle labs stop.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input {...text("name")} placeholder={v.provider === "azure" ? "My Azure" : v.provider === "gcp" ? "My Google Cloud" : "My AWS"} />
        </Field>
        <Field label="Auto-stop">
          <Select value={String(v.autoStopHours ?? 4)} onChange={(e) => set("autoStopHours", Number(e.target.value))}>
            {[1, 2, 4, 8, 12, 24].map((h) => (
              <option key={h} value={h}>
                {h} hour{h > 1 ? "s" : ""}
              </option>
            ))}
            <option value={0}>Never</option>
          </Select>
        </Field>
      </div>
      <p className="mt-2 text-[0.71875rem] text-muted-foreground">
        {v.provider === "aws"
          ? "An auto-stopped lab terminates itself when the time is up, even if this machine is off."
          : "At the auto-stop time the launcher tears the lab down to end billing, so keep it open (or stop the lab yourself) before then."}{" "}
        Each lab picks its own instance size, so the cost depends on the lab.
      </p>
      {v.provider === "aws" && (
        <div className="mt-3">
          <Field label="Monthly budget (USD)" hint="optional">
            <Input
              type="number"
              min={0}
              step={5}
              value={v.monthlyLimit ?? ""}
              onChange={(e) => set("monthlyLimit", e.target.value === "" ? null : Number(e.target.value))}
              placeholder="no limit"
            />
          </Field>
          {mtdCost != null && (
            <p className={cn("mt-1.5 text-[0.71875rem]", v.monthlyLimit && mtdCost >= v.monthlyLimit ? "text-rose-400" : "text-muted-foreground")}>
              Spent this month: ${mtdCost.toFixed(2)}
              {v.monthlyLimit ? ` of $${v.monthlyLimit.toFixed(2)}` : ""}.
            </p>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-[0.75rem] text-destructive">{error}</p>}
      <Nav
        left={
          <Button variant="outline" onClick={back}>
            <ArrowLeft className="size-4" /> Back
          </Button>
        }
        right={
          <Button variant="learn" onClick={saveAndTest} disabled={saving || !connectionOk}>
            {saving && <Spinner className="size-4" />} Save and test
          </Button>
        }
      />
    </Step>
  );
}
