"use client";

import { useEffect, useRef } from "react";
import { Building2, Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { useZones } from "@/hooks/use-zones";
import { currentZoneName, shouldShowSwitcher } from "@/lib/auth/zones";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Which zone am I in — and, for HQ, a way to move.
 *
 * Most staff belong to exactly one zone and get a label, not a control:
 * a menu whose only entry is the thing already selected reads as
 * something that should do more than it can. Only a user who is a member
 * of more than one zone sees a trigger at all (`shouldShowSwitcher`).
 *
 * Everything account-scoped in the app keys off `useAuth().accountId`,
 * so the switch is deliberately small — see `use-zones` for why moving
 * that one value is what clears the previous zone off the screen.
 */
export function ZoneSwitcher() {
  const t = useTranslations("ZoneSwitcher");
  const { account, accountId } = useAuth();
  const { zones, switchingTo, error, switchTo } = useZones();

  const switching = switchingTo !== null;

  // `my_accounts()` lands a moment after the profile does, so fall back
  // to the account name `useAuth` already holds — the header should
  // never flash an empty zone on the way in.
  const name = currentZoneName(zones, account?.name);
  const canSwitch = shouldShowSwitcher(zones);

  // Report a failure once per failure, not once per render.
  const reportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!error) {
      reportedRef.current = null;
      return;
    }
    const key = `${error}:${switchingTo ?? ""}`;
    if (reportedRef.current === key) return;
    reportedRef.current = key;
    // Both messages end by saying where the user still is, because the
    // guarantee that matters after a failed switch is that nothing moved.
    toast.error(
      error === "not_member" ? t("errorNotMember") : t("errorFailed"),
      { description: name ? t("stillIn", { zone: name }) : undefined },
    );
  }, [error, switchingTo, name, t]);

  if (!name) return null;

  if (!canSwitch) {
    // One zone: say which, and stop. No trigger, no chevron, nothing to
    // click and nothing to wonder about.
    return (
      <span
        className="hidden min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground sm:flex"
        title={t("currentZone", { zone: name })}
      >
        <Building2 className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{name}</span>
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={switching}
        aria-label={t("openZoneMenu", { zone: name })}
        aria-busy={switching}
        className={cn(
          "flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-foreground transition-colors",
          "hover:bg-muted/70 focus:bg-muted/70 focus:outline-none data-popup-open:bg-muted/70",
          // Not just visually disabled: `disabled` above already refuses
          // the click, and the guard in `useZones.switchTo` refuses a
          // second one that beats the re-render.
          switching && "cursor-wait opacity-70",
        )}
      >
        {switching ? (
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
        ) : (
          <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="max-w-32 truncate sm:max-w-48">{name}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="w-auto min-w-56 bg-popover text-popover-foreground ring-border"
      >
        <DropdownMenuLabel>{t("menuLabel")}</DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-border" />
        {zones.map((zone) => {
          const isActive = zone.id === accountId || zone.isActive;
          const isTarget = switchingTo === zone.id;
          return (
            <DropdownMenuItem
              key={zone.id}
              // Every entry locks while a switch is in flight, not only
              // the one clicked: a second zone chosen mid-switch would
              // race the first and land the user somewhere neither click
              // asked for.
              disabled={switching || isActive}
              onClick={() => {
                void switchTo(zone.id);
              }}
              className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
            >
              {isTarget ? (
                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
              ) : isActive ? (
                <Check className="size-4 shrink-0" aria-hidden />
              ) : (
                <span className="size-4 shrink-0" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate">{zone.name}</span>
              {zone.role ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t(`role.${zone.role}`)}
                </span>
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
