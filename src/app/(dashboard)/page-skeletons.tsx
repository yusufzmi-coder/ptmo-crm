import { Skeleton } from "@/components/dashboard/skeleton";

/**
 * Loading placeholders for the dashboard page shells.
 *
 * Every section here opened the same way — a lone centred spinner in a
 * tall empty box, then the whole page arriving in one jump — and each
 * page drew its own, so switching sections showed a different loading
 * state each time. These stand in the shape the page is about to take
 * instead, matching how the inbox list and the settings panels already
 * signal "loading".
 *
 * Deliberately local to `(dashboard)/` rather than an addition to the
 * shared `Skeleton` primitive in `components/dashboard/skeleton.tsx`:
 * that one is used across six workstreams and is not mine to change.
 * This file is a component, not a route — same as `dashboard-shell.tsx`
 * beside it.
 */

/** Title, subtitle, and the action button most pages sit opposite them. */
function HeaderSkeleton({ action }: { action: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      {action && <Skeleton className="h-9 w-32 shrink-0" />}
    </div>
  );
}

/**
 * A whole page shell: the heading block, then whatever body the page
 * fills in. `label` is what a screen reader hears in place of the page.
 */
export function PageSkeleton({
  label,
  action = true,
  children,
}: {
  label: string;
  action?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6" aria-busy="true" aria-label={label}>
      <HeaderSkeleton action={action} />
      {children}
    </div>
  );
}

/** Stands in for a responsive grid of cards (flows, automations). */
export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-3">
            <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
            <Skeleton className="h-5 w-16 shrink-0 rounded-full" />
          </div>
          <Skeleton className="mt-4 h-4 w-36" />
          <Skeleton className="mt-2 h-3 w-full max-w-52" />
          <Skeleton className="mt-4 h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

/** Stands in for a stack of full-width rows (broadcasts, run logs). */
export function RowListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="rounded-xl border border-border bg-card/50 p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-3 w-64 max-w-full" />
            </div>
            <Skeleton className="h-6 w-20 shrink-0 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A row of summary tiles, as the broadcast detail page opens with. */
export function StatRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-xl border border-border bg-card p-4">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-3 h-6 w-12" />
        </div>
      ))}
    </div>
  );
}

/**
 * The flow / automation editors: a header bar, a toolbar row, then one
 * large bordered stage filling the rest of the viewport. Shaped to
 * `FlowEditorShell` so the stage doesn't jump into place.
 */
export function EditorSkeleton({ label }: { label: string }) {
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      aria-busy="true"
      aria-label={label}
    >
      <div className="flex items-center justify-between gap-4 px-6 py-4">
        <div className="min-w-0 space-y-2">
          <Skeleton className="h-5 w-52" />
          <Skeleton className="h-3 w-32" />
        </div>
        <div className="flex shrink-0 gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
      <div className="flex items-center gap-4 px-6 pb-3.5">
        <Skeleton className="h-9 w-44 rounded-lg" />
      </div>
      <Skeleton className="mx-6 mb-6 min-h-0 flex-1 rounded-xl" />
    </div>
  );
}
