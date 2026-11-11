import { Activity } from './models';
import { parseDay } from './stats';
import {
  EFFORT_DISTANCES,
  activeDays,
  daytimeStats,
  eddington,
  effortIn,
  freshnessState,
  histogram,
  milestones,
  notables,
  paceOf,
  pmc,
  punchcard,
  runnerProfile,
  startHour,
  startPlaces,
  topEfforts,
  topN,
  weekStreaks,
  weekday,
  weekdayStats,
  yearProjection,
} from './insights';

const act = (date: string, extra: Partial<Activity> = {}): Activity =>
  ({ id: date + (extra.id ?? ''), date, name: 'Sortie', kind: 'road', distanceKm: 10, durationSec: 3600, start: null, lat: null, lon: null, ...extra }) as unknown as Activity;
const at = (date: string, h: number, extra: Partial<Activity> = {}) => act(date, { start: new Date(`${date}T${String(h).padStart(2, '0')}:00:00`).getTime() / 1000, ...extra });
const effort = (key: string) => EFFORT_DISTANCES.find((e) => e.key === key)!;
const fit = (efforts: Record<string, number>) => ({ efforts }) as unknown as Activity['fit'];

describe('jour et heure', () => {
  it('heure locale de départ, null si inconnue', () => {
    expect(startHour(at('2026-03-02', 6))).toBe(6);
    expect(startHour(act('2026-03-02'))).toBeNull();
  });

  it('0 = lundi … 6 = dimanche', () => {
    expect(weekday(act('2026-03-02'))).toBe(0);
    expect(weekday(act('2026-03-08'))).toBe(6);
  });

  it('allure en s/km', () => {
    expect(paceOf(act('2026-03-02', { distanceKm: 10, durationSec: 3000 }))).toBe(300);
  });

  it('carte jour × heure et statistiques par jour', () => {
    const acts = [at('2026-03-02', 6), at('2026-03-02', 6, { id: 'b' }), at('2026-03-04', 18, { distanceKm: 5 }), act('2026-03-05')];
    const grid = punchcard(acts);
    expect(grid).toHaveLength(7);
    expect(grid[0][6]).toBe(2);
    expect(grid[2][18]).toBe(1);
    // la sortie sans heure n'apparaît pas
    expect(grid.flat().reduce((s, n) => s + n, 0)).toBe(3);
    const ws = weekdayStats(acts);
    expect(ws[0]).toEqual({ day: 'Lundi', count: 2, km: 20 });
    expect(ws[3]).toMatchObject({ day: 'Jeudi', count: 1 });
  });
});

describe('moments de la journée', () => {
  it('répartit par tranche, la nuit couvre minuit à 5 h et 22 h à minuit', () => {
    const acts = [at('2026-03-02', 5), at('2026-03-02', 4), at('2026-03-02', 23), at('2026-03-02', 12), at('2026-03-02', 13, { distanceKm: 4 }), act('2026-03-03')];
    const by = Object.fromEntries(daytimeStats(acts).map((d) => [d.key, d]));
    expect(by['aube'].count).toBe(1);
    expect(by['nuit'].count).toBe(2);
    expect(by['midi']).toMatchObject({ count: 2, km: 14 });
  });

  it('bornes : 8 h est le matin, 22 h la nuit', () => {
    const by = Object.fromEntries(daytimeStats([at('2026-03-02', 8), at('2026-03-02', 22)]).map((d) => [d.key, d.count]));
    expect(by['matin']).toBe(1);
    expect(by['nuit']).toBe(1);
    expect(by['aube']).toBe(0);
  });
});

describe('histogramme', () => {
  it('compte par borne inférieure, ignore ce qui est sous la première', () => {
    expect(histogram([1, 5, 9, 10, 25, 100], [5, 10, 20])).toEqual([2, 1, 2]);
    expect(histogram([], [0, 1])).toEqual([0, 0]);
    expect(histogram([-3], [0, 1])).toEqual([0, 0]);
  });
});

describe('lieux de départ', () => {
  it('regroupe à moins de 1 km, les plus fréquents d’abord, noms limités à 3', () => {
    const acts = [
      act('2026-01-01', { lat: 45, lon: 3, name: 'A' }),
      act('2026-01-02', { lat: 45.001, lon: 3, name: 'B' }),
      act('2026-01-03', { lat: 45.002, lon: 3, name: 'C' }),
      act('2026-01-04', { lat: 45.003, lon: 3, name: 'D' }),
      act('2026-01-05', { lat: 46, lon: 3, name: 'Loin' }),
      act('2026-01-06'),
    ];
    const places = startPlaces(acts);
    expect(places).toHaveLength(2);
    expect(places[0]).toMatchObject({ count: 4, km: 40, first: '2026-01-01', last: '2026-01-04' });
    expect(places[0].names).toEqual(['A', 'B', 'C']);
    expect(places[1].count).toBe(1);
  });

  it('rayon réglable, entrée vide', () => {
    const acts = [act('2026-01-01', { lat: 45, lon: 3 }), act('2026-01-02', { lat: 45.05, lon: 3 })];
    expect(startPlaces(acts, 10)).toHaveLength(1);
    expect(startPlaces([])).toEqual([]);
  });
});

describe('profil de coureur', () => {
  it('sans sortie : coureur en devenir', () => {
    expect(runnerProfile([])).toEqual({ title: 'Coureur en devenir', traits: [] });
  });

  it('coureur du matin, jour préféré et distance moyenne en français', () => {
    const acts = [at('2026-03-02', 9), at('2026-03-09', 9), at('2026-03-04', 9)].map((a) => ({ ...a, distanceKm: 8 }));
    const p = runnerProfile(acts);
    expect(p.title).toBe('Coureur du matin');
    expect(p.traits[0]).toBe('Lundi est ton jour préféré (2 sorties)');
    expect(p.traits[2]).toBe('8,0 km par sortie en moyenne');
  });

  it('traileur et coureur de fond', () => {
    expect(runnerProfile([at('2026-03-02', 9, { kind: 'trail' }), at('2026-03-03', 9)]).title).toMatch(/^Traileur/);
    expect(runnerProfile([at('2026-03-02', 19, { distanceKm: 15 })]).title).toBe('Coureur de fond du soir');
  });
});

describe('régularité', () => {
  it('Eddington : plus grand E avec E km sur E jours, jours cumulés', () => {
    const km = [10, 10, 9, 4, 3];
    const acts = km.map((d, i) => act(`2026-01-0${i + 1}`, { distanceKm: d }));
    expect(eddington(acts)).toEqual({ e: 4, nextNeeded: 2 });
    // deux sorties le même jour s'additionnent
    expect(eddington([act('2026-01-01', { distanceKm: 3 }), act('2026-01-01', { id: 'b', distanceKm: 3 })]).e).toBe(1);
    expect(eddington([])).toEqual({ e: 0, nextNeeded: 1 });
  });

  it('séries de semaines : plus longue et en cours (la semaine courante vide ne casse pas)', () => {
    // lundis 5 janv., 12, 19 puis 2 fév.
    const acts = ['2026-01-05', '2026-01-12', '2026-01-21', '2026-02-02'].map((d) => act(d));
    expect(weekStreaks(acts, parseDay('2026-01-23')).longest).toBe(3);
    expect(weekStreaks(acts, parseDay('2026-01-23')).current).toBe(3);
    // semaine du 26 janv. vide mais encore en cours à la date : la série d'avant compte
    expect(weekStreaks(acts.slice(0, 3), parseDay('2026-01-28')).current).toBe(3);
    // deux semaines vides : plus de série en cours
    expect(weekStreaks(acts.slice(0, 3), parseDay('2026-02-10')).current).toBe(0);
    expect(weekStreaks([], parseDay('2026-02-10'))).toEqual({ longest: 0, current: 0 });
  });

  it('jours actifs', () => {
    expect(activeDays([act('2026-01-01'), act('2026-01-01', { id: 'b' }), act('2026-01-02')])).toBe(2);
  });
});

describe('meilleurs efforts', () => {
  it('segment FIT dans une sortie plus longue, sortie entière sinon', () => {
    expect(effortIn(act('2026-01-01', { distanceKm: 12, fit: fit({ '5000': 1200 }) }), effort('5000'))).toEqual({ time: 1200, source: 'segment' });
    expect(effortIn(act('2026-01-01', { distanceKm: 5.02, fit: fit({ '5000': 1200 }) }), effort('5000'))).toEqual({ time: 1200, source: 'sortie' });
    expect(effortIn(act('2026-01-01', { fit: fit({}) }), effort('5000'))).toBeNull();
  });

  it('tapis exclu', () => {
    expect(effortIn(act('2026-01-01', { kind: 'indoor', fit: fit({ '5000': 1000 }) }), effort('5000'))).toBeNull();
  });

  it('sans FIT : meilleur km Coros, ou allure moyenne d’une sortie à +5 % au plus', () => {
    expect(effortIn(act('2026-01-01', { bestKmSec: 250 }), effort('1000'))).toEqual({ time: 250, source: 'coros' });
    expect(effortIn(act('2026-01-01', { bestKmSec: 250 }), effort('5000'))).toBeNull();
    const five = act('2026-01-01', { distanceKm: 5.1, durationSec: 1530 });
    expect(effortIn(five, effort('5000'))).toEqual({ time: 1500, source: 'moyenne' });
    expect(effortIn(act('2026-01-01', { distanceKm: 5.3, durationSec: 1590 }), effort('5000'))).toBeNull();
    expect(effortIn(act('2026-01-01', { distanceKm: 4.9, durationSec: 1470 }), effort('5000'))).toBeNull();
    // sous 3 km, l'allure moyenne n'est pas retenue
    expect(effortIn(act('2026-01-01', { distanceKm: 1, durationSec: 240 }), effort('1000'))).toBeNull();
  });

  it('top : une fois par sortie, du plus rapide au plus lent, limité à n', () => {
    const acts = [
      act('2026-01-01', { fit: fit({ '5000': 1300 }) }),
      act('2026-01-02', { fit: fit({ '5000': 1200 }) }),
      act('2026-01-03', { fit: fit({ '5000': 1250 }) }),
      act('2026-01-04', { fit: fit({}) }),
    ];
    const top = topEfforts(acts, effort('5000'), 2);
    expect(top.map((t) => t.time)).toEqual([1200, 1250]);
    expect(top[0].activity.date).toBe('2026-01-02');
    expect(topEfforts([], effort('5000'), 3)).toEqual([]);
  });

  it('topN : score nul ou infini exclu', () => {
    const acts = [act('2026-01-01', { distanceKm: 5 }), act('2026-01-02', { distanceKm: 20 }), act('2026-01-03', { distanceKm: 12 })];
    expect(topN(acts, (a) => (a.date === '2026-01-03' ? null : a.distanceKm), 5).map((a) => a.date)).toEqual(['2026-01-02', '2026-01-01']);
    expect(topN(acts, () => Infinity, 3)).toEqual([]);
  });
});

describe('notables', () => {
  const history = [act('2025-06-01', { distanceKm: 20 }), act('2025-09-01', { distanceKm: 15 }), act('2025-12-01', { distanceKm: 18 })];

  it('plus longue sortie de tous les temps, avec une fenêtre libellée', () => {
    const target = act('2026-01-15', { distanceKm: 25 });
    expect(notables(target, [...history, target])).toContain('Plus longue sortie de tous les temps');
  });

  it('retient la fenêtre la plus large où la sortie est la meilleure', () => {
    const target = act('2026-01-15', { distanceKm: 19 });
    // battue par les 20 km de juin 2025 (hors 6 mois), mais meilleure que tout depuis 6 mois
    const labels = notables(target, [...history, target]);
    expect(labels).toContain('Plus longue sortie depuis 6 mois');
    expect(labels).not.toContain('Plus longue sortie de tous les temps');
  });

  it('un historique trop court (moins de 20 jours) ne donne rien', () => {
    const target = act('2026-01-15', { distanceKm: 25 });
    expect(notables(target, [target, act('2026-01-10')])).toEqual([]);
    expect(notables(target, [])).toEqual([]);
  });

  it('allure rapide seulement à partir de 3 km, hors tapis', () => {
    const quick = act('2026-01-15', { distanceKm: 2, durationSec: 400 });
    expect(notables(quick, [...history, quick]).some((l) => l.startsWith('Allure'))).toBe(false);
  });
});

describe('projection de fin d’année', () => {
  it('rythme de l’année et des 30 derniers jours', () => {
    const acts = [act('2026-01-01', { distanceKm: 100 }), act('2026-06-20', { distanceKm: 30 })];
    const p = yearProjection(acts, parseDay('2026-07-01'));
    expect(p.done).toBe(130);
    expect(p.daysLeft).toBe(183);
    expect(p.projected).toBeGreaterThan(130);
    // aucune sortie récente : projection plus basse qu'avec des sorties récentes
    const idle = yearProjection([act('2026-01-01', { distanceKm: 130 })], parseDay('2026-07-01'));
    expect(idle.projected).toBeLessThan(yearProjection([act('2026-01-01', { distanceKm: 100 }), act('2026-06-25', { distanceKm: 30 })], parseDay('2026-07-01')).projected);
  });

  it('1er janvier et fin d’année', () => {
    expect(yearProjection([], parseDay('2026-01-01'))).toEqual({ projected: 0, done: 0, daysLeft: 364 });
    expect(yearProjection([], parseDay('2026-12-31')).daysLeft).toBe(0);
  });
});

describe('forme, fatigue, fraîcheur', () => {
  it('vide : aucune courbe', () => {
    expect(pmc([], parseDay('2026-01-10'))).toEqual([]);
  });

  it('un jour par jour du premier jour à aujourd’hui, charges cumulées par jour', () => {
    const acts = [act('2026-01-01', { trainingLoad: 100 }), act('2026-01-01', { id: 'b', trainingLoad: 50 }), act('2026-01-03', { trainingLoad: null })];
    const days = pmc(acts, parseDay('2026-01-05'));
    expect(days).toHaveLength(5);
    expect(days[0].load).toBe(150);
    // fraîcheur du jour = forme − fatigue de la veille : nulle le premier jour
    expect(days[0].tsb).toBe(0);
    expect(days[1].tsb).toBeLessThan(0);
    expect(days[0].atl).toBeGreaterThan(days[0].ctl);
  });

  it('la fatigue retombe plus vite que la forme', () => {
    const days = pmc([act('2026-01-01', { trainingLoad: 200 })], parseDay('2026-02-28'));
    const last = days.at(-1)!;
    expect(last.atl).toBeLessThan(last.ctl);
    expect(last.tsb).toBeGreaterThan(0);
  });

  it('lecture de la fraîcheur : seuils', () => {
    expect(freshnessState(20).label).toBe('Désentraînement');
    expect(freshnessState(15).label).toBe('Frais');
    expect(freshnessState(6).label).toBe('Frais');
    expect(freshnessState(5).label).toBe('Neutre');
    expect(freshnessState(-9).label).toBe('Neutre');
    expect(freshnessState(-10).label).toBe('Productif');
    expect(freshnessState(-29).label).toBe('Productif');
    expect(freshnessState(-30).label).toBe('Surcharge');
    expect(freshnessState(-60).tone).toBe('critical');
  });
});

describe('jalons', () => {
  it('rien sans sortie', () => {
    expect(milestones([])).toEqual([]);
  });

  it('première sortie, premières distances, trail, kilométrage', () => {
    const acts = [
      act('2026-01-01', { distanceKm: 5 }),
      act('2026-01-10', { distanceKm: 10 }),
      act('2026-02-01', { distanceKm: 22, kind: 'trail', elevGain: 9000 }),
      act('2026-02-20', { distanceKm: 70 }),
    ];
    const m = milestones(acts);
    const labels = m.map((x) => x.label);
    expect(labels).toContain('Première sortie enregistrée');
    expect(labels).toContain('Premier 10 km');
    expect(labels).toContain('Premier semi-marathon (distance)');
    expect(labels).toContain('Premier trail');
    expect(labels).toContain('Premier marathon (distance)');
    expect(labels).toContain('100 km au compteur');
    expect(labels).toContain('Un Everest de D+ cumulé');
    // du plus récent au plus ancien
    const dates = m.map((x) => x.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(m.find((x) => x.label === 'Premier 10 km')!.date).toBe('2026-01-10');
  });

  it('premier mois à 100 km une seule fois, et à 200 km', () => {
    const acts = [act('2026-01-05', { distanceKm: 60 }), act('2026-01-20', { distanceKm: 60 }), act('2026-02-10', { distanceKm: 90 }), act('2026-02-20', { distanceKm: 120 })];
    const labels = milestones(acts).map((x) => x.label);
    expect(labels.filter((l) => l === 'Premier mois à 100 km')).toHaveLength(1);
    expect(labels.filter((l) => l === 'Premier mois à 200 km')).toHaveLength(1);
  });

  it('un seul passage franchit plusieurs paliers d’Everest', () => {
    const labels = milestones([act('2026-01-05', { elevGain: 20000 })]).map((x) => x.label);
    expect(labels).toContain('Un Everest de D+ cumulé');
    expect(labels).toContain('2 Everest de D+ cumulés');
  });
});
