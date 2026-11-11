import { TestBed } from '@angular/core/testing';
import { IDBFactory } from 'fake-indexeddb';
import { ApiError } from '../../engine/backup/api';
import { TamperedData, WrongPassphrase, newDataKey, recoveryCode, wrapKey } from '../../engine/backup/crypto';
import { INDEX_FILE, Rollback } from '../../engine/backup/sync';
import { MemoryStore } from '../../engine/storage/memory';
import { AccountService, accountError } from './account.service';
import { DataService } from './data.service';
import { EntryError } from './entry-error';
import { LocalService } from './local.service';

// Compte local-first : IndexedDB (fake-indexeddb), WebCrypto réel, NAS simulé par un fetch bouchonné.
// Hors mode local-first (tests), le constructeur ne relit pas la base : l'état se pose par `save`.
describe('AccountService', () => {
  let raw: MemoryStore;
  let calls: { url: string; method: string; auth: string | null }[];
  let respond: (url: string, method: string) => Response;
  const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });
  const stored = { nas: 'https://nas.example', token: 'jeton', user: { id: 'carol', name: 'Carol' }, device: { id: 'dev1', name: 'Chrome · Mac' } };
  const service = () => TestBed.inject(AccountService);
  /** Compte déjà ouvert sur cet appareil */
  const signedIn = async (extra: object = {}) => {
    const s = service();
    await (s as any).save({ ...stored, ...extra });
    return s;
  };
  /** Sauvegarde du NAS, chiffrée par une phrase de passe (600 000 itérations, une seule fois pour tout le fichier) */
  let manifest: { version: number; header: unknown; blob: string };
  beforeAll(async () => {
    const wraps = [await wrapKey(newDataKey(), 'cheval agrafe batterie correcte', 'passphrase')];
    manifest = { version: 1, header: { v: 1, wraps }, blob: 'x' };
  });

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    raw = new MemoryStore();
    calls = [];
    respond = () => json({});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, method: init.method ?? 'GET', auth: ((init.headers ?? {}) as Record<string, string>)['Authorization'] ?? null });
        return respond(url, init.method ?? 'GET');
      }),
    );
    TestBed.configureTestingModule({
      providers: [
        { provide: LocalService, useValue: { raw: async () => raw, rebuild: async () => '', onRebuilt: undefined } },
        { provide: DataService, useValue: { reload: async () => undefined } },
      ],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  describe('état initial', () => {
    it('aucun compte, rien de déverrouillé, rien de prêt hors mode local-first', () => {
      const s = service();
      expect(s.state()).toBeNull();
      expect(s.connected()).toBe(false);
      expect(s.unlocked()).toBe(false);
      expect(s.syncing()).toBe(false);
      expect(s.lastResult()).toBeNull();
      expect(s.lastError()).toBeNull();
    });

    it('sans NAS, toute action réseau est refusée avant d’appeler quoi que ce soit', async () => {
      const s = service();
      await expect(s.hasBackup()).rejects.toMatchObject({ errors: ['Aucun NAS'] });
      await expect(s.unlock('phrase')).rejects.toBeInstanceOf(EntryError);
      await expect(s.deleteAccount()).rejects.toBeInstanceOf(EntryError);
      await expect(s.deviceLink('https://app.example/')).rejects.toBeInstanceOf(EntryError);
      expect(calls).toEqual([]);
    });

    it('adresse du NAS invalide : refusée par join, login et redeemLink', async () => {
      const s = service();
      await expect(s.join('http://nas.example', 'code')).rejects.toMatchObject({ errors: ['Adresse du NAS invalide'] });
      await expect(s.login('pas une adresse')).rejects.toMatchObject({ errors: ['Adresse du NAS invalide'] });
      await expect(s.redeemLink('ftp://x', 'code')).rejects.toMatchObject({ errors: ['Adresse du NAS invalide'] });
      expect(calls).toEqual([]);
    });

    it('lien de connexion : ouvre le compte, garde le jeton, nomme l’appareil', async () => {
      respond = () => json({ token: 'session', user: { id: 'carol', name: 'Carol' } });
      const s = service();
      await s.redeemLink('https://nas.example/auth', 'LIEN');
      expect(calls[0]).toMatchObject({ url: 'https://nas.example/auth/link', method: 'POST' });
      expect(s.state()).toMatchObject({ nas: 'https://nas.example', token: 'session', user: { id: 'carol' } });
      expect(s.state()!.device.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
      expect(s.connected()).toBe(true);
      // pas de clés tant que la phrase de passe n'est pas saisie
      expect(s.unlocked()).toBe(false);
    });
  });

  describe('déverrouillage', () => {
    it('mauvaise phrase de passe : refusée, aucune clé gardée', async () => {
      const s = await signedIn();
      respond = (url) => (url.endsWith('/backup/manifest') ? json(manifest) : json({}));
      await expect(s.unlock('une toute autre phrase')).rejects.toBeInstanceOf(WrongPassphrase);
      expect(s.unlocked()).toBe(false);
      expect(s.state()!.keys).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: 'https://nas.example/backup/manifest', method: 'GET', auth: 'Bearer jeton' });
    });

    it('mauvais code de secours : refusé aussi, même casse et tirets ignorés', async () => {
      const s = await signedIn();
      respond = (url) => (url.endsWith('/backup/manifest') ? json(manifest) : json({}));
      // la sauvegarde de test n'a pas de code de secours
      await expect(s.unlock(recoveryCode().toLowerCase(), 'recovery')).rejects.toBeInstanceOf(WrongPassphrase);
      expect(s.unlocked()).toBe(false);
    });

    it('aucune sauvegarde sur le NAS (404)', async () => {
      const s = await signedIn();
      respond = () => json({ error: 'absent' }, { status: 404 });
      await expect(s.unlock('phrase')).rejects.toMatchObject({ errors: ['Aucune sauvegarde sur le NAS'] });
      expect(await s.hasBackup()).toBe(false);
    });

    it('sauvegarde présente : hasBackup', async () => {
      const s = await signedIn();
      respond = () => json(manifest);
      expect(await s.hasBackup()).toBe(true);
    });

    it('changePassphrase et newRecoveryCode : mauvaise phrase actuelle refusée avant tout envoi', async () => {
      const s = await signedIn();
      respond = (url) => (url.endsWith('/backup/manifest') ? json(manifest) : json({}));
      await expect(s.changePassphrase('fausse', 'nouvelle')).rejects.toBeInstanceOf(WrongPassphrase);
      await expect(s.newRecoveryCode('fausse')).rejects.toBeInstanceOf(WrongPassphrase);
      expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    });

    it('sync sans clés : demande d’abord la phrase de passe, sans toucher au réseau', async () => {
      const s = await signedIn();
      await expect(s.sync()).rejects.toMatchObject({ errors: ['Saisis d’abord ta phrase de passe sur cet appareil'] });
      expect(calls).toEqual([]);
      expect(s.syncing()).toBe(false);
    });
  });

  describe('déconnexion', () => {
    it('révoque la session sur le NAS, oublie le compte, efface l’index de sauvegarde', async () => {
      const s = await signedIn();
      await raw.write(INDEX_FILE, '{}');
      await raw.write('records.txt', 'garde');
      await s.logout();
      expect(calls).toEqual([{ url: 'https://nas.example/auth/session', method: 'DELETE', auth: 'Bearer jeton' }]);
      expect(s.state()).toBeNull();
      expect(s.connected()).toBe(false);
      expect(await raw.read(INDEX_FILE)).toBeNull();
      // les données locales restent
      expect(await raw.readText('records.txt')).toBe('garde');
    });

    it('NAS injoignable : l’appareil se déconnecte quand même', async () => {
      const s = await signedIn();
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
      await s.logout();
      expect(s.state()).toBeNull();
    });

    it('session déjà expirée (jeton vide) : pas d’appel au NAS', async () => {
      const s = await signedIn({ token: '' });
      await s.logout();
      expect(calls).toEqual([]);
      expect(s.state()).toBeNull();
    });

    it('l’état est persisté dans IndexedDB : oublié aussi après déconnexion', async () => {
      const s = await signedIn();
      const read = () =>
        new Promise((resolve) => {
          const req = indexedDB.open('runstat-account', 1);
          req.onsuccess = () => {
            const r = req.result.transaction('kv').objectStore('kv').get('account');
            r.onsuccess = () => resolve(r.result);
          };
        });
      expect(await read()).toMatchObject({ nas: 'https://nas.example', token: 'jeton' });
      await s.logout();
      expect(await read()).toBeUndefined();
    });
  });

  describe('suppression et liens', () => {
    it('suppression : DELETE /auth/account, puis compte oublié', async () => {
      const s = await signedIn();
      await s.deleteAccount();
      expect(calls[0]).toMatchObject({ url: 'https://nas.example/auth/account', method: 'DELETE', auth: 'Bearer jeton' });
      expect(s.state()).toBeNull();
    });

    it('suppression refusée pour une autre raison que la ré-authentification : erreur, compte gardé', async () => {
      const s = await signedIn();
      respond = () => json({ error: 'interdit' }, { status: 403 });
      await expect(s.deleteAccount()).rejects.toMatchObject({ errors: ['interdit'] });
      expect(s.connected()).toBe(true);
    });

    it('lien de connexion pour un autre appareil', async () => {
      const s = await signedIn();
      respond = () => json({ code: 'ABC123' });
      expect(await s.deviceLink('https://app.example/runstat/')).toBe('https://app.example/runstat/connexion#nas=https%3A%2F%2Fnas.example&lien=ABC123');
      expect(calls[0]).toMatchObject({ url: 'https://nas.example/auth/links', method: 'POST' });
    });
  });

  describe('Garmin et Google par le NAS', () => {
    it('Garmin sans compte : message explicite', () => {
      expect(() => service().garminFetch()).toThrow(/ouvre d’abord ton compte/);
    });

    it('Garmin avec compte : un fetch', async () => {
      const s = await signedIn();
      expect(typeof s.garminFetch()).toBe('function');
    });

    it('client Google du propriétaire', async () => {
      const s = await signedIn();
      respond = () => json({ client_id: 'abc', redirects: ['https://app.example/connexion/google'] });
      expect(await s.googleClient()).toEqual({ client_id: 'abc', redirects: ['https://app.example/connexion/google'] });
      expect(calls[0]).toMatchObject({ url: 'https://nas.example/relay/google/client', method: 'GET' });
    });

    it('jeton Google : réponse rendue telle quelle ; refus de Google (snake_case) rendu au client du moteur', async () => {
      const s = await signedIn();
      respond = () => json({ access_token: 'a', expires_in: 3600 });
      expect(await s.googleToken({ grant_type: 'refresh_token' })).toEqual({ status: 200, body: { access_token: 'a', expires_in: 3600 } });
      respond = () => json({ error: 'invalid_grant' }, { status: 400 });
      expect(await s.googleToken({ grant_type: 'refresh_token' })).toEqual({ status: 400, body: { error: 'invalid_grant' } });
    });

    it('jeton Google : erreur du relais lui-même (session, limite) : levée, pas confondue avec un refus de Google', async () => {
      const s = await signedIn();
      respond = () => json({ error: 'Trop de demandes, réessaie plus tard' }, { status: 429 });
      await expect(s.googleToken({})).rejects.toMatchObject({ errors: ['Trop de demandes, réessaie plus tard'] });
    });
  });

  describe('accountError', () => {
    it('messages lisibles pour chaque cause', () => {
      const entry = new EntryError(['déjà prêt']);
      expect(accountError(entry)).toBe(entry);
      expect(accountError(new WrongPassphrase('Phrase de passe incorrecte')).errors).toEqual(['Phrase de passe incorrecte']);
      expect(accountError(new Rollback('version 3 < 5')).errors[0]).toMatch(/^Sauvegarde refusée : version 3 < 5\. Préviens/);
      expect(accountError(new TamperedData('objet altéré')).errors[0]).toBe('Sauvegarde illisible avec cette clé (objet altéré)');
      expect(accountError(new ApiError(500, { error: 'panne' })).errors).toEqual(['panne']);
      expect(accountError(new ApiError(502, {})).errors).toEqual(['HTTP 502']);
      expect(accountError(new DOMException('annulé', 'NotAllowedError')).errors).toEqual(['Passkey annulée ou refusée']);
      expect(accountError(new DOMException('abandon', 'AbortError')).errors).toEqual(['Passkey annulée ou refusée']);
      expect(accountError(new TypeError('Failed to fetch')).errors[0]).toMatch(/^NAS injoignable/);
      expect(accountError(new Error('autre')).errors).toEqual(['autre']);
      expect(accountError(undefined).errors).toEqual(['erreur inconnue']);
    });
  });
});
