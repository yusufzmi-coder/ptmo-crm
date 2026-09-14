"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { errorKeyFor } from "@/lib/issues/labels";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type {
  Centre,
  Contact,
  IssueCategory,
  IssueSeverity,
} from "@/types";

/**
 * Every category and severity, in display order.
 *
 * Written as a Record keyed by the union rather than an array of it,
 * because `IssueCategory[]` happily accepts a list that is MISSING a
 * member. Add a tenth category to the type and an array here keeps
 * compiling while the option silently stops being offered; a Record
 * fails the build until this file names it too.
 *
 * The API validates against its own copy in route.ts, which is a const
 * local rather than an export — see the handoff. Until that is shared,
 * this is the closest thing to a link between them: both are pinned to
 * the same union, so neither can drift without the type moving first.
 */
const CATEGORY_ORDER: Record<IssueCategory, number> = {
  progress: 0,
  keselamatan: 1,
  staf: 2,
  servis: 3,
  yuran: 4,
  jadual: 5,
  pendaftaran: 6,
  fasiliti: 7,
  lain: 8,
};
const CATEGORIES = (Object.keys(CATEGORY_ORDER) as IssueCategory[]).sort(
  (a, b) => CATEGORY_ORDER[a] - CATEGORY_ORDER[b],
);

const SEVERITY_ORDER: Record<IssueSeverity, number> = {
  biasa: 0,
  penting: 1,
  kritikal: 2,
};
const SEVERITIES = (Object.keys(SEVERITY_ORDER) as IssueSeverity[]).sort(
  (a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b],
);


/** Sentinel for "no centre" — Select cannot carry an empty string value. */
const NO_CENTRE = "__none__";

/**
 * Which centre a contact's tags point at.
 *
 * A contact is linked to a branch today only by carrying a tag whose
 * NAME matches a centre's name. There is no foreign key and no
 * tags.centre_id, so this match is the only signal available.
 *
 * It is used to PRE-SELECT, never to decide. What gets stored is the
 * centre_id the human confirmed — a real FK. Freezing a name match into
 * an FK at the moment the case opens means renaming a centre later does
 * not orphan old cases: the match is fragile, the stored id is not.
 *
 * Returns null when nothing matches, and the caller leaves the field
 * empty rather than guessing. A case with no centre is better than a
 * case filed against the wrong one.
 */
export function suggestCentreId(
  contact: Pick<Contact, "tags"> | null | undefined,
  centres: Pick<Centre, "id" | "name">[],
): string | null {
  const tagNames = new Set(
    (contact?.tags ?? []).map((t) => t.name.trim().toLowerCase()),
  );
  if (tagNames.size === 0) return null;
  const hit = centres.find((c) => tagNames.has(c.name.trim().toLowerCase()));
  return hit?.id ?? null;
}

interface OpenCaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  contact: Contact | null;
}

export function OpenCaseDialog({
  open,
  onOpenChange,
  conversationId,
  contact,
}: OpenCaseDialogProps) {
  const t = useTranslations("Issues.create");
  const tCategory = useTranslations("Issues.category");
  const tSeverity = useTranslations("Issues.severity");
  const tError = useTranslations("Issues.errors");

  const [centres, setCentres] = useState<Centre[]>([]);
  const [summary, setSummary] = useState("");
  const [category, setCategory] = useState<IssueCategory>("lain");
  const [severity, setSeverity] = useState<IssueSeverity>("biasa");
  const [centreId, setCentreId] = useState<string>(NO_CENTRE);
  const [saving, setSaving] = useState(false);

  // Centres come straight from the table, the same way the settings
  // panel reads them. RLS scopes the rows to the caller's account.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const { data } = await createClient()
        .from("centres")
        .select("id, name, region_id, account_id, is_active")
        .eq("is_active", true)
        .order("name");
      if (!cancelled && data) setCentres(data as Centre[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const suggested = useMemo(
    () => suggestCentreId(contact, centres),
    [contact, centres],
  );

  // Pre-select once the centres land. Only while the field is still
  // untouched — re-running this after the agent picked something would
  // overwrite their choice with a guess.
  useEffect(() => {
    if (open && suggested && centreId === NO_CENTRE) setCentreId(suggested);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggested, open]);

  const reset = useCallback(() => {
    setSummary("");
    setCategory("lain");
    setSeverity("biasa");
    setCentreId(NO_CENTRE);
  }, []);

  const submit = useCallback(async () => {
    const trimmed = summary.trim();
    if (!trimmed) {
      toast.error(tError("summaryRequired"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: trimmed,
          category,
          severity,
          centre_id: centreId === NO_CENTRE ? null : centreId,
          contact_id: contact?.id ?? null,
          conversation_id: conversationId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(tError(errorKeyFor(data?.error)));
        return;
      }
      const id = data?.issue?.id as string | undefined;
      toast.success(t("opened"), {
        action: id
          ? { label: t("viewCase"), onClick: () => window.open(`/issues/${id}`, "_self") }
          : undefined,
      });
      reset();
      onOpenChange(false);
    } catch {
      toast.error(tError("saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [
    summary,
    category,
    severity,
    centreId,
    contact,
    conversationId,
    onOpenChange,
    reset,
    t,
    tError,
  ]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              {t("summaryLabel")}
            </label>
            <Textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder={t("summaryPlaceholder")}
              rows={3}
              className="bg-muted"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                {t("categoryLabel")}
              </label>
              <Select
                value={category}
                onValueChange={(v) => setCategory(v as IssueCategory)}
              >
                <SelectTrigger className="bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {tCategory(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                {t("severityLabel")}
              </label>
              <Select
                value={severity}
                onValueChange={(v) => setSeverity(v as IssueSeverity)}
              >
                <SelectTrigger className="bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {tSeverity(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              {t("centreLabel")}
            </label>
            <Select
              value={centreId}
              onValueChange={(v) => setCentreId(v ?? NO_CENTRE)}
            >
              <SelectTrigger className="bg-muted">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CENTRE}>{t("centreNone")}</SelectItem>
                {centres.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {suggested && centreId === suggested && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("centreFromTag")}
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t("cancel")}
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Spinner size="sm" className="mr-1" />}
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
