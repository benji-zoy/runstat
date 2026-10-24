import { Activity } from './models';
import { durability, hrDrift, kmLaps } from './durability';

function run(km: number[][], extra: Partial<Activity> = {}): Activity {
  const durationSec = km.reduce((s, l) => s + l[1], 0);
  return {
    id: 'x', sportType: 100, kind: 'road', date: '2026-09-01', name: '', start: null, durationSec,
    distanceKm: km.reduce((s, l) => s + l[0], 0) / 1000, avgHr: 150, calories: null, lat: null, lon: null, km, ...extra,
  };
}

/** n km à allure ajustée `gap`, FC qui monte de `drift` bpm par km */
const laps = (n: number, gap: number, hr: number, drift = 0) =>
  Array.from({ length: n }, (_, i) => [1000, gap, Math.round(hr + drift * i), 10, 10, gap, 200, 170]);

describe('durabilité', () => {
  it('ne voit aucune dégradation à allure et FC constantes', () => {
    const d = durability(run(laps(20, 330, 150)))!;
    expect(d.efLoss).toBeCloseTo(0, 6);
    expect(d.onset).toBeNull();
    expect(d.hrDrift).toBeCloseTo(0, 3);
  });

  it('mesure la perte d’efficacité et la dérive quand la FC monte à allure égale', () => {
    const d = durability(run(laps(20, 330, 140, 1)))!;
    expect(d.efLoss).toBeGreaterThan(5);
    // +1 bpm par km de 330 s ≈ +10,9 bpm/h
    expect(d.hrDrift!).toBeCloseTo(3600 / 330, 0);
    expect(d.onset).not.toBeNull();
  });

  it('écarte les arrêts et compare les montées en trail', () => {
    const km = [
      ...Array.from({ length: 6 }, () => [1000, 600, 160, 120, 0, 400, 180, 120]),
      [1000, 2000, 120, 0, 0, 1500, 50, 40], // ravitaillement
      ...Array.from({ length: 6 }, () => [1000, 720, 160, 120, 0, 480, 170, 115]),
    ];
    const a = run(km, { kind: 'trail', elevGain: 1440 });
    expect(kmLaps(a).length).toBe(12);
    const d = durability(a)!;
    expect(d.trail).toBe(true);
    expect(d.climb![0]).toBeCloseTo(720, 0);
    expect(d.climb![1]).toBeCloseTo(600, 0);
  });

  it('demande assez de tours', () => {
    expect(durability(run(laps(5, 330, 150).map((l) => [l[0], l[1] * 3, ...l.slice(2)])))).toBeNull();
    expect(hrDrift([])).toBeNull();
  });
});
