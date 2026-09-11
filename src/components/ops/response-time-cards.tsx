"use client";

import { useTranslations } from "next-intl";
import { CheckCircle2, Clock, AlertTriangle, CalendarDays } from "lucide-react";
import { MetricCard } from "@/components/dashboard/metric-card";
import { SkeletonCard } from "@/components/dashboard/skeleton";
import { formatWait, SLA_THRESHOLDS } from "@/lib/ops/sla";
import type { ResponseTimeCards as Cards } from "@/lib/ops/response-time";

/**
 * First Response Time — four dashboard-style metric cards on the SLA
 * clock. Reuses the dashboard's MetricCard so this reads as the same
 * product, not a bolt-on. "Within target" is the headline: the share of
 * replies that landed inside their shift's target (5 min office, 15 min
 * class), which is the number the team is chasing.
 */
export function ResponseTimeCards({ cards }: { cards: Cards | null }) {
  const t = useTranslations("Ops.responseTime");

  if (!cards) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  const { today, week } = cards;
  const pct = (v: number | null) => (v === null ? "—" : `${v}%`);
  const mins = (v: number | null) => (v === null ? "—" : formatWait(v));

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <MetricCard
        title={t("withinTargetToday")}
        value={pct(today.withinTargetPct)}
        icon={CheckCircle2}
        subtitle={
          today.answered === 0
            ? t("noRepliesYet")
            : t("ofAnswered", { within: today.withinTarget, total: today.answered })
        }
      />
      <MetricCard
        title={t("medianToday")}
        value={mins(today.medianMinutes)}
        icon={Clock}
        subtitle={
          today.worstMinutes === null
            ? t("onTheClock", {
                office: SLA_THRESHOLDS.office.targetMinutes,
                cls: SLA_THRESHOLDS.class.targetMinutes,
              })
            : t("slowestToday", { wait: formatWait(today.worstMinutes) })
        }
      />
      <MetricCard
        title={t("lateToday")}
        value={String(today.late)}
        icon={AlertTriangle}
        subtitle={
          today.pastTarget > 0
            ? t("pastTargetToday", { count: today.pastTarget })
            : t("lateHint", {
                office: SLA_THRESHOLDS.office.breachMinutes,
                cls: SLA_THRESHOLDS.class.breachMinutes,
              })
        }
      />
      <MetricCard
        title={t("withinTargetWeek")}
        value={pct(week.withinTargetPct)}
        icon={CalendarDays}
        subtitle={
          week.answered === 0
            ? t("noRepliesWeek")
            : t("ofAnsweredWeek", {
                within: week.withinTarget,
                total: week.answered,
                median: mins(week.medianMinutes),
              })
        }
      />
    </div>
  );
}
