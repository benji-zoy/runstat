import { Activity } from './models';
import { BADGES, LEVELS, levelFor } from './badges';

const act = (date: string, extra: Partial<Activity> = {}): Activity =>
  ({ id: date + (extra.id ?? ''), date, name: 'Sortie', kind: 'road', distanceKm: 10, durationSec: 3600, start: null, lat: null, lon: null, ...extra }) as unknown as Activity;
/** Départ à l'heure locale `h` du jour `date` */
const at = (date: string, h: number, extra: Partial<Activity> = {}) => act(date, { start: new Date(`${date}T${String(h).padStart(2, '0')}:00:00`).getTime() / 1000, ...extra });
const badge = (id: string) => BADGES.find((b) => b.id === id)!;
const iso = (from: string, i: number, step = 1) => new Date(Date.parse(`${from}T12:00:00Z`) + i * step * 86_400_000).toISOString().slice(0, 10);
const days = (from: string, n: number, extra: Partial<Activity> = {}) => Array.from({ length: n }, (_, i) => act(iso(from, i), { ...extra, id: `d${i}` }));

describe('niveaux', () => {
  it('franchit un niveau pile au seuil', () => {
    expect(levelFor(0).level.name).toBe('Jaune');
    expect(levelFor(49.9).level.name).toBe('Jaune');
    expect(levelFor(50).level.name).toBe('Orange');
    expect(levelFor(250).level.name).toBe('Vert');
  });

  it('progression vers le niveau suivant', () => {
    const r = levelFor(150);
    expect(r.next?.name).toBe('Vert');
    expect(r.progress).toBeCloseTo(0.5);
  });

  it('dernier niveau : pas de suivant, progression pleine', () => {
    const r = levelFor(40000);
    expect(r.level).toBe(LEVELS.at(-1));
    expect(r.next).toBeNull();
    expect(r.progress).toBe(1);
  });
});

describe('catalogue', () => {
  it('identifiants uniques, et aucun badge obtenu sans sortie', () => {
    expect(new Set(BADGES.map((b) => b.id)).size).toBe(BADGES.length);
    for (const b of BADGES) {
      const r = b.eval([]);
      expect(r.earned, b.id).toBeNull();
      expect(r.progress, b.id).toBe(0);
    }
  });

  it('un historique réaliste ne produit que des avancements entre 0 et 1', () => {
    const acts = [...days('2026-01-01', 40, { distanceKm: 12, durationSec: 4000, elevGain: 100 }), at('2026-03-01', 6, { distanceKm: 25 })];
    for (const b of BADGES) {
      const r = b.eval(acts);
      expect(r.progress, b.id).toBeGreaterThanOrEqual(0);
      expect(r.progress, b.id).toBeLessThanOrEqual(1);
      if (r.earned) expect(r.earned, b.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('distance d’une sortie', () => {
  it('obtenu à la première sortie assez longue, compté à chaque fois', () => {
    const acts = [act('2026-01-01', { distanceKm: 4 }), act('2026-01-05', { distanceKm: 5 }), act('2026-01-09', { distanceKm: 6 })];
    expect(badge('d5').eval(acts)).toMatchObject({ earned: '2026-01-05', times: 2, progress: 1 });
  });

  it('pas obtenu : meilleure sortie en avancement', () => {
    const r = badge('d10').eval([act('2026-01-01', { distanceKm: 4 }), act('2026-01-02', { distanceKm: 7.5 })]);
    expect(r.earned).toBeNull();
    expect(r.progress).toBeCloseTo(0.75);
    expect(r.hint).toContain('/ 10 km');
  });

  it('la borne est incluse', () => {
    expect(badge('d50').eval([act('2026-02-02', { distanceKm: 50 })]).earned).toBe('2026-02-02');
  });
});

describe('cumuls', () => {
  it('date du badge = sortie qui franchit le seuil', () => {
    const acts = [act('2026-01-01', { distanceKm: 300 }), act('2026-01-02', { distanceKm: 150 }), act('2026-01-03', { distanceKm: 100 })];
    expect(badge('c500').eval(acts)).toMatchObject({ earned: '2026-01-03', progress: 1 });
  });

  it('avancement et texte avant le seuil', () => {
    const r = badge('c500').eval([act('2026-01-01', { distanceKm: 250 })]);
    expect(r.earned).toBeNull();
    expect(r.progress).toBe(0.5);
    expect(r.hint).toMatch(/^250 km \/ 500 km$/);
  });

  it('dénivelé nul ou absent compté pour zéro', () => {
    expect(badge('eev').eval([act('2026-01-01', { elevGain: null }), act('2026-01-02')]).progress).toBe(0);
  });
});

describe('volume par semaine et par mois', () => {
  it('somme sur la semaine (lundi → dimanche)', () => {
    // 2026-01-05 est un lundi
    const acts = [act('2026-01-05', { distanceKm: 20 }), act('2026-01-11', { distanceKm: 12 })];
    expect(badge('w30').eval(acts)).toMatchObject({ earned: '2026-01-11', times: 1 });
    // même total mais à cheval sur deux semaines : pas de badge
    const split = [act('2026-01-04', { distanceKm: 20 }), act('2026-01-05', { distanceKm: 12 })];
    expect(badge('w30').eval(split).earned).toBeNull();
  });

  it('mois à 100 : compte les mois atteints', () => {
    const acts = [act('2026-01-10', { distanceKm: 60 }), act('2026-01-20', { distanceKm: 45 }), act('2026-02-10', { distanceKm: 100 })];
    expect(badge('m100').eval(acts)).toMatchObject({ earned: '2026-01-20', times: 2 });
  });
});

describe('régularité', () => {
  it('série de jours consécutifs', () => {
    expect(badge('s5').eval(days('2026-03-01', 5))).toMatchObject({ earned: '2026-03-05', progress: 1 });
    const r = badge('s5').eval(days('2026-03-01', 4));
    expect(r.earned).toBeNull();
    expect(r.hint).toBe('Record : 4 / 5 jours');
  });

  it('un trou casse la série, deux sorties le même jour comptent une fois', () => {
    const acts = [...days('2026-03-01', 3), ...days('2026-03-05', 3), act('2026-03-06', { id: 'bis' })];
    const r = badge('s5').eval(acts);
    expect(r.earned).toBeNull();
    expect(r.hint).toBe('Record : 3 / 5 jours');
  });

  it('série de semaines, passage de fin d’année', () => {
    // un lundi par semaine à partir du 15 déc. 2025
    const weeks = Array.from({ length: 12 }, (_, i) => act(iso('2025-12-15', i, 7), { id: `w${i}` }));
    expect(badge('ws12').eval(weeks)).toMatchObject({ progress: 1 });
    expect(badge('ws12').eval(weeks.slice(0, 11)).earned).toBeNull();
  });

  it('escalier : distance mensuelle en hausse 4 mois de suite', () => {
    const up = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'].map((m, i) => act(`${m}-15`, { distanceKm: 50 + 10 * i, id: m }));
    expect(badge('stairs').eval(up)).toMatchObject({ earned: '2026-05-15', progress: 1 });
    // un mois sans sortie interrompt la série
    expect(badge('stairs').eval(up.filter((a) => a.date !== '2026-03-15')).earned).toBeNull();
    // un mois en baisse aussi
    const down = up.map((a) => (a.date === '2026-03-15' ? { ...a, distanceKm: 1 } : a));
    expect(badge('stairs').eval(down).earned).toBeNull();
  });
});

describe('moments', () => {
  it('lève-tôt : heure locale de départ, sorties sans heure ignorées', () => {
    const nine = Array.from({ length: 9 }, (_, i) => at(`2026-02-${String(i + 1).padStart(2, '0')}`, 6, { id: String(i) }));
    const acts = [...nine, act('2026-02-10')];
    expect(badge('early').eval(acts)).toMatchObject({ earned: null, hint: '9 / 10 sorties' });
    expect(badge('early').eval([...acts, at('2026-02-11', 5)])).toMatchObject({ earned: '2026-02-11', times: 1 });
    // 7 h pile n'est plus « avant 7 h »
    expect(badge('early').eval([at('2026-02-12', 7)]).progress).toBe(0);
  });

  it('double ration : deux sorties le même jour', () => {
    expect(badge('double').eval([act('2026-01-01'), act('2026-01-02')]).earned).toBeNull();
    expect(badge('double').eval([act('2026-01-01'), act('2026-01-02'), act('2026-01-02', { id: 'b' })]).earned).toBe('2026-01-02');
  });

  it('jours symboliques, comptés par année', () => {
    const acts = [act('2025-01-01'), act('2026-01-01'), act('2026-01-02')];
    expect(badge('ny').eval(acts)).toMatchObject({ earned: '2025-01-01', times: 2 });
    expect(badge('xmas').eval(acts)).toMatchObject({ earned: null, progress: 0 });
  });
});

describe('vitesse et exploration', () => {
  it('sub 4 : meilleur km en moins de 4:00 seulement', () => {
    expect(badge('km4').eval([act('2026-01-01', { bestKmSec: 240 })]).earned).toBe('2026-01-01');
    const r = badge('km4').eval([act('2026-01-01', { bestKmSec: 250 })]);
    expect(r.earned).toBeNull();
    expect(r.progress).toBeCloseTo(240 / 250);
    expect(badge('km4').eval([act('2026-01-01', { bestKmSec: null })]).progress).toBe(0);
  });

  it('10 km sub 5 : seulement à partir de 10 km', () => {
    expect(badge('p10').eval([act('2026-01-01', { distanceKm: 9, durationSec: 9 * 280 })]).earned).toBeNull();
    expect(badge('p10').eval([act('2026-01-02', { distanceKm: 10, durationSec: 10 * 290 })]).earned).toBe('2026-01-02');
  });

  it('explorateur : 10 lieux à plus de 1 km les uns des autres', () => {
    const place = (i: number) => act(`2026-01-${String(i + 1).padStart(2, '0')}`, { lat: 45 + i * 0.1, lon: 3 });
    const nine = Array.from({ length: 9 }, (_, i) => place(i));
    expect(badge('places10').eval(nine)).toMatchObject({ earned: null, hint: '9 / 10 lieux' });
    // deux départs proches ne font qu'un lieu
    expect(badge('places10').eval([...nine, act('2026-01-20', { lat: 45.0001, lon: 3 })]).earned).toBeNull();
    expect(badge('places10').eval([...nine, place(9)]).earned).toBe('2026-01-10');
  });

  it('Eddington 30 : jours cumulés à 30 km', () => {
    const acts = Array.from({ length: 29 }, (_, i) => act(`2026-01-${String(i + 1).padStart(2, '0')}`, { distanceKm: 31 }));
    expect(badge('edd30').eval(acts)).toMatchObject({ earned: null, hint: '29 / 30 jours à 30 km' });
    expect(badge('edd30').eval([...acts, act('2026-02-01', { distanceKm: 30 })])).toMatchObject({ earned: '2026-02-01', progress: 1 });
  });

  it('traileur : 10 sorties trail', () => {
    expect(badge('trail10').eval(days('2026-01-01', 10, { kind: 'trail' })).earned).toBe('2026-01-10');
    expect(badge('trail10').eval(days('2026-01-01', 10)).earned).toBeNull();
  });
});
