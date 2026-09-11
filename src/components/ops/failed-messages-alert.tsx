"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, ChevronRight } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { FailedMessage } from "@/lib/ops/failed-messages";

/**
 * Failed Message Alert — the WACRM `Alert` primitive in its destructive
 * variant, listing outbound messages Meta could not deliver. Each row
 * deep-links to the thread so staff can resend from the real composer;
 * nothing here sends anything itself.
 */
export function FailedMessagesAlert({
  failed,
  now,
}: {
  failed: FailedMessage[] | null;
  now: Date;
}) {
  const t = useTranslations("Ops.failed");

  if (failed === null) return null;

  if (failed.length === 0) {
    return (
      <Alert>
        <CheckCircle2 className="text-emerald-600 dark:text-emerald-400" />
        <AlertTitle>{t("noneTitle")}</AlertTitle>
        <AlertDescription>{t("noneDesc")}</AlertDescription>
      </Alert>
    );
  }

  const shown = failed.slice(0, 8);
  const more = failed.length - shown.length;

  return (
    <Alert variant="destructive" className="border-destructive/40">
      <AlertTriangle />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        {t("title", { count: failed.length })}
        <Badge variant="destructive">{t("badge")}</Badge>
      </AlertTitle>
      <AlertDescription className="text-foreground/80">
        <p className="mb-2">{t("desc")}</p>
        <ul className="divide-y divide-border rounded-md border border-border bg-card">
          {shown.map((f) => {
            const who = f.contactName ?? f.contactPhone ?? t("unknownContact");
            return (
              <li key={f.messageId}>
                <Link
                  href={`/inbox?c=${encodeURIComponent(f.conversationId)}`}
                  className="flex items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="truncate font-medium">{who}</span>
                      {f.contactName && f.contactPhone && (
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {f.contactPhone}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {relative(new Date(f.failedAt), now, t)}
                        {f.senderType === "bot" ? ` · ${t("byBot")}` : ""}
                      </span>
                    </span>
                    <span className="mt-0.5 line-clamp-1 text-muted-foreground">
                      {f.preview}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
        {more > 0 && <p className="mt-2 text-xs">{t("more", { count: more })}</p>}
      </AlertDescription>
    </Alert>
  );
}

function relative(
  at: Date,
  now: Date,
  t: ReturnType<typeof useTranslations>,
): string {
  const mins = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (mins < 60) return t("minutesAgo", { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("hoursAgo", { count: hours });
  return t("daysAgo", { count: Math.floor(hours / 24) });
}
