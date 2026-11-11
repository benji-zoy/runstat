import { Activity, Athlete } from './models';
import { activityEffortKm, courseEffortKm, personalTerrain, priorCost, segmentsEffortKm } from './terrain';

const athlete = { hrMax: 190, hrRest: 50, sex: 'M', weightKg: 70, heightCm: 175, birthday: '1990-01-01' } as Athlete;
const REF = new Date('2026-06-30T12:00:00');

/** Tranche : [s, m, m ajustés, D+, D−, s avec FC, FC × s] */
const bin = (sec = 0, speed = 3, hr = 140, up = 0, down = 0): number[] => [sec, sec * speed, sec * speed, up, down, hr ? sec : 0, hr * sec];
/** Sept tranches ; seule la plate (index 3) est donnée par défaut, `over` remplace des tranches */
const terrain = (flatSec: number, over: Record<number, number[]> = {}) => {
  const t = Array.from({ length: 7 }, () => bin(0));
  t[3] = bin(flatSec);
  for (const [i, b] of Object.entries(over)) t[+i] = b;
  return t;
};
const act = (date: string, t: number[][], extra: Partial<Activity> = {}): Activity =>
  ({ id: date, date, kind: 'road', distanceKm: 10, durationSec: 3600, elevGain: 0, fit: { terrain: t }, ...extra }) as unknown as Activity;

describe('courbe de base', () => {
  it('1 sur le plat, plus cher en montée, moins en descente douce', () => {
    expect(priorCost(0)).toBe(1);
    expect(priorCost(0.1)).toBeGreaterThan(1.4);
    expect(priorCost(0.2)).toBeGreaterThan(priorCost(0.1));
    expect(priorCost(-0.09)).toBeLessThan(1);
    // descente raide : le gain disparaît
    expect(priorCost(-0.2)).toBeGreaterThan(1);
  });

  it('interpolation entre deux points de la table', () => {
    expect(priorCost(0.035)).toBeCloseTo((1.07 + 1.2) / 2, 5);
  });

  it('pentes extrêmes bornées, jamais sous 0,7', () => {
    expect(priorCost(5)).toBe(priorCost(0.45));
    expect(priorCost(-5)).toBe(priorCost(-0.45));
    for (let g = -0.5; g <= 0.5; g += 0.01) expect(priorCost(g)).toBeGreaterThanOrEqual(0.7);
  });
});

describe('courbe personnelle', () => {
  it('sans donnée : la base commune, aucun point, aucune vitesse', () => {
    const t = personalTerrain([], REF, athlete, false);
    expect(t.points).toEqual([]);
    expect(t.flatSpeed).toBeNull();
    expect(t.surface).toBeNull();
    expect(t.hours).toBe(0);
    expect(t.cost(0.08)).toBe(priorCost(0.08));
  });

  it('ignore les sorties hors des 12 derniers mois, postérieures à la date ou sans tranches', () => {
    const old = act('2024-01-01', terrain(7200));
    const future = act('2026-12-01', terrain(7200));
    const noFit = act('2026-05-01', terrain(7200), { fit: undefined });
    const t = personalTerrain([old, future, noFit], REF, athlete, false);
    expect(t.hours).toBe(0);
    expect(t.flatSpeed).toBeNull();
  });

  it('vitesse sur le plat et FC moyenne ; moins de 10 min : pas de référence', () => {
    const t = personalTerrain([act('2026-05-01', terrain(3600))], REF, athlete, false);
    expect(t.flatSpeed).toBeCloseTo(3);
    expect(t.flatHr).toBeCloseTo(140);
    expect(t.hours).toBeCloseTo(1);
    expect(personalTerrain([act('2026-05-01', terrain(500))], REF, athlete, false).flatSpeed).toBeNull();
  });

  it('beaucoup de données : suit la mesure ; une côte plus lente que prévu coûte plus cher', () => {
    const grade = 0.08;
    const sec = 36_000;
    const speedAtPrior = 3 / priorCost(grade);
    const same = act('2026-05-01', terrain(7200, { 5: bin(sec, speedAtPrior, 140, sec * speedAtPrior * grade, 0) }));
    expect(personalTerrain([same], REF, athlete, false).cost(grade)).toBeCloseTo(priorCost(grade), 1);
    const slowSpeed = speedAtPrior / 1.3;
    const slow = act('2026-05-01', terrain(7200, { 5: bin(sec, slowSpeed, 140, sec * slowSpeed * grade, 0) }));
    const t = personalTerrain([slow], REF, athlete, false);
    expect(t.cost(grade)).toBeGreaterThan(priorCost(grade) * 1.15);
    expect(t.points.find((p) => Math.abs(p.grade - grade) < 1e-9)).toMatchObject({ prior: priorCost(grade), sec });
  });

  it('peu de données : on reste plus près de la base qu’avec beaucoup', () => {
    const grade = 0.08;
    const build = (sec: number) => personalTerrain([act('2026-05-01', terrain(7200, { 5: bin(sec, 1, 140, sec * grade, 0) }))], REF, athlete, false);
    const gap = (t: ReturnType<typeof build>) => Math.abs(Math.log(t.cost(grade) / priorCost(grade)));
    expect(gap(build(400))).toBeLessThan(gap(build(40_000)));
  });

  it('surface : trail plus lent que la route à FC égale (borné à 1,3), rien sans assez de trail', () => {
    const road = act('2026-04-01', terrain(7200));
    const trail = act('2026-04-02', terrain(3600, { 3: bin(3600, 2.5, 140) }), { kind: 'trail' });
    const t = personalTerrain([road, trail], REF, athlete, true);
    expect(t.surface).toBeGreaterThan(1);
    expect(t.surface).toBeLessThanOrEqual(1.3);
    const little = act('2026-04-02', terrain(600), { kind: 'trail' });
    expect(personalTerrain([road, little], REF, athlete, true).surface).toBeNull();
  });

  it('sans sortie de sa catégorie (moins d’une heure), retombe sur toutes les sorties', () => {
    const road = act('2026-04-01', terrain(7200));
    expect(personalTerrain([road], REF, athlete, true).hours).toBeCloseTo(2);
  });
});

describe('distance équivalent plat', () => {
  const flat = () => 1;
  const costly = (g: number) => (g > 0 ? 2 : 1);

  it('somme des tronçons pondérés par leur coût', () => {
    const segs = [
      { from: 0, to: 1, grade: 0 },
      { from: 1, to: 3, grade: 0.1 },
    ] as any;
    expect(segmentsEffortKm(segs, flat)).toBe(3);
    expect(segmentsEffortKm(segs, costly)).toBe(5);
    expect(segmentsEffortKm([], costly)).toBe(0);
  });

  it('course sans dénivelé : sa distance', () => {
    expect(courseEffortKm({ distanceKm: 10, kind: 'road' }, priorCost)).toBeCloseTo(10, 5);
  });

  it('un trail avec beaucoup de D+ vaut plus que sa distance', () => {
    expect(courseEffortKm({ distanceKm: 20, elevGain: 1200, elevLoss: 1200, kind: 'trail' }, priorCost)).toBeGreaterThan(22);
  });

  it('sortie avec tranches FIT : pente de chaque tranche, ramenée à la distance', () => {
    // 5 km plats puis 5 km à 10 % de pente
    const a = act('2026-05-01', terrain(0, { 3: bin(1000, 5), 5: [1000, 5000, 5000, 500, 0, 0, 0] }), { distanceKm: 10 });
    expect(activityEffortKm(a, costly)).toBeCloseTo(15);
    expect(activityEffortKm(a, flat)).toBeCloseTo(10);
  });

  it('tranches FIT incomplètes (moins de 60 % de la distance) : repli sur le D+ et le D−', () => {
    const a = act('2026-05-01', terrain(0, { 3: bin(100, 5) }), { distanceKm: 10, elevGain: 0 });
    expect(activityEffortKm(a, priorCost)).toBeCloseTo(10, 5);
    expect(activityEffortKm({ ...a, elevGain: 600, elevLoss: 600 } as Activity, priorCost)).toBeGreaterThan(10);
  });

  it('sans FIT, un D− absent vaut le D+', () => {
    const base = { id: 'x', date: '2026-05-01', kind: 'road', distanceKm: 10, elevGain: 300 } as unknown as Activity;
    expect(activityEffortKm(base, priorCost)).toBeCloseTo(activityEffortKm({ ...base, elevLoss: 300 } as Activity, priorCost), 8);
  });
});
