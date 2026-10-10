"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { CommandPalette } from "@/components/command-palette";
import { UpdateBanner } from "@/components/update-banner";
import { Toaster } from "@/components/ui/toaster";
import { Sidebar } from "@/components/shell/sidebar";
import { ShellHeader } from "@/components/shell/shell-header";
import { Screen } from "@/components/shell/screen";
import { SettingsWindowView, isSettingsWindow } from "@/components/shell/settings-window";
import { paletteCommands } from "@/components/shell/palette-commands";
import { breadcrumbs, isNavTab, isTyping, shortcutFor, type Tab } from "@/components/shell/shell-model";
import { useAuthSession } from "@/components/shell/use-auth-session";
import { useSidebarLabs } from "@/components/shell/use-sidebar-labs";
import { useSystemCheck } from "@/components/shell/use-system-check";
import { QuitGuard } from "@/features/app/quit-guard";
import { LaunchConfirm } from "@/features/app/launch-confirm";
import { Onboarding } from "@/features/onboarding/onboarding";
import { PortModePrompt } from "@/features/labs/port-mode-prompt";
import { useAttackBoxAutoStart } from "@/features/labs/attack-box-auto";
import { openSettings } from "@/lib/tauri";
import { useActiveOperations } from "@/lib/deploy-store";
import { ignore, tell } from "@/lib/failure";
import { useLabLinks } from "@/lib/deep-link";
import { NAVIGATE_EVENT, REPLAY_ONBOARDING_EVENT } from "@/lib/app-events";
import { installDevMock } from "@/lib/dev-mock";
import { useAppearanceSync } from "@/lib/appearance";
import { isMac as onMac } from "@/lib/platform";
import { useTauriEvent } from "@/lib/use-tauri-event";
import { translate, useT } from "@/lib/i18n";

// Development only: ?mock in a plain browser answers the Tauri commands with sample data.
installDevMock();

const ONBOARDED_KEY = "cyberctf.onboarded";

const openSettingsWindow = () => void openSettings().catch(tell(translate("shell.failures.openSettings")));

/**
 * The main window: sidebar, header and the open screen, plus the app-wide listeners (deep links,
 * requests from the Settings window, session changes, keyboard shortcuts) and prompts (quit guard,
 * launch confirmation, port mode). The Settings window runs this shell too, as just its screen.
 */
export function AppShell() {
  useAppearanceSync();
  const t = useT();
  const [tab, setTab] = useState<Tab>("home");
  const [openLab, setOpenLab] = useState<{ slug: string | null; tick: number }>({ slug: null, tick: 0 });
  const [onboarded, setOnboarded] = useState(true);
  const [ready, setReady] = useState(false);
  const [settingsWindow, setSettingsWindow] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The lab page open in Labs, for the breadcrumb (null on the list and other screens).
  const [labTitle, setLabTitle] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [isMac, setIsMac] = useState(true);
  const { report, checkError, check } = useSystemCheck();
  const session = useAuthSession();
  const { auth, init: readSession } = session;

  useEffect(() => {
    // Reads the window marker once on mount (window isn't available during render).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettingsWindow(isSettingsWindow());
    void check();
    getVersion().then(setVersion).catch(ignore("no version outside the app"));
    setIsMac(onMac());
    readSession();
    try {
      // Reads a per-machine flag once on mount (localStorage isn't available during render).
      setOnboarded(localStorage.getItem(ONBOARDED_KEY) === "1");
    } catch {
      setOnboarded(true);
    }
    setReady(true);
  }, [check, readSession]);
  const mainWindow = ready && !settingsWindow;

  function navigate(next: Tab, slug?: string) {
    // Setup now lives inside the Machine dashboard; "setup" just lands on Machine.
    setTab(next === "setup" ? "machine" : next);
    setOpenLab((o) => ({ slug: next === "setup" ? null : (slug ?? null), tick: o.tick + 1 }));
  }

  function findALab() {
    navigate("labs");
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>("[data-lab-search]")?.focus());
  }

  // Asked from the Settings window: switch screens, or show the onboarding again. Brought to the
  // front, since the request came from another window.
  const toFront = () => void getCurrentWindow().setFocus().catch(ignore("the window manager keeps focus where it is"));
  useTauriEvent<string>(
    NAVIGATE_EVENT,
    (screen) => {
      if (isNavTab(screen)) navigate(screen);
      toFront();
    },
    mainWindow,
  );
  useTauriEvent(
    REPLAY_ONBOARDING_EVENT,
    () => {
      setOnboarded(false);
      toFront();
    },
    mainWindow,
  );

  // A cyberctf://labs/<slug> link (the one that opened the app, or one opened since) shows that
  // lab, whatever screen is open. Not in the Settings window: the main window takes it.
  useLabLinks((slug) => navigate("labs", slug), mainWindow);

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const shortcut = shortcutFor(e, onMac(), isTyping(document.activeElement));
    if (!shortcut) return;
    e.preventDefault();
    if (shortcut === "palette") setPaletteOpen((o) => !o);
    else if (shortcut === "settings") openSettingsWindow();
    else findALab();
  });
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // What each busy lab is doing and the step it is at, for a live line under its name.
  const ops = useActiveOperations();
  // Main window only: Settings runs this shell too, and two windows must not both start a box.
  useAttackBoxAutoStart(ops, mainWindow);
  const sidebarLabs = useSidebarLabs(auth?.loggedIn, ops);

  function completeOnboarding() {
    try {
      localStorage.setItem(ONBOARDED_KEY, "1");
    } catch {
      /* ignore */
    }
    setOnboarded(true);
    setTab("labs");
    void check();
    // Pick up a sign-in done during onboarding: the shell's auth was read once at mount (before
    // onboarding), so re-read the persisted session, otherwise the app stays "offline" until a
    // restart even though the user just signed in.
    session.reread();
  }

  if (!ready) return <div className="h-dvh bg-background" />;
  // Settings runs standalone in its own window: no sidebar, no onboarding, just the screen.
  if (settingsWindow) return <SettingsWindowView auth={auth} onAuthChange={session.changed} />;
  // With its own Toaster: `tell()` shows errors as toasts while the window has focus.
  if (!onboarded)
    return (
      <>
        <Onboarding onComplete={completeOnboarding} />
        <Toaster />
      </>
    );

  const title = (id: Tab) => t(`shell.tabs.${id}`);
  const commands = paletteCommands(t, sidebarLabs.labs, { findLab: findALab, openSettings: openSettingsWindow, navigate });

  return (
    // `overflow-clip`, not `hidden`: a hidden box can still be scrolled (focus, scrollIntoView,
    // a wheel over the sidebar), which shifted the whole window up under the titlebar.
    <div className="flex h-dvh overflow-clip bg-background text-foreground">
      <CommandPalette key={paletteOpen ? "open" : "closed"} open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <QuitGuard />
      <LaunchConfirm />
      <PortModePrompt />
      <Toaster />
      <Sidebar
        tab={tab}
        isMac={isMac}
        version={version}
        labCount={sidebarLabs.labs.length}
        activeLabs={sidebarLabs.active}
        auth={auth}
        onFind={() => setPaletteOpen(true)}
        onNavigate={navigate}
        onOpenSettings={openSettingsWindow}
        onAuthChange={session.changed}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-clip">
        <ShellHeader crumbs={breadcrumbs(tab, labTitle, title, t("shell.header.thisMachine"))} report={report} checkError={checkError} />
        <div className="flex-1 overflow-y-auto">
          <UpdateBanner />
          <div className="mx-auto w-full max-w-[72rem] px-7 pt-7 pb-10">
            <Screen
              tab={tab}
              report={report}
              checkError={checkError}
              auth={auth}
              openLab={openLab}
              onRefresh={check}
              onNavigate={navigate}
              onAuthChange={session.setAuth}
              onLabChange={setLabTitle}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
