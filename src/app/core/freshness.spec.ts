import { describe, expect, it } from 'vitest';
import { acwr } from './science';
import { LOW_READINESS, STALE_DAYS, acwrReading, dataAge, dayVerdict, daysBetween, indexTrend } from './freshness';

const today = new Date(2026, 10, 11);

describe('dataAge', () => {
  it('compte les jours calendaires', () => {
    expect(daysBetween(new Date(2026, 10, 10, 23, 59), new Date(2026, 10, 11, 0, 1))).toBe(1);
    expect(daysBetween(new Date(2026, 10, 12), today)).toBe(0);
  });
  it("ne dit rien d'aujourd'hui ou d'hier", () => {
    expect(dataAge(new Date(2026, 10, 11), today)).toEqual({ days: 0, stale: false, label: null });
    expect(dataAge(new Date(2026, 10, 10), today)?.label).toBeNull();
  });
  it('date la donnée au-delà et atténue après 3 jours', () => {
    const a = dataAge(new Date(2026, 10, 9), today)!;
    expect(a.label).toMatch(/^au 9 nov/);
    expect(a.stale).toBe(false);
    const old = dataAge(new Date(2026, 9, 24), today)!;
    expect(old.days).toBe(18);
    expect(old.stale).toBe(true);
    expect(old.label).toMatch(/^au 24 oct/);
    expect(dataAge(new Date(2026, 10, 11 - STALE_DAYS), today)!.stale).toBe(false);
    expect(dataAge(null, today)).toBeNull();
  });
});

describe('dayVerdict', () => {
  const base = { age: dataAge(today, today), freshLabel: 'Neutre', freshTone: 'neutral' as const, freshText: 'Équilibre.', parts: ['fraîcheur +2 (neutre)'] };
  it('rassure quand rien ne la contredit', () => {
    expect(dayVerdict(base)?.title).toContain('séance normale');
  });
  it('ne dit pas « séance normale » avec une préparation basse', () => {
    const v = dayVerdict({ ...base, readiness: LOW_READINESS - 1 })!;
    expect(v.title).toBe('Journée à prendre en douceur');
  });
  it('ne dit pas « séance normale » en désentraînement', () => {
    const v = dayVerdict({ ...base, freshLabel: 'Désentraînement', freshTone: 'warning' })!;
    expect(v.title).not.toContain('séance normale');
    expect(v.stale).toBe(false);
  });
  it("ne donne aucun conseil au-delà de 3 jours et date la donnée", () => {
    const v = dayVerdict({ ...base, age: dataAge(new Date(2026, 9, 24), today) })!;
    expect(v.stale).toBe(true);
    expect(v.title).toMatch(/^Dernières données au 24 oct.* synchronise/);
    expect(v.line).not.toContain('Privilégie');
  });
  it('sans donnée, pas de verdict', () => {
    expect(dayVerdict({ ...base, parts: [] })).toBeNull();
  });
});

describe('acwrReading', () => {
  // 40 jours de charge régulière puis 18 jours d'arrêt
  const daily = [...Array(40).fill(60), ...Array(18).fill(0)];
  const ratios = acwr(daily);
  it("signale un ratio effondré par l'arrêt, avec la valeur à la dernière donnée", () => {
    const r = acwrReading(ratios, daily)!;
    expect(r.ratio).toBeLessThan(0.05);
    expect(r.idleDays).toBe(18);
    expect(r.stale).toBe(true);
    expect(r.atLastData).toBeGreaterThan(0.8);
  });
  it('ne marque pas un ratio calculé sur des données récentes', () => {
    const d = [...Array(40).fill(60), 0, 0];
    const r = acwrReading(acwr(d), d)!;
    expect(r.stale).toBe(false);
    expect(r.idleDays).toBe(2);
  });
  it('sans aucune charge, rien à lire', () => {
    expect(acwrReading(acwr([0, 0, 0]), [0, 0, 0])).toBeNull();
  });
});

describe('indexTrend', () => {
  it('utilise les mêmes valeurs que celles affichées', () => {
    const t = indexTrend([38, 36, 35, 34, 33, 32], 4)!;
    expect(t).toEqual({ from: 36, to: 32, diff: -4, weeks: 4 });
  });
  it('arrondit avant de soustraire', () => {
    const t = indexTrend([37.6, 38.4, 38.4, 38.4, 38.4], 4)!;
    expect(t.from).toBe(38);
    expect(t.to).toBe(38);
    expect(t.diff).toBe(0);
  });
  it("exige assez d'historique", () => {
    expect(indexTrend([1, 2, 3, 4], 4)).toBeNull();
  });
});
