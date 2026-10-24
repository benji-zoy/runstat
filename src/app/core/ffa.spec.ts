import { Activity } from './models';
import { FFA_DISTANCES, FFA_LEVELS, confirmedLevel, ffaDistance, ffaGrade, ffaLimits, parseFfaTime, racePerformances } from './ffa';
import { parseDay } from './stats';

function race(date: string, km: number, sec: number, extra: Partial<Activity> = {}): Activity {
  return {
    id: date, sportType: 100, kind: 'road', date, name: '', start: null, durationSec: sec, distanceKm: km, avgHr: null,
    calories: null, lat: null, lon: null, ...extra,
  };
}

describe('barème FFA', () => {
  it('lit les temps du barème', () => {
    expect(parseFfaTime("1h37'00")).toBe(5820);
    expect(parseFfaTime("27'50")).toBe(1670);
    expect(parseFfaTime("55'00")).toBe(3300);
  });

  it('classe un temps au niveau dont il passe la limite, et donne la marche suivante', () => {
    // Semi homme : D3 = 1h37'00, D2 = 1h34'00
    const g = ffaGrade('M', 21097, 5790)!;
    expect(g.level).toBe('D3');
    expect(g.tier).toBe('Départemental');
    expect(g.points).toBe(6);
    expect(g.next).toBe('D2');
    expect(g.nextSec).toBe(5640);
    // Pile sur la limite : le niveau est acquis
    expect(ffaGrade('M', 10000, 35 * 60)!.level).toBe('R1');
    // Plus lent que D7 : pas de niveau, D7 à viser
    const slow = ffaGrade('M', 42195, 4 * 3600 + 15 * 60)!;
    expect(slow.level).toBeNull();
    expect(slow.next).toBe('D7');
    expect(ffaGrade('F', 10000, 31 * 60)!.level).toBe('IA');
    expect(ffaGrade('M', 3000, 600)).toBeNull();
  });

  it('a 23 limites strictement croissantes par distance, et des femmes plus lentes à niveau égal', () => {
    for (const sex of ['M', 'F'] as const) {
      for (const d of FFA_DISTANCES) {
        const l = ffaLimits(sex, d)!;
        expect(l.length).toBe(FFA_LEVELS.length);
        for (let i = 1; i < l.length; i++) expect(l[i]).toBeGreaterThan(l[i - 1]);
      }
    }
    for (const d of FFA_DISTANCES) expect(ffaLimits('F', d)![0]).toBeGreaterThan(ffaLimits('M', d)![0]);
  });

  it('reconnaît les distances du barème à 4 % près', () => {
    expect(ffaDistance(21.24)).toBe(21097);
    expect(ffaDistance(10.08)).toBe(10000);
    expect(ffaDistance(2.87)).toBeNull();
  });

  it('préfère le temps officiel, puis le temps puce, puis la montre ; ignore le trail', () => {
    const official = race('2026-03-15', 10.05, 2580, {
      result: {
        event: '10 km', course: null, distanceKm: 10, officialSec: 2590, rank: 1, finishers: 1, sex: 'M', sexRank: 1, sexCount: 1,
        category: null, catRank: null, catCount: null, source: '', fetchedAt: '',
      },
    });
    const chip = race('2026-10-18', 21.24, 5800);
    const watch = race('2025-11-09', 42.64, 14644);
    const trail = race('2026-06-28', 21, 8000, { kind: 'trail' });
    const perfs = racePerformances([official, chip, watch, trail], 'M', new Map([['2026-10-18', 5790]]));
    expect(perfs.map((p) => [p.sec, p.timeSource])).toEqual([
      [2590, 'officiel'],
      [5790, 'puce du bilan'],
      [14644, 'montre'],
    ]);
  });

  it('acquiert un niveau avec deux performances sur 12 mois (le plus bas des deux)', () => {
    const today = parseDay('2026-10-20');
    const perfs = racePerformances(
      [race('2026-03-15', 10, 43 * 60 + 40), race('2026-10-18', 21.1, 5790), race('2024-03-03', 10, 30 * 60)],
      'M',
    );
    // 10 km en 43'40 = D5, semi en 1h36'30 = D3 : D5 acquis ; le 10 km de 2024 est trop ancien
    expect(confirmedLevel(perfs, today)).toBe('D5');
    expect(confirmedLevel(perfs.slice(0, 1), today)).toBeNull();
  });
});
