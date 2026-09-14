"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

/**
 * Google sign-in, shared by /login and /signup.
 *
 * There is only one button for both because OAuth has no separate
 * sign-up: Google hands back a verified identity, and Supabase either
 * finds the user or creates them. The `handle_new_user` trigger then
 * provisions their profile, personal account and membership row, so a
 * first-time Google visitor arrives at the dashboard already set up.
 *
 * Registration is deliberately open — anyone with a Google account may
 * sign up. Staff who do that before redeeming their invitation are not
 * stranded: redeeming is additive (migration 044 inserts an
 * `account_members` row rather than moving the profile), so they simply
 * gain the zone on top of the personal account they already have.
 *
 * `label` is passed in rather than translated here because /login is
 * internationalised and /signup is not yet; keeping the string at the
 * call site avoids forcing one convention onto the other page.
 */
export function GoogleButton({
  label,
  next,
  disabled,
}: {
  label: string;
  /** Same-origin path to land on after the exchange. */
  next?: string;
  disabled?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const callback = new URL("/auth/callback", window.location.origin);
    if (next) callback.searchParams.set("next", next);

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callback.toString() },
    });

    // On success the browser is already navigating to Google, so there is
    // nothing to reset — only the failure path returns here.
    if (error) {
      setError(error.message);
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div className="rounded-lg border border-destructive/70 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        onClick={handleClick}
        disabled={disabled || loading}
        className="h-10 w-full border-border text-foreground hover:bg-muted"
      >
        <GoogleMark />
        {label}
      </Button>
    </div>
  );
}

/**
 * Google's mark, inlined. lucide-react carries no brand icons, and the
 * four-colour logo must keep its own colours in both themes, so the
 * paths are not `currentColor`.
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.96 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
