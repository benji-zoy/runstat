// Reconstruction complète du snapshot dans l'environnement de test du navigateur, depuis des données brutes
// fictives : le résultat doit être celui de l'ancien pipeline Node (build-fit.mjs + build-data.mjs), octet pour
// octet hors generatedAt. Même chose avec le stockage IndexedDB (fake-indexeddb).
import { IDBFactory } from 'fake-indexeddb';
import { buildFit } from '../pipeline/build-fit.ts';
import { indexedDbStorage } from '../storage/indexeddb.ts';
import { memoryStorage } from '../storage/memory.ts';
import type { FileData, Storage } from '../storage/types.ts';
import { corosRaw, expected, stravaRaw } from '../testing/fixtures.ts';
import { buildSnapshot, snapshotSummary, writeSnapshot } from './build.ts';

const now = new Date('2026-03-11T06:00:00Z');

async function load(storage: Storage, files: Record<string, FileData>) {
  for (const [path, data] of Object.entries(files)) await storage.raw.write(path, data);
  return storage;
}

/** Pipeline complet (build-fit puis build-data), comme `npm run data` */
async function rebuild(storage: Storage) {
  const fit = await buildFit(storage.raw);
  const result = await buildSnapshot(storage.raw, { now });
  await writeSnapshot(storage, result);
  const read = async (path: string) => JSON.parse((await storage.snapshot.readText(path))!);
  return { fit, result, coros: await read('coros.json'), routes: await read('routes.json') };
}

const withoutDate = ({ generatedAt, ...rest }: { generatedAt: string }) => rest;

describe('snapshot COROS + Google Health', () => {
  it('identique à la sortie du pipeline Node', async () => {
    const storage = await load(memoryStorage(), corosRaw());
    const { fit, result, coros, routes } = await rebuild(storage);
    expect(fit).toMatchObject({ done: 1, skipped: 0, failed: 0, total: 1 });
    expect(coros.generatedAt).toBe(now.toISOString());
    expect(withoutDate(coros)).toEqual(expected.coros);
    expect(JSON.stringify(withoutDate(result.snapshot))).toBe(JSON.stringify(expected.coros));
    expect(routes).toEqual(expected.routes);
    expect(await storage.raw.readText('missing-details.txt')).toBe(expected.missing);
    expect(result.warnings).toEqual([
      'Ligne ignorée dans part-00.jsonl: pas du json',
      'Classement sans sortie correspondante : date-2025-01-01-10.json',
    ]);
    expect(snapshotSummary(result)).toContain('6 activités COROS, 77.0 km, 5 enrichies, 1 sans détail');
  });

  it('cache des analyses : un second passage ne relit pas le FIT, sauf avec force', async () => {
    const storage = await load(memoryStorage(), corosRaw());
    await buildFit(storage.raw);
    expect(await buildFit(storage.raw)).toMatchObject({ done: 0, skipped: 1 });
    expect(await buildFit(storage.raw, { force: true })).toMatchObject({ done: 1, skipped: 0 });
  });

  it('enrichissements attendus', async () => {
    const { result } = await rebuild(await load(memoryStorage(), corosRaw()));
    const byId = Object.fromEntries(result.snapshot.activities.map((a) => [a.id, a]));
    expect(byId['100003'].fit?.trimp).toBe(expected.sortie.trimp);
    expect(byId['100002'].result?.['category']).toBe('SEM');
    expect(byId['100002'].splits).toEqual([300, 298, 299, 301, 300]);
    expect(byId['100004'].km?.length).toBe(3);
    expect(byId['100006'].weather).toBeUndefined();
    expect(result.snapshot.goals[0].forecast?.temp).toBeGreaterThan(0);
    expect(result.snapshot.health?.syncedAt).toBe('2026-03-11T05:00:00Z');
  });
});

describe('snapshot Strava + santé COROS', () => {
  it('identique à la sortie du pipeline Node', async () => {
    const { fit, result, coros, routes } = await rebuild(await load(memoryStorage(), stravaRaw()));
    expect(fit).toMatchObject({ done: 3, failed: 0 });
    expect(withoutDate(coros)).toEqual(expected.strava);
    expect(routes).toEqual(expected.stravaRoutes);
    expect(result.missing).toBeNull();
  });
});

describe('stockage IndexedDB', () => {
  it('même snapshot qu’en mémoire, fichiers relus à l’identique', async () => {
    const storage = await load(await indexedDbStorage('runstat-test', new IDBFactory()), corosRaw());
    const { coros, routes } = await rebuild(storage);
    expect(withoutDate(coros)).toEqual(expected.coros);
    expect(routes).toEqual(expected.routes);
    expect((await storage.raw.list('results')).sort()).toEqual([
      '100005.json',
      'date-2025-01-01-10.json',
      'date-2026-02-22-21.json',
    ]);
    expect(await storage.raw.list('fit-derived')).toEqual(['100003.json']);
    expect(await storage.raw.read('fit/100003.fit')).toEqual(corosRaw()['fit/100003.fit']);
    await storage.raw.remove('fit/100003.fit');
    expect(await storage.raw.read('fit/100003.fit')).toBeNull();
    await expect(storage.raw.write('../evil', 'x')).rejects.toThrow(/invalide/);
  });
});
