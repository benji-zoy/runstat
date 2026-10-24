// Lecteur zip minimal pour l'archive Strava (souvent plusieurs centaines de Mo) : répertoire central lu à la fin
// du fichier, entrées lues à leur décalage sans charger le zip en mémoire. Stocké ou deflate, zip64 compris.
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export class ZipError extends Error {}

/**
 * Ouvre un zip : { entries: [{ name, size, compressedSize }], read(entry) → Buffer, close() }.
 * `maxEntrySize` borne la taille décompressée d'une entrée (bombe zip).
 */
export function openZip(file, { maxEntrySize = 256 * 1024 * 1024 } = {}) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const at = (pos, len) => {
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, pos);
      if (n !== len) throw new ZipError('zip tronqué');
      return buf;
    };

    // Fin du répertoire central : dans les 64 Ko + 22 octets de la fin (commentaire éventuel)
    const tailLen = Math.min(size, 65_557);
    const tail = at(size - tailLen, tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD) (e = i), (i = -1);
    if (e < 0) throw new ZipError('pas une archive zip');
    let count = tail.readUInt16LE(e + 10);
    let cdSize = tail.readUInt32LE(e + 12);
    let cdOffset = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) {
      const loc = e - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== EOCD64_LOCATOR) throw new ZipError('zip64 illisible');
      const rec = at(Number(tail.readBigUInt64LE(loc + 8)), 56);
      if (rec.readUInt32LE(0) !== EOCD64) throw new ZipError('zip64 illisible');
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    if (cdOffset + cdSize > size) throw new ZipError('répertoire central hors du fichier');

    const cd = at(cdOffset, cdSize);
    const entries = [];
    for (let p = 0, k = 0; k < count; k++) {
      if (cd.readUInt32LE(p) !== CENTRAL) throw new ZipError('répertoire central corrompu');
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let uncompressed = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      // Champ zip64 (0x0001) : valeurs 64 bits dans l'ordre taille, taille compressée, décalage
      for (let x = p + 46 + nameLen; x < p + 46 + nameLen + extraLen; ) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (uncompressed === 0xffffffff) (uncompressed = Number(cd.readBigUInt64LE(q))), (q += 8);
          if (compressedSize === 0xffffffff) (compressedSize = Number(cd.readBigUInt64LE(q))), (q += 8);
          if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(q));
        }
        x += 4 + len;
      }
      if (!name.endsWith('/')) entries.push({ name, method, size: uncompressed, compressedSize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }

    return {
      entries,
      read(entry) {
        if (entry.size > maxEntrySize) throw new ZipError(`${entry.name} : trop volumineux`);
        const head = at(entry.offset, 30);
        if (head.readUInt32LE(0) !== LOCAL) throw new ZipError(`${entry.name} : en-tête local invalide`);
        const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
        const data = at(start, entry.compressedSize);
        if (entry.method === 0) return data;
        if (entry.method !== 8) throw new ZipError(`${entry.name} : compression ${entry.method} non gérée`);
        return inflateRawSync(data, { maxOutputLength: maxEntrySize });
      },
      close: () => closeSync(fd),
    };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}
