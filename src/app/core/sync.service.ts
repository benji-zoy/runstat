import { Injectable, computed, inject, signal } from '@angular/core';
import { DataService } from './data.service';
import { sourcesOf } from './sources';

/** État d'une source dans data-raw/sync-state.json (scripts/sync/run.mjs) */
interface SourceState {
  lastSuccess?: string;
  lastSummary?: string;
  lastError?: string;
  lastErrorAt?: string;
  reauthSince?: string;
}

interface SyncStatus {
  /** Run en cours ou en attente (file des runs de tous les comptes du NAS) */
  running: boolean;
  /** En attente : un autre compte synchronise */
  queued?: boolean;
  startedAt: string | null;
  nextAt: string | null;
  state: Partial<Record<SourceKey, SourceState>> & {
    lastBuildError?: string;
    lastFitError?: string;
    lastImportError?: string;
    /** Dernière archive Strava importée (run.mjs --import-strava) */
    stravaArchive?: { importedAt: string; runs: number; added: number; files: number };
  };
  log: string[];
  /** Appli Strava enregistrée (secrets/strava-client.json) et jetons présents : leur contenu n'est jamais exposé */
  stravaClient?: boolean;
  stravaConnected?: boolean;
  /** « Prénom, athlète 123 » */
  stravaAthlete?: string | null;
  /** Adresse du site pour la connexion Strava (SYNC_PUBLIC_ORIGINS, HTTPS d'abord), null sur le poste */
  stravaOrigin?: string | null;
}

/** Retour de la connexion Strava (/aujourdhui?strava=ok|refus&raison=…, scripts/sync/strava-connect.mjs) */
const STRAVA_RETURN: Record<string, string> = {
  ok: 'Strava connecté : synchro de tes sorties',
  public: 'Strava connecté, sans tes sorties privées',
  annule: 'Connexion Strava annulée',
  portee: 'Strava : autorise l’accès à tes activités',
  lien: 'Lien Strava expiré : recommence depuis Réglages',
  echange: 'Strava a refusé : vérifie le Client Secret',
  appli: 'Enregistre d’abord ton appli Strava (Réglages)',
  origine: 'Connexion Strava : passe par l’adresse Tailscale',
  compte: 'Connexion Strava lancée depuis un autre compte : recommence depuis Réglages',
};

/** Clés de sync-state.json : source d'activités, puis source de santé (corosHealth : santé COROS) */
const SOURCES = { coros: 'COROS', strava: 'Strava', google: 'Google Health', corosHealth: 'COROS santé' } as const;
type SourceKey = keyof typeof SOURCES;
/** Commande de ré-autorisation : la santé COROS partage les jetons COROS */
const AUTH: Record<SourceKey, string> = { coros: 'coros', strava: 'strava', google: 'google', corosHealth: 'coros' };

/**
 * Synchro à la demande par le service runstat-sync du NAS (/api/sync, proxy nginx).
 * Sans ce service (ng serve, autre hébergement), `available` reste faux et le bouton n'apparaît pas.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly store = inject(DataService);
  readonly status = signal<SyncStatus | null>(null);
  readonly available = computed(() => this.status() !== null);
  readonly running = computed(() => this.status()?.running ?? false);
  /** Message d'une demande refusée (déjà en cours, trop tôt, service injoignable) */
  readonly notice = signal<string | null>(null);
  /** Sortie dont le FIT est en cours de téléchargement (« Affiner avec le tracé ») */
  readonly refining = signal<string | null>(null);
  /** Résultat du dernier « Affiner », par sortie */
  readonly refineNotice = signal<{ id: string; text: string } | null>(null);
  private polling = false;

  /** Sources synchronisées par cette instance (data-raw/sources.json) */
  readonly active = computed<SourceKey[]>(() => {
    const s = sourcesOf(this.store.data());
    const health: SourceKey | null = s.health === 'google' ? 'google' : s.health === 'coros' ? 'corosHealth' : null;
    return [s.activities, ...(health ? [health] : [])];
  });
  readonly label = (key: SourceKey) => SOURCES[key];

  /** Problèmes à signaler : source en échec ou à ré-autoriser, reconstruction ou import en échec */
  readonly problems = computed(() => {
    const s = this.status()?.state;
    if (!s) return [];
    const out: string[] = [];
    for (const key of this.active()) {
      const src = s[key];
      if (src?.reauthSince)
        out.push(`${SOURCES[key]} : ré-autorisation nécessaire (${key === 'strava' ? 'Réglages › Connecter Strava' : `npm run auth -- ${AUTH[key]}`})`);
      else if (src?.lastError) out.push(`${SOURCES[key]} : ${src.lastError}`);
    }
    if (s.lastBuildError) out.push(`Reconstruction : ${s.lastBuildError}`);
    if (s.lastImportError) out.push(`Archive Strava : ${s.lastImportError}`);
    return out;
  });

  /** Info-bulle du bouton */
  readonly title = computed(() => {
    const st = this.status();
    if (!st) return '';
    if (st.queued) return 'En file d’attente : un autre compte synchronise';
    if (st.running) return 'Synchronisation en cours…';
    const lines = [`Synchroniser ${this.active().map((k) => SOURCES[k]).join(' et ')}`];
    for (const key of this.active()) {
      const t = st.state[key]?.lastSuccess;
      lines.push(`${SOURCES[key]} : ${t ? `à jour ${ago(t)}` : 'jamais synchronisé'}`);
    }
    lines.push(...this.problems());
    return lines.join('\n');
  });

  constructor() {
    void this.refresh().then(() => {
      if (this.running()) void this.poll();
    });
  }

  async refresh(): Promise<void> {
    try {
      const res = await fetch('api/sync', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const type = res.headers.get('content-type') ?? '';
      // ng serve renvoie index.html pour une adresse inconnue : pas de service de synchro
      this.status.set(res.ok && type.includes('json') ? await res.json() : null);
    } catch {
      this.status.set(null);
    }
  }

  private noticeTimer?: ReturnType<typeof setTimeout>;

  /** Message bref sous le bouton, effacé après quelques secondes */
  private say(message: string, ms = 5000): void {
    clearTimeout(this.noticeTimer);
    this.notice.set(message);
    this.noticeTimer = setTimeout(() => this.notice.set(null), ms);
  }

  /** Retour de Strava après « Connecter Strava » : message, puis suivi de la synchro lancée par le service */
  stravaReturned(result: string, reason: string | null): void {
    const ok = result === 'ok';
    this.say(STRAVA_RETURN[ok ? (reason ?? 'ok') : (reason ?? '')] ?? (ok ? STRAVA_RETURN['ok'] : 'Connexion Strava refusée'), 8000);
    if (ok) void this.followImport();
  }

  async trigger(): Promise<void> {
    if (this.running()) return;
    this.notice.set(null);
    try {
      const res = await fetch('api/sync', { method: 'POST', headers: { 'X-RunStat': 'sync' } });
      const body = await res.json().catch(() => ({}));
      if (res.status === 429) this.say(`Synchro toute récente : réessaie dans ${body.retryInSec ?? 60} s`);
      else if (!res.ok && res.status !== 409) this.say(`Synchro impossible (${body.error ?? `HTTP ${res.status}`})`);
    } catch {
      this.say('Service de synchro injoignable');
    }
    await this.refresh();
    if (this.running()) await this.poll();
  }

  /** Télécharge le FIT d'une sortie sur le NAS puis recalcule (quota COROS de 50 FIT par jour) */
  async refineFit(id: string): Promise<void> {
    if (this.running()) return;
    this.refineNotice.set(null);
    this.refining.set(id);
    try {
      const res = await fetch(`api/fit?id=${encodeURIComponent(id)}`, { method: 'POST', headers: { 'X-RunStat': 'sync' } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        this.refineNotice.set({ id, text: res.status === 409 ? 'Synchro en cours, réessaie dans un instant' : `Impossible (${body.error ?? `HTTP ${res.status}`})` });
        return;
      }
      await this.refresh();
      await this.poll(true);
      const err = this.status()?.state.lastFitError;
      const fit = this.store.activities().find((a) => a.id === id)?.fit;
      this.refineNotice.set({ id, text: fit ? 'Tracé ajouté : analyse affinée' : `Tracé indisponible${err ? ` (${err.replace(/^(strava:)?\d+ : /, '')})` : ''}` });
    } catch {
      this.refineNotice.set({ id, text: 'Service de synchro injoignable' });
    } finally {
      this.refining.set(null);
    }
  }

  /** Archive Strava envoyée au NAS (import puis reconstruction) : suivie comme une synchro */
  async followImport(): Promise<void> {
    await this.refresh();
    if (this.running()) await this.poll();
  }

  /** Après une saisie : suit la reconstruction lancée par le service, puis recharge les données */
  async follow(): Promise<void> {
    await this.refresh();
    if (this.running()) await this.poll(true);
  }

  /** Suit le run jusqu'au bout, puis recharge les données du site */
  private async poll(quiet = false): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      do {
        await new Promise((r) => setTimeout(r, 3000));
        await this.refresh();
      } while (this.running());
      await this.store.reload();
      if (!quiet) this.say(this.problems().length ? 'Synchro terminée avec des erreurs' : 'Données à jour');
    } finally {
      this.polling = false;
    }
  }
}

function ago(iso: string): string {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}
