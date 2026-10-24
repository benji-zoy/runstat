// Comptes de l'instance (users.json dans RUNSTAT_USERS) et identité d'une requête.
// Sans users.json : instance mono-utilisateur historique (chemins du dépôt ou de l'ancien conteneur, aucun compte).
// La confiance vient du port d'écoute (zone), jamais d'un en-tête envoyé par le client :
//   lan     (nginx :80, port 8080 du NAS lié à son adresse locale) → le propriétaire, sans administration
//   tailnet (nginx :81, derrière Tailscale Serve, seul à transmettre Tailscale-User-Login) → le compte de ce login
// users.json : [{ id, name, role: owner|member, mode: hosted|local, logins: ["prenom@exemple.fr", …] }]
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidEntry, writeJsonAtomic } from './entries.mjs';

export const USER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Noms pris par d'autres dossiers de RUNSTAT_USERS */
const RESERVED = new Set(['auth', 'backup', 'users', 'tmp']);
/** Login Tailscale (adresse du compte, ou utilisateur@github) */
const LOGIN = /^[^\s@,"'<>\\]{1,64}@[^\s@,"'<>\\]{1,253}$/;
export const ZONES = ['lan', 'tailnet'];
const MAX_USERS = 50;

/** Liste des comptes validée : identifiants uniques, un seul propriétaire, logins uniques (insensibles à la casse) */
export function validateUsers(list) {
  if (!Array.isArray(list)) throw new InvalidEntry(['liste de comptes attendue']);
  const errors = [];
  if (list.length > MAX_USERS) errors.push(`${MAX_USERS} comptes au plus`);
  const ids = new Set();
  const logins = new Map();
  const users = list.map((u, i) => {
    const at = `compte ${i + 1}`;
    if (!u || typeof u !== 'object' || Array.isArray(u)) return errors.push(`${at} : objet attendu`), null;
    for (const k of Object.keys(u)) if (!['id', 'name', 'role', 'mode', 'logins'].includes(k)) errors.push(`${at} : ${k} : champ inconnu`);
    const id = typeof u.id === 'string' ? u.id : '';
    if (!USER_ID.test(id) || RESERVED.has(id)) errors.push(`${at} : identifiant en minuscules, chiffres et tirets (32 au plus)`);
    else if (ids.has(id)) errors.push(`${at} : identifiant « ${id} » en double`);
    ids.add(id);
    const name = typeof u.name === 'string' ? u.name.trim() : '';
    if (!name || name.length > 60) errors.push(`${at} : nom obligatoire (60 caractères au plus)`);
    const role = u.role ?? 'member';
    if (!['owner', 'member'].includes(role)) errors.push(`${at} : rôle owner ou member`);
    const mode = u.mode ?? 'hosted';
    if (!['hosted', 'local'].includes(mode)) errors.push(`${at} : mode hosted ou local`);
    const own = Array.isArray(u.logins) ? u.logins : u.logins == null ? [] : null;
    if (!own) errors.push(`${at} : logins : liste attendue`);
    const clean = [];
    for (const l of own ?? []) {
      const login = typeof l === 'string' ? l.trim().toLowerCase() : '';
      if (!LOGIN.test(login)) errors.push(`${at} : login Tailscale invalide (${String(l).slice(0, 40)})`);
      else if (logins.has(login) && logins.get(login) !== id) errors.push(`${at} : login ${login} déjà pris`);
      else if (!clean.includes(login)) (logins.set(login, id), clean.push(login));
    }
    return { id, name, role, mode, logins: clean };
  });
  const owners = users.filter((u) => u?.role === 'owner');
  if (owners.length !== 1) errors.push('un et un seul propriétaire (role owner)');
  if (owners[0] && owners[0].mode !== 'hosted') errors.push('le propriétaire est en mode hébergé');
  if (errors.length) throw new InvalidEntry(errors);
  return users;
}

/**
 * Comptes relus quand users.json change (mtime). `legacy` : chemins de l'instance mono-utilisateur
 * ({ raw, snapshot, secrets }). Renvoie une fonction : () => { multi, users, dir }.
 */
export function accountsLoader(usersDir, legacy) {
  const file = join(usersDir, 'users.json');
  let cache = null;
  let stamp = null;
  const single = { multi: false, dir: usersDir, users: [{ id: 'owner', name: 'Propriétaire', role: 'owner', mode: 'hosted', logins: [], legacy }] };
  return () => {
    if (!existsSync(file)) return single;
    const st = statSync(file);
    const key = `${st.mtimeMs}:${st.size}`;
    if (key !== stamp) {
      // Fichier invalide (édité à la main) : erreur franche plutôt qu'un repli sur le mono-utilisateur
      cache = { multi: true, dir: usersDir, users: validateUsers(JSON.parse(readFileSync(file, 'utf8'))) };
      stamp = key;
    }
    return cache;
  };
}

/** Dossiers d'un compte : users/<id>/data-raw, snapshot, secrets (ou chemins historiques sans users.json) */
export function userPaths(accounts, user) {
  if (user.legacy) return user.legacy;
  if (!USER_ID.test(user.id)) throw new Error('identifiant de compte invalide');
  const base = join(accounts.dir, user.id);
  return { base, raw: join(base, 'data-raw'), snapshot: join(base, 'snapshot'), secrets: join(base, 'secrets') };
}

/** Variables transmises aux runs, en plus des dossiers du compte : jamais de copie de process.env */
const PASS_ENV = ['PATH', 'HOME', 'TZ', 'LANG', 'NODE_EXTRA_CA_CERTS', 'SYNC_OVERLAP_DAYS', 'SYNC_FIT_PER_RUN', 'SYNC_STREAMS_PER_RUN', 'COROS_MCP_URL', 'STRAVA_API_URL'];

/** Environnement d'un run : liste blanche + dossiers du compte (scripts/paths.mjs) */
export function runEnv(paths, usersDir, env = process.env) {
  const out = {};
  for (const k of PASS_ENV) if (env[k] != null) out[k] = env[k];
  return { ...out, RUNSTAT_USERS: usersDir, RUNSTAT_RAW: paths.raw, RUNSTAT_SNAPSHOT: paths.snapshot, RUNSTAT_SECRETS: paths.secrets };
}

export function saveUsers(usersDir, list) {
  const users = validateUsers(list);
  writeJsonAtomic(join(usersDir, 'users.json'), users);
  return users;
}

/**
 * Compte d'une requête selon la zone (port) qui l'a reçue :
 * { user, admin } ou { status, error }. `admin` : gestion des comptes, seulement par le tailnet et pour le propriétaire.
 */
export function resolveUser(accounts, zone, headers) {
  const owner = accounts.users.find((u) => u.role === 'owner');
  if (!accounts.multi) return { user: owner, admin: false };
  if (zone === 'lan') return { user: owner, admin: false };
  if (zone !== 'tailnet') return { status: 403, error: 'accès refusé' };
  const login = String(headers['tailscale-user-login'] ?? '').trim().toLowerCase();
  if (!login) return { status: 403, error: 'identité Tailscale absente' };
  const user = accounts.users.find((u) => u.logins.includes(login));
  if (!user) return { status: 403, error: `aucun compte pour ${login} : demande au propriétaire de t'ajouter` };
  if (user.mode !== 'hosted') return { status: 403, error: 'compte local-first : tes données sont sur ton appareil' };
  return { user, admin: user.role === 'owner' };
}
