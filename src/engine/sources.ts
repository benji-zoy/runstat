// Sources de données d'une instance (data-raw/sources.json) et identifiants de sortie.
// Une seule source d'activités par instance (pas de dédoublonnage) ; santé au choix ou aucune.

export type ActivitySource = 'coros' | 'strava';
export type HealthSource = 'google' | 'coros' | 'none';
export interface Sources {
  activities: ActivitySource;
  health: HealthSource;
}

export const ACTIVITY_SOURCES: readonly ActivitySource[] = ['coros', 'strava'];
export const HEALTH_SOURCES: readonly HealthSource[] = ['google', 'coros', 'none'];
/** Sans fichier : le fonctionnement d'origine (COROS + Google Health) */
export const DEFAULT_SOURCES: Sources = { activities: 'coros', health: 'google' };

/** Contenu de sources.json (absent, partiel ou invalide) → sources valides */
export function normalizeSources(s: unknown): Sources {
  const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
  return {
    activities: ACTIVITY_SOURCES.includes(o['activities'] as ActivitySource)
      ? (o['activities'] as ActivitySource)
      : DEFAULT_SOURCES.activities,
    health: HEALTH_SOURCES.includes(o['health'] as HealthSource) ? (o['health'] as HealthSource) : DEFAULT_SOURCES.health,
  };
}

/** Identifiant de sortie : LabelId COROS (chiffres) ou « strava:<id> » */
export const ACTIVITY_ID = /^(\d{1,30}|strava:\d{1,30})$/;

/** Nom de fichier d'une sortie (fit/, fit-derived/, tracks/, results/…) : pas de « : » sur un partage SMB */
export const fileKey = (id: string): string => id.replace(':', '-');
/** Inverse de fileKey : « strava-123 » → « strava:123 » */
export const idFromFileKey = (key: string): string => key.replace(/^strava-(?=\d+$)/, 'strava:');
