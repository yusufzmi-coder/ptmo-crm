"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import {
  CALL_DIRECTIONS,
  CALL_OUTCOMES,
  callErrorKey,
  needsFollowUp,
  parseDurationMinutes,
} from "@/lib/calls/labels";
import type { CallDirection, CallLog, CallOutcome } from "@/types";

/**
 * Log a phone call.
 *
 * The form is short on purpose. Every field beyond the four that matter
 * — which way, what came of it, when, and what was said — is one more
 * reason for a busy branch to skip logging the call at all, and an
 * unlogged call is the failure this whole feature exists to stop.
 *
 * `datetime-local` rather than a date picker component: it is the one
 * control that already understands "a time today", it is keyboard- and
 * screen-reader-native, and staff filling this in are typing up a shift
 * rather than browsing a calendar.
 */

interface LogCallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefilled links, when the call is logged from a thread or a case. */
  contactId?: string | null;
  conversationId?: string | null;
  centreId?: string | null;
  issueId?: string | null;
  /** Called with the saved row so the list can show it without refetching. */
  onLogged?: (call: CallLog) => void;
}

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in LOCAL time, not an ISO Z. */
function localInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function LogCallDialog({
  open,
  onOpenChange,
  contactId = null,
  conversationId = null,
  centreId = null,
  issueId = null,
  onLogged,
}: LogCallDialogProps) {
  const t = useTranslations("Calls.log");
  const tDirection = useTranslations("Calls.direction");
  const tOutcome = useTranslations("Calls.outcome");
  const tErrors = useTranslations("Calls.errors");

  const [direction, setDirection] = useState<CallDirection>("keluar");
  const [outcome, setOutcome] = useState<CallOutcome>("dijawab");
  const [calledAt, setCalledAt] = useState(() => localInputValue(new Date()));
  const [duration, setDuration] = useState("");
  const [summary, setSummary] = useState("");
  const [followUpAt, setFollowUpAt] = useState("");
  const [saving, setSaving] = useState(false);

  // Reset on open, not on close: a dialog that clears as it animates
  // away shows the user their words disappearing.
  useEffect(() => {
    if (!open) return;
    setDirection("keluar");
    setOutcome("dijawab");
    setCalledAt(localInputValue(new Date()));
    setDuration("");
    setSummary("");
    setFollowUpAt("");
  }, [open]);

  // Prompting for a callback time is driven by the outcome, because the
  // outcome is what knows whether the parent is still waiting. Clearing
  // it when the outcome turns finished matters as much as showing it:
  // otherwise picking "no answer", typing a time, then correcting to
  // "answered" leaves a callback nobody intends to make.
  const wantsFollowUp = needsFollowUp(outcome);
  useEffect(() => {
    if (!wantsFollowUp) setFollowUpAt("");
  }, [wantsFollowUp]);

  async function handleSave() {
    if (saving) return;

    const trimmed = summary.trim();
    if (!trimmed) {
      toast.error(tErrors("summaryRequired"));
      return;
    }

    // undefined means "typed something unusable" — distinct from null,
    // which means the box was left empty. See parseDurationMinutes.
    const seconds = parseDurationMinutes(duration);
    if (seconds === undefined) {
      toast.error(tErrors("invalidDuration"));
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          direction,
          outcome,
          summary: trimmed,
          // The input is local wall-clock time; the column is
          // TIMESTAMPTZ. `new Date(local)` reads it in the browser's
          // zone, which is the zone the person typing it meant.
          called_at: new Date(calledAt).toISOString(),
          duration_seconds: seconds,
          follow_up_at: followUpAt ? new Date(followUpAt).toISOString() : null,
          contact_id: contactId,
          conversation_id: conversationId,
          centre_id: centreId,
          issue_id: issueId,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(tErrors(callErrorKey(json.error)));
        return;
      }
      toast.success(t("saved"));
      onLogged?.(json.call as CallLog);
      onOpenChange(false);
    } catch {
      toast.error(tErrors("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="call-direction">{t("directionLabel")}</Label>
              <Select
                value={direction}
                onValueChange={(v) => setDirection(v as CallDirection)}
              >
                <SelectTrigger id="call-direction">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CALL_DIRECTIONS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {tDirection(d)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="call-outcome">{t("outcomeLabel")}</Label>
              <Select
                value={outcome}
                onValueChange={(v) => setOutcome(v as CallOutcome)}
              >
                <SelectTrigger id="call-outcome">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CALL_OUTCOMES.map((o) => (
                    <SelectItem key={o} value={o}>
                      {tOutcome(o)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="call-when">{t("calledAtLabel")}</Label>
              <Input
                id="call-when"
                type="datetime-local"
                value={calledAt}
                onChange={(e) => setCalledAt(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="call-duration">{t("durationLabel")}</Label>
              <Input
                id="call-duration"
                inputMode="decimal"
                placeholder={t("durationPlaceholder")}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="call-summary">{t("summaryLabel")}</Label>
            <Textarea
              id="call-summary"
              rows={4}
              placeholder={t("summaryPlaceholder")}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>

          {wantsFollowUp && (
            <div className="space-y-1.5">
              <Label htmlFor="call-followup">{t("followUpLabel")}</Label>
              <Input
                id="call-followup"
                type="datetime-local"
                value={followUpAt}
                onChange={(e) => setFollowUpAt(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("followUpHint")}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t("cancel")}
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={saving}>
            {saving && <Spinner size="sm" className="mr-1" />}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
