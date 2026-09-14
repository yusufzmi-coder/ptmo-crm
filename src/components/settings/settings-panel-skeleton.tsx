import { Skeleton } from '@/components/dashboard/skeleton';

/**
 * Loading placeholder for a whole settings panel.
 *
 * Every panel here opens the same way — a heading with a description,
 * usually an action button opposite it, then a stack of cards or rows —
 * so six panels were each rendering their own centred spinner in a tall
 * empty box and then filling it in one jump. This stands in that space
 * instead, at roughly the height the panel will take.
 *
 * Deliberately a local component rather than an addition to the shared
 * `Skeleton` primitive: that one is used across four workstreams and is
 * not mine to change.
 */
export function SettingsPanelSkeleton({
  rows = 3,
  label,
  action = true,
}: {
  /** How many card rows to stand in for. */
  rows?: number;
  /** Announced by screen readers in place of the panel. */
  label: string;
  /** Whether this panel has an action button beside its heading. */
  action?: boolean;
}) {
  return (
    <section className="space-y-6" aria-busy="true" aria-label={label}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-3.5 w-72 max-w-full" />
        </div>
        {action && <Skeleton className="h-9 w-32 shrink-0" />}
      </div>
      <div className="space-y-3">
        {Array.from({ length: rows }, (_, i) => (
          <div
            key={i}
            className="rounded-xl border border-border bg-card/50 p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56 max-w-full" />
              </div>
              <Skeleton className="h-8 w-20 shrink-0" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
