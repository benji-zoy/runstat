import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Activity, CorosData } from './models';
import { CAPABILITIES, sourcesOf } from './sources';
import { DataService } from './data.service';
import { ScienceService } from './science.service';

function run(id: string, date: string, extra: Partial<Activity> = {}): Activity {
  return {
    id, sportType: 100, kind: 'road', date, name: 'Sortie', start: null, durationSec: 3000, distanceKm: 10,
    avgHr: 150, calories: null, lat: null, lon: null, ...extra,
  };
}

function snapshot(over: Partial<CorosData>): CorosData {
  return {
    generatedAt: '2026-10-17T00:00:00Z',
    athlete: { hrMax: 190, hrRest: 50, sex: 'M', weightKg: 70, heightCm: 175, birthday: '1990-01-01' },
    health: null, activities: [], fitness: null, load: [], ...over,
  };
}

describe('sources de données', () => {
  it('suppose COROS + Google Health pour un instantané sans sources', () => {
    expect(sourcesOf(null)).toEqual({ activities: 'coros', health: 'google' });
    expect(sourcesOf({})).toEqual({ activities: 'coros', health: 'google' });
    expect(sourcesOf({ sources: { activities: 'strava', health: 'none' } })).toEqual({ activities: 'strava', health: 'none' });
  });

  it('ne promet sous Strava aucune métrique propre à COROS', () => {
    const s = CAPABILITIES.strava;
    expect([s.corosLoad, s.trainingEffect, s.corosFitness, s.loadRatio, s.fitQuota]).toEqual([false, false, false, false, false]);
    expect(s.loadLabel).toContain('TRIMP');
    expect(CAPABILITIES.coros.trainingEffect).toBe(true);
  });

  it('classe en course une sortie marquée « course » dans Strava, quel que soit son nom', () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('hors ligne')));
    try {
      TestBed.configureTestingModule({ providers: [provideRouter([])] });
      const store = TestBed.inject(DataService);
      const sci = TestBed.inject(ScienceService);
      store.data.set(
        snapshot({
          sources: { activities: 'strava', health: 'none' },
          activities: [
            run('strava:1', '2026-10-01', { source: 'strava', name: 'Morning Run', race: true }),
            run('strava:2', '2026-10-03', { source: 'strava', name: 'Morning Run' }),
          ],
        }),
      );
      expect(sci.types().get('strava:1')).toBe('race');
      expect(sci.types().get('strava:2')).not.toBe('race');
      expect(sci.caps().label).toBe('Strava');
      expect(sci.healthLabel()).toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
