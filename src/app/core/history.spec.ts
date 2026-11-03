import { Activity, Athlete, Goal } from './models';
import { confidenceHistory, predictionHistory, sampleDates } from './history';
import { evaluateGoal, goalContext } from './goals';
import { classifyAll } from './science';
import { isoDay } from './stats';

const ath: Athlete = { hrMax: 195, hrRest: 50, sex: 'M', weightKg: 70, heightCm: 175, birthday: '1990-01-01' };

function run(date: string, distanceKm: number, durationSec: number, extra: Partial<Activity> = {}): Activity {
  return {
    id: date + distanceKm, sportType: 100, kind: 'road', date, name: '', start: null, durationSec, distanceKm,
    avgHr: null, calories: null, lat: null, lon: null, ...extra,
  };
}

describe('historiques', () => {
  it('échantillonne de la date de départ à aujourd\'hui, une semaine d\'écart au moins', () => {
    const to = new Date(2026, 10, 3);
    const short = sampleDates(new Date(2026, 9, 1), to);
    expect(isoDay(short.at(-1)!)).toBe('2026-11-03');
    expect(short.length).toBe(5);
    const long = sampleDates(new Date(2020, 0, 1), to, 60);
    expect(long.length).toBeLessThanOrEqual(61);
    expect(isoDay(long.at(-1)!)).toBe('2026-11-03');
  });

  it('ne prédit qu\'avec les courses connues à chaque date', () => {
    const acts = [run('2026-03-15', 10, 2700, { name: '10 km de Valbourg', avgHr: 180 }), run('2026-09-20', 10, 2520, { name: '10 km de Valbourg', avgHr: 180 })];
    const types = classifyAll(acts, ath);
    const h = predictionHistory(acts, types, ath, [new Date(2026, 1, 1), new Date(2026, 5, 1), new Date(2026, 10, 1)]);
    expect(h[0].times['10k']).toBeUndefined();
    expect(h[1].times['10k']).toBeGreaterThan(h[2].times['10k']!);
    expect(h[2].times.marathon).toBeGreaterThan(h[2].times.semi!);
  });

  it('rejoue l\'indice d\'un objectif chaque semaine et finit sur l\'évaluation du jour', () => {
    const acts = [run('2026-03-15', 10, 2700, { name: '10 km de Valbourg', avgHr: 180 }), run('2026-09-20', 10, 2520, { name: '10 km de Valbourg', avgHr: 180 })];
    const types = classifyAll(acts, ath);
    const today = new Date(2026, 10, 3);
    const goal: Goal = { id: 'g', name: '10 km', date: '2026-12-06', distanceKm: 10, targetSec: 2550, kind: 'road' };
    const now = evaluateGoal(goal, goalContext(goal, acts, types, ath, today, {}, null), today, acts)!;
    const h = confidenceHistory(now, acts, types, ath, null, today, 12);
    expect(h.at(-1)).toEqual({ date: '2026-11-03', daysLeft: 33, index: now.index, predicted: now.predicted });
    expect(h[0].date).toBe('2026-08-11');
    // Avant le 10 km de septembre, l'objectif semblait moins accessible
    expect(h[0].index).toBeLessThan(now.index);
  });
});
