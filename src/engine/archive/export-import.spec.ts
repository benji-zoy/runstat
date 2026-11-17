// Import d'un export RunStat : aller-retour avec exportEntries, fichiers propres à la machine d'origine ignorés, chemins
// piégés refusés, budget d'octets.
import { MemoryStore } from '../storage/memory.ts';
import type { KeyedStore } from '../storage/types.ts';
import { importRunstatExport, safePath } from './export-import.ts';
import { ZipError, blobSource } from './zip.ts';
import { README, exportEntries, zipStream, type ZipInput } from './zip-writer.ts';

const enc = (s: string) => new TextEncoder().encode(s);

async function zipOf(entries: AsyncIterable<ZipInput> | ZipInput[]): Promise<Blob> {
  const parts: Uint8Array[] = [];
  const src = Array.isArray(entries) ? (async function* () { yield* entries; })() : entries;
  for await (const p of zipStream(src as AsyncGenerator<ZipInput>)) parts.push(p);
  return new Blob(parts as Uint8Array<ArrayBuffer>[]);
}
const readme: ZipInput = { path: 'LISEZMOI.txt', data: enc(README(new Date('2026-11-17'))) };

describe('import d’un export RunStat', () => {
  it('aller-retour : la zone raw exportée revient à l’identique, sans les jetons ni l’état de synchro', async () => {
    const from = new MemoryStore();
    await from.write('goals.json', enc('[{"id":"marathon"}]'));
    await from.write('records.txt', enc('liste'));
    await from.write('fit/123.fit', new Uint8Array([1, 2, 3]));
    await from.write('secrets/coros-tokens.json', enc('{"refresh":"x"}'));
    await from.write('sync-state.json', enc('{"reauthSince":"2026-11-01"}'));
    await from.write('raw/coros/records/1.json', enc('{}'));
    const snapshot = new MemoryStore();
    await snapshot.write('coros.json', enc('{}'));

    const to = new MemoryStore();
    await to.write('secrets/coros-tokens.json', enc('{"refresh":"appareil"}'));
    await to.write('records.txt', enc('ancienne'));
    await to.write('athlete.json', enc('{"hrMax":190}'));
    const r = await importRunstatExport(blobSource(await zipOf(exportEntries(from as unknown as KeyedStore, snapshot))), to);

    expect(r.files).toBe(3);
    expect(r.skipped).toBe(2);
    expect(await to.readText('goals.json')).toBe('[{"id":"marathon"}]');
    expect(await to.readText('records.txt')).toBe('liste');
    expect(await to.read('fit/123.fit')).toEqual(new Uint8Array([1, 2, 3]));
    // Gardés : jetons et fichiers de l'appareil absents de l'export
    expect(await to.readText('secrets/coros-tokens.json')).toBe('{"refresh":"appareil"}');
    expect(await to.readText('athlete.json')).toBe('{"hrMax":190}');
    expect(await to.read('sync-state.json')).toBeNull();
    expect(await to.read('raw/coros/records/1.json')).toBeNull();
    expect(await to.read('coros.json')).toBeNull();
  });

  it('refuse ce qui n’est pas un export RunStat', async () => {
    const strava = await zipOf([{ path: 'activities.csv', data: enc('Activity ID') }]);
    await expect(importRunstatExport(blobSource(strava), new MemoryStore())).rejects.toThrow(/pas un export RunStat/);
    const empty = await zipOf([readme]);
    await expect(importRunstatExport(blobSource(empty), new MemoryStore())).rejects.toThrow(/export vide/);
  });

  it('chemins piégés, doublons et JSON illisible ignorés', async () => {
    const to = new MemoryStore();
    const r = await importRunstatExport(
      blobSource(
        await zipOf([
          readme,
          { path: 'data-raw/../secrets/x.json', data: enc('{}') },
          { path: 'data-raw//etc/passwd', data: enc('x') },
          { path: 'data-raw/a\\b.txt', data: enc('x') },
          { path: 'data-raw/goals.json', data: enc('[]') },
          { path: 'data-raw/goals.json', data: enc('[{"id":"pas-moi"}]') },
          { path: 'data-raw/athlete.json', data: enc('{pas du json') },
        ]),
      ),
      to,
    );
    expect(r).toEqual({ files: 1, bytes: 2, skipped: 5 });
    expect(await to.readText('goals.json')).toBe('[]');
    expect(await to.read('athlete.json')).toBeNull();
    expect(safePath('details/part-20260101.jsonl')).toBe(true);
    expect(safePath('./goals.json')).toBe(false);
  });

  it('budget total d’octets décompressés', async () => {
    const blob = await zipOf([readme, ...[1, 2, 3].map((i) => ({ path: `data-raw/fit/${i}.fit`, data: new Uint8Array(1000) }))]);
    const refused = importRunstatExport(blobSource(blob), new MemoryStore(), { maxImportBytes: 2500 });
    await expect(refused).rejects.toBeInstanceOf(ZipError);
    await expect(refused).rejects.toThrow(/export refusé/);
    expect((await importRunstatExport(blobSource(blob), new MemoryStore(), { maxImportBytes: 3000 })).files).toBe(3);
  });
});
