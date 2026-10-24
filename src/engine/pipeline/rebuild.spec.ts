// Mode local-first : reconstruction complète sur l'appareil (IndexedDB, comme dans le Web Worker de l'appli), météo par un
// fetch bouchonné, et import de l'archive Strava dans le navigateur (lecteur zip du moteur).
import { IDBFactory } from 'fake-indexeddb';
import exportZip from '../../../scripts/sync/fixtures/strava/export.zip';
import { importStravaArchive } from '../archive/strava-archive.ts';
import { ZipError, type ByteSource } from '../archive/zip.ts';
import { indexedDbStorage } from '../storage/indexeddb.ts';
import { memoryStorage } from '../storage/memory.ts';
import type { FileData, Storage } from '../storage/types.ts';
import { expected, stravaRaw } from '../testing/fixtures.ts';
import { LOCAL_STATE, rebuild } from './rebuild.ts';

const now = new Date('2026-03-11T06:00:00Z');
const withoutDate = ({ generatedAt, ...rest }: { generatedAt: string }) => rest;
const bytesSource = (b: Uint8Array): ByteSource => ({ size: b.length, read: async (p, l) => b.slice(p, p + l) });

async function load(storage: Storage, files: Record<string, FileData>) {
  for (const [path, data] of Object.entries(files)) await storage.raw.write(path, data);
  return storage;
}

/** Réponses Open-Meteo minimales : 24 heures par jour demandé */
function openMeteo(calls: string[]) {
  return (async (url: string) => {
    calls.push(String(url));
    const u = new URL(String(url));
    if (u.pathname.endsWith('/elevation')) {
      const n = u.searchParams.get('latitude')!.split(',').length;
      return new Response(JSON.stringify({ elevation: Array(n).fill(212) }));
    }
    const day = u.searchParams.get('start_date') ?? '2026-03-01';
    const time = Array.from({ length: 24 }, (_, h) => `${day}T${String(h).padStart(2, '0')}:00`);
    const v = Array(24).fill(10);
    return new Response(JSON.stringify({ hourly: { time, temperature_2m: v, dew_point_2m: v, relative_humidity_2m: v, wind_speed_10m: v, wind_direction_10m: v } }));
  }) as typeof fetch;
}

describe('reconstruction sur l’appareil', () => {
  it('IndexedDB : même snapshot que le pipeline du NAS, état local écrit', async () => {
    const storage = await load(await indexedDbStorage('runstat-local', new IDBFactory()), stravaRaw());
    const { summary, state } = await rebuild(storage, { weather: false, now });
    const coros = JSON.parse((await storage.snapshot.readText('coros.json'))!);
    expect(withoutDate(coros)).toEqual(expected.strava);
    expect(summary).toContain('activités');
    expect(state.athleteFit).toBe(JSON.stringify([190, 50, null, null]));
    expect(JSON.parse((await storage.raw.readText(LOCAL_STATE))!).lastBuild).toBe(now.toISOString());
  });

  it('FC max modifiée : analyses FIT recalculées', async () => {
    const storage = await load(memoryStorage(), stravaRaw());
    const lines: string[] = [];
    await rebuild(storage, { weather: false, now, log: (l) => lines.push(l) });
    await rebuild(storage, { weather: false, now, log: (l) => lines.push(l) });
    expect(lines.filter((l) => l.startsWith('FIT')).at(-1)).toContain('0 analysés');
    const athlete = JSON.parse((await storage.raw.readText('athlete.json'))!);
    await storage.raw.write('athlete.json', JSON.stringify({ ...athlete, hrMax: athlete.hrMax + 2 }));
    await rebuild(storage, { weather: false, now, log: (l) => lines.push(l) });
    expect(lines.filter((l) => l.startsWith('FIT')).at(-1)).toContain('3 analysés');
  });

  it('météo depuis le navigateur ; hors ligne, le snapshot reste construit', async () => {
    const storage = await load(memoryStorage(), stravaRaw());
    const calls: string[] = [];
    await rebuild(storage, { now, fetch: openMeteo(calls) });
    expect(calls.some((c) => c.includes('archive-api.open-meteo.com'))).toBe(true);
    expect(await storage.raw.readText('weather/elevation.json')).toContain('212');

    const offline = await load(memoryStorage(), stravaRaw());
    const { state } = await rebuild(offline, { now, fetch: (async () => Promise.reject(new TypeError('hors ligne'))) as typeof fetch });
    expect(state.lastWeatherError).toContain('hors ligne');
    expect(await offline.snapshot.readText('coros.json')).toContain('"activities"');
  });
});

describe('archive Strava dans le navigateur', () => {
  it('sorties, FIT et tracés écrits dans le stockage local, entrée piégée ignorée, idempotent', async () => {
    const storage = memoryStorage();
    const progress: number[] = [];
    const r = await importStravaArchive(bytesSource(exportZip), storage.raw, { onProgress: (d) => progress.push(d) });
    expect(r).toEqual({ runs: 5, added: 5, files: 3, skipped: 1 });
    expect((await storage.raw.list('fit')).sort()).toEqual(['strava-1006.fit']);
    expect((await storage.raw.list('tracks')).sort()).toEqual(['strava-1001.gpx.gz', 'strava-1003.tcx.gz']);
    expect(await storage.raw.list('')).not.toContain('evil.gpx');
    expect(progress.at(-1)).toBe(5);
    const again = await importStravaArchive(bytesSource(exportZip), storage.raw);
    expect(again.added).toBe(0);
    await expect(importStravaArchive(bytesSource(new TextEncoder().encode('pas un zip')), storage.raw)).rejects.toBeInstanceOf(ZipError);
  });
});
