import { Loader2 } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * The one spinner.
 *
 * Before this, loading was drawn three different ways across the app —
 * a bare `<Loader2 className="animate-spin">`, a hand-rolled bordered
 * circle, and a conditional `RefreshCw` — at four different sizes, so
 * the same "working…" signal looked different on every screen and
 * there was nowhere to fix it.
 *
 * Colour is inherited: the icon is drawn in `currentColor`, so a
 * `text-primary-readable` or `text-muted-foreground` on the spinner (or on any
 * parent) is what tints it. Don't add colours to the variants.
 *
 * Reduced motion is already handled globally — `globals.css` collapses
 * every animation duration under `prefers-reduced-motion: reduce`, and
 * that rule targets `*` with `!important`, so it reaches this icon
 * without help. Never re-declare the animation here with `!important`
 * of your own; that is exactly what would punch through the global
 * rule and spin regardless.
 *
 * ACCESSIBILITY — the part that is easy to get wrong:
 *
 *   Inside a button that already has a visible label, pass no `label`.
 *   The spinner is then `aria-hidden` and the button announces once.
 *   Labelling it too would make a screen reader read "Loading, Delete"
 *   for a button whose name is simply "Delete".
 *
 *   Standing alone — a page or panel with nothing else to read — pass
 *   a `label`. The spinner becomes a `role="status"` and announces it.
 *
 *   If a visible "Loading…" line already sits beside the spinner, that
 *   text is the announcement. Leave the spinner unlabelled there too.
 */
const spinnerVariants = cva("animate-spin shrink-0", {
  variants: {
    size: {
      sm: "size-4",
      md: "size-6",
      lg: "size-8",
    },
  },
  defaultVariants: {
    size: "md",
  },
});

export function Spinner({
  className,
  size,
  label,
}: VariantProps<typeof spinnerVariants> & {
  className?: string;
  /**
   * Announce the spinner under this name. Omit whenever something else
   * on screen already names the wait — a button's own text, or a
   * "Loading…" line beside it.
   */
  label?: string;
}) {
  return (
    <Loader2
      className={cn(spinnerVariants({ size }), className)}
      {...(label
        ? { role: "status", "aria-label": label }
        : { "aria-hidden": true })}
    />
  );
}

export { spinnerVariants };
