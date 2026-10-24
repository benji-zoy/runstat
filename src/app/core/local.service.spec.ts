import { TestBed } from '@angular/core/testing';
import { IDBFactory } from 'fake-indexeddb';
import { EntryError } from './entry-error';
import { LocalService } from './local.service';

// Saisie en mode local-first : mêmes règles de validation que le NAS (src/engine/entries.ts), écriture dans IndexedDB
describe('saisie sur l’appareil', () => {
  let local: LocalService;
  const athlete = { hrMax: 190, hrRest: 50, sex: 'M', weightKg: 70, heightCm: 175, birthday: '1990-01-01' };

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    TestBed.configureTestingModule({});
    local = TestBed.inject(LocalService);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('valide comme le NAS et écrit dans la zone raw', async () => {
    await expect(local.apply('PUT', 'athlete', { ...athlete, nom: 'X' })).rejects.toBeInstanceOf(EntryError);
    await expect(local.apply('PUT', 'athlete', { ...athlete, hrRest: 180 })).rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/hrRest/)]) });
    const { saved } = await local.apply('PUT', 'athlete', { ...athlete, homeCity: 'Lyon' });
    expect(saved).toEqual({ ...athlete, homeCity: 'Lyon' });
    const goals = [{ id: 'semi', name: 'Semi', date: '2027-04-04', distanceKm: 21.0975, kind: 'road' }];
    expect((await local.apply('PUT', 'goals', goals)).saved).toEqual(goals);
    await expect(local.apply('PUT', 'goals', [...goals, goals[0]])).rejects.toBeInstanceOf(EntryError);
    expect((await local.apply('PUT', 'sources', { activities: 'strava', health: 'none' })).saved).toEqual({ activities: 'strava', health: 'none' });
  });

  it('classements : aucun nom de tiers, remplacement du fichier par date, suppression', async () => {
    const result = { event: '10 km', source: 'https://example.org', rank: 3, finishers: 10 };
    await expect(local.apply('PUT', 'results/strava:12', { ...result, name: 'DUPONT' })).rejects.toBeInstanceOf(EntryError);
    const { saved } = await local.apply('PUT', 'results/strava:12?replaces=date-2026-03-15-10.json', result);
    expect(saved).toMatchObject({ activityId: 'strava:12', rank: 3 });
    await local.apply('DELETE', 'results/strava:12');
    await expect(local.apply('DELETE', 'results/strava:12')).rejects.toMatchObject({ errors: ['aucun classement pour cette sortie'] });
    await expect(local.apply('PUT', 'strava/client', {})).rejects.toBeInstanceOf(EntryError);
  });

  it('snapshot absent : compte vide', async () => {
    expect(await local.snapshot()).toBeNull();
    expect(await local.routes()).toEqual({});
  });
});
