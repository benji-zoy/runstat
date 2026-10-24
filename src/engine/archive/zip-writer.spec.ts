// Export des données (zip stocké) : relu par le lecteur du moteur, noms UTF-8, aucun secret.
import { MemoryStore } from '../storage/memory.ts';
import { blobSource, openZip } from './zip.ts';
import { crc32, exportEntries, zipStream } from './zip-writer.ts';

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Blob> {
  const parts: Uint8Array[] = [];
  for await (const p of gen) parts.push(p);
  return new Blob(parts as Uint8Array<ArrayBuffer>[]);
}

describe('export zip', () => {
  it('CRC-32 standard', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('relu à l’identique par le lecteur du moteur, sans les jetons', async () => {
    const fit = new Uint8Array(70_000).map((_, i) => i % 251);
    const raw = new MemoryStore({
      'athlete.json': '{"hrMax":190}',
      'fit/100001.fit': fit,
      'results/date-2026-03-15-10.json': '{"event":"Course de Valbourg"}',
      'secrets/coros-tokens.json': '{"refresh_token":"SECRET"}',
      'secrets/strava-client.json': '{"client_secret":"SECRET"}',
      'notes/été.txt': 'accentué',
    });
    const snapshot = new MemoryStore({ 'coros.json': '{"activities":[]}' });
    const blob = await collect(zipStream(exportEntries(raw, snapshot, new Date('2026-10-24T10:00:00Z'))));
    const zip = await openZip(blobSource(blob));
    const names = zip.entries.map((e) => e.name).sort();
    expect(names).toEqual(['LISEZMOI.txt', 'data-raw/athlete.json', 'data-raw/fit/100001.fit', 'data-raw/notes/été.txt', 'data-raw/results/date-2026-03-15-10.json', 'snapshot/coros.json']);
    const read = async (name: string) => zip.read(zip.entries.find((e) => e.name === name)!);
    expect(await read('data-raw/fit/100001.fit')).toEqual(fit);
    expect(new TextDecoder().decode(await read('data-raw/notes/été.txt'))).toBe('accentué');
    expect(new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()))).not.toContain('SECRET');
  });
});
