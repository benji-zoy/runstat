// Fichiers de secrets (clients OAuth, tokens) : dossier de l'utilisateur du run (RUNSTAT_SECRETS, scripts/paths.mjs),
// ou celui passé explicitement par le service (server.mjs sert plusieurs comptes dans un même processus).
// Les tokens ne sont jamais affichés.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { secretsDir } from '../paths.mjs';

export { secretsDir };

export function readSecret(name, dir = secretsDir()) {
  const file = join(dir, name);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** Écriture atomique, lisible par le seul propriétaire */
export function writeSecret(name, value, dir = secretsDir()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
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
