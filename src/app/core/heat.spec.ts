import { HEAT_STEPS, LatLon, heatLevel, heatOf, heatPreview } from './heat';

/** Tracé rectiligne vers l'est, un point tous les ~8 m */
const line = (lat: number, lon: number, n: number): LatLon[] => Array.from({ length: n }, (_, i) => [lat, lon + i * 0.0001]);

describe('carte thermique', () => {
  it('donne un niveau par palier doublé', () => {
    expect(heatLevel(1)).toBe(0);
    expect(heatLevel(HEAT_STEPS[0])).toBe(1);
    expect(heatLevel(3)).toBe(1);
    expect(heatLevel(8)).toBe(3);
    expect(heatLevel(40)).toBe(4);
  });

  it('fait ressortir le tronçon emprunté par plusieurs sorties', () => {
    const habituel = line(43.6, 1.4, 50);
    const tracks = [...Array.from({ length: 9 }, () => habituel), line(43.7, 1.5, 50)];
    const heat = heatOf(tracks);
    expect(heat.max).toBe(9);
    const levels = new Set(heat.lines.map((l) => l.level));
    expect(levels).toEqual(new Set([0, 3]));
    // Les niveaux forts sont dessinés en dernier
    expect(heat.lines.at(-1)!.level).toBe(3);
  });

  it('compte une sortie une seule fois par cellule, même si elle y repasse', () => {
    const allerRetour = [...line(43.6, 1.4, 20), ...line(43.6, 1.4, 20).reverse()];
    expect(heatOf([allerRetour]).max).toBe(1);
  });

  it('cadre la zone habituelle sans la sortie lointaine', () => {
    const tracks = [...Array.from({ length: 5 }, () => line(43.6, 1.4, 50)), line(45.8, 6.9, 50)];
    const [[lat0], [lat1]] = heatOf(tracks).bounds!;
    expect(lat0).toBeCloseTo(43.6, 3);
    expect(lat1).toBeCloseTo(43.6, 3);
  });

  it('produit un aperçu SVG par niveau', () => {
    const preview = heatPreview(heatOf([line(43.6, 1.4, 30), line(43.6, 1.4, 30)]), 240, 100);
    expect(preview.map((p) => p.level)).toEqual([1]);
    expect(preview[0].d.startsWith('M')).toBe(true);
  });

  it('reste vide sans tracé', () => {
    const heat = heatOf([]);
    expect(heat.lines).toEqual([]);
    expect(heat.bounds).toBeNull();
    expect(heatPreview(heat, 240, 100)).toEqual([]);
  });
});
