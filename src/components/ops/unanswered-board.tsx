"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Spinner } from "@/components/ui/spinner";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  UserRound,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useRealtime } from "@/hooks/use-realtime";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  SLA_THRESHOLDS,
  formatWait,
  measureWait,
  slaState,
  type SlaState,
  type SlaTier,
} from "@/lib/ops/sla";
import {
  loadUnanswered,
  sortByUrgency,
  type UnansweredItem,
} from "@/lib/ops/unanswered";
import {
  loadResponseTimeCards,
  type ResponseTimeCards as Cards,
} from "@/lib/ops/response-time";
import { loadFailedMessages, type FailedMessage } from "@/lib/ops/failed-messages";
import { ResponseTimeCards } from "./response-time-cards";
import { FailedMessagesAlert } from "./failed-messages-alert";

/**
 * "Belum Dibalas" — the operations worklist.
 *
 * One page, three things, top to bottom in the order a supervisor
 * reads them: how are we doing (First Response Time cards), what
 * silently broke (Failed Message Alert), what needs a reply now (the
 * board). They share one reload so a Realtime event refreshes all
 * three together.
 *
 * Refresh strategy (existing patterns only, no new deps):
 *   - Realtime: the shared `useRealtime` hook fires on any change to
 *     `messages` / `conversations`. Events are coalesced with a short
 *     debounce so a burst of inserts triggers one reload, not ten.
 *   - Clock tick: the SLA state of a waiting row changes with time even
 *     when nothing is written, so the board re-evaluates each row
 *     against a fresh `now` every 30s without touching the network.
 *   - Safety net: a full reload every 2 minutes in case a Realtime
 *     event was missed (tab backgrounded, socket dropped).
 *
 * Status is never colour alone: every row carries an icon and a text
 * label for its state, and the group headers say it in words.
 */

const TICK_MS = 30_000;
const SAFETY_RELOAD_MS = 120_000;
const REALTIME_DEBOUNCE_MS = 800;

type Member = { user_id: string; full_name: string | null };

const STATE_META: Record<
  SlaState,
  {
    labelKey: string;
    icon: typeof AlertTriangle;
    /** Left rule on rows + summary tiles — reinforces, never replaces, the label. */
    rule: string;
    badge: string;
  }
> = {
  breached: {
    labelKey: "stateBreached",
    icon: AlertTriangle,
    rule: "border-l-2 border-l-red-500",
    badge:
      "border-destructive/70 bg-destructive/10 text-destructive",
  },
  warning: {
    labelKey: "stateWarning",
    icon: Clock,
    rule: "border-l-2 border-l-amber-500",
    badge:
      "border-warning/70 bg-warning/10 text-warning",
  },
  ok: {
    labelKey: "stateOk",
    icon: CheckCircle2,
    rule: "border-l-2 border-l-emerald-500",
    badge:
      "border-success/70 bg-success/10 text-success",
  },
};

const GROUP_ORDER: SlaState[] = ["breached", "warning", "ok"];

export function UnansweredBoard() {
  const t = useTranslations("Ops.unanswered");

  const [items, setItems] = useState<UnansweredItem[] | null>(null);
  const [cards, setCards] = useState<Cards | null>(null);
  const [failed, setFailed] = useState<FailedMessage[] | null>(null);
  const [members, setMembers] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const [now, setNow] = useState(() => new Date());

  const inFlight = useRef(false);

  const reload = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    const db = createClient();
    const fresh = new Date();
    // Each section settles independently so one slow query never
    // blanks the others — the same shape the dashboard page uses.
    const results = await Promise.allSettled([
      loadUnanswered(db, fresh),
      loadResponseTimeCards(db, fresh),
      loadFailedMessages(db, fresh),
    ]);
    const [u, c, f] = results;
    if (u.status === "fulfilled") setItems(u.value);
    if (c.status === "fulfilled") setCards(c.value);
    if (f.status === "fulfilled") setFailed(f.value);
    const firstError = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (firstError) {
      console.error("[ops] load failed:", firstError.reason);
      setError(
        firstError.reason instanceof Error
          ? firstError.reason.message
          : String(firstError.reason),
      );
    } else {
      setError(null);
    }
    setNow(fresh);
    setLastLoadedAt(fresh);
    inFlight.current = false;
    setRefreshing(false);
  }, []);

  // Agent names for the "assigned" line. Same RLS-bounded profiles
  // read the inbox assign dropdown uses; only the two columns we show.
  useEffect(() => {
    let cancelled = false;
    createClient()
      .from("profiles")
      .select("user_id, full_name")
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) {
          console.error("[ops] profiles failed:", err);
          return;
        }
        const map = new Map<string, string>();
        for (const row of (data ?? []) as Member[]) {
          if (row.full_name) map.set(row.user_id, row.full_name);
        }
        setMembers(map);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Kick the first load off the effect's synchronous body — `reload`
    // flips `refreshing` immediately, and setting state inside an
    // effect body is what the set-state-in-effect rule guards against.
    const first = setTimeout(() => void reload(), 0);
    const id = setInterval(() => void reload(), SAFETY_RELOAD_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [reload]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReload = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void reload(), REALTIME_DEBOUNCE_MS);
  }, [reload]);
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);
  // Scoped to the active zone so the channel is rebuilt on a switch;
  // this board reloads wholesale on any event, so it has no cached rows
  // of its own to clear beyond what that reload replaces.
  const { accountId } = useAuth();
  const { isConnected } = useRealtime({
    channelName: "ops-unanswered-board",
    accountId,
    onMessageEvent: scheduleReload,
    onConversationEvent: scheduleReload,
  });

  // Between reloads, re-run the SLA clock against the current `now` so
  // a row that crosses a threshold changes state and moves group
  // without waiting for the next fetch.
  const visibleItems = useMemo(() => {
    if (!items) return [];
    return sortByUrgency(
      items.map((item) => {
        const wait = measureWait(new Date(item.waitingSince), now);
        return {
          ...item,
          waitedMinutes: wait.minutes,
          tier: wait.tier,
          state: slaState(wait.minutes, wait.tier),
        };
      }),
    );
  }, [items, now]);

  const groups = useMemo(() => {
    const map = new Map<SlaState, UnansweredItem[]>();
    for (const state of GROUP_ORDER) map.set(state, []);
    for (const item of visibleItems) map.get(item.state)!.push(item);
    return map;
  }, [visibleItems]);

  return (
    <div className="space-y-5">
      {/* 1. First Response Time */}
      <ResponseTimeCards cards={cards} />

      {/* 2. Failed Message Alert */}
      <FailedMessagesAlert failed={failed} now={now} />

      {/* 3. The board */}
      <section aria-labelledby="board-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="board-heading" className="text-base font-semibold text-foreground">
              {t("boardHeading")}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("thresholds", {
                officeTarget: SLA_THRESHOLDS.office.targetMinutes,
                officeBreach: SLA_THRESHOLDS.office.breachMinutes,
                classTarget: SLA_THRESHOLDS.class.targetMinutes,
                classBreach: SLA_THRESHOLDS.class.breachMinutes,
              })}
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span
                className={cn(
                  "inline-block h-2 w-2 rounded-full",
                  isConnected ? "bg-success" : "bg-muted-foreground/50",
                )}
                aria-hidden
              />
              {isConnected ? t("live") : t("polling")}
              {lastLoadedAt && (
                <span className="hidden sm:inline">
                  {" · "}
                  {t("updatedAt", {
                    time: lastLoadedAt.toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                  })}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => void reload()}
              disabled={refreshing}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-60"
            >
              {refreshing ? (
                <Spinner size="sm" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              )}
              {t("refresh")}
            </button>
          </div>
        </div>

        {/* Summary tiles — same card frame as the dashboard metrics. */}
        <div className="grid grid-cols-3 gap-3">
          {GROUP_ORDER.map((state) => {
            const meta = STATE_META[state];
            const Icon = meta.icon;
            return (
              <div
                key={state}
                className={cn(
                  "rounded-xl border border-border bg-card p-3 sm:p-4",
                  meta.rule,
                )}
              >
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground sm:text-sm">
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{t(meta.labelKey)}</span>
                </div>
                <p className="mt-1.5 text-2xl leading-none font-semibold tabular-nums text-foreground sm:text-[28px]">
                  {items === null ? "—" : groups.get(state)!.length}
                </p>
              </div>
            );
          })}
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/70 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {t("loadError")} <span className="font-mono text-xs">{error}</span>
          </div>
        )}

        {items === null ? (
          <BoardSkeleton />
        ) : visibleItems.length === 0 ? (
          <EmptyState label={t("empty")} hint={t("emptyHint")} />
        ) : (
          <div className="space-y-6">
            {GROUP_ORDER.map((state) => {
              const rows = groups.get(state)!;
              if (rows.length === 0) return null;
              const meta = STATE_META[state];
              const Icon = meta.icon;
              return (
                <section key={state} aria-labelledby={`group-${state}`}>
                  <h3
                    id={`group-${state}`}
                    className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground"
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    {t(meta.labelKey)}
                    <Badge variant="secondary" className="tabular-nums">
                      {rows.length}
                    </Badge>
                  </h3>
                  <ul className="space-y-2">
                    {rows.map((item) => (
                      <BoardRow
                        key={item.conversationId}
                        item={item}
                        agentName={
                          item.assignedAgentId
                            ? (members.get(item.assignedAgentId) ?? null)
                            : null
                        }
                        now={now}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function BoardRow({
  item,
  agentName,
  now,
}: {
  item: UnansweredItem;
  agentName: string | null;
  now: Date;
}) {
  const t = useTranslations("Ops.unanswered");
  const meta = STATE_META[item.state];
  const Icon = meta.icon;
  const title = item.contactName ?? item.contactPhone ?? t("unknownContact");
  const showPhone = !!item.contactName && !!item.contactPhone;

  // Wall-clock "since" next to the covered wait — a parent who wrote
  // Thursday night has waited days on their own clock even if the SLA
  // clock only counts minutes.
  const sinceLabel = relativeSince(new Date(item.waitingSince), now, t);

  return (
    <li className={cn("rounded-xl border border-border bg-card", meta.rule)}>
      <Link
        href={`/inbox?c=${encodeURIComponent(item.conversationId)}`}
        className="block rounded-xl px-3 py-3 hover:bg-card-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:px-4"
        aria-label={t("openConversation", { name: title })}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="truncate text-sm font-semibold text-foreground">
                {title}
              </span>
              {showPhone && (
                <span className="truncate text-xs tabular-nums text-muted-foreground">
                  {item.contactPhone}
                </span>
              )}
            </div>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              {item.preview}
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end sm:gap-1.5">
            <Badge variant="outline" className={meta.badge}>
              <Icon aria-hidden />
              {t(meta.labelKey)}
            </Badge>
            <span className="inline-flex items-center gap-1 text-xs tabular-nums text-foreground">
              <Clock className="h-3 w-3 text-muted-foreground" aria-hidden />
              <span className="font-semibold">{formatWait(item.waitedMinutes)}</span>
              <span className="text-muted-foreground">
                {t("coveredWait", { tier: tierLabel(item.tier, t) })}
              </span>
            </span>
            <span className="text-[11px] text-muted-foreground">{sinceLabel}</span>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <UserRound className="h-3 w-3" aria-hidden />
              {agentName ?? t("unassigned")}
            </span>
          </div>
        </div>
      </Link>
    </li>
  );
}

function tierLabel(
  tier: SlaTier | null,
  t: ReturnType<typeof useTranslations>,
): string {
  if (tier === "office") return t("tierOffice");
  if (tier === "class") return t("tierClass");
  return t("tierOffDuty");
}

function relativeSince(
  at: Date,
  now: Date,
  t: ReturnType<typeof useTranslations>,
): string {
  const mins = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (mins < 1) return t("sentJustNow");
  if (mins < 60) return t("sentMinutesAgo", { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("sentHoursAgo", { count: hours });
  return t("sentDaysAgo", { count: Math.floor(hours / 24) });
}

function BoardSkeleton() {
  const t = useTranslations("Ops.unanswered");
  return (
    <ul className="space-y-2" aria-busy="true" aria-label={t("loadingBoard")}>
      {Array.from({ length: 4 }).map((_, i) => (
        <li
          key={i}
          className="h-[76px] animate-pulse rounded-xl border border-border bg-muted/40"
        />
      ))}
    </ul>
  );
}

function EmptyState({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center">
      <CheckCircle2 className="mx-auto h-8 w-8 text-success" aria-hidden />
      <p className="mt-3 text-sm font-semibold text-foreground">{label}</p>
      <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
    </div>
  );
}
