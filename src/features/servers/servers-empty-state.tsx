"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export function ServersEmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <EmptyState
      icon="server"
      title="No server connected"
      description="Add your Proxmox or ESXi server to run heavier, multi-VM labs on it instead of this machine."
      action={
        <Button size="sm" onClick={onAdd}>
          <Plus className="size-3.5" /> Add server
        </Button>
      }
    />
  );
}
