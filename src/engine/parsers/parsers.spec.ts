// Parseurs des sources, sources et file FIT : le même code que la synchro Node (scripts/sync/*.test.mjs couvre
// le détail), vérifié ici dans l'environnement du navigateur.
import { fitQueue, fitQueueText } from '../fit-queue.ts';
import { fileKey, idFromFileKey, normalizeSources } from '../sources.ts';
import { corosDaily, corosHrv, corosRhr, csvFr } from '../testing/fixtures.ts';
import { healthFromCoros } from './coros-health.ts';
import { parseDetail, unwrap } from './coros.ts';
import { activityFromApi, parseActivitiesCsv } from './strava.ts';

describe('parseurs', () => {
  it('santé COROS : sommeil, VFC et FC de repos fusionnés par jour', () => {
    const h = healthFromCoros({ daily: [corosDaily], hrv: [corosHrv], rhr: [corosRhr] });
    const days = Object.values(h.days);
    expect(days.length).toBeGreaterThan(0);
    expect(days.some((d) => d.hrv != null)).toBe(true);
    expect(days.some((d) => d.rhr != null)).toBe(true);
    expect(h.weight).toEqual([]);
  });

  it('archive Strava en français : course à pied seulement, dates en heure de Paris', () => {
    const runs = parseActivitiesCsv(csvFr);
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) {
      expect(r.id).toMatch(/^strava:\d+$/);
      expect([100, 101, 102]).toContain(r.sportType);
    }
  });

  it('API Strava : course marquée, autres sports ignorés', () => {
    const base = { id: 7, distance: 10000, moving_time: 2700, start_date: '2026-03-01T08:00:00Z', start_date_local: '2026-03-01T09:00:00Z' };
    expect(activityFromApi({ ...base, sport_type: 'Run', workout_type: 1 })).toMatchObject({ id: 'strava:7', sportType: 100, race: true });
    expect(activityFromApi({ ...base, sport_type: 'Ride' })).toBeNull();
  });

  it('détail COROS dans une chaîne JSON encodée', () => {
    const text = JSON.stringify('Elevation Gain / Loss: 120 m / 118 m\nTraining Load: 95\nBest Kilometer: 4:41 /km');
    expect(unwrap(text)).toContain('Training Load');
    expect(parseDetail(1, text)).toMatchObject({ id: '1', elevGain: 120, elevLoss: 118, trainingLoad: 95, bestKm: '4:41' });
  });
});

describe('sources et file FIT', () => {
  it('sources normalisées, clés de fichier', () => {
    expect(normalizeSources(null)).toEqual({ activities: 'coros', health: 'google' });
    expect(normalizeSources({ activities: 'strava', health: 'x' })).toEqual({ activities: 'strava', health: 'google' });
    expect(idFromFileKey(fileKey('strava:12'))).toBe('strava:12');
  });

  it('courses, puis sorties longues, puis qualité, puis le reste, du plus récent au plus ancien', () => {
    const a = (id: string, name: string, distanceKm = 8, durationSec = 2400, extra = {}) => ({ id, sportType: 100, date: '2026-01-01', name, distanceKm, durationSec, ...extra });
    const q = fitQueue(
      [a('1', 'Footing'), a('2', 'Semi de Testville 2026', 21.1), a('3', 'Sortie longue', 20, 6000), a('4', '10x400'), a('5', 'Footing'), a('6', 'Seuil', 10, 2700, { focus: 'Threshold' })],
      new Set(['5']),
    );
    expect(fitQueueText(q).split('\n').map((l) => l.split(' ')[0])).toEqual(['2', '3', '6', '4', '1', '']);
  });
});
