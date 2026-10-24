// Saisie depuis le site (objectifs, bilans, classements, réglages, sources) : écriture dans data-raw/. La validation
// (fonctions pures, testées par sync.test.mjs) est dans le moteur, partagée avec l'appli en mode local-first.
import { writeFileSync, renameSync, mkdirSync, existsSync, readFileSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ACTIVITY_ID, fileKey } from './sources.mjs';
import { DATE_RESULT, validateResult } from '#engine/entries.ts';

export { ACTIVITY_ID };
export { DATE_RESULT, InvalidEntry, validateAthlete, validateGoal, validateGoals, validateResult, validateSources } from '#engine/entries.ts';

// ---------- fichiers ----------

/** Écriture atomique : un lecteur (build-data) ne voit jamais un fichier à moitié écrit */
/** Écriture atomique, droits explicites (0644) : sur le NAS, les ACL héritées de DSM ouvriraient le fichier à tous */
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, file);
}

export const readJsonFile = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);

/** Enregistre le classement d'une sortie ; `replaces` : ancien fichier rattaché par la date, supprimé */
export function saveResult(raw, activityId, body, replaces) {
  const res = validateResult(activityId, body);
  writeJsonAtomic(join(raw, 'results', `${fileKey(activityId)}.json`), res);
  if (replaces && DATE_RESULT.test(replaces)) unlinkSync(join(raw, 'results', replaces));
  return res;
}

/** Supprime le classement d'une sortie (et l'éventuel fichier rattaché par la date) ; vrai si un fichier existait */
export function deleteResult(raw, activityId, replaces) {
  let found = false;
  for (const f of [`${fileKey(activityId)}.json`, replaces && DATE_RESULT.test(replaces) ? replaces : null]) {
    const file = f && join(raw, 'results', f);
    if (file && existsSync(file)) (unlinkSync(file), (found = true));
  }
  return found;
}
