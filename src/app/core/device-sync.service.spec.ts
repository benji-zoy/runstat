import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { MemoryStore } from '../../engine/storage/memory';
import { AccountService } from './account.service';
import { DataService } from './data.service';
import { DeviceSyncService, NotPrimary, PRIMARY_FILE } from './device-sync.service';
import { EntryError } from './entry-error';
import { LocalService } from './local.service';

// Appareil principal (seul à renouveler les jetons), connexions OAuth depuis le navigateur, appli Strava de la personne
describe('synchro sur l’appareil', () => {
  let raw: MemoryStore;
  let device: DeviceSyncService;
  let calls: string[];
  const state = signal<any>(null);

  function setup(account: { device: string } | null) {
    raw = new MemoryStore();
    calls = [];
    state.set(account && { nas: 'https://nas.example', token: 't', user: { id: 'carol', name: 'Carol' }, device: { id: account.device, name: `Appareil ${account.device}` }, keys: {} });
    TestBed.configureTestingModule({
      providers: [
        { provide: LocalService, useValue: { raw: async () => raw, rebuild: async () => (calls.push('rebuild'), ''), snapshot: async () => null } },
        { provide: DataService, useValue: { reload: async () => calls.push('reload') } },
        {
          provide: AccountService,
          useValue: {
            state,
            ready: signal(false),
            connected: computed(() => state() != null),
            unlocked: computed(() => Boolean(state()?.keys)),
            sync: async () => (calls.push('sync'), { changed: false }),
          },
        },
      ],
    });
    device = TestBed.inject(DeviceSyncService);
  }
  const refresh = (name = 'coros-tokens.json') => (device as any).store(raw).refresh(name, async () => (calls.push('renew'), 'acc'));

  it('sans appareil principal : il le devient, relit la sauvegarde avant et l’envoie après le renouvellement', async () => {
    setup({ device: 'A' });
    expect(await refresh()).toBe('acc');
    expect(calls).toEqual(['sync', 'sync', 'renew', 'sync']);
    expect(JSON.parse((await raw.readText(PRIMARY_FILE))!)).toMatchObject({ device: 'A', epoch: 1 });
    expect(device.isPrimary()).toBe(true);
  });

  it('appareil secondaire : renouvellement refusé après relecture de la sauvegarde', async () => {
    setup({ device: 'B' });
    await raw.write(PRIMARY_FILE, JSON.stringify({ device: 'A', name: 'Téléphone', epoch: 3, since: '' }));
    await expect(refresh()).rejects.toBeInstanceOf(NotPrimary);
    expect(calls).toEqual(['sync']);
    await device.reload();
    expect(device.isPrimary()).toBe(false);
    // Reprise : époque suivante, sauvegarde envoyée tout de suite, puis le renouvellement passe
    await device.claim();
    expect(JSON.parse((await raw.readText(PRIMARY_FILE))!)).toMatchObject({ device: 'B', epoch: 4 });
    expect(await refresh()).toBe('acc');
  });

  it('sauvegarde verrouillée : pas de renouvellement (les autres appareils ne recevraient pas le nouveau jeton)', async () => {
    setup({ device: 'A' });
    state.update((s) => ({ ...s, keys: undefined }));
    await expect(refresh()).rejects.toThrow(/déverrouille/);
    expect(calls).toEqual([]);
  });

  it('sans compte : appareil seul, renouvellement direct', async () => {
    setup(null);
    expect(await refresh()).toBe('acc');
    expect(calls).toEqual(['renew']);
    expect(device.isPrimary()).toBe(true);
  });

  it('appli Strava : validée comme sur le NAS, changer d’appli efface les jetons', async () => {
    setup(null);
    await expect(device.saveStravaApp('abc', 'court')).rejects.toBeInstanceOf(EntryError);
    await device.saveStravaApp('123', 's'.repeat(40));
    await raw.write('secrets/strava-tokens.json', JSON.stringify({ refresh_token: 'r', access_token: 'a', expires_at: 0 }));
    await device.saveStravaApp('123', 't'.repeat(40));
    expect(await raw.read('secrets/strava-tokens.json')).not.toBeNull();
    await device.saveStravaApp('456', 't'.repeat(40));
    expect(await raw.read('secrets/strava-tokens.json')).toBeNull();
    expect(device.tokens()).toMatchObject({ stravaClient: true, strava: false });
  });

  it('retour de connexion : state vérifié (usage unique), refus Strava sans accès aux activités, échange puis appareil principal', async () => {
    setup({ device: 'A' });
    await device.saveStravaApp('123', 's'.repeat(40));
    const url = new URL(await device.connectUrl('strava'));
    expect(url.searchParams.get('redirect_uri')).toBe(device.redirect('strava'));
    const st = url.searchParams.get('state')!;
    expect(await device.finish('strava', new URLSearchParams({ state: 'autre', code: 'c' }))).toEqual({ result: 'refus', reason: 'lien' });
    // Le state a été consommé par la tentative précédente
    expect(await device.finish('strava', new URLSearchParams({ state: st, code: 'c', scope: 'read,activity:read_all' }))).toEqual({ result: 'refus', reason: 'lien' });

    const st2 = new URL(await device.connectUrl('strava')).searchParams.get('state')!;
    expect(await device.finish('strava', new URLSearchParams({ state: st2, code: 'c', scope: 'read' }))).toEqual({ result: 'refus', reason: 'portee' });

    const st3 = new URL(await device.connectUrl('strava')).searchParams.get('state')!;
    vi.stubGlobal('fetch', async (u: string, init: RequestInit) => {
      expect(String(u)).toBe('https://www.strava.com/oauth/token');
      expect(String(init.body)).toContain('code=c');
      return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 9e9, athlete: { id: 7, firstname: 'Carol' } }));
    });
    try {
      expect(await device.finish('strava', new URLSearchParams({ state: st3, code: 'c', scope: 'read,activity:read' }))).toEqual({ result: 'ok', reason: 'public' });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(device.tokens()).toMatchObject({ strava: true, stravaAthlete: 'Carol' });
    expect(JSON.parse((await raw.readText(PRIMARY_FILE))!)).toMatchObject({ device: 'A' });
  });
});
