"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus, Search } from "lucide-react";

import type { Issue, IssueCategory, IssueSeverity, IssueStatus } from "@/types";
import { ISSUE_STATUSES } from "@/lib/issues/status";
import { relativeTime } from "@/lib/time/relative";
import { createClient } from "@/lib/supabase/client";
import { useCan } from "@/hooks/use-can";
import { GatedButton } from "@/components/ui/gated-button";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PageSkeleton, CardGridSkeleton } from "../page-skeletons";

/**
 * Severity and status are STATE, not identity — an issue's colour reports
 * how much trouble it is in, so both come from the status token scale
 * rather than a hand-picked hue. Categories deliberately get no colour at
 * all: nine of them would need nine hues, and none of those hues would
 * mean anything.
 */
const SEVERITY_CLASS: Record<IssueSeverity, string> = {
  kritikal: "border-destructive/70 bg-destructive/10 text-destructive",
  penting: "border-warning/70 bg-warning/10 text-warning",
  biasa: "border-border bg-muted text-muted-foreground",
};

const STATUS_CLASS: Record<IssueStatus, string> = {
  new: "border-border bg-muted text-muted-foreground",
  acknowledged: "border-info/70 bg-info/10 text-info",
  investigating: "border-info/70 bg-info/10 text-info",
  waiting: "border-border bg-muted text-muted-foreground",
  resolution_proposed: "border-info/70 bg-info/10 text-info",
  resolved: "border-success/70 bg-success/10 text-success",
  reopened: "border-warning/70 bg-warning/10 text-warning",
};

const CATEGORIES: readonly IssueCategory[] = [
  "progress",
  "keselamatan",
  "staf",
  "servis",
  "yuran",
  "jadual",
  "pendaftaran",
  "fasiliti",
  "lain",
];

const SEVERITIES: readonly IssueSeverity[] = ["kritikal", "penting", "biasa"];

const ALL = "__all__";

export default function IssuesPage() {
  const router = useRouter();
  const t = useTranslations("Issues.list");
  const tStatus = useTranslations("Issues.status");
  const tSeverity = useTranslations("Issues.severity");
  const tCategory = useTranslations("Issues.category");
  const tErrors = useTranslations("Issues.errors");
  const tRel = useTranslations("RelativeTime");
  const canCreate = useCan("send-messages");
  const supabase = createClient();

  const [issues, setIssues] = useState<Issue[]>([]);
  const [centres, setCentres] = useState<Record<string, string>>({});
  const [people, setPeople] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>(ALL);
  const [category, setCategory] = useState<string>(ALL);
  const [severity, setSeverity] = useState<string>(ALL);
  const [centre, setCentre] = useState<string>(ALL);
  const [assignee, setAssignee] = useState<string>(ALL);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/issues");
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!cancelled) setLoadError(tErrors("loadFailed"));
          return;
        }
        if (!cancelled) setIssues(json.issues ?? []);

        // Names for the centre and assignee filters. Read through the
        // browser client so RLS scopes them; a failure here costs the
        // labels, not the page, so it is not allowed to set loadError.
        const [c, p] = await Promise.all([
          supabase.from("centres").select("id,name"),
          supabase.from("profiles").select("id,full_name,email"),
        ]);
        if (cancelled) return;
        setCentres(
          Object.fromEntries(
            (c.data ?? []).map((row) => [row.id as string, row.name as string]),
          ),
        );
        setPeople(
          Object.fromEntries(
            (p.data ?? []).map((row) => [
              row.id as string,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One pass, client-side. The set is small and RLS already scoped it, so
  // pushing these onto the route would add query params for nothing.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return issues.filter((i) => {
      if (status !== ALL && i.status !== status) return false;
      if (category !== ALL && i.category !== category) return false;
      if (severity !== ALL && i.severity !== severity) return false;
      if (centre !== ALL && (i.centre_id ?? "") !== centre) return false;
      if (assignee !== ALL && (i.assigned_to ?? "") !== assignee) return false;
      if (needle && !i.summary.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [issues, q, status, category, severity, centre, assignee]);

  const filtersActive =
    q.trim() !== "" ||
    status !== ALL ||
    category !== ALL ||
    severity !== ALL ||
    centre !== ALL ||
    assignee !== ALL;

  function clearFilters() {
    setQ("");
    setStatus(ALL);
    setCategory(ALL);
    setSeverity(ALL);
    setCentre(ALL);
    setAssignee(ALL);
  }

  if (loading) {
    return (
      <PageSkeleton label={t("title")}>
        <CardGridSkeleton count={6} />
      </PageSkeleton>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <GatedButton
          canAct={canCreate}
          gateReasonKey="createFlows"
          onClick={() => router.push("/issues/new")}
        >
          <Plus className="h-4 w-4" />
          {t("createButton")}
        </GatedButton>
      </header>

      {loadError ? (
        <div className="rounded-lg border border-destructive/70 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {loadError}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("colSummary")}
            className="pl-8"
            aria-label={t("colSummary")}
          />
        </div>

        <FilterSelect
          label={t("filterStatus")}
          value={status}
          onChange={setStatus}
          allLabel={t("filterAll")}
          options={ISSUE_STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
        />
        <FilterSelect
          label={t("filterSeverity")}
          value={severity}
          onChange={setSeverity}
          allLabel={t("filterAll")}
          options={SEVERITIES.map((s) => ({ value: s, label: tSeverity(s) }))}
        />
        <FilterSelect
          label={t("filterCategory")}
          value={category}
          onChange={setCategory}
          allLabel={t("filterAll")}
          options={CATEGORIES.map((c) => ({ value: c, label: tCategory(c) }))}
        />
        <FilterSelect
          label={t("filterCentre")}
          value={centre}
          onChange={setCentre}
          allLabel={t("filterAll")}
          options={Object.entries(centres).map(([id, name]) => ({
            value: id,
            label: name,
          }))}
        />
        <FilterSelect
          label={t("filterAssignee")}
          value={assignee}
          onChange={setAssignee}
          allLabel={t("filterAll")}
          options={Object.entries(people).map(([id, name]) => ({
            value: id,
            label: name,
          }))}
        />

        {filtersActive ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            {t("clearFilters")}
          </Button>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        /* Two different sentences on purpose. "Nothing here" and "nothing
           matches" send a reader to different places, and collapsing them
           is what makes a filter look broken. */
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <p className="text-sm font-medium text-foreground">
            {filtersActive ? t("emptyFiltered") : t("empty")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {filtersActive ? t("emptyFilteredHint") : t("emptyHint")}
          </p>
          {filtersActive ? (
            <Button variant="outline" size="sm" className="mt-4" onClick={clearFilters}>
              {t("clearFilters")}
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((issue) => (
            <li key={issue.id}>
              <button
                type="button"
                onClick={() => router.push(`/issues/${issue.id}`)}
                className="flex w-full flex-col gap-2 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Chip className={SEVERITY_CLASS[issue.severity]}>
                    {tSeverity(issue.severity)}
                  </Chip>
                  <Chip className={STATUS_CLASS[issue.status]}>
                    {tStatus(issue.status)}
                  </Chip>
                  <span className="text-xs text-muted-foreground">
                    {tCategory(issue.category)}
                  </span>
                </div>

                <p className="text-sm font-medium text-foreground">{issue.summary}</p>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    {issue.centre_id
                      ? (centres[issue.centre_id] ?? t("noCentre"))
                      : t("noCentre")}
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    {issue.assigned_to
                      ? (people[issue.assigned_to] ?? t("unassigned"))
                      : t("unassigned")}
                  </span>
                  <span aria-hidden>·</span>
                  <time dateTime={issue.opened_at}>
                    {relativeTime(issue.opened_at, tRel, { style: "full" })}
                  </time>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Chip({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  allLabel,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  allLabel: string;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <option value={ALL}>{`${label}: ${allLabel}`}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
