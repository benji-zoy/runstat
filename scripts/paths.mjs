// Dossiers de données d'un run : data-raw (brut), snapshot (coros.json, routes.json servis au site) et secrets (jetons).
// RUNSTAT_RAW, RUNSTAT_SNAPSHOT, RUNSTAT_SECRETS (posés par server.mjs pour l'utilisateur du run), sinon les chemins
// historiques du dépôt (data-raw/, public/data/, secrets/ ; RUNSTAT_SECRETS seul sur l'ancien conteneur).
// Instance à plusieurs comptes (RUNSTAT_USERS/users.json présent) : une variable absente est une erreur, jamais un repli
// silencieux sur les données du propriétaire.
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Dossier des comptes : users.json, puis un dossier par compte (users/<id>/data-raw, snapshot, secrets) */
export const usersDir = () => process.env.RUNSTAT_USERS ?? join(root, 'users');
export const isMultiUser = () => existsSync(join(usersDir(), 'users.json'));

const LEGACY = {
  RUNSTAT_RAW: () => join(root, 'data-raw'),
  RUNSTAT_SNAPSHOT: () => join(root, 'public', 'data'),
  RUNSTAT_SECRETS: () => join(root, 'secrets'),
};

function pick(name) {
  const value = process.env[name];
  if (value) return value;
  if (isMultiUser()) throw new Error(`${name} absent : instance à plusieurs comptes, le run doit être lancé par server.mjs`);
  return LEGACY[name]();
}

export const rawDir = () => pick('RUNSTAT_RAW');
export const snapshotDir = () => pick('RUNSTAT_SNAPSHOT');
export const secretsDir = () => pick('RUNSTAT_SECRETS');
