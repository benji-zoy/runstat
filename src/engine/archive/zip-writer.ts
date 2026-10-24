// Écriture d'un zip « stocké » (sans compression : FIT et tracés .gz sont déjà compressés), en flux, pour l'export des
// données d'un compte (RGPD, droit à la portabilité) : sur le NAS (GET /api/export) et sur l'appareil. Noms en UTF-8.
// Ni zip64 ni plus de 65 535 fichiers : refus net au-delà (l'export d'un compte reste bien en dessous).
import type { FileStore, KeyedStore } from '../storage/types.ts';

export class ExportTooLarge extends Error {}

/** Jamais exportés : jetons et clients OAuth, fichiers techniques */
export const EXPORT_EXCLUDED = [/^secrets\//, /(^|\/)\.sync\.lock$/, /\.tmp$/, /^import\//];
export const exported = (path: string) => !EXPORT_EXCLUDED.some((re) => re.test(path));

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Date et heure au format DOS (heure locale, à 2 s près) */
function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export interface ZipInput {
  path: string;
  data: Uint8Array;
  date?: Date;
}

/** Morceaux du zip, entrée après entrée, puis le répertoire central */
export async function* zipStream(entries: AsyncIterable<ZipInput> | Iterable<ZipInput>, now = new Date()): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  const central: Uint8Array[] = [];
  let offset = 0;
  let count = 0;
  for await (const e of entries) {
    const name = enc.encode(e.path);
    const crc = crc32(e.data);
    const { time, date } = dosTime(e.date ?? now);
    if (++count > 0xffff || offset + 30 + name.length + e.data.length > 0xffffffff) throw new ExportTooLarge('export trop volumineux pour un seul zip');
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // noms en UTF-8
    lv.setUint16(8, 0, true); // stocké
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    yield local;
    yield e.data;
    offset += local.length + e.data.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  for (const c of central) yield c;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  yield end;
}

/**
 * Fichiers d'export d'un appareil : zone raw sous `data-raw/` (sans secrets), snapshot sous `snapshot/`, plus un LISEZMOI.
 */
export async function* exportEntries(raw: KeyedStore, snapshot: FileStore, now = new Date()): AsyncGenerator<ZipInput> {
  yield { path: 'LISEZMOI.txt', data: new TextEncoder().encode(README(now)) };
  for (const path of await raw.keys()) {
    if (!exported(path)) continue;
    const data = await raw.read(path);
    if (data) yield { path: `data-raw/${path}`, data };
  }
  for (const name of ['coros.json', 'routes.json']) {
    const data = await snapshot.read(name);
    if (data) yield { path: `snapshot/${name}`, data };
  }
}

export const README = (now: Date) =>
  [
    `Export RunStat du ${now.toISOString().slice(0, 10)}.`,
    '',
    'data-raw/ : tes données brutes (sorties COROS ou Strava, fichiers FIT et tracés, santé, objectifs, réglages, classements).',
    'snapshot/ : les données calculées affichées par RunStat (coros.json, routes.json).',
    'Les jetons de connexion aux services (COROS, Strava, Google) ne sont pas exportés.',
    '',
  ].join('\n');
