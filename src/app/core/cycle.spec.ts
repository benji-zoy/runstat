import { Activity, Cycle, Goal, PlanSession } from './models';
import { cycleId, cycleName, cycleState, cycleTracking, cycleVolume, currentCycle, nextMonday } from './cycle';
import { cycleLastDay, cycleRelay, planOf, upcomingPlanned } from './plan';
import { parseDay } from './stats';

const rates = { easy: 1, quality: 1.6, race: 2, easyPace: 360 };
const s = (date: string, kind: PlanSession['kind'] = 'easy', km = 8): PlanSession => ({ date, kind, name: `${kind} ${date}`, distanceKm: km, durationMin: 48 });
const plan = (id: string, sessions: PlanSession[]) => ({ goalId: id, importedAt: '2026-11-01T00:00:00.000Z', sessions });
const cycle = (extra: Partial<Cycle> = {}): Cycle => ({
  id: 'cycle-endurance-2026-11-02',
  name: 'Cycle Endurance · nov. 2026',
  focus: 'endurance',
  start: '2026-11-02',
  weeks: 4,
  plan: plan('cycle-endurance-2026-11-02', [s('2026-11-03'), s('2026-11-05', 'quality'), s('2026-11-07', 'strength'), s('2026-11-10'), s('2026-11-12'), s('2026-11-24'), s('2026-11-28', 'race', 5)]),
  ...extra,
});
const run = (date: string, km = 8, load = 50): Activity =>
  ({ id: date, date, distanceKm: km, durationSec: km * 360, trainingLoad: load, avgHr: 140, kind: 'road', elevGain: 0, name: 'Sortie' }) as unknown as Activity;

describe('cycles sans course', () => {
  it('nomme, numérote et date un cycle', () => {
    expect(cycleLastDay(cycle())).toBe('2026-11-29');
    expect(cycleName('speed', '2026-11-16')).toBe('Cycle Vitesse · nov. 2026');
    expect(cycleId('trail', '2026-11-16', ['cycle-trail-2026-11-16'])).toBe('cycle-trail-2026-11-16-2');
    expect(nextMonday(parseDay('2026-11-11'))).toBe('2026-11-16');
    expect(nextMonday(parseDay('2026-11-16'))).toBe('2026-11-16');
  });

  it('suit l’état : à venir, en cours (semaine), terminé', () => {
    const c = cycle();
    expect(cycleState(c, [], parseDay('2026-11-01')).status).toBe('upcoming');
    expect(cycleState(c, [], parseDay('2026-11-11'))).toMatchObject({ status: 'active', week: 2, end: '2026-11-29', relay: null });
    expect(cycleState(c, [], parseDay('2026-11-30')).status).toBe('done');
    expect(currentCycle([c, cycle({ id: 'b', start: '2026-12-07' })], [], parseDay('2026-11-11'))?.id).toBe(c.id);
  });

  it('une course prend le relais : le cycle s’arrête la veille de son plan', () => {
    const race: Goal = { id: 'semi', name: 'Semi', date: '2027-01-10', distanceKm: 21.1, kind: 'road', plan: plan('semi', [s('2026-11-16'), s('2026-11-18')]) };
    const c = cycle();
    expect(cycleRelay(c, [race])?.date).toBe('2026-11-16');
    expect(cycleState(c, [race], parseDay('2026-11-20'))).toMatchObject({ status: 'done', end: '2026-11-15' });
    // Séance du jour : le cycle jusqu'au 15, puis le plan de course
    const days = upcomingPlanned([race], null, rates, parseDay('2026-11-09'), [c]).map((x) => x.date).filter((d) => d >= '2026-11-09');
    expect(days).toEqual(['2026-11-10', '2026-11-12', '2026-11-16', '2026-11-18']);
    // Le test du cycle suit le plan du cycle, pas le relais
    const test: Goal = { id: 'test', name: 'Test 5 km', date: '2026-11-29', distanceKm: 5, kind: 'road', cycle: c.id };
    expect(planOf(test, [test], [c]).map((x) => x.date)).toContain('2026-11-28');
    expect(cycleRelay(c, [{ ...test, plan: plan('test', [s('2026-11-20')]) }])).toBeNull();
  });

  it('compare le prévu et le fait, semaine par semaine', () => {
    const t = cycleTracking(cycle(), [], [run('2026-11-03'), run('2026-11-06', 10), run('2026-11-10', 12)], new Map(), rates, parseDay('2026-11-11'));
    expect(t.weeks.map((w) => w.start)).toEqual(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']);
    // Semaine 1 : 2 séances de course prévues (le renfo ne compte pas), une faite le même jour
    expect(t.weeks[0]).toMatchObject({ plannedCount: 2, matched: 1, doneCount: 2, doneKm: 18, plannedKm: 16, future: false });
    expect(t.weeks[1]).toMatchObject({ plannedCount: 2, matched: 1 });
    expect(t.weeks[2].future).toBe(true);
    // Jusqu'à hier (10 novembre) : 3 séances prévues, 2 faites
    expect([t.plannedToDate, t.doneToDate, t.doneKmToDate]).toEqual([3, 2, 30]);
    expect(t.acwr).toBeGreaterThan(0);
  });

  it('conseille un volume selon le but', () => {
    expect(cycleVolume('restart', 30, 6)).toBe(24);
    expect(cycleVolume('endurance', 30, 4)).toBeCloseTo(36.3, 1);
    // Plafond : 1,5 × le volume actuel
    expect(cycleVolume('endurance', 30, 8)).toBe(45);
    expect(cycleVolume('speed', 30, 8)).toBe(30);
  });
});
