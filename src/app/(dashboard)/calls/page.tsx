"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Phone, PhoneIncoming, PhoneOutgoing, Search } from "lucide-react";

import type { CallLog, CallOutcome } from "@/types";
import {
  CALL_DIRECTIONS,
  CALL_OUTCOMES,
  formatDuration,
} from "@/lib/calls/labels";
import { relativeTime } from "@/lib/time/relative";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { LogCallDialog } from "@/components/calls/log-call-dialog";
import { PageSkeleton, RowListSkeleton } from "../page-skeletons";

/**
 * The calls a thread cannot show.
 *
 * A parent asks about fees on WhatsApp, the branch phones them back, and
 * the thread stops mid-sentence. Whoever covers the evening shift reads
 * a conversation that looks abandoned and calls the same parent again.
 * This page is where that call was written down.
 *
 * Outcome is the only thing coloured, and only the two that mean someone
 * still owes the parent something. Colouring all five would make the
 * page a rainbow in which nothing stands out — which is the same
 * argument the issues list makes for leaving categories uncoloured.
 */
const OUTCOME_CLASS: Record<CallOutcome, string> = {
  dijawab: "border-success/70 bg-success/10 text-success",
  tidak_dijawab: "border-warning/70 bg-warning/10 text-warning",
  tinggal_mesej: "border-border bg-muted text-muted-foreground",
  call_balik: "border-warning/70 bg-warning/10 text-warning",
  nombor_salah: "border-border bg-muted text-muted-foreground",
};

const ALL = "__all__";

export default function CallsPage() {
  const t = useTranslations("Calls.list");
  const tDirection = useTranslations("Calls.direction");
  const tOutcome = useTranslations("Calls.outcome");
  const tErrors = useTranslations("Calls.errors");
  const tRel = useTranslations("RelativeTime");
  const supabase = createClient();

  const [calls, setCalls] = useState<CallLog[]>([]);
  const [contacts, setContacts] = useState<Record<string, string>>({});
  const [people, setPeople] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);
  /**
   * `call_logs` arrives with migration 051, and the apply is a human
   * step while the deploy is a merge. When the code is ahead, the route
   * answers with an empty list and says so rather than 500ing, and the
   * page has to say so too — otherwise an empty page reads as "no calls
   * logged yet" and nobody ever applies the migration.
   */
  const [unavailable, setUnavailable] = useState(false);

  const [q, setQ] = useState("");
  const [direction, setDirection] = useState<string>(ALL);
  const [outcome, setOutcome] = useState<string>(ALL);
  const [dueOnly, setDueOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/calls");
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!cancelled) setLoadError(tErrors("loadFailed"));
          return;
        }
        if (!cancelled) {
          setCalls(json.calls ?? []);
          setUnavailable(json.call_logging === "unavailable");
        }

        // Names for the rows. Read through the browser client so RLS
        // scopes them; a failure here costs the labels, not the page,
        // so it deliberately does not set loadError.
        const [c, p] = await Promise.all([
          supabase.from("contacts").select("id,name,phone"),
          supabase.from("profiles").select("user_id,full_name,email"),
        ]);
        if (cancelled) return;
        setContacts(
          Object.fromEntries(
            (c.data ?? []).map((row) => [
              row.id as string,
              ((row.name as string | null) ?? (row.phone as string)) || "",
            ]),
          ),
        );
        setPeople(
          Object.fromEntries(
            (p.data ?? []).map((row) => [
              row.user_id as string,
              (row.full_name as string | null) ?? (row.email as string),
            ]),
          ),
        );
      } catch {
        if (!cancelled) setLoadError(tErrors("loadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `supabase` is a fresh client object each render; including it would
    // refetch on every render. Same reason the issues list leaves it out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return calls.filter((call) => {
      if (direction !== ALL && call.direction !== direction) return false;
      if (outcome !== ALL && call.outcome !== outcome) return false;
      if (dueOnly && !call.follow_up_at) return false;
      if (!needle) return true;
      const who = call.contact_id ? (contacts[call.contact_id] ?? "") : "";
      return (
        call.summary.toLowerCase().includes(needle) ||
        who.toLowerCase().includes(needle)
      );
    });
  }, [calls, q, direction, outcome, dueOnly, contacts]);

  const filtersOn =
    q.trim() !== "" || direction !== ALL || outcome !== ALL || dueOnly;

  if (loading) {
    return (
      <PageSkeleton label={t("title")}>
        <RowListSkeleton count={6} />
      </PageSkeleton>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Button
          type="button"
          onClick={() => setLogging(true)}
          disabled={unavailable}
        >
          <Phone className="size-4" />
          {t("logCall")}
        </Button>
      </div>

      {unavailable ? (
        <p className="rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-warning">
          {t("unavailable")}
        </p>
      ) : null}

      {loadError ? (
        <p className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {loadError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("search")}
            aria-label={t("search")}
            className="pl-8"
          />
        </div>

        {/* Native selects, not the Select component: these are three
            plain filters on a dense list, and a portalled listbox for
            each costs more than it gives. The issues list makes the
            same call. */}
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          aria-label={t("allDirections")}
          className="h-9 rounded-md border border-border bg-card px-2 text-sm text-foreground"
        >
          <option value={ALL}>{t("allDirections")}</option>
          {CALL_DIRECTIONS.map((d) => (
            <option key={d} value={d}>
              {tDirection(d)}
            </option>
          ))}
        </select>

        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          aria-label={t("allOutcomes")}
          className="h-9 rounded-md border border-border bg-card px-2 text-sm text-foreground"
        >
          <option value={ALL}>{t("allOutcomes")}</option>
          {CALL_OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {tOutcome(o)}
            </option>
          ))}
        </select>

        <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2.5 text-sm text-foreground">
          <input
            type="checkbox"
            checked={dueOnly}
            onChange={(e) => setDueOnly(e.target.checked)}
            className="size-3.5 accent-primary"
          />
          {t("dueOnly")}
        </label>

        {filtersOn && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setQ("");
              setDirection(ALL);
              setOutcome(ALL);
              setDueOnly(false);
            }}
          >
            {t("clearFilters")}
          </Button>
        )}

        <span className="text-xs text-muted-foreground tabular-nums">
          {t("count", { count: filtered.length })}
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Phone}
          title={t("empty")}
          hint={t("emptyHint")}
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {filtered.map((call) => {
            const who = call.contact_id ? contacts[call.contact_id] : null;
            const by = call.logged_by ? people[call.logged_by] : null;
            const length = formatDuration(call.duration_seconds);
            const DirectionIcon =
              call.direction === "masuk" ? PhoneIncoming : PhoneOutgoing;

            return (
              <li key={call.id} className="flex gap-3 px-4 py-3">
                <DirectionIcon
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-sm font-medium text-foreground">
                      {who ?? tDirection(call.direction)}
                    </span>
                    <span
                      className={`rounded-full border px-1.5 py-0.5 text-[11px] font-medium ${OUTCOME_CLASS[call.outcome]}`}
                    >
                      {tOutcome(call.outcome)}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {relativeTime(call.called_at, tRel)}
                    </span>
                    {length && (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {t("duration", { duration: length })}
                      </span>
                    )}
                  </div>

                  <p className="mt-1 text-sm text-muted-foreground">
                    {call.summary}
                  </p>

                  <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                    {/* The promise, shown wherever the call is shown. A
                        callback recorded on a row nobody re-reads is the
                        same as one nobody wrote down. */}
                    {call.follow_up_at && (
                      <span className="font-medium text-warning">
                        {t("followUp", {
                          when: relativeTime(call.follow_up_at, tRel),
                        })}
                      </span>
                    )}
                    <span>
                      {t("loggedBy", { name: by ?? t("unknownPerson") })}
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <LogCallDialog
        open={logging}
        onOpenChange={setLogging}
        onLogged={(call) => setCalls((prev) => [call, ...prev])}
      />
    </div>
  );
}
