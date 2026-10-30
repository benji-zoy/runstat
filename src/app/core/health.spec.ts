import { Health, HealthDay } from './models';
import { readinessFor } from './health';
import { addDays, isoDay, parseDay } from './stats';

/** Nuits régulières autour d'une base (VFC 60 ms, FC 50 bpm, 7 h 30), avec un score Fitbit jusqu'à `scoredUntil` */
function health(days: number, scoredUntil: number, last?: Partial<HealthDay>): Health {
  const start = parseDay('2026-06-01');
  const out: Record<string, HealthDay> = {};
  for (let i = 0; i < days; i++) {
    const wobble = Math.sin(i * 1.7);
    const hrv = 60 + 8 * wobble, rhr = 50 - 2 * wobble, sleepMin = 450 + 40 * Math.cos(i * 0.9);
    const day: HealthDay = { hrv, rhr, sleepMin };
    // Le score « source » suit la VFC et le sommeil : l'estimation doit le retrouver
    if (i < scoredUntil) day.readiness = Math.round(70 + 1.2 * (hrv - 60) + 0.1 * (sleepMin - 450));
    out[isoDay(addDays(start, i))] = day;
  }
  if (last) Object.assign(out[isoDay(addDays(start, days - 1))], last);
  return { importedAt: '2026-10-01T00:00:00Z', days: out, weight: [] };
}
const lastDay = (h: Health) => parseDay(Object.keys(h.days).sort().at(-1)!);

describe('préparation du jour', () => {
  it('reprend le score de la source quand il existe', () => {
    const h = health(40, 40);
    expect(readinessFor(h, lastDay(h))).toEqual({ score: h.days[isoDay(lastDay(h))].readiness!, estimated: false, calibratedOn: 0, error: null });
  });

  it("l'estime sans score, calé sur l'historique Fitbit", () => {
    const h = health(90, 80, { hrv: 75, rhr: 47, sleepMin: 480 });
    const r = readinessFor(h, lastDay(h))!;
    expect(r.estimated).toBe(true);
    expect(r.calibratedOn).toBeGreaterThanOrEqual(20);
    // VFC nettement au-dessus de la base : bien au-dessus du score moyen (70)
    expect(r.score).toBeGreaterThan(80);
  });

  it('baisse quand la nuit est mauvaise', () => {
    const good = health(90, 80, { hrv: 66, rhr: 49, sleepMin: 470 });
    const bad = health(90, 80, { hrv: 48, rhr: 55, sleepMin: 300 });
    expect(readinessFor(bad, lastDay(bad))!.score).toBeLessThan(readinessFor(good, lastDay(good))!.score);
  });

  it('prend des poids par défaut sans historique de score', () => {
    const h = health(40, 0);
    const r = readinessFor(h, lastDay(h))!;
    expect(r.estimated).toBe(true);
    expect(r.calibratedOn).toBe(0);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(100);
  });

  it("ne dit rien sans base personnelle (moins de 10 nuits)", () => {
    const h = health(8, 0);
    expect(readinessFor(h, lastDay(h))).toBeNull();
  });
});
