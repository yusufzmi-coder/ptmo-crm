"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { toast } from "sonner";

import type { Issue, IssueEvent, IssueSeverity, IssueStatus } from "@/types";
import { allowedTransitions, isResolvedStatus } from "@/lib/issues/status";
import { relativeTime } from "@/lib/time/relative";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EditorSkeleton } from "../../page-skeletons";

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

export default function IssueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const t = useTranslations("Issues.detail");
  const tStatus = useTranslations("Issues.status");
  const tSeverity = useTranslations("Issues.severity");
  const tCategory = useTranslations("Issues.category");
  const tErrors = useTranslations("Issues.errors");
  const tRel = useTranslations("RelativeTime");

  const [issue, setIssue] = useState<Issue | null>(null);
  const [events, setEvents] = useState<IssueEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [target, setTarget] = useState<IssueStatus | "">("");
  const [resolution, setResolution] = useState("");
  const [saving, setSaving] = useState(false);

  type LoadResult =
    | { kind: "ok"; issue: Issue; events: IssueEvent[] }
    | { kind: "notFound" }
    | { kind: "error" };

  const load = useCallback(async (): Promise<LoadResult> => {
    const res = await fetch(`/api/issues/${id}`);
    const json = await res.json().catch(() => ({}));
    if (res.status === 404) return { kind: "notFound" };
    if (!res.ok) return { kind: "error" };
    return {
      kind: "ok",
      issue: json.issue as Issue,
      events: (json.events ?? []) as IssueEvent[],
    };
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await load();
        if (cancelled) return;
        if (r.kind === "notFound") {
          setNotFound(true);
          return;
        }
        if (r.kind === "error") {
          toast.error(tErrors("loadFailed"));
          return;
        }
        setIssue(r.issue);
        setEvents(r.events);
      } catch {
        if (!cancelled) toast.error(tErrors("loadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function save() {
    if (!issue || !target) return;

    // A case closed without a record of what was done is a case lost in a
    // different way, so `resolved` will not go through without one.
    const needsResolution = isResolvedStatus(target);
    if (needsResolution && resolution.trim() === "") {
      toast.error(t("resolutionRequired"));
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/issues/${issue.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: target,
          ...(needsResolution ? { resolution: resolution.trim() } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));

      if (res.status === 422 && json.from && json.to) {
        // The route names which move it refused. Showing "save failed"
        // here would hide the one fact worth knowing.
        toast.error(
          tErrors("invalidTransition", {
            from: tStatus(json.from as IssueStatus),
            to: tStatus(json.to as IssueStatus),
          }),
        );
        return;
      }
      if (!res.ok) {
        toast.error(tErrors("saveFailed"));
        return;
      }

      const next = await load();
      if (next.kind === "ok") {
        setIssue(next.issue);
        setEvents(next.events);
      }
      setTarget("");
      setResolution("");
    } catch {
      toast.error(tErrors("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <EditorSkeleton label={t("back")} />;

  if (notFound || !issue) {
    return (
      <div className="space-y-4 p-6">
        <Button variant="ghost" size="sm" onClick={() => router.push("/issues")}>
          <ArrowLeft className="size-4" />
          {t("back")}
        </Button>
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <p className="text-sm font-medium text-foreground">{t("notFound")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("notFoundHint")}</p>
        </div>
      </div>
    );
  }

  // Only the moves the machine actually allows. Rendering seven buttons
  // and refusing six teaches people to guess.
  const moves = allowedTransitions(issue.status);

  return (
    <div className="space-y-6 p-6">
      <Button variant="ghost" size="sm" onClick={() => router.push("/issues")}>
        <ArrowLeft className="size-4" />
        {t("back")}
      </Button>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Chip className={SEVERITY_CLASS[issue.severity]}>
            {tSeverity(issue.severity)}
          </Chip>
          <Chip className={STATUS_CLASS[issue.status]}>{tStatus(issue.status)}</Chip>
          <span className="text-xs text-muted-foreground">
            {tCategory(issue.category)}
          </span>
        </div>
        <h1 className="text-2xl font-semibold text-foreground">{issue.summary}</h1>
      </header>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-border bg-card p-4 text-sm sm:grid-cols-3">
        <Field label={t("openedAt")}>
          <time dateTime={issue.opened_at}>
            {relativeTime(issue.opened_at, tRel, { style: "full" })}
          </time>
        </Field>
        {issue.resolved_at ? (
          <Field label={t("resolvedAt")}>
            <time dateTime={issue.resolved_at}>
              {relativeTime(issue.resolved_at, tRel, { style: "full" })}
            </time>
          </Field>
        ) : null}
        {issue.due_at ? (
          <Field label={t("dueAt")}>
            <time dateTime={issue.due_at}>
              {relativeTime(issue.due_at, tRel, { style: "full" })}
            </time>
          </Field>
        ) : null}
      </dl>

      {issue.conversation_id ? (
        <Link
          href={`/inbox?c=${issue.conversation_id}`}
          className="inline-flex items-center gap-1.5 text-sm text-primary-readable hover:underline"
        >
          <MessageSquare className="size-4" aria-hidden />
          {t("viewConversation")}
        </Link>
      ) : null}

      {issue.resolution ? (
        <section className="rounded-xl border border-success/70 bg-success/10 p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-success">
            {t("resolutionLabel")}
          </h2>
          <p className="mt-1 text-sm text-foreground">{issue.resolution}</p>
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">{t("changeStatus")}</h2>
        {moves.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noTransitions")}</p>
        ) : (
          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap gap-2">
              {moves.map((m) => (
                <Button
                  key={m}
                  size="sm"
                  variant={target === m ? "default" : "outline"}
                  onClick={() => setTarget(m)}
                >
                  {t("moveTo", { status: tStatus(m) })}
                </Button>
              ))}
            </div>

            {target && isResolvedStatus(target) ? (
              <div className="space-y-1.5">
                <label
                  htmlFor="issue-resolution"
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("resolutionLabel")}
                </label>
                <Textarea
                  id="issue-resolution"
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  placeholder={t("resolutionPlaceholder")}
                  rows={3}
                />
              </div>
            ) : null}

            {target ? (
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? t("saving") : t("save")}
              </Button>
            ) : null}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">{t("timeline")}</h2>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("timelineEmpty")}</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {events.map((ev) => (
              <li
                key={ev.id}
                className="rounded-lg border border-border bg-card p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {ev.from_status ? (
                    <>
                      <Chip className={STATUS_CLASS[ev.from_status]}>
                        {tStatus(ev.from_status)}
                      </Chip>
                      <span aria-hidden className="text-muted-foreground">
                        →
                      </span>
                    </>
                  ) : null}
                  <Chip className={STATUS_CLASS[ev.to_status]}>
                    {tStatus(ev.to_status)}
                  </Chip>
                  <time
                    dateTime={ev.created_at}
                    className="text-xs text-muted-foreground"
                  >
                    {relativeTime(ev.created_at, tRel, { style: "full" })}
                  </time>
                </div>
                {ev.note ? (
                  <p className="mt-1.5 text-muted-foreground">{ev.note}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-foreground">{children}</dd>
    </div>
  );
}
