import { Activity, FitAnalysis } from './models';
import {
  MetricDef, WORLD_RECORDS, climbEfficiencySamples, descentEfficiencySamples, heatAdjusted, matrixGrid, percentile, runnerMatrix,
  speedSamples, verticalSamples, windowValue, worldLevel, worldSpeed, worldVdot,
} from './matrix';
import { addDays, isoDay, parseDay } from './stats';

const today = parseDay('2026-10-13');
const ATH = { hrMax: 190, hrRest: 50, sex: 'M' as const, weightKg: 70, heightCm: 175, birthday: '1990-01-01' };

let seq = 0;
function act(daysAgo: number, extra: Partial<Activity> = {}): Activity {
  return {
    id: String(seq++), sportType: 100, kind: 'road', date: isoDay(addDays(today, -daysAgo)), name: '', start: null,
    durationSec: 3600, distanceKm: 10, avgHr: 150, calories: null, lat: null, lon: null, ...extra,
  };
}
const fit = (f: Partial<FitAnalysis>) => f as FitAnalysis;
/** Tranches de pente : [s, m, m ajustés, D+, D−, s avec FC, FC × s] */
const bin = (sec: number, speed: number, gapSpeed: number, hr: number) => [sec, sec * speed, sec * gapSpeed, 0, 0, sec, sec * hr];
const empty = [0, 0, 0, 0, 0, 0, 0];

describe('Runner Matrix', () => {
  it('classe une valeur dans son historique (égalités au rang moyen, sens de la métrique)', () => {
    expect(percentile(4, [1, 2, 3, 4], true)).toBe(100);
    expect(percentile(1, [1, 2, 3, 4], true)).toBe(0);
    expect(percentile(1, [1, 2, 3, 4], false)).toBe(100);
    expect(percentile(3, [1, 3, 3, 7], true)).toBe(50);
  });

  it('prend la meilleure valeur ou la médiane de la fenêtre, avec un minimum d’échantillons', () => {
    const t = (d: number) => addDays(today, -d).getTime();
    const def = (agg: 'best' | 'median', higherIsBetter = true): MetricDef => ({
      id: 'x', branch: 'vitesse', label: '', unit: 'pace', agg, higherIsBetter, windowDays: 30, minSamples: 2,
      samples: [{ t: t(40), value: 9 }, { t: t(20), value: 3 }, { t: t(10), value: 5 }, { t: t(0), value: 4 }],
    });
    expect(windowValue(def('best'), today.getTime())!.value).toBe(5);
    expect(windowValue(def('best', false), today.getTime())!.value).toBe(3);
    expect(windowValue(def('median'), today.getTime())!.value).toBe(4);
    expect(windowValue(def('median'), t(25))).toBeNull(); // une seule valeur dans la fenêtre
  });

  it('lit la courbe ajustée du FIT, sinon borne basse par la vitesse moyenne, hors tapis', () => {
    const withFit = act(0, { fit: fit({ curveGap: { 300: 1200 } }) });
    const noFit = act(1, { durationSec: 1800, distanceKm: 6 });
    const indoor = act(2, { kind: 'indoor' });
    const short = act(3, { durationSec: 200, distanceKm: 1 });
    const s = speedSamples([withFit, noFit, indoor, short], 300);
    expect(s.map((x) => x.value)).toEqual([4, 6000 / 1800]);
  });

  it('mesure la vitesse verticale par durée, ou le D+ moyen sans FIT', () => {
    const a = act(0, { fit: fit({ climb: { 1200: 200 } }) });
    const b = act(1, { durationSec: 7200, elevGain: 600 });
    expect(verticalSamples([a, b], 1200, 'climb').map((x) => x.value)).toEqual([600, 300]);
  });

  it('compare montée et descente au plat de la même sortie', () => {
    const terrain = [empty, bin(240, 3, 1.5, 150), empty, bin(1200, 3, 3, 150), empty, bin(600, 1.2, 3.3, 150), empty];
    const a = act(0, { fit: fit({ terrain }) });
    // Côte : (3,3 / 150) / (3 / 150) = 1,1 ; descente : 1,5 / 3 = 0,5
    expect(climbEfficiencySamples([a])[0].value).toBeCloseTo(1.1, 6);
    expect(descentEfficiencySamples([a])[0].value).toBeCloseTo(0.5, 6);
    // Trop peu de côte (< 5 min) : pas d'échantillon
    const flatOnly = act(0, { fit: fit({ terrain: [empty, empty, empty, bin(1200, 3, 3, 150), empty, bin(100, 1, 3, 160), empty] }) });
    expect(climbEfficiencySamples([flatOnly])).toEqual([]);
  });

  it('retire l’effet de la chaleur avec la pente personnelle', () => {
    const samples = Array.from({ length: 20 }, (_, i) => {
      const temp = 5 + i;
      const a = act(i, { weather: { temp, dew: 5, rh: 50, wind: 0 } });
      return { t: parseDay(a.date).getTime(), value: 2 + 0.3 * (temp - 12), activity: a };
    });
    const h = heatAdjusted(samples);
    expect(h.slope).toBeCloseTo(0.3, 6);
    for (const s of h.samples) expect(s.value).toBeCloseTo(2, 6);
    expect(heatAdjusted(samples.slice(0, 5)).slope).toBeNull();
  });

  it('donne 100 en vitesse à un coureur qui progresse, et un score plus bas il y a six mois', () => {
    // Une séance par semaine pendant deux ans, de plus en plus rapide
    const acts = Array.from({ length: 104 }, (_, w) => {
      const v = 3.6 - 0.005 * w; // la plus rapide aujourd'hui
      return act(w * 7, { fit: fit({ curveGap: { 300: v * 300 + 30, 1200: v * 1200 } }) });
    }).reverse();
    const m = runnerMatrix({ acts, athlete: ATH, types: new Map(), health: null, today });
    const vitesse = m.branches.find((b) => b.id === 'vitesse')!;
    expect(vitesse.score).toBe(100);
    expect(vitesse.scoreThen!).toBeLessThan(80);
    expect(vitesse.confidence).toBe('solide');
    // Ni D− ni tranches de pente : la descente n'est pas notée
    const descente = m.branches.find((b) => b.id === 'descente')!;
    expect(descente.confidence).toBe('insuffisante');
    expect(descente.score).toBeNull();
    expect(m.history.at(-1)!.date.getTime()).toBe(today.getTime());
  });

  it('remplit la grille avec la meilleure valeur récente face au record', () => {
    const old = act(300, { fit: fit({ curveGap: { 300: 1500 }, climb: { 300: 80 }, descent: {} }) });
    const recent = act(10, { fit: fit({ curveGap: { 300: 1200 }, climb: { 300: 100 }, descent: {} }) });
    const grid = matrixGrid([old, recent], today);
    const plat = grid.find((r) => r.id === 'plat')!.cells[0];
    expect(plat.best!.value).toBe(5);
    expect(plat.now!.value).toBe(4);
    expect(plat.ratio).toBeCloseTo(0.8, 6);
    const montee = grid.find((r) => r.id === 'montee')!.cells[0];
    expect(montee.ratio).toBe(1);
    expect(grid.find((r) => r.id === 'descente')!.cells[0].best).toBeNull();
  });

  it('étalonne la lecture absolue sur la courbe des records du monde', () => {
    // La courbe passe par ses deux records et retrouve le 10 000 m (26:11) et le semi (56:42) à ± 2 %
    for (const r of WORLD_RECORDS.M) expect(worldSpeed('M', r.time)).toBeCloseTo(r.dist / r.time, 6);
    expect(worldSpeed('M', 1571) / (10000 / 1571)).toBeCloseTo(1, 1);
    expect(Math.abs(worldSpeed('M', 3402) / (21097.5 / 3402) - 1)).toBeLessThan(0.02);
    expect(worldSpeed('F', 3600)).toBeLessThan(worldSpeed('M', 3600));
    expect(worldVdot('M')).toBeGreaterThan(80);
    expect(worldLevel(59)).toBe('loisir');
    expect(worldLevel(65)).toBe('classe locale');
    expect(worldLevel(92)).toBe('classe mondiale');
  });

  it('donne le pourcentage du niveau mondial des branches qui ont un étalon', () => {
    // 1 h à 60 % de la vitesse du record, VO₂max Coros 52 face au VDOT du record du marathon
    const v = 0.6 * worldSpeed('M', 3600);
    const acts = Array.from({ length: 30 }, (_, w) =>
      act(w * 7, { avgHr: 160, fit: fit({ curveGap: { 3600: v * 3600 }, gapDistance: 12000 }), durationSec: 3600, distanceKm: 12 }),
    ).reverse();
    const m = runnerMatrix({ acts, athlete: ATH, types: new Map(), health: null, today, corosVo2max: 52 });
    const endurance = m.branches.find((b) => b.id === 'endurance')!;
    expect(endurance.metrics.find((x) => x.def.id === 'v60')!.absNow).toBeCloseTo(60, 6);
    expect(endurance.abs).toBeCloseTo(60, 6); // la plus longue sortie n'a pas d'étalon
    expect(m.branches.find((b) => b.id === 'physio')!.abs).toBeCloseTo((52 / worldVdot('M')) * 100, 6);
    expect(m.branches.find((b) => b.id === 'montee')!.abs).toBeNull();
    expect(m.grid.find((r) => r.id === 'plat')!.cells.find((c) => c.duration === 3600)!.world).toBeCloseTo(60, 6);
  });
});
