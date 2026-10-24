// Analyse les fichiers FIT (fit/*.fit) et les tracés sans FIT (tracks/*.{gpx,tcx,json}[.gz] : archive et API Strava)
// et met en cache un résumé par sortie dans fit-derived/<clé>.json (fit/analyse.ts). Un fichier dont le cache est à
// la version courante n'est pas relu, sauf avec `force`.
import { analyse, FIT_VERSION } from '../fit/analyse.ts';
import { gunzip, parseFit } from '../fit/parse-fit.ts';
import { parseTrack } from '../fit/track.ts';
import type { FitAthlete } from '../fit/types.ts';
import { decodeText, readJson, type FileStore } from '../storage/types.ts';

export interface FitSource {
  /** Clé de fichier = identifiant de la sortie (« strava-123 » pour « strava:123 », voir sources.ts) */
  key: string;
  path: string;
  /** Tracé : format et compression ; absent pour un FIT */
  ext?: string;
  gz?: boolean;
}

/** Fichiers à analyser : FIT d'abord ; un tracé (tracks/) seulement pour une sortie sans FIT */
export async function fitSources(raw: FileStore): Promise<FitSource[]> {
  const list: FitSource[] = (await raw.list('fit')).filter((f) => f.endsWith('.fit')).map((f) => ({ key: f.slice(0, -4), path: `fit/${f}` }));
  const keys = new Set(list.map((x) => x.key));
  for (const f of await raw.list('tracks')) {
    const m = f.match(/^(.+)\.(gpx|tcx|json)(\.gz)?$/);
    if (m && !keys.has(m[1])) keys.add(m[1]), list.push({ key: m[1], path: `tracks/${f}`, ext: m[2], gz: Boolean(m[3]) });
  }
  return list;
}

/** Analyse d'un fichier brut (FIT ou tracé) */
export async function analyseSource(bytes: Uint8Array, source: Pick<FitSource, 'ext' | 'gz'>, athlete: FitAthlete) {
  const data = source.ext
    ? parseTrack(source.ext, decodeText(source.gz ? await gunzip(bytes) : bytes))
    : await parseFit(bytes);
  return analyse(data, athlete);
}

export interface BuildFitResult {
  done: number;
  skipped: number;
  failed: number;
  total: number;
  warnings: string[];
}

export async function buildFit(raw: FileStore, { force = false }: { force?: boolean } = {}): Promise<BuildFitResult> {
  const athlete = await readJson<FitAthlete>(raw, 'athlete.json');
  if (!athlete) throw new Error('athlete.json absent');
  const files = await fitSources(raw);
  const warnings: string[] = [];
  let done = 0, skipped = 0, failed = 0;
  for (const source of files) {
    const out = `fit-derived/${source.key}.json`;
    if (!force) {
      try {
        if ((await readJson<{ v?: number }>(raw, out))?.v === FIT_VERSION) {
          skipped++;
          continue;
        }
      } catch {}
    }
    try {
      const res = await analyseSource((await raw.read(source.path))!, source, athlete);
      await raw.write(out, JSON.stringify(res ?? { v: FIT_VERSION, empty: true }));
      done++;
    } catch (e) {
      warnings.push(`Échec ${source.key} : ${e instanceof Error ? e.message : e}`);
      failed++;
    }
  }
  return { done, skipped, failed, total: files.length, warnings };
}

export const buildFitSummary = ({ done, skipped, failed, total }: BuildFitResult): string =>
  `FIT et tracés : ${done} analysés, ${skipped} en cache, ${failed} en échec (${total} fichiers)`;
