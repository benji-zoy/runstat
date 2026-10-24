// Fichiers de secrets (clients OAuth, tokens) : dossier de l'utilisateur du run (RUNSTAT_SECRETS, scripts/paths.mjs),
// ou celui passé explicitement par le service (server.mjs sert plusieurs comptes dans un même processus).
// Les tokens ne sont jamais affichés.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { secretsDir } from '../paths.mjs';

export { secretsDir };
/** Erreur d'autorisation persistante (src/engine/sync/http.ts) : la source doit être reconnectée */
export { ReauthRequired } from '#engine/sync/http.ts';

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

/** Magasin de jetons du moteur (TokenStore) sur un dossier de secrets ; savedAt = date de modification du fichier */
export function nodeTokens(dir = secretsDir()) {
  return {
    read: async (name) => readSecret(name, dir),
    write: async (name, value) => writeSecret(name, value, dir),
    savedAt: async (name) => {
      const file = join(dir, name);
      return existsSync(file) ? statSync(file).mtimeMs : null;
    },
  };
}
