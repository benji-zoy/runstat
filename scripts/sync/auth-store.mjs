// Identités des comptes local-first (zone publique, public-api.mjs), dans RUNSTAT_USERS/auth/ (dossier 700, fichiers 600) :
//   credentials.json : passkeys { id, userId, publicKey (SPKI), alg, signCount, label, createdAt, lastUsedAt }
//   sessions.json    : sessions { id, hash (sha256 du jeton), userId, label, createdAt, lastUsedAt, expiresAt, absoluteAt, stepUpUntil }
//   codes.json       : invitations et liens de connexion { hash, userId, kind: invite|link, createdAt, expiresAt }
//   handles.json     : { <userId>: identifiant WebAuthn aléatoire (user.id) }
// Aucun jeton ni code n'est stocké en clair : seulement leur empreinte. Un seul processus écrit (server.mjs) : les écritures
// synchrones sont atomiques à l'échelle de la boucle d'événements.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const INVITE_TTL_MS = 7 * 86_400_000;
export const LINK_TTL_MS = 15 * 60_000;
export const SESSION_IDLE_MS = 30 * 86_400_000;
export const SESSION_MAX_MS = 180 * 86_400_000;
export const STEP_UP_MS = 5 * 60_000;
const MAX_SESSIONS_PER_USER = 20;
const MAX_CREDENTIALS_PER_USER = 10;

export const token = () => randomBytes(32).toString('base64url');
export const digest = (s) => createHash('sha256').update(String(s)).digest('base64url');

export class AuthStore {
  constructor(usersDir, now = Date.now) {
    this.dir = join(usersDir, 'auth');
    this.now = now;
  }

  #read(name, fallback) {
    const file = join(this.dir, name);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
  }

  #write(name, value) {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
    }
    const file = join(this.dir, name);
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    chmodSync(`${file}.tmp`, 0o600);
    renameSync(`${file}.tmp`, file);
  }

  // ---------- codes : invitations (7 jours) et liens de connexion (15 min), à usage unique ----------

  /** Nouveau code ; une invitation remplace les invitations encore valides du compte */
  createCode(userId, kind) {
    const code = token();
    const now = this.now();
    const codes = this.#read('codes.json', []).filter((c) => c.expiresAt > now && !(kind === 'invite' && c.userId === userId && c.kind === 'invite'));
    codes.push({ hash: digest(code), userId, kind, createdAt: now, expiresAt: now + (kind === 'invite' ? INVITE_TTL_MS : LINK_TTL_MS) });
    this.#write('codes.json', codes);
    return { code, expiresAt: new Date(now + (kind === 'invite' ? INVITE_TTL_MS : LINK_TTL_MS)).toISOString() };
  }

  /** Code valide (sans le consommer), ou null */
  findCode(code, kind) {
    if (typeof code !== 'string' || code.length > 100) return null;
    const hash = digest(code);
    return this.#read('codes.json', []).find((c) => c.hash === hash && c.kind === kind && c.expiresAt > this.now()) ?? null;
  }

  consumeCode(code) {
    const hash = digest(code);
    this.#write('codes.json', this.#read('codes.json', []).filter((c) => c.hash !== hash && c.expiresAt > this.now()));
  }

  // ---------- passkeys ----------

  /** Identifiant WebAuthn du compte (user.id), aléatoire, jamais l'identifiant RunStat */
  handle(userId) {
    const handles = this.#read('handles.json', {});
    if (!handles[userId]) {
      handles[userId] = randomBytes(16).toString('base64url');
      this.#write('handles.json', handles);
    }
    return handles[userId];
  }

  userOfHandle(h) {
    return Object.entries(this.#read('handles.json', {})).find(([, v]) => v === h)?.[0] ?? null;
  }

  credentials(userId) {
    return this.#read('credentials.json', []).filter((c) => !userId || c.userId === userId);
  }

  credential(id) {
    return this.#read('credentials.json', []).find((c) => c.id === id) ?? null;
  }

  addCredential(userId, { credentialId, publicKey, alg, signCount }, label) {
    const all = this.#read('credentials.json', []);
    if (all.some((c) => c.id === credentialId)) throw new Error('clé déjà enregistrée');
    if (all.filter((c) => c.userId === userId).length >= MAX_CREDENTIALS_PER_USER) throw new Error('trop de clés pour ce compte');
    const now = this.now();
    all.push({ id: credentialId, userId, publicKey, alg, signCount, label, createdAt: now, lastUsedAt: now });
    this.#write('credentials.json', all);
  }

  touchCredential(id, signCount) {
    const all = this.#read('credentials.json', []);
    const c = all.find((x) => x.id === id);
    if (!c) return;
    Object.assign(c, { signCount, lastUsedAt: this.now() });
    this.#write('credentials.json', all);
  }

  removeCredential(userId, id) {
    const all = this.#read('credentials.json', []);
    const next = all.filter((c) => !(c.userId === userId && c.id === id));
    if (next.length === all.length) return false;
    this.#write('credentials.json', next);
    return true;
  }

  // ---------- sessions ----------

  /** `stepUp` : session ouverte par une passkey (vaut ré-authentification quelques minutes), pas par un lien */
  createSession(userId, label, { stepUp = false } = {}) {
    const t = token();
    const now = this.now();
    let sessions = this.#read('sessions.json', []).filter((s) => s.expiresAt > now && s.absoluteAt > now);
    const mine = sessions.filter((s) => s.userId === userId).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    // Au-delà de 20 appareils, la plus ancienne session tombe
    while (mine.length >= MAX_SESSIONS_PER_USER) {
      const old = mine.shift();
      sessions = sessions.filter((s) => s !== old);
    }
    const hash = digest(t);
    sessions.push({ id: hash.slice(0, 12), hash, userId, label, createdAt: now, lastUsedAt: now, expiresAt: now + SESSION_IDLE_MS, absoluteAt: now + SESSION_MAX_MS, stepUpUntil: stepUp ? now + STEP_UP_MS : 0 });
    this.#write('sessions.json', sessions);
    return t;
  }

  /** Session d'un jeton Bearer, prolongée à l'usage (au plus une écriture par heure) ; null si inconnue ou expirée */
  session(t) {
    if (typeof t !== 'string' || t.length > 100) return null;
    const hash = digest(t);
    const now = this.now();
    const sessions = this.#read('sessions.json', []);
    const s = sessions.find((x) => x.hash === hash);
    if (!s || s.expiresAt <= now || s.absoluteAt <= now) return null;
    if (now - s.lastUsedAt > 3_600_000) {
      Object.assign(s, { lastUsedAt: now, expiresAt: Math.min(now + SESSION_IDLE_MS, s.absoluteAt) });
      this.#write('sessions.json', sessions);
    }
    return s;
  }

  sessions(userId) {
    const now = this.now();
    return this.#read('sessions.json', []).filter((s) => s.userId === userId && s.expiresAt > now && s.absoluteAt > now);
  }

  stepUp(sessionId) {
    const sessions = this.#read('sessions.json', []);
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) return;
    s.stepUpUntil = this.now() + STEP_UP_MS;
    this.#write('sessions.json', sessions);
  }

  revokeSession(userId, sessionId) {
    const all = this.#read('sessions.json', []);
    const next = all.filter((s) => !(s.userId === userId && s.id === sessionId));
    this.#write('sessions.json', next);
    return next.length !== all.length;
  }

  /** Accès réinitialisé (propriétaire) ou compte supprimé : passkeys, sessions et codes du compte effacés */
  revokeAll(userId) {
    this.#write('credentials.json', this.#read('credentials.json', []).filter((c) => c.userId !== userId));
    this.#write('sessions.json', this.#read('sessions.json', []).filter((s) => s.userId !== userId));
    this.#write('codes.json', this.#read('codes.json', []).filter((c) => c.userId !== userId));
  }
}
