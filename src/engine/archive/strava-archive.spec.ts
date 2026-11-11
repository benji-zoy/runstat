// Import de l'archive Strava : bornes contre une archive piégée (entrée pointée par plusieurs lignes, budget total d'octets
// décompressés, répertoire central et données compressées d'une entrée lus en mémoire).
import { MemoryStore } from '../storage/memory.ts';
import { importStravaArchive } from './strava-archive.ts';
import { ZipError, blobSource, openZip } from './zip.ts';
import { zipStream, type ZipInput } from './zip-writer.ts';

const HEAD = 'Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename';
const row = (id: number, file: string) => `${id},"Jan ${(id % 27) + 1}, 2026, 7:30:12 AM",Footing,Run,600,2.00,${file}`;
const gpx = (n: number) => new TextEncoder().encode(`<?xml version="1.0"?><gpx>${'<trkpt lat="45.7" lon="4.8"/>'.repeat(n)}</gpx>`);

async function zipOf(entries: ZipInput[]): Promise<Blob> {
  const parts: Uint8Array[] = [];
  for await (const p of zipStream((async function* () {
    yield* entries;
  })()))
    parts.push(p);
  return new Blob(parts as Uint8Array<ArrayBuffer>[]);
}
const csvOf = (rows: string[]): ZipInput => ({ path: 'activities.csv', data: new TextEncoder().encode([HEAD, ...rows].join('\n')) });

describe('archive Strava : bornes', () => {
  it('une entrée du zip ne sert qu’une fois, même pointée par plusieurs lignes', async () => {
    const blob = await zipOf([csvOf([row(1, 'activities/1.gpx'), row(2, 'activities/1.gpx'), row(3, 'activities/1.gpx')]), { path: 'activities/1.gpx', data: gpx(10) }]);
    const raw = new MemoryStore();
    const warnings: string[] = [];
    const r = await importStravaArchive(blobSource(blob), raw, { warn: (m) => warnings.push(m) });
    expect(r).toEqual({ runs: 3, added: 3, files: 1, skipped: 2 });
    expect(await raw.read('tracks/strava-1.gpx.gz')).toBeTruthy();
    expect(await raw.read('tracks/strava-2.gpx.gz')).toBeNull();
  });

  it('budget total d’octets décompressés : archive refusée au-delà, avec un message clair', async () => {
    const entries = [1, 2, 3, 4].map((i) => ({ path: `activities/${i}.gpx`, data: gpx(2000) }));
    const blob = await zipOf([csvOf([1, 2, 3, 4].map((i) => row(i, `activities/${i}.gpx`))), ...entries]);
    const size = entries[0].data.length;
    const refused = importStravaArchive(blobSource(blob), new MemoryStore(), { maxImportBytes: 3 * size });
    await expect(refused).rejects.toBeInstanceOf(ZipError);
    await expect(refused).rejects.toThrow(/archive refusée : plus de .* Mio une fois décompressée/);
    // Juste assez : tout passe
    const r = await importStravaArchive(blobSource(blob), new MemoryStore(), { maxImportBytes: 5 * size });
    expect(r.files).toBe(4);
  });

  it('répertoire central et données compressées d’une entrée bornés avant toute lecture en mémoire', async () => {
    const blob = await zipOf([csvOf([row(1, 'activities/1.gpx')]), { path: 'activities/1.gpx', data: gpx(100) }]);
    await expect(openZip(blobSource(blob), { maxCentralDir: 50 })).rejects.toThrow(/répertoire central trop volumineux/);
    // Entrée stockée dont la taille déclarée ment : les données compressées dépassent la borne d'une entrée
    const zip = await openZip(blobSource(blob), { maxEntrySize: 10 });
    const entry = { ...zip.entries.find((e) => e.name === 'activities/1.gpx')!, size: 1 };
    await expect(zip.read(entry)).rejects.toThrow(/trop volumineux \(données compressées\)/);
  });
});
