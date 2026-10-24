import { ActivitySource, CorosData, HealthSource } from './models';

/** Ce que chaque source d'activités fournit : l'interface masque le reste au lieu d'afficher des « – » */
export interface Capabilities {
  label: string;
  /** Charge d'entraînement de la montre ; sinon TRIMP calculé par build-data */
  corosLoad: boolean;
  /** Effet d'entraînement aérobie / anaérobie et focus de séance */
  trainingEffect: boolean;
  /** VO₂max, niveau, allure seuil et prédictions de la montre */
  corosFitness: boolean;
  /** Ratio de charge court / long terme de la montre */
  loadRatio: boolean;
  /** Tracé d'une sortie à la demande limité à 50 par jour */
  fitQuota: boolean;
  loadLabel: string;
}

export const CAPABILITIES: Record<ActivitySource, Capabilities> = {
  coros: {
    label: 'COROS',
    corosLoad: true,
    trainingEffect: true,
    corosFitness: true,
    loadRatio: true,
    fitQuota: true,
    loadLabel: 'Charge Coros',
  },
  strava: {
    label: 'Strava',
    corosLoad: false,
    trainingEffect: false,
    corosFitness: false,
    loadRatio: false,
    fitQuota: false,
    loadLabel: 'Charge (TRIMP)',
  },
};

export const HEALTH_LABELS: Record<HealthSource, string> = { google: 'Google Health', coros: 'COROS', none: '' };

/** Sources de l'instantané ; absentes (instantané d'avant le choix des sources) : COROS + Google Health */
export function sourcesOf(d: Pick<CorosData, 'sources'> | null): { activities: ActivitySource; health: HealthSource } {
  return { activities: d?.sources?.activities ?? 'coros', health: d?.sources?.health ?? 'google' };
}
