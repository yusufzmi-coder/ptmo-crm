"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Loader2, MessageSquare, Zap } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BranchedQuickReply, QuickReply } from "@/types";
import { interactivePayloadPreviewText } from "@/lib/whatsapp/interactive";
import { cn } from "@/lib/utils";

interface QuickReplyPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (qr: QuickReply) => void;
}

/**
 * Lists the account's saved quick replies for insertion into the
 * composer. Text snippets fill the textarea; interactive snippets open
 * the builder pre-filled (handled by the caller's `onPick`).
 *
 * Branch awareness (migration 043) is deliberately invisible to the
 * caller: the conversation id comes from the `?c=` deep link this page
 * already drives its thread from, not from a new prop, and the API
 * returns text with `{{cawangan}}` ALREADY resolved. So the composer
 * inserts whatever it is handed and never learns what a branch is.
 *
 * Reading the id from the URL rather than from props also means the
 * branch the server resolves is the branch of the thread actually on
 * screen — there is no second copy of that state to fall out of sync.
 */
export function QuickReplyPicker({
  open,
  onOpenChange,
  onPick,
}: QuickReplyPickerProps) {
  const t = useTranslations("Inbox.composer");
  const searchParams = useSearchParams();
  const conversationId = searchParams.get("c");

  const [items, setItems] = useState<BranchedQuickReply[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        // Without a thread this is the plain account list — the same
        // response the settings screen gets, with no branch rules.
        const url = conversationId
          ? `/api/quick-replies?conversationId=${encodeURIComponent(conversationId)}`
          : "/api/quick-replies";
        const res = await fetch(url, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) {
          setItems((data.quick_replies as BranchedQuickReply[]) ?? []);
          setBranch((data.branch as string | null) ?? null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, conversationId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("quickReplies")}</DialogTitle>
          {/* Who the agent is about to speak as. The thread header says
              this too, but it is muted 12px text at the far end of a
              truncating line — and the snippet they are about to pick
              may name a centre. Say it where the choice is made. */}
          {branch && (
            <p className="text-xs font-medium text-primary">
              {t("quickRepliesFor", { branch })}
            </p>
          )}
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("quickRepliesEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {items.map((qr) => {
                // A tokenised snippet on a thread with no branch cannot
                // be filled in. Offering it anyway would send either a
                // blank where the centre's name belongs or the literal
                // braces, so it is shown greyed with the reason rather
                // than hidden — a snippet that silently disappears
                // reads as a bug and sends the agent to Settings.
                const blocked = qr.branch_unresolved === true;
                const foreign = qr.foreign_branches ?? [];
                const pinned = qr.whatsapp_config_id != null;

                return (
                  <li key={qr.id}>
                    <button
                      type="button"
                      disabled={blocked}
                      onClick={() => onPick(qr)}
                      title={
                        blocked
                          ? t("quickReplyUnavailableHint")
                          : undefined
                      }
                      className={cn(
                        "flex w-full items-start gap-2 rounded-md border p-2.5 text-left",
                        blocked
                          ? "cursor-not-allowed border-border bg-muted/20 opacity-60"
                          : "border-border bg-muted/40 hover:border-primary/50 hover:bg-muted",
                      )}
                    >
                      {qr.kind === "interactive" ? (
                        <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      ) : (
                        <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                            {qr.title}
                          </span>
                          {pinned && branch && (
                            <span className="shrink-0 rounded-full border border-primary-soft-2 bg-primary-soft px-1.5 py-0.5 text-[10px] font-medium text-primary">
                              {t("quickReplyPinned", { branch })}
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {qr.kind === "interactive" && qr.interactive_payload
                            ? interactivePayloadPreviewText(qr.interactive_payload)
                            : qr.content_text}
                        </span>
                        {/* The snippet names a centre that is not this
                            thread's. Nothing stops the agent sending it
                            — the wording may be deliberate — but they
                            should not find out from the parent. */}
                        {foreign.length > 0 && (
                          <span className="mt-1 flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                            {t("quickReplyForeignBranch", {
                              branches: foreign.join(", "),
                            })}
                          </span>
                        )}
                        {blocked && (
                          <span className="mt-1 block text-[11px] font-medium text-muted-foreground">
                            {t("quickReplyUnavailable")}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
