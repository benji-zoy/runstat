import { Activity, Athlete } from './models';
import {
  PRIOR_EXPONENT, acwr, classify, officialDistance, personalExponentFromRaces, wallAnalysis, criticalSpeed, foster, heatPenalty, kmEffort, personalExponent, polarizationIndex, riegel,
  tanda, theilSen, timeForVdot, trimp, vdot, vickers,
} from './science';

const ath: Athlete = { hrMax: 195, hrRest: 50, sex: 'M', weightKg: 70, heightCm: 175, birthday: '1990-01-01' };

function run(date: string, distanceKm: number, durationSec: number, extra: Partial<Activity> = {}): Activity {
  return {
    id: date + distanceKm, sportType: 100, kind: 'road', date, name: '', start: null, durationSec, distanceKm,
    avgHr: null, calories: null, lat: null, lon: null, ...extra,
  };
}

describe('Daniels', () => {
  it('retrouve les tables de Daniels (VDOT 50)', () => {
    expect(vdot(5000, 19 * 60 + 57)).toBeCloseTo(50, 0);
    const marathon = timeForVdot(50, 42195);
    // Table de Daniels : 3:10:49
    expect(Math.abs(marathon - (3 * 3600 + 10 * 60 + 49))).toBeLessThan(90);
  });
});

describe('prédictions', () => {
  it('applique Riegel et l’exposant personnel', () => {
    expect(riegel(1200, 5000, 10000)).toBeCloseTo(1200 * 2 ** 1.06, 6);
    expect(personalExponent(1200, 5000, 2500, 10000)).toBeCloseTo(Math.log(2500 / 1200) / Math.log(2), 6);
  });

  it('applique la formule de Tanda', () => {
    // 8 semaines à 60 km/sem et 5:00/km → 17,1 + 140·e^(−0,318) + 0,55·300 ≈ 284 s/km
    const acts = Array.from({ length: 48 }, (_, i) => run(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, 10, 3000));
    const res = tanda(acts.slice(0, 48), new Date(2026, 0, 31))!;
    expect(res).not.toBeNull();
    const expectedPace = 17.1 + 140 * Math.exp(-0.0053 * res.kmPerWeek) + 0.55 * 300;
    expect(res.seconds).toBeCloseTo(expectedPace * 42.195, 3);
  });

  it('donne un marathon plus lent que Riegel avec peu de volume (Vickers)', () => {
    const half = 1 * 3600 + 40 * 60;
    expect(vickers(half, 21097, 30)).toBeGreaterThan(riegel(half, 21097, 42195));
  });
});

describe('vitesse critique', () => {
  it('retrouve CS et D′ sur des points parfaits', () => {
    // CS = 4 m/s, D′ = 200 m
    const pts = [180, 300, 600, 1200].map((t) => ({ time: t, dist: 4 * t + 200 }));
    const cs = criticalSpeed(pts)!;
    expect(cs.cs).toBeCloseTo(4, 6);
    expect(cs.dPrime).toBeCloseTo(200, 4);
    expect(cs.r2).toBeCloseTo(1, 6);
  });

  it('ignore les efforts trop courts ou trop longs', () => {
    expect(criticalSpeed([{ time: 60, dist: 400 }, { time: 3000, dist: 10000 }, { time: 300, dist: 1300 }])).toBeNull();
  });
});

describe('charge', () => {
  it('calcule le TRIMP de Banister à partir de la FC moyenne', () => {
    const a = run('2026-01-01', 10, 3600, { avgHr: 150 });
    const hrr = (150 - 50) / (195 - 50);
    expect(trimp(a, ath)).toBeCloseTo(60 * hrr * 0.64 * Math.exp(1.92 * hrr), 6);
  });

  it('calcule la monotonie de Foster', () => {
    const f = foster([100, 0, 100, 0, 100, 0, 100]);
    expect(f.load).toBe(400);
    expect(f.monotony).toBeCloseTo(400 / 7 / Math.sqrt((4 * (100 - 400 / 7) ** 2 + 3 * (400 / 7) ** 2) / 7), 6);
  });

  it('donne un ACWR de 1 pour une charge constante établie', () => {
    const r = acwr(new Array(200).fill(50));
    expect(r.at(-1)).toBeCloseTo(1, 2);
  });
});

describe('classification', () => {
  it('reconnaît fractionné, sortie longue et endurance', () => {
    expect(classify(run('2026-01-01', 8, 2700, { name: '10x400 m VMA', avgHr: 160 }), 10, ath)).toBe('interval');
    expect(classify(run('2026-01-01', 22, 7200, { avgHr: 145 }), 10, ath)).toBe('long');
    expect(classify(run('2026-01-01', 10, 3300, { avgHr: 145, focus: 'Base' }), 10, ath)).toBe('easy');
    expect(classify(run('2026-01-01', 21.1, 5900, { name: 'Semi de Valbourg', avgHr: 180 }), 10, ath)).toBe('race');
    expect(classify(run('2025-10-12', 21.3, 6180, { name: 'Semi des Collines 2025', avgHr: 176 }), 10, ath)).toBe('race');
    expect(classify(run('2026-01-01', 15, 7000, { elevGain: 800 }), 10, ath)).toBe('trail');
  });
});

describe('divers', () => {
  it('applique la règle de Hadley et le km-effort', () => {
    expect(heatPenalty(10, 5)).toBe(0);
    // 30 °C + rosée 20 °C → 86 + 68 = 154 °F → entre 4,5 et 6 %
    expect(heatPenalty(30, 20)).toBeCloseTo(4.5 + 0.4 * 1.5, 6);
    expect(kmEffort(run('2026-01-01', 22, 1, { elevGain: 2000 }))).toBe(42);
  });

  it('calcule la pente de Theil-Sen et l’index de polarisation', () => {
    // Une valeur aberrante ne change pas la pente
    expect(theilSen([{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 6 }, { x: 4, y: 100 }])).toBe(2);
    expect(polarizationIndex([80, 5, 15])).toBeCloseTo(Math.log10((0.8 / 0.05) * 0.15 * 100), 6);
  });
});

describe('mur du marathon', () => {
  const steady = new Array(42).fill(320);
  const crashed = [...new Array(29).fill(320), 350, 370, 380, 420, 450, 480, 500, 460, 430, 400, 380, 370, 360];

  it('ne détecte pas de mur sur une course régulière', () => {
    const w = wallAnalysis(run('2025-11-09', 42.2, steady.reduce((a, b) => a + b, 0), { splits: steady }))!;
    expect(w.wall).toBe(false);
    expect(w.potential).toBeNull();
  });

  it('détecte le mur et estime le temps potentiel', () => {
    const total = crashed.reduce((a, b) => a + b, 0);
    const w = wallAnalysis(run('2025-11-09', 42.2, total, { splits: crashed }))!;
    expect(w.wall).toBe(true);
    expect(w.preWallKm).toBe(29);
    expect(w.potential!).toBeLessThan(total);
    expect(w.potential!).toBeCloseTo(riegel(29 * 320, 29, 42.2), 6);
  });

  it('pondère l’exposant : le mur pèse moins que l’a priori', () => {
    const ten = run('2026-03-15', 10.05, 2580, { name: '10km de Valbourg', avgHr: 180, kind: 'road' });
    const total = crashed.reduce((a, b) => a + b, 0);
    const mara = run('2025-11-09', 42.64, total, { name: 'Marathon de Valbourg', avgHr: 170, splits: crashed, kind: 'road' });
    const types = new Map([[ten.id, 'race' as const], [mara.id, 'race' as const]]);
    const e = personalExponentFromRaces([mara, ten], types, ath, new Date(2026, 9, 6))!;
    expect(e.parts.length).toBe(2);
    expect(e.parts[1].weight).toBe(0.5);
    // Moyenne pondérée entre l'a priori (poids 1) et la course (poids 0,5)
    expect(e.k).toBeCloseTo((PRIOR_EXPONENT + 0.5 * e.parts[1].k) / 1.5, 6);
    expect(e.k).toBeLessThan(e.raw);
    // Un poids forcé à 0 ignore la course
    expect(personalExponentFromRaces([mara, ten], types, { ...ath, raceWeights: { [mara.id]: 0 } }, new Date(2026, 9, 6))).toBeNull();
  });

  it('ramène la distance GPS à la distance officielle', () => {
    expect(officialDistance(42.64)).toBe(42195);
    expect(officialDistance(10.08)).toBe(10000);
    expect(officialDistance(15.8)).toBe(15800);
  });
});
