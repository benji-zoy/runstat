import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AccountService } from './account.service';
import { DataService } from './data.service';
import { DeviceSyncService } from './device-sync.service';
import { LocalService } from './local.service';
import { SyncService } from './sync.service';

// Synchro par le service du NAS (le mode local-first est couvert par device-sync.service.spec.ts) : fetch bouchonné
describe('SyncService (NAS)', () => {
  let calls: { url: string; method: string; headers: Record<string, string> }[];
  let status: unknown;
  let reloads: number;
  const data = signal<any>(null);
  const activities = signal<any[]>([]);

  const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });
  const idle = (over: object = {}) => ({ running: false, startedAt: null, nextAt: null, state: {}, log: [], ...over });

  /** Réponse du NAS à une requête ; `status` = réponse à GET /api/sync */
  let respond: (url: string, method: string) => Response | Promise<Response>;

  function create(): SyncService {
    return TestBed.inject(SyncService);
  }
  const flush = () => (async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); })();
  /** Laisse passer les attentes de suivi (3 s entre deux lectures) sans les attendre pour de vrai */
  async function settle<T>(p: Promise<T>): Promise<T> {
    let done = false;
    void p.finally(() => (done = true));
    for (let i = 0; i < 30 && !done; i++) await vi.advanceTimersByTimeAsync(1000);
    return p;
  }
  const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  beforeEach(() => {
    calls = [];
    reloads = 0;
    status = idle();
    data.set(null);
    activities.set([]);
    respond = (url, method) => (method === 'GET' && url === 'api/sync' ? json(status) : json({}));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string> });
        return respond(url, init.method ?? 'GET');
      }),
    );
    TestBed.configureTestingModule({
      providers: [
        { provide: DataService, useValue: { data, activities, reload: async () => void reloads++ } },
        { provide: LocalService, useValue: { busy: signal(false) } },
        { provide: AccountService, useValue: { connected: signal(false) } },
        { provide: DeviceSyncService, useValue: {} },
      ],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('disponibilité', () => {
    it('disponible quand le service répond en JSON', async () => {
      const s = create();
      await flush();
      expect(s.available()).toBe(true);
      expect(s.running()).toBe(false);
      expect(calls[0]).toMatchObject({ url: 'api/sync', method: 'GET' });
    });

    it('indisponible si ng serve renvoie index.html, sur une erreur HTTP ou un réseau coupé', async () => {
      respond = () => new Response('<html>', { headers: { 'content-type': 'text/html' } });
      const html = create();
      await flush();
      expect(html.available()).toBe(false);
      expect(html.status()).toBeNull();

      TestBed.resetTestingModule();
      respond = () => json({}, { status: 500 });
      TestBed.configureTestingModule({
        providers: [
          { provide: DataService, useValue: { data, activities, reload: async () => undefined } },
          { provide: LocalService, useValue: { busy: signal(false) } },
          { provide: AccountService, useValue: { connected: signal(false) } },
          { provide: DeviceSyncService, useValue: {} },
        ],
      });
      const err = create();
      await flush();
      expect(err.available()).toBe(false);

      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
      await err.refresh();
      expect(err.available()).toBe(false);
    });

    it('lit l’état « en cours » du run', async () => {
      status = idle({ running: true });
      const s = create();
      // le constructeur démarre le suivi du run : on ne l'attend pas
      await vi.waitFor(() => expect(s.running()).toBe(true));
    });
  });

  describe('sources actives, problèmes et info-bulle', () => {
    it('COROS et Google Health par défaut', async () => {
      const s = create();
      await flush();
      expect(s.active()).toEqual(['coros', 'google']);
      expect(s.label('corosHealth')).toBe('COROS santé');
    });

    it('suit les sources choisies dans le snapshot', async () => {
      data.set({ sources: { activities: 'strava', health: 'garmin' } });
      const s = create();
      await flush();
      expect(s.active()).toEqual(['strava', 'garminHealth']);
      data.set({ sources: { activities: 'garmin', health: 'none' } });
      expect(s.active()).toEqual(['garmin']);
    });

    it('signale une source en erreur ou à ré-autoriser, avec la bonne commande', async () => {
      data.set({ sources: { activities: 'strava', health: 'google' } });
      status = idle({
        state: {
          strava: { reauthSince: '2026-11-01' },
          google: { lastError: 'quota dépassé' },
          lastBuildError: 'disque plein',
          lastImportError: 'zip illisible',
        },
      });
      const s = create();
      await flush();
      expect(s.problems()).toEqual([
        'Strava : ré-autorisation nécessaire (Réglages › Connecter Strava)',
        'Google Health : quota dépassé',
        'Reconstruction : disque plein',
        'Archive Strava : zip illisible',
      ]);
    });

    it('COROS sur le NAS : ré-autorisation par la commande, Garmin : clé refusée', async () => {
      status = idle({ state: { coros: { reauthSince: 'x' } } });
      const s = create();
      await flush();
      expect(s.problems()).toEqual(['COROS : ré-autorisation nécessaire (npm run auth -- coros)']);
      data.set({ sources: { activities: 'garmin', health: 'none' } });
      status = idle({ state: { garmin: { reauthSince: 'x' } } });
      await s.refresh();
      expect(s.problems()[0]).toMatch(/Garmin : clé refusée/);
    });

    it('ignore les erreurs des sources non actives, aucun problème sans état', async () => {
      status = idle({ state: { strava: { lastError: 'ignorée' } } });
      const s = create();
      await flush();
      expect(s.problems()).toEqual([]);
    });

    it('info-bulle : fraîcheur de chaque source, file d’attente, run en cours', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
      status = idle({ state: { coros: { lastSuccess: '2026-11-11T11:30:00Z' } } });
      const s = create();
      await vi.waitFor(() => expect(s.available()).toBe(true));
      expect(s.title()).toContain('Synchroniser COROS et Google Health');
      expect(s.title()).toContain('COROS : à jour il y a 30 min');
      expect(s.title()).toContain('Google Health : jamais synchronisé');
      status = idle({ queued: true, running: true });
      await s.refresh();
      expect(s.title()).toBe('En file d’attente : un autre compte synchronise');
      status = idle({ running: true });
      await s.refresh();
      expect(s.title()).toBe('Synchronisation en cours…');
    });

    it('info-bulle vide sans service', async () => {
      respond = () => new Response('', { headers: { 'content-type': 'text/html' } });
      const s = create();
      await flush();
      expect(s.title()).toBe('');
    });
  });

  describe('trigger', () => {
    it('POST /api/sync avec l’en-tête X-RunStat, puis relit l’état', async () => {
      const s = create();
      await flush();
      calls.length = 0;
      await s.trigger();
      expect(calls[0]).toMatchObject({ url: 'api/sync', method: 'POST', headers: { 'X-RunStat': 'sync' } });
      expect(calls[1]).toMatchObject({ url: 'api/sync', method: 'GET' });
      expect(s.notice()).toBeNull();
    });

    it('ne fait rien si un run est déjà en cours', async () => {
      status = idle({ running: true });
      const s = create();
      await vi.waitFor(() => expect(s.running()).toBe(true));
      calls.length = 0;
      await s.trigger();
      expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    });

    it('429 : message avec le délai', async () => {
      respond = (url, method) => (method === 'POST' ? json({ retryInSec: 12 }, { status: 429 }) : json(status));
      const s = create();
      await flush();
      await s.trigger();
      expect(s.notice()).toBe('Synchro toute récente : réessaie dans 12 s');
    });

    it('autre refus : message avec l’erreur du service ; 409 sans message', async () => {
      respond = (url, method) => (method === 'POST' ? json({ error: 'quota du compte' }, { status: 507 }) : json(status));
      const s = create();
      await flush();
      await s.trigger();
      expect(s.notice()).toBe('Synchro impossible (quota du compte)');
      s.notice.set(null);
      respond = (url, method) => (method === 'POST' ? json({}, { status: 409 }) : json(status));
      await s.trigger();
      expect(s.notice()).toBeNull();
    });

    it('service injoignable', async () => {
      const s = create();
      await flush();
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
      await s.trigger();
      expect(s.notice()).toBe('Service de synchro injoignable');
    });

    it('le message s’efface tout seul', async () => {
      respond = (url, method) => (method === 'POST' ? json({}, { status: 429 }) : json(status));
      const s = create();
      await flush();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await s.trigger();
      expect(s.notice()).toContain('réessaie dans 60 s');
      vi.advanceTimersByTime(5001);
      expect(s.notice()).toBeNull();
    });

    it('suit le run jusqu’à la fin puis recharge les données', async () => {
      const s = create();
      await flush();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let polls = 0;
      respond = (url, method) => {
        if (method === 'POST') {
          status = idle({ running: true });
          return json({}, { status: 202 });
        }
        if (status && (status as any).running && ++polls >= 2) status = idle();
        return json(status);
      };
      await settle(s.trigger());
      expect(reloads).toBe(1);
      expect(s.running()).toBe(false);
      expect(s.notice()).toBe('Données à jour');
    });
  });

  describe('affiner une sortie (FIT)', () => {
    beforeEach(fakeTimers);
    it('POST /api/fit?id= encodé, avec X-RunStat', async () => {
      activities.set([{ id: 'strava:1', fit: { efforts: {} } }]);
      const s = create();
      await flush();
      calls.length = 0;
      await settle(s.refineFit('strava:1'));
      expect(calls[0]).toMatchObject({ url: 'api/fit?id=strava%3A1', method: 'POST', headers: { 'X-RunStat': 'sync' } });
      expect(s.refineNotice()).toEqual({ id: 'strava:1', text: 'Tracé ajouté : analyse affinée' });
      expect(s.refining()).toBeNull();
    });

    it('sans FIT à l’arrivée : indisponible, avec l’erreur du service sans son préfixe', async () => {
      activities.set([{ id: '42' }]);
      const s = create();
      await flush();
      respond = (url, method) => {
        if (method === 'POST') return json({}, { status: 202 });
        return json(idle({ state: { lastFitError: '42 : quota de 50 FIT atteint' } }));
      };
      await settle(s.refineFit('42'));
      expect(s.refineNotice()).toEqual({ id: '42', text: 'Tracé indisponible (quota de 50 FIT atteint)' });
    });

    it('409 : synchro en cours ; autres erreurs : message du service', async () => {
      const s = create();
      await flush();
      respond = (url, method) => (method === 'POST' ? json({}, { status: 409 }) : json(status));
      await settle(s.refineFit('1'));
      expect(s.refineNotice()?.text).toBe('Synchro en cours, réessaie dans un instant');
      respond = (url, method) => (method === 'POST' ? json({ error: 'sortie inconnue' }, { status: 404 }) : json(status));
      await settle(s.refineFit('1'));
      expect(s.refineNotice()?.text).toBe('Impossible (sortie inconnue)');
      expect(s.refining()).toBeNull();
    });

    it('service injoignable', async () => {
      const s = create();
      await flush();
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
      await settle(s.refineFit('1'));
      expect(s.refineNotice()).toEqual({ id: '1', text: 'Service de synchro injoignable' });
      expect(s.refining()).toBeNull();
    });

    it('ne fait rien pendant un run', async () => {
      status = idle({ running: true });
      const s = create();
      await vi.waitFor(() => expect(s.running()).toBe(true));
      calls.length = 0;
      await settle(s.refineFit('1'));
      expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
      expect(s.refining()).toBeNull();
    });
  });

  describe('relancer les FIT récents', () => {
    beforeEach(fakeTimers);
    it('POST /api/fit?days=14 par défaut, résultat sans erreur', async () => {
      const s = create();
      await flush();
      calls.length = 0;
      await settle(s.refitRecent());
      expect(calls[0]).toMatchObject({ url: 'api/fit?days=14', method: 'POST', headers: { 'X-RunStat': 'sync' } });
      expect(s.refitNotice()).toBe('FIT retéléchargés, analyse recalculée');
      expect(s.refitting()).toBe(false);
    });

    it('nombre de jours choisi, erreur FIT ou de reconstruction rapportée', async () => {
      const s = create();
      await flush();
      respond = (url, method) => (method === 'POST' ? json({}) : json(idle({ state: { lastFitError: 'quota' } })));
      await settle(s.refitRecent(30));
      expect(calls.find((c) => c.method === 'POST')!.url).toBe('api/fit?days=30');
      expect(s.refitNotice()).toBe('Terminé avec une erreur (quota)');
      respond = (url, method) => (method === 'POST' ? json({}) : json(idle({ state: { lastBuildError: 'x' } })));
      await settle(s.refitRecent());
      expect(s.refitNotice()).toBe('FIT retéléchargés, reconstruction en échec');
    });

    it('409, erreur HTTP, injoignable', async () => {
      const s = create();
      await flush();
      respond = (url, method) => (method === 'POST' ? json({}, { status: 409 }) : json(status));
      await settle(s.refitRecent());
      expect(s.refitNotice()).toBe('Déjà en cours, réessaie dans un instant');
      respond = (url, method) => (method === 'POST' ? new Response('boom', { status: 500 }) : json(status));
      await settle(s.refitRecent());
      expect(s.refitNotice()).toBe('Impossible (HTTP 500)');
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
      await settle(s.refitRecent());
      expect(s.refitNotice()).toBe('Service de synchro injoignable');
      expect(s.refitting()).toBe(false);
    });
  });

  describe('retour de connexion', () => {
    it('Strava : message selon la raison, succès par défaut, refus générique', async () => {
      const s = create();
      await flush();
      s.connectionReturned('strava', 'refus', 'echange');
      expect(s.notice()).toBe('Strava a refusé : vérifie le Client Secret');
      s.connectionReturned('strava', 'refus', null);
      expect(s.notice()).toBe('Connexion Strava refusée');
      s.connectionReturned('strava', 'refus', 'inconnue');
      expect(s.notice()).toBe('Connexion Strava refusée');
      s.connectionReturned('strava', 'ok', 'public');
      expect(s.notice()).toBe('Strava connecté, sans tes sorties privées');
      s.connectionReturned('strava', 'ok', null);
      expect(s.notice()).toBe('Strava connecté : synchro de tes sorties');
    });

    it('COROS et Google : messages au nom de la source', async () => {
      const s = create();
      await flush();
      s.connectionReturned('coros', 'refus', 'lien');
      expect(s.notice()).toBe('Lien COROS expiré : recommence depuis Réglages');
      s.connectionReturned('google', 'refus', 'appli');
      expect(s.notice()).toBe('Google Health : l’appli OAuth du propriétaire manque sur le NAS');
      s.connectionReturned('google', 'refus', 'zzz');
      expect(s.notice()).toBe('Connexion Google Health refusée');
      s.connectionReturned('coros', 'ok', null);
      expect(s.notice()).toBe('COROS connecté : synchro lancée');
    });

    it('une connexion réussie relit l’état (suivi de la synchro lancée par le service)', async () => {
      const s = create();
      await flush();
      calls.length = 0;
      s.connectionReturned('strava', 'ok', null);
      await flush();
      expect(calls.some((c) => c.url === 'api/sync' && c.method === 'GET')).toBe(true);
      // un refus ne relit rien
      calls.length = 0;
      s.connectionReturned('strava', 'refus', 'annule');
      await flush();
      expect(calls).toEqual([]);
    });
  });

  describe('suivi après une saisie ou une archive', () => {
    it('follow : sans run en cours, relit seulement l’état', async () => {
      const s = create();
      await flush();
      calls.length = 0;
      await s.follow();
      expect(calls.map((c) => c.method)).toEqual(['GET']);
      expect(reloads).toBe(0);
    });

    it('follow : run en cours → attend la fin, recharge, sans message', async () => {
      const s = create();
      await flush();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let n = 0;
      respond = () => json(++n < 3 ? idle({ running: true }) : idle());
      await settle(s.follow());
      expect(reloads).toBe(1);
      expect(s.notice()).toBeNull();
    });
  });
});
