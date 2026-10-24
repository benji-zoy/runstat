// Lecture d'un fichier FIT par fit-file-parser (JavaScript pur ; dans le navigateur, son import de `buffer`
// est servi par le polyfill npm du même nom) et décompression gzip portable (DecompressionStream : Node ≥ 18 et
// navigateurs).
import FitParser from 'fit-file-parser';
import type { FitData } from './types.ts';

export function parseFit(bytes: Uint8Array): Promise<FitData> {
  // fit-file-parser lit un ArrayBuffer ou toute vue sur des octets (Buffer, Uint8Array) : pas de copie
  const buf = bytes as unknown as ArrayBuffer;
  return new Promise((resolve, reject) => {
    new FitParser({ force: true, speedUnit: 'm/s', lengthUnit: 'm', elapsedRecordField: true, mode: 'list' }).parse(
      buf,
      (err, data) => (err ? reject(err) : resolve(data as FitData)),
    );
  });
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes as Uint8Array<ArrayBuffer>);
      controller.close();
    },
  });
  const reader = input.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value), (size += r.value.length);
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) out.set(c, at), (at += c.length);
  return out;
}

/** En-tête d'un fichier FIT valide : « .FIT » aux octets 8 à 11 */
export const isFitFile = (buf: Uint8Array): boolean =>
  buf.length > 12 && String.fromCharCode(buf[8], buf[9], buf[10], buf[11]) === '.FIT';
