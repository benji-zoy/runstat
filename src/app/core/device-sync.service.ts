import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { corosClient, type CorosClientInfo } from '../../engine/sync/coros';
import { stravaAuthorizeUrl, stravaClient, validateStravaApp } from '../../engine/sync/strava';
import { googleAuthorizeUrl, googleClient } from '../../engine/sync/google';
import { fileTokenStore, type TokenStore } from '../../engine/sync/http';
import { sourceSync, type SyncState } from '../../engine/sync/run-sources';
import { fitQueue, fitQueueText } from '../../engine/fit-queue';
import { InvalidEntry } from '../../engine/entries';
import { readJson } from '../../engine/storage/types';
import { AccountService } from './account.service';
import { DataService } from './data.service';
import { EntryError } from './entry-error';
import { LocalService } from './local.service';
import { LOCAL_MODE } from './runtime';

/** Appareil qui synchronise les sources (sauvegardé et fusionné comme les autres fichiers) */
export const PRIMARY_FILE = 'sync-primary.json';
interface Primary {
  device: string;
  name: string;
  /** Incrémentée à chaque reprise : la dernière l'emporte à la fusion */
  epoch: number;
  since: string;
}
export type DeviceSource = 'coros' | 'strava' | 'google';
interface PendingOAuth {
  source: DeviceSource;
  state: string;
  verifier: string;
  redirect: string;
  client?: CorosClientInfo;
}

const PENDING = 'runstat-oauth';
const AUTO_SYNC_MS = 60 * 60_000;
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** Refus de renouveler un jeton ailleurs que sur l'appareil principal (le refresh token COROS n'a qu'un détenteur) */
export class NotPrimary extends Error {}

/**
 * Synchro des sources sur l'appareil (appli publique, local-first) : COROS, Strava et Google Health par le moteur
 * (src/engine/sync/), jetons dans la zone raw (secrets/, chiffrés dans la sauvegarde), puis reconstruction.
 * Un seul appareil principal par compte renouvelle les jetons (sync-primary.json) : juste avant, il relit la sauvegarde
 * (jetons et appareil principal les plus récents), et l'envoie aussitôt après. Renouvellements et synchros sous Web Locks
 * (onglets et worker). Connexions OAuth depuis le navigateur : /connexion/<source> (pages/oauth-return.ts).
 */
@Injectable({ providedIn: 'root' })
export class DeviceSyncService {
  private readonly local = inject(LocalService);
  private readonly account = inject(AccountService);
  private readonly data = inject(DataService);
  readonly running = signal(false);
  readonly state = signal<SyncState>({});
  readonly primary = signal<Primary | null>(null);
  readonly log = signal<string[]>([]);
  readonly tokens = signal({ coros: false, stravaClient: false, strava: false, stravaAthlete: null as string | null, google: false });
  readonly anyConnected = computed(() => {
    const t = this.tokens();
    return t.coros || t.strava || t.google;
  });
  /** Identifiant de l'appareil dans le compte ; sans compte, l'appareil est seul */
  private readonly deviceId = computed(() => this.account.state()?.device.id ?? null);
  readonly isPrimary = computed(() => {
    const p = this.primary();
    return !this.deviceId() || !p || p.device === this.deviceId();
  });
  readonly appUrl = new URL('.', document.baseURI).href;

  constructor() {
    if (!LOCAL_MODE) return;
    // Au démarrage (compte lu) : état, puis synchro si la dernière date de plus d'une heure
    effect(() => {
      if (!this.account.ready()) return;
      untracked(() => void this.reload().then(() => this.autoSync()));
    });
  }

  /** Relit l'état, l'appareil principal et la présence des jetons (jamais leur contenu) */
  async reload(): Promise<void> {
    const raw = await this.local.raw();
    const tokens = this.store(raw);
    this.state.set((await readJson<SyncState>(raw, 'sync-state.json')) ?? {});
    this.primary.set(await readJson<Primary>(raw, PRIMARY_FILE));
    const strava = await tokens.read('strava-tokens.json');
    this.tokens.set({
      coros: Boolean(await tokens.read('coros-tokens.json')),
      stravaClient: Boolean(await tokens.read('strava-client.json')),
      strava: Boolean(strava?.refresh_token),
      stravaAthlete: strava?.athleteName ?? null,
      google: Boolean(await tokens.read('google-tokens.json')),
    });
  }

  private async autoSync(): Promise<void> {
    if (!this.anyConnected() || !this.isPrimary() || (this.account.state() && !this.account.unlocked())) return;
    const last = Object.values(this.state())
      .map((s) => (s && typeof s === 'object' && 'lastAttempt' in s ? Date.parse(String(s.lastAttempt)) : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    if (Date.now() - last > AUTO_SYNC_MS) await this.syncNow().catch(() => undefined);
  }

  /** Jetons de la zone raw ; renouvellement sous verrou, réservé à l'appareil principal, sauvegarde aussitôt après */
  private store(raw: Awaited<ReturnType<LocalService['raw']>>): TokenStore {
    const base = fileTokenStore(raw);
    return {
      ...base,
      refresh: <T>(name: string, fn: () => Promise<T>): Promise<T> =>
        withLock<T>(`runstat-jeton-${name}`, async () => {
          await this.ensurePrimary();
          const result = await fn();
          if (this.account.unlocked()) await this.account.sync().catch(() => undefined);
          return result;
        }) as Promise<T>,
    };
  }

  /**
   * Avant tout renouvellement : avec un compte, relit la sauvegarde (jetons et appareil principal les plus récents), puis
   * vérifie que cet appareil est le principal (il le devient s'il n'y en a pas encore).
   */
  private async ensurePrimary(): Promise<void> {
    const me = this.account.state();
    if (!me) return;
    if (!this.account.unlocked() || !me.token) throw new NotPrimary('déverrouille ta sauvegarde (Compte et sauvegarde) avant de synchroniser');
    await this.account.sync();
    const raw = await this.local.raw();
    const p = await readJson<Primary>(raw, PRIMARY_FILE);
    this.primary.set(p);
    if (!p) return this.claim();
    if (p.device !== me.device.id) throw new NotPrimary(`synchro réservée à l’appareil principal (${p.name})`);
  }

  /** Cet appareil devient l'appareil principal (époque suivante), puis sauvegarde tout de suite */
  async claim(): Promise<void> {
    const me = this.account.state();
    if (!me) return;
    const raw = await this.local.raw();
    const prev = await readJson<Primary>(raw, PRIMARY_FILE);
    const next: Primary = { device: me.device.id, name: me.device.name, epoch: (prev?.epoch ?? 0) + 1, since: new Date().toISOString() };
    await raw.write(PRIMARY_FILE, JSON.stringify(next));
    this.primary.set(next);
    if (this.account.unlocked() && me.token) await this.account.sync();
  }

  private async clients() {
    const raw = await this.local.raw();
    const tokens = this.store(raw);
    return {
      raw,
      tokens,
      coros: corosClient({ tokens, clientName: 'RunStat (appli)' }),
      strava: stravaClient({ tokens }),
      google: this.account.state() ? googleClient({ tokens, token: (p) => this.account.googleToken(p) }) : undefined,
    };
  }

  /** Synchro des sources choisies, puis reconstruction ; une seule à la fois pour tous les onglets */
  async syncNow(): Promise<string> {
    if (this.running()) return 'Synchro déjà en cours';
    const done = await withLock('runstat-sources', async () => {
      this.running.set(true);
      this.log.set([]);
      try {
        if (!this.isPrimary()) throw new NotPrimary(`synchro faite par ${this.primary()!.name} (Réglages › Devenir l’appareil principal)`);
        const c = await this.clients();
        const { sources } = await sourceSync(c.raw, c, { stage: false, log: (...m) => this.say(m) }).syncAll();
        await this.local.rebuild();
        if (sources.activities === 'coros') await this.writeFitQueue();
        await this.data.reload();
        return 'Données à jour';
      } finally {
        this.running.set(false);
        await this.reload();
      }
    }, true);
    return done ?? 'Synchro en cours dans un autre onglet';
  }

  /** « Affiner avec le tracé » : FIT COROS ou streams Strava d'une sortie, puis reconstruction */
  async refine(id: string): Promise<{ ok: boolean; message: string }> {
    const r = await withLock('runstat-sources', async () => {
      this.running.set(true);
      try {
        const c = await this.clients();
        const out = await sourceSync(c.raw, c, { stage: false, log: (...m) => this.say(m) }).syncOne(id);
        if (out.ok) {
          await this.local.rebuild();
          await this.data.reload();
        }
        return out;
      } finally {
        this.running.set(false);
        await this.reload();
      }
    }, true);
    return r ?? { ok: false, message: 'synchro en cours dans un autre onglet' };
  }

  /** File des FIT par utilité (fit-queue.txt), comme scripts/fit-queue.mjs sur le NAS */
  private async writeFitQueue(): Promise<void> {
    const snap = await this.local.snapshot();
    if (!snap) return;
    const raw = await this.local.raw();
    const have = new Set((await raw.list('fit')).map((f) => f.replace('.fit', '')));
    await raw.write('fit-queue.txt', fitQueueText(fitQueue(snap.activities as never[], have)));
  }

  private say(m: unknown[]): void {
    this.log.update((l) => [...l.slice(-49), m.map(String).join(' ')]);
  }

  /** Appli Strava de la personne (Réglages) : changer d'appli efface les jetons de l'ancienne */
  async saveStravaApp(clientId: string, clientSecret: string): Promise<void> {
    let app: { client_id: string; client_secret: string };
    try {
      app = validateStravaApp({ client_id: clientId, client_secret: clientSecret });
    } catch (e) {
      throw e instanceof InvalidEntry ? new EntryError(e.errors) : e;
    }
    const raw = await this.local.raw();
    const tokens = fileTokenStore(raw);
    const prev = await tokens.read('strava-client.json');
    await tokens.write('strava-client.json', app);
    if (prev?.client_id !== app.client_id) await raw.remove('secrets/strava-tokens.json');
    await this.reload();
  }

  /** Adresse de retour d'une source (à déclarer chez Strava et dans le client Google : domaine de l'appli) */
  redirect(source: DeviceSource): string {
    return `${this.appUrl}connexion/${source}`;
  }

  /** Début d'une connexion : adresse d'autorisation de la source (state et vérificateur PKCE gardés pour l'onglet) */
  async connectUrl(source: DeviceSource): Promise<string> {
    const c = await this.clients();
    const redirect = this.redirect(source);
    const verifier = random(32);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const pending: PendingOAuth = { source, state: random(16), verifier, redirect };
    let url: string;
    if (source === 'coros') {
      const meta = await c.coros.metadata();
      pending.client = await c.coros.registerClient(meta, { redirect });
      url = c.coros.authorizeUrl(meta, pending.client, { redirect, challenge, state: pending.state });
    } else if (source === 'strava') {
      const app = await c.tokens.read('strava-client.json');
      if (!app) throw new EntryError(['Enregistre d’abord ton appli Strava']);
      url = stravaAuthorizeUrl(app.client_id, redirect, pending.state);
    } else {
      if (!this.account.state()) throw new EntryError(['Google Health passe par le NAS qui t’héberge : ouvre d’abord ton compte (invitation)']);
      const g = await this.account.googleClient();
      if (!g.redirects.includes(redirect)) throw new EntryError([`Adresse de retour ${redirect} non déclarée sur le NAS (RUNSTAT_GOOGLE_REDIRECTS)`]);
      url = googleAuthorizeUrl(g.client_id, { redirect, challenge, state: pending.state });
    }
    sessionStorage.setItem(PENDING, JSON.stringify(pending));
    return url;
  }

  /**
   * Retour d'une connexion : state vérifié (usage unique), code échangé directement (COROS, Strava) ou par le relais
   * (Google), jetons écrits, puis cet appareil devient le principal. Renvoie le code de résultat de /aujourdhui?<source>=.
   */
  async finish(source: DeviceSource, params: URLSearchParams): Promise<{ result: 'ok' | 'refus'; reason?: string }> {
    const pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null') as PendingOAuth | null;
    sessionStorage.removeItem(PENDING);
    if (!pending || pending.source !== source || !params.get('state') || params.get('state') !== pending.state) return { result: 'refus', reason: 'lien' };
    if (params.get('error') || !params.get('code')) return { result: 'refus', reason: 'annule' };
    const code = params.get('code')!;
    const c = await this.clients();
    let reason: string | undefined;
    try {
      if (source === 'coros') await c.coros.exchangeCode(await c.coros.metadata(), pending.client!, { code, verifier: pending.verifier, redirect: pending.redirect });
      else if (source === 'strava') {
        const scope = params.get('scope');
        if (!/activity:read/.test(scope ?? '')) return { result: 'refus', reason: 'portee' };
        await c.strava.exchangeCode(code, scope);
        if (!/activity:read_all/.test(scope ?? '')) reason = 'public';
      } else await c.google!.exchangeCode({ code, verifier: pending.verifier, redirect: pending.redirect });
    } catch {
      return { result: 'refus', reason: 'echange' };
    }
    // Nouveaux jetons sur cet appareil : il les renouvellera, les autres ne doivent plus le faire
    await this.claim().catch(() => undefined);
    await this.reload();
    return { result: 'ok', reason };
  }
}

/** Web Locks (onglets, worker) ; `ifAvailable` : null si déjà pris. Sans l'API (anciens navigateurs), appel direct. */
async function withLock<T>(name: string, fn: () => Promise<T>, ifAvailable = false): Promise<T | null> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) return fn();
  return locks.request(name, { ifAvailable }, async (lock) => (lock ? fn() : null)) as Promise<T | null>;
}
