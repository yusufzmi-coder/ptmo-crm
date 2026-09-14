import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The layout chrome's busy indicator.
 *
 * The three call sites here had each spelled out
 * `<Loader2 className="… animate-spin" />` by hand and had already
 * drifted: two sizes, and one missing `aria-hidden`. Busy state is
 * announced by the control that owns it — `aria-busy` on the
 * zone-switcher trigger, `disabled` on the retry button — so the icon
 * itself must stay out of the accessibility tree rather than being
 * read out a second time as a graphic.
 *
 * Deliberately scoped to `layout/`: the wider codebase has ~110
 * hand-rolled spinners in three different shapes, and consolidating
 * those is a repo-wide change owned by nobody on this batch.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      className={cn("size-4 shrink-0 animate-spin", className)}
      aria-hidden
    />
  );
}
