"use client";

import { useEffect, useState } from "react";
import { authLogin, authLogout, authStatus, type AuthStatus } from "@/lib/tauri";
import { Button } from "@/components/ui/button";

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
  return (
    <div className="flex items-center gap-3 text-sm">
      {error && <span className="text-destructive">{error}</span>}
      {status.loggedIn ? (
        <>
          <span className="text-muted-foreground">{status.name ?? status.email ?? "Logged in"}</span>
          <Button variant="outline" size="sm" onClick={logout}>Log out</Button>
        </>
      ) : (
        <Button variant="learn" size="sm" onClick={login} disabled={busy}>
          {busy ? "Waiting for the browser…" : "Log in"}
        </Button>
      )}
    </div>
  );
}
