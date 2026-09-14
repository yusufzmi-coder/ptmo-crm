'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Building2,
  Check,
  Copy,
  Link2,
  Loader2,
  MapPin,
  Phone,
  Plus,
  QrCode,
  Download,
  Trash2,
} from 'lucide-react';
import { SettingsPanelSkeleton } from './settings-panel-skeleton';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Automation, Centre, Region, Tag } from '@/types';
import {
  branchBlocker,
  buildBranchAutomation,
  buildWaLink,
  findBranchAutomation,
  isValidCode,
  suggestCode,
} from './branch-link';
import { encodeQr, qrSvg } from './qr';

/** Sentinel for "no zone" -- Radix Select cannot hold an empty value. */
const NO_ZONE = '__none__';

interface PendingDelete {
  kind: 'region' | 'centre';
  id: string;
  name: string;
}

const EMPTY_FORM = {
  name: '',
  code: '',
  region_id: NO_ZONE,
  phone: '',
  address: '',
  operating_hours: '',
};

/**
 * Centres & zones.
 *
 * A centre stopped being a WhatsApp number in migration 049. This is
 * where they are kept: the branch list HQ escalates to, grouped by
 * zone. Settings-class, so RLS only lets an admin write -- a non-admin
 * simply gets an error from Postgres rather than a hidden button,
 * which matches how the other settings cards behave.
 */
export function CentresPanel() {
  const t = useTranslations('Settings.centres');
  const supabase = createClient();
  const { accountId, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [regions, setRegions] = useState<Region[]>([]);
  const [centres, setCentres] = useState<Centre[]>([]);

  const [newZone, setNewZone] = useState('');
  const [savingZone, setSavingZone] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [savingCentre, setSavingCentre] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleting, setDeleting] = useState(false);

  /**
   * The one number every parent now writes to, as Meta formats it. Comes
   * from the config route's `phone_info`, which verifies the PRIMARY number
   * only — which is exactly the number the links must point at.
   */
  const [waNumber, setWaNumber] = useState<string | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [automations, setAutomations] = useState<
    Pick<Automation, 'id' | 'trigger_type' | 'trigger_config'>[]
  >([]);

  /** Per-centre transient UI: the code being edited, and what is in flight. */
  const [codeDraft, setCodeDraft] = useState<Record<string, string>>({});
  const [busyCentre, setBusyCentre] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /** Branch whose QR is open. One dialog, not sixteen inline codes. */
  const [qrFor, setQrFor] = useState<Centre | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    try {
      setLoading(true);
      const [r, c, tg, au] = await Promise.all([
        supabase
          .from('regions')
          .select('*')
          .eq('account_id', accountId)
          .order('sort_order')
          .order('name'),
        supabase
          .from('centres')
          .select('*')
          .eq('account_id', accountId)
          .order('name'),
        supabase.from('tags').select('*').eq('account_id', accountId).order('name'),
        supabase
          .from('automations')
          .select('id, trigger_type, trigger_config')
          .eq('account_id', accountId),
      ]);
      if (r.error) throw r.error;
      if (c.error) throw c.error;
      setRegions((r.data ?? []) as Region[]);
      setCentres((c.data ?? []) as Centre[]);
      // Tags and automations decide whether a branch is already wired; a
      // failure to read them is not fatal to the panel, it just means the
      // setup button cannot tell you the answer yet.
      if (!tg.error) setTags((tg.data ?? []) as Tag[]);
      if (!au.error) {
        setAutomations(
          (au.data ?? []) as Pick<Automation, 'id' | 'trigger_type' | 'trigger_config'>[],
        );
      }

      // The number the links point at. Best-effort: if WhatsApp is not
      // connected the rows say so rather than showing a broken link.
      try {
        const res = await fetch('/api/whatsapp/config');
        const payload = await res.json();
        setWaNumber(payload?.phone_info?.display_phone_number ?? null);
      } catch {
        setWaNumber(null);
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => {
    if (authLoading) return;
    if (!accountId) {
      setLoading(false);
      return;
    }
    load();
  }, [authLoading, accountId, load]);

  // Centres bucketed by zone, unassigned last. Pure derivation so the
  // list re-groups the moment a zone is added or removed.
  const grouped = useMemo(() => {
    const byZone = regions.map((region) => ({
      region,
      rows: centres.filter((c) => c.region_id === region.id),
    }));
    const orphans = centres.filter((c) => !c.region_id);
    return { byZone, orphans };
  }, [regions, centres]);

  async function addZone() {
    const name = newZone.trim();
    if (!name) {
      toast.error(t('nameRequired'));
      return;
    }
    if (!accountId) return;
    setSavingZone(true);
    try {
      const { error } = await supabase
        .from('regions')
        .insert({ account_id: accountId, name });
      if (error) throw error;
      setNewZone('');
      toast.success(t('zoneAdded'));
      await load();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSavingZone(false);
    }
  }

  async function addCentre() {
    const name = form.name.trim();
    if (!name) {
      toast.error(t('nameRequired'));
      return;
    }
    if (!accountId) return;
    setSavingCentre(true);
    try {
      const { error } = await supabase.from('centres').insert({
        account_id: accountId,
        name,
        // Blank is allowed: the admin can fill it in from the list, where
        // they can see the link it produces.
        code: form.code.trim() || null,
        region_id: form.region_id === NO_ZONE ? null : form.region_id,
        phone: form.phone.trim() || null,
        address: form.address.trim() || null,
        operating_hours: form.operating_hours.trim() || null,
      });
      if (error) throw error;
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      toast.success(t('centreAdded'));
      await load();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSavingCentre(false);
    }
  }

  /** Persist a branch's link keyword. */
  async function saveCode(centre: Centre) {
    const code = (codeDraft[centre.id] ?? '').trim().toLowerCase();
    if (!isValidCode(code)) {
      toast.error(t('codeInvalid'));
      return;
    }
    // Two branches sharing a keyword means every message lands on both
    // tags, which is worse than a branch with no keyword at all.
    const clash = centres.find((c) => c.id !== centre.id && c.code === code);
    if (clash) {
      toast.error(t('codeTaken', { name: clash.name }));
      return;
    }
    setBusyCentre(centre.id);
    try {
      const { error } = await supabase.from('centres').update({ code }).eq('id', centre.id);
      if (error) throw error;
      toast.success(t('codeSaved'));
      await load();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusyCentre(null);
    }
  }

  /**
   * Wire a branch up: a tag named after it, and an automation that applies
   * that tag when a message carries the branch keyword.
   *
   * Idempotent by necessity, not by politeness. Sixteen branches means this
   * runs sixteen times, by hand, and a double-tap must not produce a second
   * automation on the same keyword — two automations matching one keyword
   * both fire, and the thread ends up double-tagged.
   */
  async function setupBranch(centre: Centre) {
    if (!accountId || !centre.code) return;
    const code = centre.code;

    setBusyCentre(centre.id);
    try {
      const existing = findBranchAutomation(automations, code);
      if (existing) {
        toast.info(t('setupAlreadyDone'));
        return;
      }

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        toast.error(t('setupFailed'));
        return;
      }

      // Reuse a tag of the same name rather than creating a duplicate —
      // the admin may well have made it by hand already.
      let tag = tags.find((x) => x.name.toLowerCase() === centre.name.toLowerCase());
      if (!tag) {
        const { data, error } = await supabase
          .from('tags')
          .insert({
            user_id: user.id,
            account_id: accountId,
            name: centre.name,
            color: '#0a77bb',
          })
          .select('*')
          .single();
        if (error) throw error;
        tag = data as Tag;
      }

      const res = await fetch('/api/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...buildBranchAutomation(centre.name, code, tag.id), is_active: true }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error ?? t('setupFailed'));
        return;
      }

      toast.success(t('setupDone', { name: centre.name }));
      await load();
    } catch {
      toast.error(t('setupFailed'));
    } finally {
      setBusyCentre(null);
    }
  }

  async function copyLink(centre: Centre, link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(centre.id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const table = pendingDelete.kind === 'region' ? 'regions' : 'centres';
      const { error } = await supabase.from(table).delete().eq('id', pendingDelete.id);
      if (error) throw error;
      setPendingDelete(null);
      toast.success(t('deleted'));
      await load();
    } catch {
      toast.error(t('deleteFailed'));
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    // No action button beside this panel's heading.
    return <SettingsPanelSkeleton rows={3} action={false} label={t('loading')} />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </div>

      {/* ---- zones ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('zonesTitle')}</CardTitle>
          <CardDescription>{t('zonesDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={newZone}
              onChange={(e) => setNewZone(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addZone();
              }}
              placeholder={t('zonePlaceholder')}
            />
            <Button onClick={addZone} disabled={savingZone}>
              {savingZone ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              {t('addZone')}
            </Button>
          </div>

          {regions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noZones')}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {regions.map((region) => (
                <span
                  key={region.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 py-1 pl-3 pr-1.5 text-sm text-foreground"
                >
                  {region.name}
                  <button
                    type="button"
                    aria-label={`${t('delete')} ${region.name}`}
                    onClick={() =>
                      setPendingDelete({ kind: 'region', id: region.id, name: region.name })
                    }
                    className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- centres ---- */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">{t('centresTitle')}</CardTitle>
            <CardDescription>{t('centresDesc')}</CardDescription>
          </div>
          <Button onClick={() => setDialogOpen(true)} className="flex-shrink-0">
            <Plus className="size-4" />
            {t('addCentre')}
          </Button>
        </CardHeader>
        <CardContent>
          {centres.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('noCentres')}
            </p>
          ) : (
            <div className="space-y-5">
              {[
                ...grouped.byZone.map(({ region, rows }) => ({
                  key: region.id,
                  label: region.name,
                  rows,
                })),
                ...(grouped.orphans.length
                  ? [{ key: NO_ZONE, label: t('unassigned'), rows: grouped.orphans }]
                  : []),
              ].map(({ key, label, rows }) => (
                <div key={key}>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {label}
                  </p>
                  {rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">—</p>
                  ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                      {rows.map((centre) => (
                        <li key={centre.id} className="px-3 py-2.5">
                        <div className="flex items-center gap-3">
                          <Building2 className="size-4 flex-shrink-0 text-primary-readable" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-foreground">
                              {centre.name}
                            </p>
                            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                              {centre.phone && (
                                <span className="inline-flex items-center gap-1">
                                  <Phone className="size-3" />
                                  {centre.phone}
                                </span>
                              )}
                              {centre.address && (
                                <span className="inline-flex min-w-0 items-center gap-1">
                                  <MapPin className="size-3 flex-shrink-0" />
                                  <span className="truncate">{centre.address}</span>
                                </span>
                              )}
                            </div>
                          </div>
                          <button
                            type="button"
                            aria-label={`${t('delete')} ${centre.name}`}
                            onClick={() =>
                              setPendingDelete({
                                kind: 'centre',
                                id: centre.id,
                                name: centre.name,
                              })
                            }
                            className="flex-shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                        <BranchWiring
                          centre={centre}
                          waNumber={waNumber}
                          wired={Boolean(centre.code && findBranchAutomation(automations, centre.code))}
                          draft={codeDraft[centre.id] ?? ''}
                          onDraft={(v) => setCodeDraft((d) => ({ ...d, [centre.id]: v }))}
                          busy={busyCentre === centre.id}
                          copied={copied === centre.id}
                          onSaveCode={() => saveCode(centre)}
                          onSetup={() => setupBranch(centre)}
                          onCopy={(link) => copyLink(centre, link)}
                          onShowQr={() => setQrFor(centre)}
                          t={t}
                        />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- QR for one branch ---- */}
      <Dialog open={Boolean(qrFor)} onOpenChange={(o) => !o && setQrFor(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{qrFor?.name}</DialogTitle>
            <DialogDescription>{t('qrDesc')}</DialogDescription>
          </DialogHeader>
          {qrFor?.code && waNumber ? (
            <BranchQr centre={qrFor} link={buildWaLink(waNumber, qrFor.code)} t={t} />
          ) : null}
        </DialogContent>
      </Dialog>

      {/* ---- add centre ---- */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('newCentre')}</DialogTitle>
            <DialogDescription>{t('centresDesc')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t('nameLabel')}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('namePlaceholder')}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t('codeLabel')}</Label>
              <Input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toLowerCase() })}
                placeholder={form.name ? suggestCode(form.name) : t('codePlaceholder')}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">{t('codeHint')}</p>
            </div>

            <div className="space-y-1.5">
              <Label>{t('zoneLabel')}</Label>
              <Select
                value={form.region_id}
                onValueChange={(v) => setForm({ ...form, region_id: v ?? NO_ZONE })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_ZONE}>{t('none')}</SelectItem>
                  {regions.map((region) => (
                    <SelectItem key={region.id} value={region.id}>
                      {region.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>{t('phoneLabel')}</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder={t('phonePlaceholder')}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t('addressLabel')}</Label>
              <Input
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t('hoursLabel')}</Label>
              <Input
                value={form.operating_hours}
                onChange={(e) =>
                  setForm({ ...form, operating_hours: e.target.value })
                }
                placeholder={t('hoursPlaceholder')}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={addCentre} disabled={savingCentre}>
              {savingCentre && <Loader2 className="size-4 animate-spin" />}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- delete confirm ---- */}
      <Dialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingDelete?.kind === 'region'
                ? t('deleteZoneTitle')
                : t('deleteCentreTitle')}
            </DialogTitle>
            <DialogDescription>
              {pendingDelete?.kind === 'region'
                ? t('deleteZoneDesc')
                : t('deleteCentreDesc')}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm font-medium text-foreground">{pendingDelete?.name}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The branch's half of the consolidation: its link keyword, the link it
 * produces, and whether the automation behind it exists yet.
 *
 * Every state that stops a branch being usable says WHY. A blank space
 * where a link should be tells nobody what to do next, and with sixteen
 * branches to get through, "what is missing here" has to be answerable at
 * a glance.
 */
function BranchWiring({
  centre,
  waNumber,
  wired,
  draft,
  onDraft,
  busy,
  copied,
  onSaveCode,
  onSetup,
  onCopy,
  onShowQr,
  t,
}: {
  centre: Centre;
  waNumber: string | null;
  wired: boolean;
  draft: string;
  onDraft: (value: string) => void;
  busy: boolean;
  copied: boolean;
  onSaveCode: () => void;
  onSetup: () => void;
  onCopy: (link: string) => void;
  onShowQr: () => void;
  t: ReturnType<typeof useTranslations<'Settings.centres'>>;
}) {
  const blocker = branchBlocker(centre.code, waNumber);

  // No keyword yet: offer one derived from the name, but let the admin
  // overwrite it — they are the one who has to read it off a printed banner.
  if (blocker === 'no-code') {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-7">
        <Label htmlFor={`code-${centre.id}`} className="text-xs text-muted-foreground">
          {t('codeLabel')}
        </Label>
        <Input
          id={`code-${centre.id}`}
          value={draft || suggestCode(centre.name)}
          onChange={(e) => onDraft(e.target.value.toLowerCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSaveCode();
          }}
          className="h-8 w-40 font-mono text-sm"
          placeholder={t('codePlaceholder')}
        />
        <Button size="sm" variant="outline" onClick={onSaveCode} disabled={busy}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t('codeSave')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('codeHint')}</span>
      </div>
    );
  }

  if (blocker === 'no-number') {
    return (
      <p className="mt-2 pl-7 text-xs text-warning">
        {t('noNumberYet')}
      </p>
    );
  }

  const link = buildWaLink(waNumber!, centre.code!);

  return (
    <div className="mt-2 space-y-2 pl-7">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-xs text-foreground">
          <Link2 className="size-3" aria-hidden />
          {centre.code}
        </span>
        <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{link}</code>
        <Button size="sm" variant="outline" onClick={() => onCopy(link)}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? t('copied') : t('copyLink')}
        </Button>
        <Button size="sm" variant="outline" onClick={onShowQr}>
          <QrCode className="size-3.5" />
          {t('qrButton')}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {wired ? (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-success/70 bg-success/10 px-2 py-1 text-xs font-medium text-success">
            <Check className="size-3.5" aria-hidden />
            {t('setupReady')}
          </span>
        ) : (
          <>
            <Button size="sm" onClick={onSetup} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t('setupButton')}
            </Button>
            <span className="text-xs text-muted-foreground">{t('setupHint')}</span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One branch's QR, sized for the screen and downloadable for print.
 *
 * SVG rather than PNG on purpose: a branch banner is printed large, and a
 * raster at screen resolution would be visibly soft at that size. SVG has
 * no resolution to lose.
 */
function BranchQr({
  centre,
  link,
  t,
}: {
  centre: Centre;
  link: string;
  t: ReturnType<typeof useTranslations<'Settings.centres'>>;
}) {
  const matrix = encodeQr(link);
  if (!matrix) {
    return <p className="text-sm text-muted-foreground">{t('qrFailed')}</p>;
  }
  const svg = qrSvg(matrix, 240);

  function download() {
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${centre.code}-whatsapp.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <div
        className="mx-auto w-fit rounded-lg border border-border bg-white p-2"
        // The matrix is ours, built from the encoder's own output — no
        // user-supplied markup reaches this.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <p className="break-all text-center font-mono text-xs text-muted-foreground">{link}</p>
      <Button onClick={download} className="w-full">
        <Download className="size-4" />
        {t('qrDownload')}
      </Button>
    </div>
  );
}
