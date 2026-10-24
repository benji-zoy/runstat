import { Activity, Athlete } from './models';
import { airDensity, conditionsCost, conditionsSummary, reportText } from './conditions';
import { heatPenalty } from './science';

const ath: Athlete = { hrMax: 195, hrRest: 50, sex: 'M', weightKg: 70, heightCm: 175, birthday: '1990-01-01' };
const STD = { elevNet: null, heatPerDeg: null };
const calm = { temp: 12, dew: 5, rh: 60, wind: 0, dir: 0 };

function run(extra: Partial<Activity> = {}): Activity {
  return {
    id: 'x', sportType: 100, kind: 'road', date: '2026-10-01', name: '', start: null, durationSec: 3000, distanceKm: 10,
    avgHr: 150, calories: null, lat: null, lon: null, elevGain: 0, elevLoss: 0, startAlt: 100, weather: calm, ...extra,
  };
}

/** FIT minimal : plat, 10 km en 3 000 s, tout le temps dans un seul secteur de cap (ou réparti en aller-retour) */
function fit(headings: number[][], altMean = 100, gapDistance = 10000) {
  return { duration: 3000, distance: 10000, gapDistance, altMean, headings } as Activity['fit'];
}
const oneWay = (sector: number) => Array.from({ length: 16 }, (_, i) => (i === sector ? [3000, 10000] : [0, 0]));
const outAndBack = Array.from({ length: 16 }, (_, i) => (i === 0 || i === 8 ? [1500, 5000] : [0, 0]));
const pct = (a: Activity, key: string) => conditionsCost(a, ath, STD)!.factors.find((f) => f.key === key)!.pct;

describe('coût des conditions', () => {
  it('conditions standard : aucun coût', () => {
    const r = conditionsCost(run({ fit: fit(outAndBack) }), ath, STD)!;
    for (const f of r.factors) expect(Math.abs(f.pct)).toBeLessThan(0.05);
    expect(r.standardSec).toBeCloseTo(3000, 0);
  });

  it('aller-retour par vent constant : le vent de face coûte plus que le vent de dos ne rend', () => {
    expect(pct(run({ fit: fit(outAndBack), weather: { ...calm, wind: 25, dir: 0 } }), 'wind')).toBeLessThan(-0.3);
  });

  it('vent de dos : un gain plus petit que le coût du même vent de face', () => {
    const tail = pct(run({ fit: fit(oneWay(0)), weather: { ...calm, wind: 25, dir: 180 } }), 'wind');
    const head = pct(run({ fit: fit(oneWay(0)), weather: { ...calm, wind: 25, dir: 0 } }), 'wind');
    expect(tail).toBeGreaterThan(0);
    expect(head).toBeLessThan(0);
    expect(tail).toBeLessThan(-head);
  });

  it('sans tracé, le vent est estimé sur une boucle et coûte toujours un peu', () => {
    const r = conditionsCost(run({ weather: { ...calm, wind: 25, dir: 90 } }), ath, STD)!;
    const w = r.factors.find((f) => f.key === 'wind')!;
    expect(w.estimated).toBe(true);
    expect(w.pct).toBeLessThan(0);
    expect(r.estimated).toBe(true);
  });

  it('altitude : environ −5,5 % à 2 000 m (Mexico 1968 : +6,5 % à 2 240 m), rien sous 300 m', () => {
    expect(pct(run({ fit: fit(outAndBack, 2000) }), 'altitude')).toBeGreaterThan(-6.5);
    expect(pct(run({ fit: fit(outAndBack, 2000) }), 'altitude')).toBeLessThan(-4.5);
    expect(Math.abs(pct(run({ fit: fit(outAndBack, 250) }), 'altitude'))).toBeLessThan(0.05);
    expect(airDensity(2000, 12)).toBeLessThan(airDensity(0, 12));
  });

  it('dénivelé : équivalent plat de Minetti avec FIT, coefficient perso sans FIT', () => {
    expect(pct(run({ fit: fit(outAndBack, 100, 10500) }), 'elevation')).toBeCloseTo((1 / 1.05 - 1) * 100, 5);
    const loop = run({ elevGain: 200, elevLoss: 200 });
    const perso = conditionsCost(loop, ath, { elevNet: 2, heatPerDeg: null })!.factors.find((f) => f.key === 'elevation')!;
    expect(perso.model).toBe('perso');
    expect(perso.pct).toBeCloseTo((10000 / 10400 - 1) * 100, 5);
  });

  it('chaleur : règle de Hadley pleine sur 2 h 30, la moitié sur 30 min', () => {
    const hot = { ...calm, temp: 27, dew: 16 };
    const long = run({ durationSec: 9000, distanceKm: 30, weather: hot });
    expect(pct(long, 'heat')).toBeCloseTo(-heatPenalty(27, 16), 5);
    expect(pct(run({ durationSec: 1800, distanceKm: 6, weather: hot }), 'heat')).toBeCloseTo(-heatPenalty(27, 16) / 2, 5);
  });

  it('chaleur perso : pente mesurée au-delà de 12 °C', () => {
    const f = conditionsCost(run({ durationSec: 3600, weather: { ...calm, temp: 22 } }), ath, { elevNet: null, heatPerDeg: 0.3 })!
      .factors.find((x) => x.key === 'heat')!;
    expect(f.model).toBe('perso');
    expect(f.pct).toBeCloseTo(-3, 5);
  });

  it('tapis et sorties très courtes : pas de rapport', () => {
    expect(conditionsCost(run({ kind: 'indoor' }), ath, STD)).toBeNull();
    expect(conditionsCost(run({ durationSec: 300 }), ath, STD)).toBeNull();
  });

  it('rapport texte au format émoji / % / raison', () => {
    const a = run({ fit: fit(oneWay(0)), weather: { ...calm, wind: 25, dir: 180 } });
    const text = reportText(a, conditionsCost(a, ath, STD)!);
    expect(text).toContain('Vent 💨 : +');
    expect(text).toContain('car le vent était de dos et donc favorable');
    expect(text).toContain('En conditions standard');
  });

  it('synthèse : effet total, facteurs principaux et allure standard', () => {
    const hot = run({ durationSec: 3600, weather: { ...calm, temp: 30, dew: 20 }, elevGain: 150, elevLoss: 150 });
    const text = conditionsSummary(hot, conditionsCost(hot, ath, STD)!);
    expect(text).toMatch(/^Les conditions t'ont coûté environ \d+,\d % \(\d+ min \d{2}\), surtout la chaleur/);
    expect(text).toContain('En conditions standard, tu aurais couru à');
    expect(text).toContain('Estimation sans tracé.');

    const tail = run({ fit: fit(oneWay(0)), weather: { ...calm, wind: 30, dir: 180 } });
    expect(conditionsSummary(tail, conditionsCost(tail, ath, STD)!)).toMatch(/^Les conditions t'ont aidé .*grâce au vent/);

    const ideal = run({ fit: fit(outAndBack) });
    expect(conditionsSummary(ideal, conditionsCost(ideal, ath, STD)!)).toMatch(/^Conditions quasi idéales/);
  });
});
