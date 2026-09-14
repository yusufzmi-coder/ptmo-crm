'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Building2, Loader2, MapPin, Phone, Plus, Trash2 } from 'lucide-react';
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
import type { Centre, Region } from '@/types';

/** Sentinel for "no zone" -- Radix Select cannot hold an empty value. */
const NO_ZONE = '__none__';

interface PendingDelete {
  kind: 'region' | 'centre';
  id: string;
  name: string;
}

const EMPTY_FORM = {
  name: '',
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

  const load = useCallback(async () => {
    if (!accountId) return;
    try {
      setLoading(true);
      const [r, c] = await Promise.all([
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
      ]);
      if (r.error) throw r.error;
      if (c.error) throw c.error;
      setRegions((r.data ?? []) as Region[]);
      setCentres((c.data ?? []) as Centre[]);
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
                        <li
                          key={centre.id}
                          className="flex items-center gap-3 px-3 py-2.5"
                        >
                          <Building2 className="size-4 flex-shrink-0 text-primary" />
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
