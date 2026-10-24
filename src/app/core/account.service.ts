import { Injectable, computed, inject, signal } from '@angular/core';
import { publicClient, nasOrigin, ApiError, type PublicClient } from '../../engine/backup/api';
import { TamperedData, WrongPassphrase, newDataKey, normalizeRecovery, recoveryCode, unwrapKey, workKeys, wrapKey, type WorkKeys } from '../../engine/backup/crypto';
import { Rollback, syncBackup, type BackupHeader, type SyncResult } from '../../engine/backup/sync';
import { DataService } from './data.service';
import { EntryError } from './entry-error';
import { LocalService } from './local.service';
import { LOCAL_MODE } from './runtime';

/** Compte local-first, gardé dans la base IndexedDB `runstat-account` (jamais la phrase de passe ni la clé de données) */
interface AccountState {
  nas: string;
  token: string;
  user: { id: string; name: string };
  device: { id: string; name: string };
  /** Clés de travail non extractibles (absentes tant que la phrase de passe n'a pas été saisie sur cet appareil) */
  keys?: WorkKeys;
  lastSync?: string;
}

const DB = 'runstat-account';
const b64url = (b: ArrayBuffer | Uint8Array) => {
  let s = '';
  for (const x of new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

function kv(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await kv();
  return new Promise((resolve, reject) => {
    const r = db.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}
async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await kv();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    if (value === undefined) tx.objectStore('kv').delete(key);
    else tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Nom lisible de l'appareil (navigateur et système), pour la liste des sessions */
function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Linux';
  const nav = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
  return `${nav} · ${os}`;
}

/** Options WebAuthn du serveur (base64url) → objets attendus par navigator.credentials */
function creationOptions(o: Record<string, any>): PublicKeyCredentialCreationOptions {
  return {
    ...o,
    challenge: fromB64url(o['challenge']),
    user: { ...o['user'], id: fromB64url(o['user'].id) },
    excludeCredentials: (o['excludeCredentials'] ?? []).map((c: { id: string; type: 'public-key' }) => ({ ...c, id: fromB64url(c.id) })),
  } as unknown as PublicKeyCredentialCreationOptions;
}
function requestOptions(o: Record<string, any>): PublicKeyCredentialRequestOptions {
  return {
    ...o,
    challenge: fromB64url(o['challenge']),
    allowCredentials: (o['allowCredentials'] ?? []).map((c: { id: string; type: 'public-key' }) => ({ ...c, id: fromB64url(c.id) })),
  } as unknown as PublicKeyCredentialRequestOptions;
}
function registrationJson(c: PublicKeyCredential) {
  const r = c.response as AuthenticatorAttestationResponse;
  return { id: c.id, rawId: b64url(c.rawId), type: c.type, response: { clientDataJSON: b64url(r.clientDataJSON), attestationObject: b64url(r.attestationObject) } };
}
function assertionJson(c: PublicKeyCredential) {
  const r = c.response as AuthenticatorAssertionResponse;
  return {
    id: c.id,
    rawId: b64url(c.rawId),
    type: c.type,
    response: { clientDataJSON: b64url(r.clientDataJSON), authenticatorData: b64url(r.authenticatorData), signature: b64url(r.signature), userHandle: r.userHandle ? b64url(r.userHandle) : null },
  };
}

/** Erreur lisible d'une étape (API, passkey annulée, phrase de passe…) */
export function accountError(e: unknown): EntryError {
  if (e instanceof EntryError) return e;
  if (e instanceof WrongPassphrase) return new EntryError([e.message]);
  if (e instanceof Rollback) return new EntryError([`Sauvegarde refusée : ${e.message}. Préviens le propriétaire du NAS.`]);
  if (e instanceof TamperedData) return new EntryError([`Sauvegarde illisible avec cette clé (${e.message})`]);
  if (e instanceof ApiError) return new EntryError([e.message]);
  if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return new EntryError(['Passkey annulée ou refusée']);
  if (e instanceof TypeError) return new EntryError(['NAS injoignable (réseau, ou accès public pas encore ouvert)']);
  return new EntryError([(e as Error)?.message ?? 'erreur inconnue']);
}

/**
 * Compte d'un proche local-first sur le NAS (accès public, scripts/sync/public-api.mjs) : passkey, session, et sauvegarde
 * chiffrée de bout en bout (src/engine/backup/), qui sert aussi de synchro entre ses appareils.
 * La phrase de passe ne quitte jamais l'appareil et n'est jamais stockée : seules les clés de travail non extractibles le sont.
 */
@Injectable({ providedIn: 'root' })
export class AccountService {
  private readonly local = inject(LocalService);
  private readonly data = inject(DataService);
  readonly state = signal<AccountState | null>(null);
  readonly ready = signal(false);
  readonly syncing = signal(false);
  readonly lastResult = signal<SyncResult | null>(null);
  readonly lastError = signal<string | null>(null);
  readonly connected = computed(() => this.state() != null);
  readonly unlocked = computed(() => Boolean(this.state()?.keys));
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    if (!LOCAL_MODE) return;
    void kvGet<AccountState>('account').then((s) => {
      this.state.set(s ?? null);
      this.ready.set(true);
    });
    // Sauvegarde automatique après chaque calcul sur l'appareil (saisie, import), regroupée
    this.local.onRebuilt = () => this.schedule();
  }

  private async save(s: AccountState | null): Promise<void> {
    await kvSet('account', s ?? undefined);
    this.state.set(s);
  }

  private client(nas = this.state()?.nas, token = () => this.state()?.token ?? null): PublicClient {
    if (!nas) throw new EntryError(['Aucun NAS']);
    return publicClient(nas, token);
  }

  /** Lien d'invitation : passkey créée sur cet appareil, compte ouvert */
  async join(nas: string, code: string): Promise<void> {
    const origin = nasOrigin(nas);
    if (!origin) throw new EntryError(['Adresse du NAS invalide']);
    const api = this.client(origin, () => null);
    const options = await api.json<Record<string, any>>('POST', '/auth/invitation/options', { code });
    const credential = (await navigator.credentials.create({ publicKey: creationOptions(options) })) as PublicKeyCredential;
    const name = deviceName();
    const r = await api.json<{ token: string; user: { id: string; name: string } }>('POST', '/auth/invitation/register', { code, credential: registrationJson(credential), label: name });
    await this.save({ nas: origin, token: r.token, user: r.user, device: { id: b64url(crypto.getRandomValues(new Uint8Array(9))), name } });
  }

  /** Autre appareil : passkey (synchronisée par le trousseau du téléphone ou de l'ordinateur) */
  async login(nas: string): Promise<void> {
    const origin = nasOrigin(nas);
    if (!origin) throw new EntryError(['Adresse du NAS invalide']);
    const api = this.client(origin, () => null);
    const options = await api.json<Record<string, any>>('POST', '/auth/login/options');
    const credential = (await navigator.credentials.get({ publicKey: requestOptions(options) })) as PublicKeyCredential;
    const name = deviceName();
    const r = await api.json<{ token: string; user: { id: string; name: string } }>('POST', '/auth/login', { credential: assertionJson(credential), label: name });
    await this.save({ nas: origin, token: r.token, user: r.user, device: { id: b64url(crypto.getRandomValues(new Uint8Array(9))), name } });
  }

  /** Lien de connexion (appareil sans passkey), émis depuis un appareil déjà connecté */
  async redeemLink(nas: string, code: string): Promise<void> {
    const origin = nasOrigin(nas);
    if (!origin) throw new EntryError(['Adresse du NAS invalide']);
    const name = deviceName();
    const r = await this.client(origin, () => null).json<{ token: string; user: { id: string; name: string } }>('POST', '/auth/link', { code, label: name });
    await this.save({ nas: origin, token: r.token, user: r.user, device: { id: b64url(crypto.getRandomValues(new Uint8Array(9))), name } });
  }

  /** Une sauvegarde existe-t-elle déjà sur le NAS (restauration) ou faut-il en créer une (première phrase de passe) ? */
  async hasBackup(): Promise<boolean> {
    return (await this.client().backup.getManifest()) != null;
  }

  /** Première sauvegarde : nouvelle clé de données, enveloppée par la phrase de passe et, au choix, un code de secours (renvoyé) */
  async create(passphrase: string, withRecovery: boolean): Promise<string | null> {
    const dataKey = newDataKey();
    const code = withRecovery ? recoveryCode() : null;
    const header: BackupHeader = { v: 1, wraps: [await wrapKey(dataKey, passphrase, 'passphrase'), ...(code ? [await wrapKey(dataKey, code, 'recovery')] : [])] };
    const keys = await workKeys(dataKey);
    await this.save({ ...this.state()!, keys });
    await this.sync(header);
    return code;
  }

  /** Appareil connecté à un compte qui a déjà une sauvegarde : phrase de passe (ou code de secours), puis restauration */
  async unlock(secret: string, kind: 'passphrase' | 'recovery' = 'passphrase'): Promise<SyncResult> {
    const remote = await this.client().backup.getManifest();
    if (!remote) throw new EntryError(['Aucune sauvegarde sur le NAS']);
    const dataKey = await unwrapKey(remote.header.wraps, kind === 'recovery' ? normalizeRecovery(secret) : secret, kind);
    await this.save({ ...this.state()!, keys: await workKeys(dataKey) });
    return this.sync();
  }

  /** Nouvelle phrase de passe : la clé de données est seulement ré-enveloppée (le code de secours reste valable) */
  async changePassphrase(current: string, next: string): Promise<void> {
    const remote = await this.client().backup.getManifest();
    if (!remote) throw new EntryError(['Aucune sauvegarde sur le NAS']);
    const dataKey = await unwrapKey(remote.header.wraps, current);
    const header: BackupHeader = { v: 1, wraps: [await wrapKey(dataKey, next, 'passphrase'), ...remote.header.wraps.filter((w) => w.kind === 'recovery')] };
    await this.sync(header);
  }

  /** Nouveau code de secours (l'ancien ne vaut plus rien) */
  async newRecoveryCode(passphrase: string): Promise<string> {
    const remote = await this.client().backup.getManifest();
    if (!remote) throw new EntryError(['Aucune sauvegarde sur le NAS']);
    const dataKey = await unwrapKey(remote.header.wraps, passphrase);
    const code = recoveryCode();
    const header: BackupHeader = { v: 1, wraps: [...remote.header.wraps.filter((w) => w.kind === 'passphrase'), await wrapKey(dataKey, code, 'recovery')] };
    await this.sync(header);
    return code;
  }

  /** Sauvegarde et synchro maintenant ; reconstruit si un autre appareil a apporté du neuf */
  async sync(header?: BackupHeader): Promise<SyncResult> {
    const s = this.state();
    if (!s?.keys) throw new EntryError(['Saisis d’abord ta phrase de passe sur cet appareil']);
    clearTimeout(this.timer);
    this.syncing.set(true);
    this.lastError.set(null);
    try {
      const result = await syncBackup({ raw: await this.local.raw(), api: this.client().backup, keys: s.keys, account: s.user.id, device: s.device, header });
      this.lastResult.set(result);
      await this.save({ ...this.state()!, lastSync: new Date().toISOString() });
      if (result.changed) {
        await this.local.rebuild();
        await this.data.reload();
      }
      return result;
    } catch (e) {
      const err = accountError(e);
      this.lastError.set(err.message);
      if (e instanceof ApiError && e.status === 401) await this.save({ ...this.state()!, token: '' });
      throw err;
    } finally {
      this.syncing.set(false);
    }
  }

  /** Sauvegarde différée de quelques secondes après un changement local */
  private schedule(): void {
    if (!this.unlocked() || !this.state()?.token) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync().catch(() => undefined), 5000);
  }

  /** Ré-authentification par passkey (5 min) avant une action sensible */
  async stepUp(): Promise<void> {
    const api = this.client();
    const options = await api.json<Record<string, any>>('POST', '/auth/stepup/options');
    const credential = (await navigator.credentials.get({ publicKey: requestOptions(options) })) as PublicKeyCredential;
    await api.json('POST', '/auth/stepup', { credential: assertionJson(credential) });
  }

  /** Lien de connexion pour un appareil sans passkey (15 min, une fois) */
  async deviceLink(appUrl: string): Promise<string> {
    const api = this.client();
    let r: { code: string };
    try {
      r = await api.json<{ code: string }>('POST', '/auth/links');
    } catch (e) {
      if (!(e instanceof ApiError && e.body['stepUp'])) throw e;
      await this.stepUp();
      r = await api.json<{ code: string }>('POST', '/auth/links');
    }
    return `${appUrl}connexion#nas=${encodeURIComponent(this.state()!.nas)}&lien=${r.code}`;
  }

  /** Client Google du propriétaire (relais du NAS) : identifiant public et adresses de retour déclarées */
  googleClient(): Promise<{ client_id: string; redirects: string[] }> {
    return this.client().json('GET', '/relay/google/client');
  }

  /**
   * Jeton Google par le relais (secret ajouté par le NAS). Les refus de Google (codes en snake_case) sont rendus tels quels
   * au client du moteur (ré-autorisation) ; les erreurs du relais lui-même (session, limite) remontent.
   */
  async googleToken(params: Record<string, string>): Promise<{ status: number; body: Record<string, any> }> {
    try {
      return { status: 200, body: await this.client().json<Record<string, any>>('POST', '/relay/google/token', params) };
    } catch (e) {
      if (e instanceof ApiError && typeof e.body['error'] === 'string' && /^[a-z_]+$/.test(e.body['error'])) return { status: e.status, body: e.body };
      throw accountError(e);
    }
  }

  /** Déconnexion : session révoquée sur le NAS, clés effacées de cet appareil (les données locales restent) */
  async logout(): Promise<void> {
    try {
      if (this.state()?.token) await this.client().json('DELETE', '/auth/session');
    } catch {}
    clearTimeout(this.timer);
    await this.save(null);
  }
}
