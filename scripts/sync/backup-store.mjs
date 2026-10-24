// Sauvegarde chiffrée de bout en bout d'un compte local-first (zone publique, public-api.mjs), dans users/<id>/backup/ :
//   manifests/<version>.json : { version, createdAt, header (clair : dérivation de clé, clé de données enveloppée), blob (manifeste
//                              chiffré, base64url), objects: [identifiants référencés], size }
//   objects/<id>             : objets chiffrés, immuables, nommés par un HMAC de leur contenu (64 caractères hexadécimaux)
// Le serveur ne voit que des tailles et des identifiants opaques. Versions : dernier écrit gagne, avec contrôle (If-Match) ;
// manifestes et objets gardés 30 jours quel que soit leur nombre (un jeton volé ne peut pas effacer l'historique en dix envois),
// le dernier toujours. Suppression douce : dossier renommé, purgé après 30 jours.
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export const OBJECT_ID = /^[a-f0-9]{64}$/;
export const RETENTION_MS = 30 * 86_400_000;
/** Un objet envoyé mais pas encore référencé (manifeste en cours d'envoi) n'est pas ramassé avant ce délai */
const ORPHAN_GRACE_MS = 86_400_000;
export const MAX_OBJECT = 32 * 2 ** 20;
export const MAX_BLOB = 8 * 2 ** 20;
const MAX_HEADER = 16 * 1024;
const MAX_REFS = 200_000;

export class BackupError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const pad = (v) => String(v).padStart(12, '0');

export class BackupStore {
  /** `base` : users/<id> */
  constructor(base, now = Date.now) {
    this.base = base;
    this.dir = join(base, 'backup');
    this.now = now;
  }

  #mkdir(dir, mode = 0o750) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode });
      chmodSync(dir, mode);
    }
  }

  #versions() {
    const d = join(this.dir, 'manifests');
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => /^\d{12}\.json$/.test(f))
      .map((f) => Number(f.slice(0, 12)))
      .sort((a, b) => a - b);
  }

  get(version) {
    const file = join(this.dir, 'manifests', `${pad(version)}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  }

  latest() {
    const v = this.#versions().at(-1);
    return v ? this.get(v) : null;
  }

  /** Historique (sans les blobs) : le client peut revenir au dernier manifeste qu'il sait déchiffrer */
  list() {
    return this.#versions().map((v) => {
      const m = this.get(v);
      return { version: m.version, createdAt: m.createdAt, size: m.size };
    });
  }

  hasObject(id) {
    return OBJECT_ID.test(id) && existsSync(join(this.dir, 'objects', id));
  }

  missing(ids) {
    if (!Array.isArray(ids) || ids.length > MAX_REFS || ids.some((i) => typeof i !== 'string' || !OBJECT_ID.test(i)))
      throw new BackupError(400, 'liste d’identifiants invalide');
    return ids.filter((i) => !this.hasObject(i));
  }

  objectStream(id) {
    if (!this.hasObject(id)) return null;
    const file = join(this.dir, 'objects', id);
    return { size: statSync(file).size, stream: createReadStream(file) };
  }

  /** Dossier temporaire pour un envoi en flux (renommé ensuite : jamais d'objet à moitié écrit) */
  tmpFile(id) {
    this.#mkdir(join(this.dir, 'tmp'));
    return join(this.dir, 'tmp', `${id}.${process.pid}.${this.now()}`);
  }

  /** Objet immuable : un identifiant déjà présent n'est pas réécrit */
  commitObject(id, tmp) {
    if (!OBJECT_ID.test(id)) throw new BackupError(400, 'identifiant d’objet invalide');
    this.#mkdir(join(this.dir, 'objects'));
    const file = join(this.dir, 'objects', id);
    if (existsSync(file)) return rmSync(tmp, { force: true }), false;
    chmodSync(tmp, 0o640);
    renameSync(tmp, file);
    return true;
  }

  /** Octets occupés par la sauvegarde (objets, manifestes, envois en cours) */
  usage() {
    const size = (d) => {
      if (!existsSync(d)) return 0;
      let t = 0;
      for (const e of readdirSync(d, { withFileTypes: true })) t += e.isDirectory() ? size(join(d, e.name)) : statSync(join(d, e.name)).size;
      return t;
    };
    return size(this.dir);
  }

  /**
   * Nouveau manifeste. `expected` : version attendue côté serveur (If-Match), ou null pour une première sauvegarde
   * (If-None-Match: *). 412 si quelqu'un a écrit entre-temps (le client relit, fusionne et renvoie) ; 409 si des objets
   * référencés manquent.
   */
  putManifest(body, expected) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BackupError(400, 'manifeste attendu');
    for (const k of Object.keys(body)) if (!['version', 'header', 'blob', 'objects'].includes(k)) throw new BackupError(400, `${k} : champ inconnu`);
    const { version, header, blob, objects } = body;
    if (!header || typeof header !== 'object' || Array.isArray(header) || JSON.stringify(header).length > MAX_HEADER)
      throw new BackupError(400, 'en-tête invalide');
    if (typeof blob !== 'string' || !/^[A-Za-z0-9_-]+$/.test(blob) || blob.length > (MAX_BLOB * 4) / 3) throw new BackupError(400, 'blob invalide');
    const missing = this.missing(objects);
    const current = this.latest()?.version ?? null;
    if (expected !== current) throw new BackupError(412, 'version périmée : relis la sauvegarde et fusionne', { current });
    if (version !== (current ?? 0) + 1) throw new BackupError(400, `version ${(current ?? 0) + 1} attendue`);
    if (missing.length) throw new BackupError(409, 'objets absents : envoie-les d’abord', { missing: missing.slice(0, 1000) });
    this.#mkdir(join(this.dir, 'manifests'));
    const m = { version, createdAt: new Date(this.now()).toISOString(), header, blob, objects: [...new Set(objects)], size: blob.length };
    const file = join(this.dir, 'manifests', `${pad(version)}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(m), { mode: 0o640 });
    renameSync(`${file}.tmp`, file);
    return { version, createdAt: m.createdAt };
  }

  /**
   * Ménage : manifestes de plus de 30 jours (sauf le dernier), objets que plus aucun manifeste gardé ne référence (après un
   * jour de grâce), envois temporaires abandonnés, sauvegardes supprimées depuis plus de 30 jours.
   */
  gc() {
    const now = this.now();
    const versions = this.#versions();
    const keep = new Set();
    for (const v of versions) {
      const m = this.get(v);
      if (v !== versions.at(-1) && now - Date.parse(m.createdAt) > RETENTION_MS) rmSync(join(this.dir, 'manifests', `${pad(v)}.json`));
      else for (const id of m.objects) keep.add(id);
    }
    let removed = 0;
    const objects = join(this.dir, 'objects');
    if (existsSync(objects))
      for (const id of readdirSync(objects)) {
        const file = join(objects, id);
        if (!keep.has(id) && now - statSync(file).mtimeMs > ORPHAN_GRACE_MS) rmSync(file), removed++;
      }
    const tmp = join(this.dir, 'tmp');
    if (existsSync(tmp)) for (const f of readdirSync(tmp)) if (now - statSync(join(tmp, f)).mtimeMs > ORPHAN_GRACE_MS) rmSync(join(tmp, f));
    if (existsSync(this.base))
      for (const d of readdirSync(this.base).filter((f) => /^backup-supprimee-\d+$/.test(f)))
        if (now - Number(d.split('-').at(-1)) > RETENTION_MS) rmSync(join(this.base, d), { recursive: true, force: true });
    return { removed };
  }

  /** Suppression douce : récupérable 30 jours (dossier renommé), puis purgée par gc() */
  softDelete() {
    if (!existsSync(this.dir)) return false;
    renameSync(this.dir, join(this.base, `backup-supprimee-${this.now()}`));
    return true;
  }
}

/**
 * Ménage de toutes les sauvegardes du dossier des comptes (toutes les 6 h, server.mjs) : gc() des comptes local-first, et
 * pour les dossiers de comptes retirés de users.json, sauvegarde restante mise en suppression douce puis purgée après
 * 30 jours, dossier effacé une fois vide. Les données d'un compte hébergé retiré (data-raw, snapshot, secrets) restent.
 */
export function gcAllBackups(usersDir, users, now = Date.now) {
  if (!existsSync(usersDir)) return;
  const known = new Map(users.map((u) => [u.id, u]));
  for (const e of readdirSync(usersDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'auth' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(e.name)) continue;
    const user = known.get(e.name);
    if (user && user.mode !== 'local') continue;
    const store = new BackupStore(join(usersDir, e.name), now);
    if (!user) store.softDelete();
    store.gc();
    if (!user && !readdirSync(store.base).length) rmSync(store.base, { recursive: true, force: true });
  }
}
