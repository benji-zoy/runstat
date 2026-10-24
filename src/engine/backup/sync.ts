// Sauvegarde chiffrée et synchro entre appareils (mode local-first), sur l'API /backup du NAS (scripts/sync/public-api.mjs).
// Une seule opération, `syncBackup` : fichiers locaux modifiés envoyés (petits fichiers regroupés en paquets), nouveautés des
// autres appareils téléchargées, manifeste fusionné puis envoyé avec contrôle de version (412 → on relit et on refusionne).
// Restaurer sur un nouvel appareil = synchroniser un stockage vide.
// - Fusion par fichier : horloge de Lamport (+ appareil pour départager) ; suppression = pierre tombale. Pas d'horloge murale.
// - Anti-retour : l'appareil garde la plus haute version vue et refuse un manifeste plus ancien (le serveur pourrait en rejouer un).
// - Non sauvegardé : ce qui se reconstruit (fit-derived/, missing-details.txt) et l'état local (local-state.json, index).
import { decryptManifest, decryptObject, encryptManifest, encryptObject, objectId, TamperedData, type KeyWrap, type WorkKeys } from './crypto.ts';
import type { KeyedStore } from '../storage/types.ts';

export const INDEX_FILE = 'backup-index.json';
const EXCLUDED = [/^fit-derived\//, /^local-state\.json$/, /^backup-index\.json$/, /^missing-details\.txt$/];
const PACK_LIMIT = 4 * 2 ** 20;
const SMALL = 256 * 1024;

/** En-tête clair du manifeste : enveloppes de la clé de données */
export interface BackupHeader {
  v: 1;
  wraps: KeyWrap[];
}

export interface FileEntry {
  /** HMAC du contenu (comparaison sans téléchargement) */
  hash: string;
  /** Objet (paquet ou fichier seul), position et longueur dans l'objet */
  obj: string;
  off: number;
  len: number;
  clock: number;
  dev: string;
  del?: true;
}

export interface Manifest {
  v: 1;
  account: string;
  version: number;
  createdAt: string;
  device: { id: string; name: string };
  devices: Record<string, { name: string; lastSeen: string }>;
  files: Record<string, FileEntry>;
}

/** Manifeste tel que le NAS le sert */
export interface RemoteManifest {
  version: number;
  createdAt?: string;
  header: BackupHeader;
  blob: string;
  objects?: string[];
}

export class Conflict extends Error {
  current: number | null;
  constructor(current: number | null) {
    super('version périmée');
    this.current = current;
  }
}
export class Rollback extends Error {}

export interface BackupApi {
  getManifest(): Promise<RemoteManifest | null>;
  listManifests(): Promise<{ version: number; createdAt: string }[]>;
  getManifestVersion(version: number): Promise<RemoteManifest>;
  /** `expected` : version actuelle attendue (null = première sauvegarde) ; Conflict si quelqu'un a écrit entre-temps */
  putManifest(body: { version: number; header: BackupHeader; blob: string; objects: string[] }, expected: number | null): Promise<void>;
  missing(ids: string[]): Promise<string[]>;
  putObject(id: string, data: Uint8Array): Promise<void>;
  getObject(id: string): Promise<Uint8Array>;
}

/** Index local (non sauvegardé) : état des fichiers à la dernière synchro, plus haute version vue */
interface Index {
  version: number | null;
  maxVersion: number;
  files: Record<string, { hash: string; clock: number; dev: string; del?: true }>;
}

export interface SyncOptions {
  raw: KeyedStore;
  api: BackupApi;
  keys: WorkKeys;
  account: string;
  device: { id: string; name: string };
  /** En-tête à poser (première sauvegarde, nouvelle phrase de passe) ; sinon celui du NAS */
  header?: BackupHeader;
  now?: () => Date;
  onProgress?: (step: string, done: number, total: number) => void;
}

export interface SyncResult {
  version: number;
  uploaded: number;
  downloaded: number;
  deleted: number;
  /** Fichiers reçus d'un autre appareil : une reconstruction est nécessaire */
  changed: boolean;
}

const backedUp = (path: string) => !EXCLUDED.some((re) => re.test(path));
const newer = (a: { clock: number; dev: string }, b: { clock: number; dev: string } | undefined) =>
  !b || a.clock > b.clock || (a.clock === b.clock && a.dev > b.dev);

export async function syncBackup(opts: SyncOptions): Promise<SyncResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await syncOnce(opts);
    } catch (e) {
      if (!(e instanceof Conflict) || attempt >= 4) throw e;
      // Un autre appareil a écrit pendant ce temps : on relit son manifeste et on refusionne
    }
  }
}

async function syncOnce({ raw, api, keys, account, device, header, now = () => new Date(), onProgress = () => {} }: SyncOptions): Promise<SyncResult> {
  const index: Index = JSON.parse((await raw.readText(INDEX_FILE)) ?? 'null') ?? { version: null, maxVersion: 0, files: {} };

  // ---- distant : dernier manifeste lisible, jamais plus ancien que ce que l'appareil a déjà vu
  const remote = await api.getManifest();
  let base: Manifest | null = null;
  let remoteHeader: BackupHeader | null = null;
  if (remote) {
    if (remote.version < index.maxVersion) throw new Rollback(`le serveur sert la version ${remote.version}, cet appareil a déjà vu la ${index.maxVersion}`);
    remoteHeader = remote.header;
    try {
      base = await decryptManifest<Manifest>(keys, account, remote.version, remote.blob);
    } catch (e) {
      if (!(e instanceof TamperedData)) throw e;
      // Dernier manifeste indéchiffrable (envoi corrompu, ou manifeste forgé avec une autre clé) : on repart du dernier lisible
      for (const m of (await api.listManifests()).sort((a, b) => b.version - a.version)) {
        if (m.version >= remote.version || m.version < index.maxVersion - 1000) continue;
        try {
          const older = await api.getManifestVersion(m.version);
          base = await decryptManifest<Manifest>(keys, account, older.version, older.blob);
          break;
        } catch {}
      }
      if (!base) throw e;
    }
  }
  const remoteFiles = base?.files ?? {};
  const hdr = header ?? remoteHeader;
  if (!hdr) throw new Error('aucun en-tête de clé : première sauvegarde sans phrase de passe');

  // ---- local : fichiers modifiés depuis la dernière synchro (empreinte du contenu), et supprimés
  const paths = (await raw.keys()).filter(backedUp);
  let clock = Math.max(0, ...Object.values(index.files).map((f) => f.clock), ...Object.values(remoteFiles).map((f) => f.clock));
  const contents = new Map<string, Uint8Array>();
  const localHash = new Map<string, string>();
  const localChanged = new Map<string, { hash: string; clock: number; dev: string; del?: true }>();
  for (const [i, path] of paths.entries()) {
    onProgress('analyse', i, paths.length);
    const bytes = (await raw.read(path))!;
    const hash = await objectId(keys, bytes);
    contents.set(path, bytes);
    localHash.set(path, hash);
    if (index.files[path]?.hash !== hash || index.files[path]?.del) localChanged.set(path, { hash, clock: ++clock, dev: device.id });
  }
  const present = new Set(paths);
  for (const [path, f] of Object.entries(index.files)) if (!f.del && !present.has(path)) localChanged.set(path, { hash: '', clock: ++clock, dev: device.id, del: true });

  // ---- fusion : pour chaque chemin, l'entrée de plus haute horloge
  const merged: Record<string, FileEntry> = { ...remoteFiles };
  const toUpload: string[] = [];
  for (const [path, l] of localChanged) {
    if (newer(l, remoteFiles[path])) {
      if (l.del) merged[path] = { hash: '', obj: '', off: 0, len: 0, clock: l.clock, dev: l.dev, del: true };
      else toUpload.push(path);
    }
  }

  // ---- envoi : gros fichiers seuls, petits regroupés en paquets de 4 Mio au plus
  const packs: { paths: string[]; size: number }[] = [];
  let small: { paths: string[]; size: number } | null = null;
  for (const path of toUpload) {
    const size = contents.get(path)!.length;
    if (size >= SMALL) {
      packs.push({ paths: [path], size });
      continue;
    }
    if (!small || small.size + size > PACK_LIMIT) packs.push((small = { paths: [], size: 0 }));
    small.paths.push(path);
    small.size += size;
  }
  const encrypted: { id: string; data: Uint8Array }[] = [];
  for (const pack of packs) {
    const data = new Uint8Array(pack.size);
    let off = 0;
    const placed: [string, number, number][] = [];
    for (const path of pack.paths) {
      const b = contents.get(path)!;
      data.set(b, off);
      placed.push([path, off, b.length]);
      off += b.length;
    }
    const obj = await encryptObject(keys, data);
    encrypted.push(obj);
    for (const [path, o, len] of placed) {
      const l = localChanged.get(path)!;
      merged[path] = { hash: l.hash, obj: obj.id, off: o, len, clock: l.clock, dev: l.dev };
    }
  }
  const missing = new Set(encrypted.length ? await api.missing(encrypted.map((o) => o.id)) : []);
  let sent = 0;
  for (const o of encrypted)
    if (missing.has(o.id)) {
      onProgress('envoi', sent, missing.size);
      await api.putObject(o.id, o.data);
      sent++;
    }

  // ---- réception : ce que les autres appareils ont changé depuis la dernière synchro de celui-ci
  let downloaded = 0;
  let deleted = 0;
  const cache = new Map<string, Uint8Array>();
  // Entrée distante gagnante, plus récente que l'état local connu, et contenu local différent (ou fichier à effacer)
  const incoming = Object.entries(remoteFiles).filter(
    ([path, r]) => merged[path] === r && newer(r, index.files[path]) && (r.del ? present.has(path) : localHash.get(path) !== r.hash),
  );
  for (const [i, [path, r]] of incoming.entries()) {
    onProgress('réception', i, incoming.length);
    if (r.del) {
      await raw.remove(path);
      deleted++;
      continue;
    }
    if (!cache.has(r.obj)) cache.set(r.obj, await decryptObject(keys, r.obj, await api.getObject(r.obj)));
    const bytes = cache.get(r.obj)!.slice(r.off, r.off + r.len);
    if ((await objectId(keys, bytes)) !== r.hash) throw new TamperedData(`${path} : contenu inattendu`);
    await raw.write(path, bytes);
    downloaded++;
  }

  // ---- manifeste fusionné, envoyé seulement s'il y a du neuf (ou un nouvel en-tête)
  const version = (remote?.version ?? 0) + 1;
  const stamp = now().toISOString();
  const dirty = [...localChanged.keys()].some((p) => merged[p] !== remoteFiles[p]);
  let finalVersion = remote?.version ?? 0;
  if (!remote || dirty || header) {
    const manifest: Manifest = {
      v: 1,
      account,
      version,
      createdAt: stamp,
      device,
      devices: { ...(base?.devices ?? {}), [device.id]: { name: device.name, lastSeen: stamp } },
      files: merged,
    };
    const objects = [...new Set(Object.values(merged).filter((f) => !f.del).map((f) => f.obj))];
    await api.putManifest({ version, header: hdr, blob: await encryptManifest(keys, account, version, manifest), objects }, remote?.version ?? null);
    finalVersion = version;
  }

  // ---- index local : état de référence pour la prochaine fois
  const files: Index['files'] = {};
  for (const [path, f] of Object.entries(merged)) files[path] = f.del ? { hash: '', clock: f.clock, dev: f.dev, del: true } : { hash: f.hash, clock: f.clock, dev: f.dev };
  await raw.write(INDEX_FILE, JSON.stringify({ version: finalVersion, maxVersion: Math.max(index.maxVersion, finalVersion), files } satisfies Index));
  return { version: finalVersion, uploaded: toUpload.length, downloaded, deleted, changed: downloaded + deleted > 0 };
}
