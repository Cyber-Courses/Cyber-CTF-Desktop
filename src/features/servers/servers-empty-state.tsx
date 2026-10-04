"use client";

import { Plus, Server } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ServersEmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="px-6 py-12 text-center">
      <span className="mx-auto flex size-10 items-center justify-center rounded-xl border border-border bg-surface text-muted-foreground">
        <Server className="size-5" />
      </span>
      <p className="mt-4 text-[0.875rem] font-medium">No server connected</p>
      <p className="mx-auto mt-1 max-w-sm text-[0.78125rem] text-muted-foreground">
        Add your Proxmox or ESXi server to run heavier, multi-VM labs on it instead of this machine.
      </p>
      <Button variant="learn" size="sm" className="mt-5" onClick={onAdd}>
        <Plus className="size-3.5" /> Add host
      </Button>
    </div>
  );
}
