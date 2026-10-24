// Analyse FIT et tracés dans l'environnement de test du navigateur (bundle esbuild : fit-file-parser avec le
// polyfill `buffer`, gunzip par DecompressionStream). Les résultats doivent être ceux du pipeline Node.
import { expected, gpxExport, sortieFit, tcxExport } from '../testing/fixtures.ts';
import { analyse, bestDistance, bestTime, encodePolyline, firstPoint, minetti } from './analyse.ts';
import { gunzip, isFitFile, parseFit } from './parse-fit.ts';
import { parseGpx, parseStreams, parseTcx, parseTrack } from './track.ts';

const athlete = { hrMax: 190, hrRest: 50, lt1Hr: 150, lt2Hr: 170 };

describe('analyse FIT', () => {
  it('lit le FIT fictif et produit le même résumé que build-fit.mjs', async () => {
    expect(isFitFile(sortieFit)).toBe(true);
    const data = await parseFit(sortieFit);
    expect(data.records?.length).toBe(2701);
    expect(data.records?.[10].timer_time).toBe(10);
    expect(data.laps?.length).toBe(3);
    expect(analyse(data, athlete)).toEqual(expected.sortie);
  });

  it('résumé cohérent : distance, côte, découplage, tours, caps', () => {
    const r = expected.sortie;
    expect(r.distance).toBe(8400);
    expect(r.duration).toBe(2700);
    // Côte de 60 m : allure ajustée plus rapide que l'allure réelle dans la montée
    expect(r.climb!['1200']).toBeGreaterThan(50);
    expect(r.gapDistance).toBeGreaterThan(r.distance);
    expect(r.lapCount).toBe(3);
    expect(r.splits.length).toBe(8);
    expect(r.km.reduce((s, k) => s + k[0], 0)).toBeCloseTo(8400, -1);
    expect(r.headings!.reduce((s, h) => s + h[1], 0)).toBeGreaterThan(8000);
  });

  it('refuse un fichier qui n’est pas un FIT', async () => {
    expect(isFitFile(new TextEncoder().encode('pas un fichier FIT, vraiment pas'))).toBe(false);
    await expect(parseFit(new Uint8Array(20))).rejects.toBeTruthy();
  });
});

describe('fonctions de base', () => {
  const time = Array.from({ length: 601 }, (_, i) => i);
  const dist = time.map((t) => t * 3 + (t > 300 ? (t - 300) : 0));

  it('meilleur temps et meilleure distance sur fenêtre glissante', () => {
    expect(bestTime(dist, time, 400)).toBe(100);
    expect(bestTime(dist, time, 1e6)).toBeNull();
    expect(bestDistance(dist, time, 60)).toBe(240);
  });

  it('Minetti : coût minimal en légère descente, symétrie rompue', () => {
    expect(minetti(0)).toBeCloseTo(3.6);
    expect(minetti(-0.1)).toBeLessThan(minetti(0));
    expect(minetti(0.1)).toBeGreaterThan(minetti(0));
    expect(minetti(1)).toBe(minetti(0.45));
  });

  it('polyline : aller-retour du premier point', () => {
    const poly = encodePolyline([[45.01234, 5.00012], [45.02, 5.01]]);
    expect(firstPoint(poly)).toEqual([45.01234, 5.00012]);
    expect(firstPoint('')).toBeNull();
  });
});

describe('tracés sans FIT', () => {
  it('GPX compressé de l’archive Strava', async () => {
    const data = parseGpx(new TextDecoder().decode(await gunzip(gpxExport)));
    expect(data.records!.length).toBeGreaterThan(100);
    const r = analyse(data, athlete)!;
    expect(r.distance).toBeGreaterThan(1500);
    expect(r.route).toBeTruthy();
  });

  it('TCX avec tours', () => {
    const data = parseTcx(tcxExport);
    expect(data.laps!.length).toBeGreaterThan(0);
    expect(analyse(data, athlete)!.distance).toBeGreaterThan(900);
  });

  it('streams de l’API : pause sans avancer le chrono', () => {
    const n = 60;
    const data = parseStreams({
      start: 1_700_000_000,
      time: { data: Array.from({ length: n }, (_, i) => (i < 30 ? i : i + 120)) },
      distance: { data: Array.from({ length: n }, (_, i) => i * 3) },
      moving: { data: Array.from({ length: n }, () => true) },
    });
    expect(data.records!.at(-1)!.timer_time).toBe(n - 2);
    expect(() => parseTrack('kml', '')).toThrow(/inconnu/);
  });
});
