import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { DataService } from './data.service';
import { DeviceSyncService } from './device-sync.service';
import { EntriesService } from './entries.service';
import { EntryError } from './entry-error';
import { LocalService } from './local.service';
import { SyncService } from './sync.service';

// Saisie sur le NAS (le mode local-first est couvert par local.service.spec.ts) : fetch bouchonné, service de synchro simulé
describe('EntriesService (NAS)', () => {
  let calls: { url: string; method: string; headers: Record<string, string>; body: any }[];
  let respond: (url: string, method: string) => Response;
  let followed: number;
  const available = signal(true);
  const data = signal<any>(null);

  const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });
  const service = () => TestBed.inject(EntriesService);

  beforeEach(() => {
    calls = [];
    followed = 0;
    available.set(true);
    data.set(null);
    respond = () => json({ saved: {} });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined });
        return respond(url, init.method ?? 'GET');
      }),
    );
    TestBed.configureTestingModule({
      providers: [
        { provide: DataService, useValue: { data, activities: () => data()?.activities ?? [], reload: async () => undefined } },
        { provide: SyncService, useValue: { available, follow: async () => void followed++, followImport: async () => void followed++ } },
        { provide: LocalService, useValue: {} },
        { provide: DeviceSyncService, useValue: {} },
      ],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('saisie disponible seulement si le service de synchro l’est', () => {
    const s = service();
    expect(s.available()).toBe(true);
    available.set(false);
    expect(s.available()).toBe(false);
    expect(s.saving()).toBe(false);
    expect(s.uploading()).toBeNull();
  });

  describe('objectifs', () => {
    const goal = { id: 'semi', name: 'Semi', date: '2027-04-04', distanceKm: 21.0975, kind: 'road' };

    it('PUT /api/goals avec X-RunStat, sans prévision ni plan (ajoutés par la reconstruction)', async () => {
      respond = () => json({ saved: [goal] });
      await service().saveGoals([{ ...goal, forecast: { x: 1 }, plan: { sessions: [] } } as any]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: 'api/goals', method: 'PUT', headers: { 'X-RunStat': 'sync', 'Content-Type': 'application/json' } });
      expect(calls[0].body).toEqual([goal]);
    });

    it('applique tout de suite le résultat, garde plan et prévision tant que le départ n’a pas bougé', async () => {
      const plan = { goalId: 'semi', sessions: [] };
      const forecast = { temp: 12 };
      data.set({ goals: [{ ...goal, startTime: '08:00', plan, forecast }], activities: [] });
      respond = () => json({ saved: [{ ...goal, startTime: '08:00', name: 'Semi de printemps' }] });
      await service().saveGoals([]);
      expect(data().goals[0]).toMatchObject({ name: 'Semi de printemps', plan, forecast });
      // l'heure de départ change : la prévision n'est plus valable
      respond = () => json({ saved: [{ ...goal, startTime: '09:30' }] });
      await service().saveGoals([]);
      expect(data().goals[0].forecast).toBeUndefined();
      expect(data().goals[0].plan).toEqual(plan);
    });

    it('lance le suivi de la reconstruction', async () => {
      respond = () => json({ saved: [] });
      await service().saveGoals([]);
      expect(followed).toBe(1);
    });

    it('sans données chargées : rien à corriger, pas d’erreur', async () => {
      respond = () => json({ saved: [goal] });
      await expect(service().saveGoals([goal as any])).resolves.toBeUndefined();
      expect(data()).toBeNull();
    });
  });

  describe('erreurs', () => {
    it('les erreurs de validation du service sont rendues telles quelles, sans suivi', async () => {
      respond = () => json({ errors: ['date invalide', 'distance manquante'] }, { status: 400 });
      const err = await service().saveGoals([]).catch((e) => e);
      expect(err).toBeInstanceOf(EntryError);
      expect(err.errors).toEqual(['date invalide', 'distance manquante']);
      expect(followed).toBe(0);
    });

    it('message unique ou statut HTTP à défaut', async () => {
      respond = () => json({ error: 'quota dépassé' }, { status: 507 });
      await expect(service().saveAthlete({} as any)).rejects.toMatchObject({ errors: ['quota dépassé'] });
      respond = () => new Response('boom', { status: 502 });
      await expect(service().saveAthlete({} as any)).rejects.toMatchObject({ errors: ['HTTP 502'] });
    });

    it('service injoignable', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
      await expect(service().saveSources({ activities: 'coros', health: 'none' })).rejects.toMatchObject({ errors: ['Service de synchro injoignable'] });
    });

    it('`saving` est vrai pendant l’envoi, faux ensuite même après une erreur', async () => {
      const s = service();
      let during = false;
      respond = () => {
        during = s.saving();
        return json({ error: 'non' }, { status: 400 });
      };
      await s.saveAthlete({} as any).catch(() => undefined);
      expect(during).toBe(true);
      expect(s.saving()).toBe(false);
    });
  });

  describe('réglages', () => {
    it('athlète et sources : PUT puis snapshot mis à jour', async () => {
      data.set({ activities: [], athlete: { hrMax: 180 } });
      respond = () => json({ saved: { hrMax: 190 } });
      await service().saveAthlete({ hrMax: 190 } as any);
      expect(calls[0]).toMatchObject({ url: 'api/athlete', method: 'PUT' });
      expect(data().athlete).toEqual({ hrMax: 190 });
      respond = () => json({ saved: { activities: 'strava', health: 'none' } });
      await service().saveSources({ activities: 'strava', health: 'none' });
      expect(calls[1]).toMatchObject({ url: 'api/sources', body: { activities: 'strava', health: 'none' } });
      expect(data().sources).toEqual({ activities: 'strava', health: 'none' });
    });

    it('appli Strava et clé Garmin : corps attendu par le service, suppression par DELETE', async () => {
      const s = service();
      await s.saveStravaClient('123', 'secret');
      expect(calls[0]).toMatchObject({ url: 'api/strava/client', method: 'PUT', body: { client_id: '123', client_secret: 'secret' } });
      await s.saveGarminKey('cle', 90);
      expect(calls[1]).toMatchObject({ url: 'api/garmin/key', method: 'PUT', body: { apiKey: 'cle', days: 90 } });
      await s.removeGarminKey();
      expect(calls[2]).toMatchObject({ url: 'api/garmin/key', method: 'DELETE', body: undefined });
      expect(calls[2].headers['X-RunStat']).toBe('sync');
    });

    it('cycles : le plan est gardé, jamais envoyé', async () => {
      const plan = { goalId: 'c1', sessions: [] };
      data.set({ activities: [], cycles: [{ id: 'c1', name: 'C', plan }] });
      respond = () => json({ saved: [{ id: 'c1', name: 'Nouveau' }] });
      await service().saveCycles([{ id: 'c1', name: 'Nouveau', plan } as any]);
      expect(calls[0].body[0]).not.toHaveProperty('plan');
      expect(data().cycles[0]).toMatchObject({ name: 'Nouveau', plan });
    });
  });

  describe('classements', () => {
    it('PUT sur la sortie, identifiant de sortie retiré du résultat gardé, ancien fichier remplacé', async () => {
      data.set({ activities: [{ id: 'strava:1' }, { id: 'strava:2' }] });
      respond = () => json({ saved: { activityId: 'strava:1', event: '10 km', rank: 3 } });
      await service().saveResult('strava:1', { event: '10 km' } as any, 'date-2026-03-15-10.json');
      expect(calls[0].url).toBe('api/results/strava:1?replaces=date-2026-03-15-10.json');
      expect(data().activities[0].result).toEqual({ event: '10 km', rank: 3 });
      expect(data().activities[1].result).toBeUndefined();
    });

    it('sans fichier à remplacer : pas de paramètre ; suppression retire le classement', async () => {
      data.set({ activities: [{ id: '7', result: { event: 'x' } }] });
      respond = () => json({ saved: { activityId: '7', event: 'y' } });
      await service().saveResult('7', { event: 'y' } as any);
      expect(calls[0].url).toBe('api/results/7');
      await service().deleteResult('7', 'a b.json');
      expect(calls[1]).toMatchObject({ url: 'api/results/7?replaces=a%20b.json', method: 'DELETE' });
      expect(data().activities[0]).not.toHaveProperty('result');
    });
  });

  describe('plans', () => {
    const plan = { goalId: 'semi', importedAt: '2026-11-01T00:00:00Z', sessions: [] } as any;

    it('enregistre le plan sur l’objectif (ou le cycle) concerné', async () => {
      data.set({ activities: [], goals: [{ id: 'semi' }, { id: 'autre' }], cycles: [{ id: 'c1' }] });
      respond = () => json({ saved: plan });
      await service().savePlan(plan);
      expect(calls[0]).toMatchObject({ url: 'api/plans/semi', method: 'PUT', body: plan });
      expect(data().goals[0].plan).toEqual(plan);
      expect(data().goals[1].plan).toBeUndefined();
      expect(data().cycles[0].plan).toBeUndefined();
    });

    it('suppression : seul le plan de l’objectif visé disparaît', async () => {
      data.set({ activities: [], goals: [{ id: 'semi', plan }, { id: 'autre', plan }], cycles: [] });
      await service().deletePlan('semi');
      expect(calls[0]).toMatchObject({ url: 'api/plans/semi', method: 'DELETE' });
      expect(data().goals[0]).not.toHaveProperty('plan');
      expect(data().goals[1].plan).toEqual(plan);
    });
  });

  describe('envoi du plan dans COROS', () => {
    it('refus du service : erreur avec son message', async () => {
      respond = () => json({ error: 'plan déjà commencé' }, { status: 409 });
      await expect(service().sendPlanToCoros('semi')).rejects.toMatchObject({ errors: ['plan déjà commencé'] });
      expect(calls[0]).toMatchObject({ url: 'api/plans/semi/coros', method: 'POST', headers: { 'X-RunStat': 'sync' } });
      expect(service().saving()).toBe(false);
    });

    it('résultat pas encore connu : demande acceptée', async () => {
      data.set({ activities: [], goals: [{ id: 'semi', plan: { sessions: [] } }] });
      respond = () => json({});
      expect(await service().sendPlanToCoros('semi')).toMatch(/Envoi demandé/);
      expect(followed).toBe(1);
    });

    it('résultat rapporté par le NAS après la reconstruction', async () => {
      const s = service();
      data.set({ activities: [], goals: [{ id: 'semi', plan: { sessions: [] } }] });
      const follow = TestBed.inject(SyncService) as any;
      follow.follow = async () => data.set({ activities: [], goals: [{ id: 'semi', plan: { sessions: [], coros: { sentAt: '2026-11-11T10:00:00Z', sessions: 24, weeks: 8 } } }] });
      respond = () => json({});
      expect(await s.sendPlanToCoros('semi')).toBe('Plan envoyé dans COROS : 24 séances sur 8 semaines.');
    });

    it('échec COROS plus récent que le dernier envoi : erreur', async () => {
      const s = service();
      data.set({ activities: [], goals: [{ id: 'semi', plan: { sessions: [] } }] });
      (TestBed.inject(SyncService) as any).follow = async () =>
        data.set({ activities: [], goals: [{ id: 'semi', plan: { sessions: [], coros: { sentAt: '2026-11-01T00:00:00Z', errorAt: '2026-11-11T00:00:00Z', error: 'jeton refusé' } } }] });
      respond = () => json({});
      await expect(s.sendPlanToCoros('semi')).rejects.toMatchObject({ errors: ['COROS : jeton refusé'] });
    });
  });

  describe('archive Strava', () => {
    class FakeXhr {
      static last: FakeXhr;
      status = 200;
      responseText = '{}';
      headers: Record<string, string> = {};
      upload: { onprogress?: (e: unknown) => void } = {};
      onload?: () => void;
      onerror?: () => void;
      method = '';
      url = '';
      open(method: string, url: string) {
        this.method = method;
        this.url = url;
        FakeXhr.last = this;
      }
      setRequestHeader(k: string, v: string) {
        this.headers[k] = v;
      }
      send() {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 });
        queueMicrotask(() => this.onload?.());
      }
    }
    beforeEach(() => vi.stubGlobal('XMLHttpRequest', FakeXhr));

    it('envoi avec X-RunStat, progression, puis suivi de l’import', async () => {
      const s = service();
      const seen: (number | null)[] = [];
      const file = new File(['zip'], 'export.zip');
      const p = s.uploadStravaArchive(file);
      seen.push(s.uploading());
      await p;
      expect(FakeXhr.last).toMatchObject({ method: 'POST', url: 'api/strava/archive' });
      expect(FakeXhr.last.headers).toMatchObject({ 'X-RunStat': 'sync', 'Content-Type': 'application/zip' });
      expect(seen[0]).toBe(0.25);
      expect(s.uploading()).toBeNull();
      expect(followed).toBe(1);
    });

    it('413 : trop volumineuse ; autre échec : message du service ; progression remise à zéro', async () => {
      const s = service();
      const bad = (status: number, body: string) =>
        class extends FakeXhr {
          override status = status;
          override responseText = body;
        };
      vi.stubGlobal('XMLHttpRequest', bad(413, ''));
      await expect(s.uploadStravaArchive(new File([''], 'a.zip'))).rejects.toMatchObject({ errors: ['Archive trop volumineuse (2 Go au plus)'] });
      vi.stubGlobal('XMLHttpRequest', bad(409, '{"error":"import en cours"}'));
      await expect(s.uploadStravaArchive(new File([''], 'a.zip'))).rejects.toMatchObject({ errors: ['import en cours'] });
      vi.stubGlobal('XMLHttpRequest', bad(500, 'pas du JSON'));
      await expect(s.uploadStravaArchive(new File([''], 'a.zip'))).rejects.toMatchObject({ errors: ['HTTP 500'] });
      expect(s.uploading()).toBeNull();
      expect(followed).toBe(0);
    });
  });
});
