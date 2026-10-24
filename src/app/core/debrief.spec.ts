import { Activity, Athlete, Goal } from './models';
import { evaluateGoal, goalContext } from './goals';
import { classifyAll } from './science';
import { raceDebrief } from './debrief';

const ath: Athlete = { hrMax: 195, hrRest: 50, sex: 'M', weightKg: 70, heightCm: 175, birthday: '1990-01-01' };

function run(date: string, distanceKm: number, durationSec: number, extra: Partial<Activity> = {}): Activity {
  return {
    id: date + distanceKm, sportType: 100, kind: 'road', date, name: '', start: null, durationSec, distanceKm,
    avgHr: null, calories: null, lat: null, lon: null, ...extra,
  };
}

const collines = run('2025-10-12', 21.3, 6180, { name: 'Semi des Collines 2025', avgHr: 176, splits: [...Array(10).fill(300), ...Array(11).fill(292)] });
const dix = run('2026-03-15', 10.05, 2580, { name: '10km de Valbourg', avgHr: 166, focus: 'Threshold' });

// Semi couru 1 % trop long à la montre : 7 km rapides, 13 km plus lents, un dernier km rapide, puis 300 m
const kmTimes = [...Array(7).fill(272), ...Array(13).fill(278), 261];
const km = [
  ...kmTimes.map((t, i) => [1000, t, i === 3 ? 140 : 179, 2, 2, t, 274, i < 5 ? 178 : 184]),
  [300, 75, 187, 0, 0, 250, 288, 190],
];
const total = km.reduce((s, r) => s + r[1], 0);
const race = run('2026-10-18', 21.3, total, { name: 'Course de Valbourg', avgHr: 178, km });
const goal: Goal = {
  id: 'semi', name: 'Semi', date: '2026-10-18', startTime: '09:30', distanceKm: 21.0975, targetSec: 5640, kind: 'road',
  debrief: { chipSec: total - 6, gelsKm: [7, 14], notes: ['Parti un peu vite'] },
};

describe('bilan de course', () => {
  const acts = [collines, dix, race];
  const today = new Date(2026, 9, 18);
  const e = evaluateGoal(goal, goalContext(goal, acts, classifyAll(acts, ath), ath, today, {}, null), today, acts)!;
  const d = raceDebrief(e, race, ath, acts, null);

  it('retient le temps officiel et compare à l’objectif et à la prédiction de la veille', () => {
    expect(e.result?.id).toBe(race.id);
    expect(d.official).toBe(total - 6);
    expect(d.fromChip).toBe(true);
    expect(d.targetGap).toBe(total - 6 - 5640);
    expect(d.predictedGap).toBeCloseTo(d.official - e.predicted, 6);
    expect(d.previous?.name).toBe('Semi des Collines 2025');
  });

  it('ramène les km GPS à la distance officielle et finit l’écart au plan sur le temps officiel', () => {
    const f = 21.0975 / 21.3;
    const ts = d.official / total;
    expect(d.kms[0].realPace).toBeCloseTo((272 * ts) / f, 6);
    expect(d.kms.at(-1)!.vsTarget).toBeCloseTo(d.official - 5640, 3);
    expect(d.kms.at(-1)!.vsPredicted).toBeCloseTo(d.official - e.predicted, 3);
    expect(d.halves![0] + d.halves![1]).toBeCloseTo(d.official, 6);
  });

  it('repère le départ rapide, le décrochage du capteur et les gels', () => {
    expect(d.thirds![0]).toBeLessThan(d.thirds![1] - 2);
    expect(d.lessons.some((l) => l.startsWith('Départ un peu rapide'))).toBe(true);
    expect(d.kms.filter((k) => k.hrDoubtful).map((k) => k.km)).toEqual([4]);
    expect(d.kms.filter((k) => k.gel).map((k) => k.km)).toEqual([7, 14]);
    expect(d.blocks.map((b) => b.title)).toEqual(['Allure', 'Cardio', 'Foulée', 'Ravitaillement']);
  });
});
