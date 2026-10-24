import { Activity } from './models';
import { cumulativeByYear, periodBuckets, periodFor, shiftPeriod, fastestOver, inRange, isoDay, streaks, summarize, weekly } from './stats';
import { TRIPS, haversineKm, headlineHeight, tripFor } from './equivalences';
import { EFFORT_DISTANCES, eddington, topEfforts, weekStreaks } from './insights';
import { BADGES, levelFor } from './badges';

function run(date: string, distanceKm: number, durationSec: number, extra: Partial<Activity> = {}): Activity {
  return {
    id: date + distanceKm,
    sportType: 100,
    kind: 'road',
    date,
    name: '',
    start: null,
    durationSec,
    distanceKm,
    avgHr: null,
    calories: null,
    lat: null,
    lon: null,
    ...extra,
  };
}

describe('stats', () => {
  const today = new Date(2026, 2, 31); // mardi 31 mars 2026

  const first = new Date(2024, 5, 1);

  it('compare le mois en cours au mois précédent à la même date', () => {
    const p = periodFor('month', today, today, first);
    expect(p.current).toBe(true);
    expect(isoDay(p.start)).toBe('2026-03-01');
    expect(isoDay(p.end)).toBe('2026-04-01');
    expect(isoDay(p.prev!.start)).toBe('2026-02-01');
    // 1er avril − 1 mois = 1er mars : tout février est inclus
    expect(isoDay(p.prev!.end)).toBe('2026-03-01');
  });

  it('compare un mois passé au mois précédent entier', () => {
    const p = periodFor('month', new Date(2025, 6, 15), today, first);
    expect(p.current).toBe(false);
    expect(p.label).toBe('Juillet 2025');
    expect(isoDay(p.end)).toBe('2025-08-01');
    expect(isoDay(p.prev!.start)).toBe('2025-06-01');
    expect(isoDay(p.prev!.end)).toBe('2025-07-01');
  });

  it('n’a pas de période précédente avant la première sortie', () => {
    expect(periodFor('year', new Date(2024, 8, 1), today, first).prev).toBeNull();
    expect(periodFor('year', new Date(2025, 8, 1), today, first).prev).not.toBeNull();
  });

  it('navigue de semaine en semaine depuis le lundi', () => {
    const w = periodFor('week', today, today, first);
    expect(isoDay(w.start)).toBe('2026-03-30');
    expect(isoDay(shiftPeriod('week', w.start, -1))).toBe('2026-03-23');
  });

  it('découpe une année en 12 mois cliquables', () => {
    const p = periodFor('year', new Date(2025, 0, 1), today, first);
    const b = periodBuckets([run('2025-03-10', 10, 1), run('2025-03-20', 5, 1)], p, first);
    expect(b.length).toBe(12);
    expect(b[2].km).toBe(15);
    expect(b[2].drill).toBe('month');
  });

  it('filtre une plage avec une fin exclusive', () => {
    const acts = [run('2026-03-01', 5, 1500), run('2026-03-31', 10, 3000), run('2026-04-01', 8, 2400)];
    expect(inRange(acts, new Date(2026, 2, 1), new Date(2026, 3, 1)).length).toBe(2);
  });

  it('résume distance, allure et dénivelé', () => {
    const s = summarize([run('2026-03-01', 10, 3000, { elevGain: 100, cadence: 170 }), run('2026-03-02', 5, 1500)]);
    expect(s.km).toBe(15);
    expect(s.avgPaceSec).toBe(300);
    expect(s.elev).toBe(100);
    expect(s.elevKnown).toBe(1);
    expect(s.steps).toBe(8500);
  });

  it('regroupe par semaine du lundi au dimanche', () => {
    const acts = [run('2026-03-29', 10, 1), run('2026-03-30', 5, 1), run('2026-03-31', 7, 1)];
    const weeks = weekly(acts, today, 2);
    expect(isoDay(weeks[1].start)).toBe('2026-03-30');
    expect(weeks[0].km).toBe(10);
    expect(weeks[1].km).toBe(12);
  });

  it('aligne le cumul sur un calendrier bissextile et coupe avant la première sortie', () => {
    const acts = [run('2025-03-01', 10, 1), run('2026-03-01', 4, 1)];
    const [y2025, y2026] = cumulativeByYear(acts, today);
    // 1er mars = index 60 dans une année bissextile
    expect(y2025.values[59]).toBeNull();
    expect(y2025.values[60]).toBe(10);
    expect(y2025.values[365]).toBe(10);
    expect(y2026.values[0]).toBe(0);
    expect(y2026.values[60]).toBe(4);
    expect(y2026.values[91]).toBeNull(); // après aujourd'hui
  });

  it('calcule la plus longue série et la série en cours', () => {
    const acts = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-29', '2026-03-30'].map((d) => run(d, 5, 1));
    const s = streaks(acts, today);
    expect(s.longest).toBe(3);
    expect(s.current).toBe(2); // pas encore couru aujourd'hui
  });

  it('ignore le tapis pour les meilleures allures', () => {
    const acts = [run('2026-03-01', 10, 2400, { kind: 'indoor' }), run('2026-03-02', 10, 2700)];
    expect(fastestOver(acts, 10)!.date).toBe('2026-03-02');
  });
});

describe('insights', () => {
  it('calcule le nombre d’Eddington', () => {
    const acts = [run('2026-01-01', 3, 1), run('2026-01-02', 3, 1), run('2026-01-03', 5, 1), run('2026-01-04', 1, 1)];
    // 3 jours à ≥ 3 km → E = 3 ; pour E = 4 il manque 3 jours à ≥ 4 km (1 seul)
    expect(eddington(acts)).toEqual({ e: 3, nextNeeded: 3 });
  });

  it('classe les meilleurs efforts : segment FIT, sinon allure moyenne d’une sortie de la distance', () => {
    const fit = (efforts: Record<string, number>) => ({ efforts } as unknown as Activity['fit']);
    const tenK = EFFORT_DISTANCES.find((e) => e.label === '10 km')!;
    const acts = [
      run('2026-01-01', 21.2, 5800, { fit: fit({ '10000': 2730 }) }),
      run('2026-02-01', 10.3, 2600),
      run('2026-03-01', 10.0, 2500, { kind: 'indoor' }),
      run('2026-04-01', 12, 2900),
    ];
    const top = topEfforts(acts, tenK, 3);
    expect(top.map((t) => t.activity.date)).toEqual(['2026-02-01', '2026-01-01']);
    expect(top[0].time).toBeCloseTo((2600 * 10) / 10.3, 6);
    expect(top[0].source).toBe('moyenne');
    expect(top[1].source).toBe('segment');
  });

  it('compte les semaines consécutives malgré le changement d’heure', () => {
    const acts = ['2026-03-22', '2026-03-29', '2026-04-01'].map((d) => run(d, 5, 1));
    expect(weekStreaks(acts, new Date(2026, 3, 2))).toEqual({ longest: 3, current: 3 });
  });

  it('attribue le badge 10 km à la première sortie qui l’atteint', () => {
    const b = BADGES.find((x) => x.id === 'd10')!;
    const r = b.eval([run('2026-01-01', 8, 1), run('2026-02-01', 10.2, 1), run('2026-03-01', 12, 1)]);
    expect(r.earned).toBe('2026-02-01');
    expect(r.times).toBe(2);
  });

  it('donne le niveau Violet à 4 953 km', () => {
    const l = levelFor(4953);
    expect(l.level.name).toBe('Violet');
    expect(l.next!.name).toBe('Noir');
  });
});

describe('équivalences', () => {
  it('calcule Paris → Lyon à vol d’oiseau', () => {
    expect(haversineKm([48.8566, 2.3522], [45.764, 4.8357])).toBeCloseTo(392, -1);
  });

  it('trie les trajets et trouve le dernier atteint et le suivant', () => {
    const { done, next } = tripFor(400);
    expect(done!.km).toBeLessThanOrEqual(400);
    expect(next!.km).toBeGreaterThan(400);
    expect(TRIPS.indexOf(next!)).toBe(TRIPS.indexOf(done!) + 1);
  });

  it('ne met jamais en avant un repère abstrait', () => {
    expect(headlineHeight(12_000).name).toBe("l'Everest");
  });
});
