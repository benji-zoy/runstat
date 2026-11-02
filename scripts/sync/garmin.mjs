// Client de la Garmin Connect Personal API en lecture seule : enveloppe Node du client portable (src/engine/sync/garmin.ts).
// Clé personnelle créée par l'athlète sur Garmin Connect (connect.garmin.com/app/settings/personalApiToken, 30 jours à un
// an), saisie dans Réglages (PUT /api/garmin/key) : secrets/garmin-key.json = { apiKey, days, savedOn }, jamais relue par
// le site. Appel direct depuis le NAS (le CORS ne joue pas) ; le jeton Bearer de 24 h reste en mémoire du run.
import { garminClient, garminKeyExpiry, validateGarminKey, GARMIN_KEY_FILE } from '#engine/sync/garmin.ts';
import { ReauthRequired } from '#engine/sync/http.ts';
import { InvalidEntry } from '#engine/entries.ts';
import { readSecret, writeSecret, nodeTokens, secretsDir } from './secrets.mjs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

/** Adresse de l'API (tests : serveur simulé) */
export const API = process.env.GARMIN_API_URL ?? 'https://personal.connectapi.garmin.com';

export const garminAt = (dir = secretsDir()) => garminClient({ tokens: nodeTokens(dir), api: API });

/** État Garmin pour GET /api/sync : présence de la clé et expiration approximative, jamais la clé. `dir` : secrets du compte */
export function garminStatus(dir) {
  let key = null;
  try {
    key = readSecret(GARMIN_KEY_FILE, dir);
  } catch {
    // fichier en cours d'écriture
  }
  return { garminConnected: Boolean(key?.apiKey), garminExpiresOn: key?.apiKey ? garminKeyExpiry(key) : null };
}

/**
 * PUT /api/garmin/key : validation, essai d'un jeton auprès de Garmin (clé refusée → 400 sans rien écrire), puis
 * enregistrement (la pause « ré-autorisation » se lève). InvalidEntry pour une saisie invalide ou une clé refusée.
 */
export async function saveGarminKey(dir, body, { fetch } = {}) {
  const key = validateGarminKey(body);
  try {
    await garminClient({ tokens: nodeTokens(dir), api: API, ...(fetch && { fetch }) }).verify(key.apiKey);
  } catch (e) {
    if (e instanceof ReauthRequired) throw new InvalidEntry(['Clé refusée par Garmin : vérifie-la, ou crée-en une nouvelle']);
    throw e;
  }
  writeSecret(GARMIN_KEY_FILE, key, dir);
  return garminStatus(dir);
}

/** DELETE /api/garmin/key */
export function removeGarminKey(dir) {
  rmSync(join(dir, GARMIN_KEY_FILE), { force: true });
  return garminStatus(dir);
}
