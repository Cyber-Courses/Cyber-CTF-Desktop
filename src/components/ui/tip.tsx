import { cn } from "@/lib/utils";

/**
 * A hover / keyboard-focus tooltip drawn in the page, for controls that swap when clicked (Shut
 * down → Resume). The native `title` tooltip stays on screen with the old text until the pointer
 * moves; this one belongs to its control, so it goes away with it. Key the wrapper by action when
 * one control replaces another in the same spot.
 */
export function Tip({ text, children, align = "end" }: { text?: string; children: React.ReactNode; align?: "start" | "end" }) {
  if (!text) return <>{children}</>;
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute top-full z-40 mt-1.5 w-max max-w-64 rounded-md border border-border bg-popover px-2 py-1 text-[0.71875rem] leading-snug text-popover-foreground opacity-0 shadow-lg shadow-black/40 transition-opacity",
          "group-hover/tip:opacity-100 group-hover/tip:delay-500 group-has-[:focus-visible]/tip:opacity-100",
          align === "end" ? "right-0" : "left-0",
        )}
      >
        {text}
      </span>
    </span>
  );
}
