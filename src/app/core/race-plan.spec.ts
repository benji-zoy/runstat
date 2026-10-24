import { Activity, Athlete, Goal } from './models';
import { passage, pacingProfile, racePlan, segmentPaces } from './race-plan';
import { evaluateGoal, goalContext, progressionSince, raceReferences } from './goals';
import { tandaPace } from './science';
import { addDays, isoDay } from './stats';
import { classifyAll } from './science';

const ath: Athlete = { hrMax: 195, hrRest: 50, sex: 'M', weightKg: 70, heightCm: 175, birthday: '1990-01-01' };

function run(date: string, distanceKm: number, durationSec: number, extra: Partial<Activity> = {}): Activity {
  return {
    id: date + distanceKm, sportType: 100, kind: 'road', date, name: '', start: null, durationSec, distanceKm,
    avgHr: null, calories: null, lat: null, lon: null, ...extra,
  };
}

const semi: Goal = { id: 's', name: 'Semi', date: '2026-10-18', startTime: '09:30', distanceKm: 21.0975, targetSec: 5640, kind: 'road' };

describe('plan d’allure', () => {
  it('cale les allures par tronçon sur le chrono visé', () => {
    for (const [d, kind] of [[10, 'road'], [21.0975, 'road'], [42.195, 'road'], [80, 'trail']] as const) {
      const parts = pacingProfile(d, kind);
      const paces = segmentPaces(5700, d, kind);
      expect(passage(d, parts, paces)).toBeCloseTo(5700, 6);
    }
  });

  it('part plus lentement et finit plus vite sur semi', () => {
    const [start, cruise, end] = segmentPaces(5640, 21.0975, 'road');
    expect(start - cruise).toBeCloseTo(3, 6);
    expect(end - cruise).toBeCloseTo(-3, 6);
  });
});

describe('courses de référence', () => {
  const collines = run('2025-10-12', 21.3, 6180, {
    name: 'Semi des Collines 2025', avgHr: 176, weather: { temp: 10, dew: 8, rh: 80, wind: 7 },
    splits: [...Array(10).fill(300), ...Array(10).fill(292)],
  });
  const today = new Date(2026, 9, 8);

  it('retient la dernière course sur la même distance et en fait un modèle', () => {
    const acts = [collines, run('2026-03-15', 10.05, 2580, { name: '10km de Valbourg', avgHr: 166, focus: 'Threshold' })];
    const ctx = goalContext(semi, acts, classifyAll(acts, ath), ath, today, {}, null);
    const [ref] = raceReferences(semi, ctx);
    expect(ref.activity.id).toBe(collines.id);
    expect(ref.splitDiff).toBeCloseTo(-8, 6);
    expect(ref.gpsDrift).toBeCloseTo(21.3 / 21.0975 - 1, 6);
    const e = evaluateGoal(semi, ctx, today, acts)!;
    const model = e.models.find((m) => m.label.startsWith('Référence'))!;
    expect(model.seconds).toBeCloseTo(6180, 0);
    expect(model.weight).toBe(1.5);
  });

  it('donne l’allure montre corrigée de l’écart GPS', () => {
    const acts = [collines];
    const ctx = goalContext(semi, acts, classifyAll(acts, ath), ath, today, {}, null);
    const plan = racePlan({ goal: semi, daysLeft: 3, ke: 21.1, predicted: 5900, probability: 0.2, raceRefs: raceReferences(semi, ctx), athlete: ath, acts });
    expect(plan.watch!.actual).toBeCloseTo(segmentPaces(5640, 21.0975, 'road')[1], 6);
    expect(plan.watch!.shown).toBeLessThan(plan.watch!.actual);
    expect(plan.blocks.map((b) => b.title)).toContain('Ravitaillement');
  });

  it('projette la référence avec le volume et l’allure d’entraînement depuis', () => {
    // 8 semaines avant le semi des Collines : 4 × 10 km/sem à 6:30 ; 8 dernières : 4 × 15 km/sem à 6:00
    const block = (end: Date, km: number, pace: number) =>
      Array.from({ length: 32 }, (_, i) => run(isoDay(addDays(end, -1 - Math.floor(i * 1.7))), km, km * pace, { name: 'Footing' }));
    const acts = [...block(new Date(2025, 9, 12), 10, 390), collines, ...block(today, 15, 360)];
    const ctx = goalContext(semi, acts, classifyAll(acts, ath), ath, today, {}, null);
    const p = progressionSince(raceReferences(semi, ctx)[0], ctx);
    const fVol = tandaPace(60, 390) / tandaPace(40, 390);
    const fPace = tandaPace(60, 360) / tandaPace(60, 390);
    expect(p.factor).toBeCloseTo(fVol * fPace, 6);
    expect(p.projected).toBeCloseTo(6180 * p.factor, 3);
    expect(p.projected).toBeLessThan(6180);
  });
});
