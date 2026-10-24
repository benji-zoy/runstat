// Fichiers de secrets (clients OAuth, tokens) : dossier secrets/ à la racine (hors git),
// ou RUNSTAT_SECRETS (volume Docker monté sur le NAS). Les tokens ne sont jamais affichés.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const secretsDir = process.env.RUNSTAT_SECRETS ?? join(root, 'secrets');

export function readSecret(name) {
  const file = join(secretsDir, name);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** Écriture atomique, lisible par le seul propriétaire */
export function writeSecret(name, value) {
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const file = join(secretsDir, name);
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  chmodSync(file, 0o600);
}

/** Erreur d'autorisation persistante : la source doit être ré-autorisée à la main */
export class ReauthRequired extends Error {
  constructor(source, detail) {
    super(`Ré-autorisation nécessaire pour ${source} (${detail}) : npm run auth -- ${source}`);
    this.source = source;
  }
}
