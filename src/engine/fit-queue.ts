// File des fichiers FIT à télécharger (COROS, 50 par jour) : les sorties sans FIT, par ordre d'utilité
// (courses → sorties longues → fractionné/tempo → le reste, du plus récent au plus ancien).

export interface QueueActivity {
  id: string;
  sportType: number;
  date: string;
  name: string;
  distanceKm: number;
  durationSec: number;
  anaerobicTE?: number | null;
  focus?: string | null;
}

export interface FitQueue<T> {
  race: T[];
  long: T[];
  quality: T[];
  rest: T[];
}

/** @param activities sorties du snapshot (ordre chronologique) ; `have` : clés des FIT présents */
export function fitQueue<T extends QueueActivity>(activities: T[], have: Set<string>): FitQueue<T> {
  const todo = activities.filter((a) => !have.has(a.id)).reverse();
  const race = (a: T) => /marathon|semi|10 ?km de|corrida|trail des|run in|\b20\d\d$/i.test(a.name) && !/allure|intervalle|séance|-S\d/i.test(a.name);
  const long = (a: T) => !race(a) && (a.distanceKm >= 18 || a.durationSec >= 90 * 60);
  const quality = (a: T) =>
    !race(a) && !long(a) &&
    ((a.anaerobicTE ?? 0) >= 3 || ['Threshold', 'VO2 Max', 'Anaerobic', 'Tempo'].includes(a.focus ?? '') ||
      /vma|fraction|intervalle|seuil|tempo|\d+ ?x ?\d/i.test(a.name));
  const groups = { race: todo.filter(race), long: todo.filter(long), quality: todo.filter(quality) };
  const used = new Set([...groups.race, ...groups.long, ...groups.quality].map((a) => a.id));
  return { ...groups, rest: todo.filter((a) => !used.has(a.id)) };
}

/** Contenu de fit-queue.txt : `<id> <sportType> <date> <nom>` par ligne */
export const fitQueueText = <T extends QueueActivity>(q: FitQueue<T>): string =>
  [...q.race, ...q.long, ...q.quality, ...q.rest].map((a) => [a.id, a.sportType, a.date, a.name].join(' ')).join('\n') + '\n';
