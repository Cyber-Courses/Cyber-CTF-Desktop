"use client";

import { useEffect, useState } from "react";
import { authLogin, authLogout, authStatus, type AuthStatus } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";

function initials(name: string | null, email: string | null): string {
  const src = (name || email || "").trim();
  if (!src) return "?";
  const parts = src.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

export function Account({ onChange }: { onChange: (status: AuthStatus) => void }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (s: AuthStatus) => {
    setStatus(s);
    onChange(s);
  };

  useEffect(() => {
    authStatus().then(update).catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function login() {
    setBusy(true);
    setError(null);
    try {
      update(await authLogin());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await authLogout();
    update({ loggedIn: false, name: null, email: null });
  }

  if (!status) return null;

  if (!status.loggedIn) {
    return (
      <div>
        {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
        <Button variant="learn" size="sm" className="w-full" onClick={login} disabled={busy}>
          {busy ? (<><Spinner className="size-3.5" /> Waiting for the browser…</>) : "Log in"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-[0.7rem] font-semibold text-foreground">
        {initials(status.name, status.email)}
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-xs font-medium text-foreground">{status.name ?? "Signed in"}</p>
        {status.email && <p className="truncate text-[0.7rem] text-muted-foreground">{status.email}</p>}
      </div>
      <button
        onClick={logout}
        title="Log out"
        className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Icon name="logout" className="size-4" />
      </button>
    </div>
  );
}
