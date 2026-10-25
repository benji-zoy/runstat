import { Activity, Athlete, Goal } from './models';
import { chance, consensus, csTime, freshnessPct, goalContext, normalCdf, trailModels, TRAIL_EXPONENT, evaluateGoal, ultraModel } from './goals';
import { classifyAll, kmEffortOf } from './science';

const ath: Athlete = { hrMax: 195, hrRest: 50, sex: 'M', weightKg: 70, heightCm: 175, birthday: '1990-01-01' };

function run(date: string, distanceKm: number, durationSec: number, extra: Partial<Activity> = {}): Activity {
  return {
    id: date + distanceKm, sportType: 100, kind: 'road', date, name: '', start: null, durationSec, distanceKm,
    avgHr: null, calories: null, lat: null, lon: null, ...extra,
  };
}

describe('statistiques', () => {
  it('approche la loi normale', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.2816)).toBeCloseTo(0.1, 3);
  });

  it('calcule la moyenne géométrique pondérée et la dispersion', () => {
    const c = consensus([
      { label: 'a', seconds: 100, weight: 1, note: '' },
      { label: 'b', seconds: 400, weight: 1, note: '' },
    ])!;
    expect(c.seconds).toBeCloseTo(200, 6);
    expect(c.spread).toBeCloseTo(Math.log(2), 6);
    expect(consensus([])).toBeNull();
  });

  it('donne 50 % pile sur la médiane, plus quand l’objectif est plus lent', () => {
    expect(chance(5700, 5700, 0.04)).toBeCloseTo(0.5, 6);
    expect(chance(5900, 5700, 0.04)).toBeGreaterThan(0.75);
    expect(chance(5500, 5700, 0.04)).toBeLessThan(0.25);
  });
});

describe('modèles', () => {
  it('raccorde la vitesse critique entre 10 km et marathon', () => {
    const cs = { cs: 4, dPrime: 200, r2: 1, points: [] };
    expect(csTime(cs, 42195)).toBeCloseTo(42195 / (0.85 * 4), 3);
    expect(csTime(cs, 21097.5)).toBeCloseTo(21097.5 / (0.92 * 4), 3);
  });

  it('pénalise une fraîcheur trop basse ou trop haute', () => {
    expect(freshnessPct(15)).toBe(0);
    expect(freshnessPct(-15)).toBeCloseTo(2, 6);
    expect(freshnessPct(45)).toBeCloseTo(1, 6);
  });

  it('compte le D− à 300 m par km-effort, égal au D+ s\'il est absent', () => {
    expect(kmEffortOf(10, 500, 300)).toBeCloseTo(10 + 5 + 1, 9);
    expect(kmEffortOf(10, 600, null)).toBeCloseTo(10 + 6 + 2, 9);
    expect(kmEffortOf(10)).toBe(10);
  });

  it('extrapole un trail au km-effort', () => {
    const acts = [run('2026-09-01', 30, 4 * 3600, { kind: 'trail', elevGain: 1000, elevLoss: 900, name: 'Trail des Pics' })];
    const goal: Goal = { id: 'g', name: 'Ultra', date: '2026-11-29', distanceKm: 80, elevGain: 2200, elevLoss: 2600, kind: 'trail' };
    const today = new Date(2026, 9, 7);
    const ctx = goalContext(goal, acts, classifyAll(acts, ath), ath, today, {}, null);
    const [m] = trailModels(goal, ctx);
    expect(m.seconds).toBeCloseTo(4 * 3600 * Math.pow((80 + 22 + 2600 / 300) / (30 + 10 + 900 / 300), TRAIL_EXPONENT), 3);
  });

  it('ajoute un modèle d\'allure à FC d\'ultra à partir des sorties longues', () => {
    // 5 sorties de 2 h à 5 km/h ajustés ≈ 12 s/km … : tours de 1 km à 6:00/km (gap 360) et FC 157 (LT1 = 80 % de 197)
    const km = Array.from({ length: 20 }, () => [1000, 360, 157, 20, 20, 360, 0, 170]);
    const acts: Activity[] = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(2026, 8, 1 + i * 5);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      acts.push(run(iso, 20, 7200, { km: km as Activity['km'], avgHr: 157 }));
    }
    const goal: Goal = { id: 'g', name: 'Ultra', date: '2026-11-29', distanceKm: 80, elevGain: 2200, kind: 'trail' };
    const today = new Date(2026, 9, 7);
    const ctx = goalContext(goal, acts, classifyAll(acts, ath), ath, today, {}, null);
    const ultra = ultraModel(goal, ctx)!;
    // 102 km-effort à 10 km/h, durée allongée par l'usure et 5 % d'arrêts : bien plus que 10,2 h
    expect(ultra.seconds).toBeGreaterThan(10.2 * 3600 * 1.05);
    expect(ultra.seconds).toBeLessThan(16 * 3600);
    expect(ultraModel({ ...goal, distanceKm: 20, elevGain: 0 }, ctx)).toBeNull();
  });
});

describe('évaluation', () => {
  it('donne une probabilité pour un chrono et un indice de préparation pour finir', () => {
    const acts: Activity[] = [];
    for (let i = 0; i < 60; i++) {
      const d = new Date(2026, 7, 1 + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      acts.push(run(iso, i % 7 === 6 ? 20 : 9, i % 7 === 6 ? 7200 : 2900, { trainingLoad: 80 }));
    }
    acts.push(run('2026-09-20', 10, 2600, { name: '10 km de la ville', avgHr: 180, trainingLoad: 150 }));
    const today = new Date(2026, 9, 14);
    const types = classifyAll(acts, ath);
    const semi: Goal = { id: 's', name: 'Semi', date: '2026-10-18', distanceKm: 21.0975, targetSec: 5640, kind: 'road' };
    const e = evaluateGoal(semi, goalContext(semi, acts, types, ath, today, { Semi: '1:38:30' }, null), today, acts)!;
    expect(e.daysLeft).toBe(4);
    expect(e.models.map((m) => m.label)).toContain('VDOT de Daniels');
    expect(e.probability).toBeGreaterThan(0);
    expect(e.probability).toBeLessThan(1);
    expect(e.index).toBe(Math.round(e.probability! * 100));
    expect(e.low).toBeLessThan(e.predicted);
    expect(e.high).toBeGreaterThan(e.predicted);

    const finish: Goal = { id: 'f', name: 'Finir', date: '2026-12-01', distanceKm: 30, kind: 'road' };
    const f = evaluateGoal(finish, goalContext(finish, acts, types, ath, today, {}, null), today, acts)!;
    expect(f.probability).toBeNull();
    expect(f.index).toBe(Math.round(f.readinessScore * 100));
  });
});
