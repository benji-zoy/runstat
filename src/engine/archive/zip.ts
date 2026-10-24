// Lecteur zip minimal pour l'archive Strava (souvent plusieurs centaines de Mo) : répertoire central lu à la fin, entrées
// lues à leur décalage sans charger le zip en mémoire. Stocké ou deflate, zip64 compris. Source à accès direct : un Blob
// (fichier choisi dans le navigateur, ou fs.openAsBlob côté Node). Décompression par DecompressionStream, taille bornée en
// cours de lecture (bombe zip).

export class ZipError extends Error {}

/** Octets à accès direct */
export interface ByteSource {
  size: number;
  read(pos: number, len: number): Promise<Uint8Array>;
}

/** Blob (File du navigateur, fs.openAsBlob de Node) → source à accès direct */
export const blobSource = (blob: Blob): ByteSource => ({
  size: blob.size,
  read: async (pos, len) => new Uint8Array(await blob.slice(pos, pos + len).arrayBuffer()),
});

export interface ZipEntry {
  name: string;
  method: number;
  size: number;
  compressedSize: number;
  offset: number;
}

export interface Zip {
  entries: ZipEntry[];
  read(entry: ZipEntry): Promise<Uint8Array>;
}

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const utf8 = new TextDecoder();

/** Flux d'un seul morceau (pas de Blob.stream() : absent de jsdom, l'environnement des tests) */
const once = (data: Uint8Array) =>
  new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(data as Uint8Array<ArrayBuffer>);
      controller.close();
    },
  });

/** Lit tout un flux d'octets, refusé au-delà de `max` octets */
async function collect(stream: ReadableStream<Uint8Array>, max = Infinity): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new ZipError('contenu décompressé trop volumineux');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) (out.set(c, p), (p += c.length));
  return out;
}

/** Décompression (deflate brut du zip ou gzip), refusée au-delà de `max` octets */
export const inflate = (data: Uint8Array, format: 'deflate-raw' | 'gzip', max: number): Promise<Uint8Array> =>
  collect(once(data).pipeThrough(new DecompressionStream(format)), max);

/** Compression gzip (tracés rangés en .gz, comme sur le NAS) */
export const gzip = (data: Uint8Array): Promise<Uint8Array> => collect(once(data).pipeThrough(new CompressionStream('gzip')));

/** Ouvre un zip ; `maxEntrySize` borne la taille décompressée d'une entrée */
export async function openZip(src: ByteSource, { maxEntrySize = 256 * 1024 * 1024 } = {}): Promise<Zip> {
  const at = async (pos: number, len: number) => {
    const buf = await src.read(pos, len);
    if (buf.length !== len) throw new ZipError('zip tronqué');
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  };
  const u64 = (v: DataView, o: number) => Number(v.getBigUint64(o, true));

  // Fin du répertoire central : dans les 64 Ko + 22 octets de la fin (commentaire éventuel)
  const tailLen = Math.min(src.size, 65_557);
  if (tailLen < 22) throw new ZipError('pas une archive zip');
  const tail = await at(src.size - tailLen, tailLen);
  let e = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === EOCD) (e = i), (i = -1);
  if (e < 0) throw new ZipError('pas une archive zip');
  let count = tail.getUint16(e + 10, true);
  let cdSize = tail.getUint32(e + 12, true);
  let cdOffset = tail.getUint32(e + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = e - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== EOCD64_LOCATOR) throw new ZipError('zip64 illisible');
    const rec = await at(u64(tail, loc + 8), 56);
    if (rec.getUint32(0, true) !== EOCD64) throw new ZipError('zip64 illisible');
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  if (cdOffset + cdSize > src.size) throw new ZipError('répertoire central hors du fichier');

  const cd = await at(cdOffset, cdSize);
  const bytes = new Uint8Array(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries: ZipEntry[] = [];
  for (let p = 0, k = 0; k < count; k++) {
    if (p + 46 > cdSize || cd.getUint32(p, true) !== CENTRAL) throw new ZipError('répertoire central corrompu');
    const method = cd.getUint16(p + 10, true);
    let compressedSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let offset = cd.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // Champ zip64 (0x0001) : valeurs 64 bits dans l'ordre taille, taille compressée, décalage
    for (let x = p + 46 + nameLen; x < p + 46 + nameLen + extraLen; ) {
      const id = cd.getUint16(x, true);
      const len = cd.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === 0xffffffff) (size = u64(cd, q)), (q += 8);
        if (compressedSize === 0xffffffff) (compressedSize = u64(cd, q)), (q += 8);
        if (offset === 0xffffffff) offset = u64(cd, q);
      }
      x += 4 + len;
    }
    if (!name.endsWith('/')) entries.push({ name, method, size, compressedSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    entries,
    async read(entry) {
      if (entry.size > maxEntrySize) throw new ZipError(`${entry.name} : trop volumineux`);
      const head = await at(entry.offset, 30);
      if (head.getUint32(0, true) !== LOCAL) throw new ZipError(`${entry.name} : en-tête local invalide`);
      const start = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
      const data = await src.read(start, entry.compressedSize);
      if (data.length !== entry.compressedSize) throw new ZipError('zip tronqué');
      if (entry.method === 0) return data;
      if (entry.method !== 8) throw new ZipError(`${entry.name} : compression ${entry.method} non gérée`);
      return inflate(data, 'deflate-raw', maxEntrySize);
    },
  };
}
