import { Activity, Athlete, Goal } from './models';
import {
  courseSegments, courseWaypoints, elevationBetween, fitTimeline, gainLoss, nightCost, nightWindow, parseGpx, simulate, timeAt, typicalGrade,
} from './course';
import { personalTerrain, priorCost } from './terrain';
import { evaluateGoal, goalContext } from './goals';
import { classifyAll } from './science';

/** Tracé fictif : 10 km plein est, montée de 300 m sur les 3 premiers km, descente de 300 m du km 6 au km 9 */
function gpx(opts: { wpt?: boolean; ele?: boolean; kmScale?: number; eleScale?: number } = {}): string {
  const lat = 45, lon0 = 4;
  const sx = opts.kmScale ?? 1, sz = opts.eleScale ?? 1;
  const kmPerDeg = (Math.PI / 180) * 6371.0088 * Math.cos((lat * Math.PI) / 180);
  const pts: string[] = [];
  for (let i = 0; i <= 1000; i++) {
    const km = i / 100;
    const ele = 200 + sz * (km <= 3 ? 100 * km : km <= 6 ? 300 : km <= 9 ? 300 - 100 * (km - 6) : 0);
    pts.push(`<trkpt lon="${(lon0 + (sx * km) / kmPerDeg).toFixed(6)}" lat="${lat}">${opts.ele === false ? '' : `<ele>${ele}</ele>`}</trkpt>`);
  }
  const wpt = opts.wpt
    ? `<wpt lat="${lat}" lon="${(lon0 + (sx * 3) / kmPerDeg).toFixed(6)}"><name>Col &amp; ravito</name></wpt>`
      + `<wpt lat="${lat + 0.1}" lon="${lon0}"><name>Trop loin</name></wpt>`
      + `<wpt lat="${lat}" lon="${(lon0 + (sx * 6) / kmPerDeg).toFixed(6)}"><name><![CDATA[Ravito 2]]></name></wpt>`
    : '';
  return `<?xml version="1.0"?><gpx version="1.1" creator="test">${wpt}<trk><name>Test</name><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
}

describe('lecture du GPX', () => {
  it('donne la distance, le D+, le D− et un profil compact', () => {
    const p = parseGpx(gpx(), 'test.gpx');
    expect(p.distanceKm).toBeCloseTo(10, 1);
    expect(p.gain).toBeGreaterThan(280);
    expect(p.gain).toBeLessThan(310);
    expect(p.loss).toBeGreaterThan(280);
    expect(p.course.stepKm).toBe(0.05);
    expect(p.course.ele.length).toBeGreaterThan(195);
    expect(p.course.ele.length).toBeLessThan(205);
    expect(p.course.file).toBe('test.gpx');
    expect(p.start).toEqual({ lat: 45, lon: 4 });
    expect(Object.keys(p.course)).not.toContain('lat');
  });

  it('place les points de passage proches du tracé, dans l’ordre', () => {
    const { course } = parseGpx(gpx({ wpt: true }));
    expect(course.waypoints?.map((w) => w.name)).toEqual(['Col & ravito', 'Ravito 2']);
    expect(course.waypoints![0].km).toBeCloseTo(3, 1);
    expect(course.waypoints![1].km).toBeCloseTo(6, 1);
  });

  it('refuse un fichier sans tracé ou sans altitude', () => {
    expect(() => parseGpx('<html></html>')).toThrow(/GPX/);
    expect(() => parseGpx('<gpx></gpx>')).toThrow(/tracé/);
    expect(() => parseGpx(gpx({ ele: false }))).toThrow(/altitude/);
  });

  it('borne le nombre de points d’un long tracé', () => {
    const p = parseGpx(gpx({ kmScale: 30 }));
    expect(p.distanceKm).toBeGreaterThan(290);
    expect(p.course.ele.length).toBeLessThanOrEqual(1000);
  });
});

describe('tronçons', () => {
  it('ramène le profil à la distance et au dénivelé annoncés', () => {
    const { course } = parseGpx(gpx({ wpt: true }));
    const g = { distanceKm: 10.5, elevGain: 330, elevLoss: 330, kind: 'trail' as const, course };
    const segs = courseSegments(g);
    expect(segs.at(-1)!.to).toBeCloseTo(10.5, 6);
    const { gain, loss } = elevationBetween(segs, 0, 10.5);
    expect(gain).toBeCloseTo(330, 0);
    expect(loss).toBeCloseTo(330, 0);
    expect(courseWaypoints(g)[1].km).toBeCloseTo(6 * 1.05, 1);
  });

  it('répartit le dénivelé d’un parcours sans GPX', () => {
    const segs = courseSegments({ distanceKm: 80, elevGain: 2200, elevLoss: 2500, kind: 'trail' });
    const { gain, loss } = elevationBetween(segs, 0, 80);
    expect(gain).toBeCloseTo(2200, 3);
    expect(loss).toBeCloseTo(2500, 3);
    expect(typicalGrade(80, 2200, 2200, 'trail')).toBeCloseTo(0.0888, 3);
    expect(gainLoss([0, 1, 0, 5, 4, 10])).toEqual({ gain: 10, loss: 0 });
  });
});

describe('simulation', () => {
  const segs = courseSegments({ distanceKm: 20, elevGain: 600, kind: 'trail' });

  it('cale la durée totale et ralentit avec l’usure', () => {
    const tl = fitTimeline(segs, 3 * 3600, { cost: priorCost, fadePerHour: 0.03, fadeFromH: 0 });
    expect(tl.total).toBe(3 * 3600);
    expect(tl.t.at(-1)).toBeCloseTo(3 * 3600, 3);
    expect(timeAt(tl, 20) - timeAt(tl, 10)).toBeGreaterThan(timeAt(tl, 10));
    expect(simulate(segs, { cost: priorCost, speed: tl.speed, fadePerHour: 0.03 }).total).toBeCloseTo(3 * 3600, -2);
  });

  it('ajoute la nuit et les arrêts', () => {
    const base = simulate(segs, { cost: priorCost, speed: 2.5 }).total;
    const night = simulate(segs, { cost: priorCost, speed: 2.5, startMin: 0, night: { dusk: 17 * 60, dawn: 7 * 60 } }).total;
    expect(night / base).toBeGreaterThan(1.03);
    expect(night / base).toBeLessThan(1.1);
    expect(simulate(segs, { cost: priorCost, speed: 2.5, stops: [{ km: 10, sec: 300 }] }).total).toBeCloseTo(base + 300, 6);
    expect(nightCost(-0.12, 180)).toBeCloseTo(1.1, 6);
    expect(nightCost(0, 23 * 60)).toBeCloseTo(1.03, 6);
  });

  it('situe la nuit fin novembre à Lyon', () => {
    const w = nightWindow('2026-11-29', 45.75, 4.85);
    // Crépuscule civil vers 17 h 25, aube vers 7 h 30 (heure d'hiver)
    expect(w.dusk).toBeGreaterThan(17 * 60);
    expect(w.dusk).toBeLessThan(17 * 60 + 50);
    expect(w.dawn).toBeGreaterThan(7 * 60);
    expect(w.dawn).toBeLessThan(7 * 60 + 50);
    // Heure d'été : tout est décalé d'une heure
    const june = nightWindow('2026-06-21', 45.75, 4.85);
    expect(june.dusk).toBeGreaterThan(22 * 60);
    expect(june.dawn).toBeLessThan(5 * 60 + 30);
  });
});

const ath: Athlete = { hrMax: 195, hrRest: 50, sex: 'M', weightKg: 70, heightCm: 175, birthday: '1990-01-01' };

function run(date: string, distanceKm: number, durationSec: number, extra: Partial<Activity> = {}): Activity {
  return {
    id: date + distanceKm, sportType: 100, kind: 'road', date, name: '', start: null, durationSec, distanceKm,
    avgHr: null, calories: null, lat: null, lon: null, ...extra,
  };
}

describe('courbe de pente personnelle', () => {
  it('reprend la courbe commune sans données, et tes descentes lentes quand tu en as', () => {
    const today = new Date(2026, 9, 1);
    expect(personalTerrain([], today, ath, true).cost(-0.1)).toBeCloseTo(priorCost(-0.1), 9);
    // Tranches : [s, m, m ajustés, D+, D−, s avec FC, FC × s] ; plat à 3 m/s, descente à −10 % à 2,5 m/s, même FC
    const bins = [
      [0, 0, 0, 0, 0, 0, 0], [36000, 90000, 0, 0, 9000, 36000, 36000 * 150], [0, 0, 0, 0, 0, 0, 0],
      [36000, 108000, 0, 0, 0, 36000, 36000 * 150], [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0],
    ];
    const acts = [run('2026-09-01', 198, 72000, { kind: 'trail', fit: { terrain: bins } as Activity['fit'] })];
    const t = personalTerrain(acts, today, ath, true);
    // 3 / 2,5 = 1,2 mesuré sur 10 h : très proche de la mesure, loin de la courbe commune (≈ 0,91)
    expect(t.cost(-0.1)).toBeGreaterThan(1.15);
    expect(t.cost(0)).toBeCloseTo(1, 2);
  });
});

describe('ultra avec tracé', () => {
  it('donne les temps de passage aux points du GPX et chiffre la nuit', () => {
    const acts: Activity[] = [];
    const km = Array.from({ length: 20 }, () => [1000, 360, 157, 2, 2, 360, 0, 170]);
    for (let i = 0; i < 40; i++) {
      const d = new Date(2026, 7, 1 + i * 2);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      acts.push(i % 4 === 3
        ? run(iso, 25, 4 * 3600, { kind: 'trail', elevGain: 1200, name: 'Trail des Bois', trainingLoad: 200 })
        : run(iso, 20, 7200, { km: km as Activity['km'], avgHr: 157, trainingLoad: 100 }));
    }
    const { course } = parseGpx(gpx({ wpt: true, kmScale: 8, eleScale: 7 }));
    const goal: Goal = {
      id: 'u', name: 'Ultra', date: '2026-11-29', startTime: '00:00', distanceKm: 80, elevGain: 2200, elevLoss: 2200,
      kind: 'trail', targetSec: 11 * 3600, course,
    };
    const today = new Date(2026, 9, 20);
    const e = evaluateGoal(goal, goalContext(goal, acts, classifyAll(acts, ath), ath, today, {}, null), today, acts)!;
    expect(e.category).toBe('ultra');
    expect(e.course.gpx).toBe(true);
    expect(e.adjustments.find((a) => a.label === 'Nuit')!.pct).toBeGreaterThan(2);
    expect(e.uncertainty.day).toBe(0.08);
    expect(e.plan.fromGpx).toBe(true);
    expect(e.plan.startMin).toBe(0);
    expect(e.plan.checkpoints.map((c) => c.name)).toEqual(['Col & ravito', 'Ravito 2', null]);
    expect(e.plan.checkpoints.at(-1)!.realistic).toBeCloseTo(e.predicted, 0);
    expect(e.plan.checkpoints.at(-1)!.target).toBeCloseTo(11 * 3600, 0);
    expect(e.plan.segments.map((s) => s.label)).toEqual(['Départ → Col & ravito', 'Col & ravito → Ravito 2', 'Ravito 2 → Arrivée']);
    // La montée du départ (2 100 m sur 24 km) se paie
    const [climb, flat] = e.plan.segments;
    expect(climb.gain).toBeGreaterThan(1500);
    expect(climb.realistic).toBeGreaterThan(flat.realistic);
  });
});
