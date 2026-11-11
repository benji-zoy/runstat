import { Goal, PlanSession, PlannedCalendar } from './models';
import { GoalEvaluation } from './goals';
import { bandOf, goalPlanned, mergeCalendars, recommendedSessions, recommendedVolume, toPlanned, upcomingPlanned, volumeBands } from './plan';
import { recoveryDays, secondaryChecks } from './plan-checks';
import { parseDay } from './stats';

const ref = parseDay('2026-11-11');
const rates = { easy: 1, quality: 1.6, race: 2, easyPace: 360 };
const s = (date: string, kind: PlanSession['kind'] = 'easy', extra: Partial<PlanSession> = {}): PlanSession => ({ date, kind, name: `${kind} ${date}`, durationMin: 50, ...extra });
const coros = (dates: string[], fetchedAt = '2026-11-10T06:00:00Z'): PlannedCalendar => ({
  source: 'coros',
  fetchedAt,
  from: '2026-11-10',
  to: '2027-03-10',
  sessions: dates.map((date) => ({ date, name: `COROS ${date}`, distanceKm: 10, durationSec: 3600, load: 60, fromPlan: true })),
});

describe('plan importé et calendrier COROS', () => {
  it('estime la charge et la distance d’une séance du plan', () => {
    expect(toPlanned(s('2026-11-12', 'quality'), rates)).toMatchObject({ durationSec: 3000, load: 80, distanceKm: 8.3, imported: true, kind: 'quality' });
    expect(toPlanned(s('2026-11-12', 'long', { durationMin: undefined, distanceKm: 20 }), rates)).toMatchObject({ durationSec: 7200, load: 120, distanceKm: 20 });
    expect(toPlanned(s('2026-11-12', 'strength'), rates).load).toBe(0);
  });

  it('donne la priorité à COROS semaine par semaine', () => {
    // Semaine du 9 novembre : COROS ; semaine du 16 : le plan importé
    const plan = [s('2026-11-12'), s('2026-11-14'), s('2026-11-17'), s('2026-11-19', 'strength')];
    const m = mergeCalendars(coros(['2026-11-13']), plan, rates, ref)!;
    expect(m.sessions.map((x) => x.name)).toEqual(['COROS 2026-11-13', 'easy 2026-11-17']);
    expect(m.fetchedAt).toBe(ref.toISOString());
    // Le renfo n'est gardé que pour l'affichage
    expect(mergeCalendars(null, plan, rates, ref, { strength: true })!.sessions).toHaveLength(4);
    // Calendrier périmé : le plan seul
    expect(mergeCalendars(coros(['2026-11-13'], '2026-10-01T00:00:00Z'), plan, rates, ref)!.source).toBe('import');
    // Sans plan : COROS tel quel
    expect(mergeCalendars(coros(['2026-11-13']), [], rates, ref)!.fetchedAt).toBe('2026-11-10T06:00:00Z');
    expect(mergeCalendars(null, [], rates, ref)).toBeNull();
  });

  it('un objectif secondaire suit le plan de son objectif principal', () => {
    const main: Goal = { id: 'main', name: 'Marathon', date: '2027-03-01', distanceKm: 42.195, kind: 'road', plan: { goalId: 'main', importedAt: '2026-11-11T00:00:00.000Z', sessions: [s('2026-11-20')] } };
    const prep: Goal = { id: 'prep', name: 'Semi', date: '2027-01-15', distanceKm: 21.1, kind: 'road', parent: 'main' };
    expect(goalPlanned(prep, [main, prep], null, rates, ref)!.sessions[0].date).toBe('2026-11-20');
    expect(upcomingPlanned([main, prep], null, rates, ref).map((x) => x.date)).toEqual(['2026-11-20']);
  });

  it('conseille un volume, des séances et des tranches', () => {
    const marathon: Goal = { id: 'm', name: 'M', date: '2027-03-07', distanceKm: 42.195, kind: 'road' };
    expect(recommendedVolume(marathon, 40, ref)).toBeCloseTo(71.7, 0);
    // Peu de temps : borné par +10 % par semaine
    const soon: Goal = { ...marathon, date: '2026-12-06' };
    expect(recommendedVolume(soon, 30, ref)).toBeCloseTo(33, 0);
    const bands = volumeBands(72, 40);
    expect(bands.at(-1)).toEqual({ min: 100, max: null });
    expect(bandOf(bands, 72)).toBe(3);
    expect([recommendedSessions(15), recommendedSessions(35), recommendedSessions(60), recommendedSessions(90)]).toEqual([3, 4, 5, 6]);
  });
});

describe('objectifs secondaires', () => {
  const ev = (goal: Goal, probability: number | null = 0.6): GoalEvaluation => ({ goal, ke: goal.distanceKm, probability } as unknown as GoalEvaluation);
  const main = ev({ id: 'main', name: 'Marathon', date: '2027-04-11', distanceKm: 42.195, kind: 'road' });

  it('signale ce qui est trop proche, trop rapproché, trop long ou trop ambitieux', () => {
    const texts = (list: GoalEvaluation[]) => secondaryChecks(main, list).map((c) => c.text);
    expect(recoveryDays(10)).toBe(7);
    expect(recoveryDays(21.1)).toBe(10);
    // Semi trois semaines avant : récupération qui mord sur l'affûtage
    expect(texts([ev({ id: 's', name: 'Semi', date: '2027-03-21', distanceKm: 21.1, kind: 'road' })])[0]).toContain('proche de Marathon');
    // 10 km pendant l'affûtage : simple remarque
    const taper = secondaryChecks(main, [ev({ id: 't', name: '10 km', date: '2027-04-04', distanceKm: 10, kind: 'road' })]);
    expect(taper).toEqual([jasmineLike('info', 'pendant l\'affûtage')]);
    // Deux semis à une semaine d'écart, loin de l'objectif
    const two = texts([
      ev({ id: 'a', name: 'Semi A', date: '2027-01-10', distanceKm: 21.1, kind: 'road' }),
      ev({ id: 'b', name: 'Semi B', date: '2027-01-17', distanceKm: 21.1, kind: 'road' }),
    ]);
    expect(two.some((t) => t.includes('7 jours d\'écart'))).toBe(true);
    // Aussi long que l'objectif, et chrono très ambitieux
    const hard = texts([ev({ id: 'c', name: 'Marathon B', date: '2027-01-10', distanceKm: 42.195, kind: 'road', targetSec: 9000 }, 0.1)]);
    expect(hard.some((t) => t.includes('aussi long'))).toBe(true);
    expect(hard.some((t) => t.includes('très ambitieux'))).toBe(true);
    // Rien à redire
    expect(texts([ev({ id: 'd', name: '10 km', date: '2027-02-07', distanceKm: 10, kind: 'road' })])).toEqual([]);
  });
});

function jasmineLike(level: 'info' | 'warning', text: string) {
  return expect.objectContaining({ level, text: expect.stringContaining(text) });
}
