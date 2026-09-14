"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CheckCircle, ArrowLeft, Loader2 } from "lucide-react";
import { BrandAuthHeader } from "@/components/brand/brand-logo";

// Where a password reset link actually lands.
//
// `forgot-password/page.tsx` sends Supabase a `redirectTo` of
// `/auth/callback?next=/reset-password`. That callback exchanges the
// one-time code for a session and then forwards here, so by the time this
// page renders the visitor already holds a recovery session — that session
// IS the proof they control the mailbox, which is why there is no "current
// password" field (unlike `components/settings/password-form.tsx`, where the
// user is merely signed in and must re-authenticate).
//
// This page is deliberately absent from both lists in `src/middleware.ts`:
// not in `protectedPaths`, because a redirect to /login would tell someone
// with an expired link nothing about what went wrong; and not in the
// already-signed-in redirect list, because the recovery session would then
// bounce every legitimate arrival to /dashboard before they could type a new
// password.

const MIN_PASSWORD = 8;

type SessionState = "checking" | "valid" | "missing";

export default function ResetPasswordPage() {
  const t = useTranslations("ResetPasswordPage");
  const supabase = createClient();

  const [sessionState, setSessionState] = useState<SessionState>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // The callback writes the auth cookies before redirecting here, so the
    // browser client can read the session straight out of storage — no
    // network round trip and no token in the URL to leak via the referrer.
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSessionState(data.session ? "valid" : "missing");
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD) {
      setError(t("errorTooShort", { min: MIN_PASSWORD }));
      return;
    }
    if (password !== confirm) {
      setError(t("errorMismatch"));
      return;
    }

    setSaving(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });

    if (updateError) {
      setError(updateError.message);
      setSaving(false);
      return;
    }

    setSuccess(true);
    setSaving(false);
  };

  if (sessionState === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // No recovery session: the link was already used, has expired, or someone
  // navigated here directly. Say so, and offer the one action that helps.
  if (sessionState === "missing") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="items-center text-center">
            <BrandAuthHeader />
            <CardTitle className="text-[1.35rem] font-semibold leading-tight tracking-tight text-foreground">
              {t("expiredTitle")}
            </CardTitle>
            <CardDescription className="text-[0.9375rem] leading-relaxed text-muted-foreground">
              {t("expiredDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/forgot-password">
              <Button className="h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90">
                {t("requestNewLink")}
              </Button>
            </Link>
            <Link
              href="/login"
              className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              {t("backToSignIn")}
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <CheckCircle className="h-6 w-6 text-primary-readable" />
            </div>
            <CardTitle className="text-[1.35rem] font-semibold leading-tight tracking-tight text-foreground">
              {t("successTitle")}
            </CardTitle>
            <CardDescription className="text-[0.9375rem] leading-relaxed text-muted-foreground">
              {t("successDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/dashboard">
              <Button className="h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90">
                {t("continueToDashboard")}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <BrandAuthHeader />
          <CardTitle className="text-[1.35rem] font-semibold leading-tight tracking-tight text-foreground">
            {t("title")}
          </CardTitle>
          <CardDescription className="text-[0.9375rem] leading-relaxed text-muted-foreground">
            {t("desc", { min: MIN_PASSWORD })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-destructive/70 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                {t("newPasswordLabel")}
              </Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                disabled={saving}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm-password" className="text-muted-foreground">
                {t("confirmPasswordLabel")}
              </Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                disabled={saving}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <Button
              type="submit"
              disabled={saving || !password || !confirm}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? t("updating") : t("submit")}
            </Button>
          </form>

          <Link
            href="/login"
            className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {t("backToSignIn")}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
