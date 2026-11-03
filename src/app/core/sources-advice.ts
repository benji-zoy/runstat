import { ActivitySource, HealthSource } from './models';

export type Watch = 'coros' | 'garmin' | 'other';
export type StravaPlan = 'none' | 'free' | 'paid';

export interface SourceAnswers {
  watch: Watch;
  strava: StravaPlan;
  /** Données Google Health / Fitbit (montre Fitbit ou Pixel Watch) */
  google: boolean;
  /** Appli publique (données sur l'appareil) : Garmin et Google passent par le compte hébergé */
  local: boolean;
}

export interface SourceAdvice {
  activities: ActivitySource;
  health: HealthSource;
  /** Pourquoi ce choix, en une phrase */
  headline: string;
  /** Marche à suivre, dans l'ordre */
  steps: string[];
  /** Ce que la personne ne doit pas attendre, ou ce qu'elle peut ajouter */
  notes: string[];
}

const GOOGLE_HISTORY = 'Google Health : pour l’historique et le score de préparation, importe d’abord le Takeout (Google Takeout › Google Health) ; l’API prend ensuite le relais chaque jour.';
const ARCHIVE_STEPS = [
  'Strava : Paramètres › Mon compte › Télécharger ou supprimer ton compte › Demander une archive (le zip arrive par e-mail).',
  'Réglages › « Importer l’archive » : tout l’historique, avec les tracés, arrive d’un coup.',
];

/** Meilleure source d'activités et de santé selon la montre, l'abonnement Strava et Google Health : le plus de données dès le départ.
 * Une seule source d'activités, sans dédoublonnage : on prend la plus riche, jamais deux. */
export function adviseSources(a: SourceAnswers): SourceAdvice {
  const stravaNote = a.strava === 'none'
    ? []
    : ['Strava n’ajouterait rien : une seule source d’activités, et ta montre donne un historique plus riche. Seul l’historique d’avant ta montre manquerait.'];
  const accountNote = a.local ? ['Dans l’appli publique, Garmin et Google passent par le NAS qui t’héberge : il te faut un compte.'] : [];

  if (a.watch === 'coros') {
    return {
      activities: 'coros',
      health: a.google ? 'google' : 'coros',
      headline: 'COROS est la source la plus riche : charge, effet d’entraînement, VO₂max, prédictions de la montre et santé.',
      steps: [
        'Réglages › « Connecter COROS » et autorise RunStat (une seule connexion à la fois).',
        ...(a.google ? ['Réglages › « Connecter Google » pour le sommeil et la préparation.', GOOGLE_HISTORY] : []),
        'La première synchro récupère toute la liste des sorties et leurs détails.',
      ],
      notes: [
        'Les tracés seconde par seconde (FIT) arrivent à 50 par jour, courses et sorties longues d’abord : les analyses fines se complètent sur quelques jours.',
        ...stravaNote,
        ...(a.google && a.local ? ['Dans l’appli publique, Google passe par le NAS qui t’héberge : il te faut un compte.'] : []),
      ],
    };
  }

  if (a.watch === 'garmin') {
    const withStrava = a.strava === 'paid';
    return {
      activities: 'garmin',
      health: a.google ? 'google' : 'garmin',
      headline: 'Garmin direct donne tout l’historique, les fichiers FIT d’origine et la santé, sans abonnement.',
      steps: [
        'Crée ta clé personnelle sur connect.garmin.com (Personal API Key, gratuite, depuis un ordinateur) et colle-la dans Réglages › Synchro Garmin.',
        'La première synchro récupère tout l’historique et les FIT, puis un an de santé.',
        ...(a.google ? [GOOGLE_HISTORY] : []),
      ],
      notes: [
        'La clé expire (30 jours à un an) : choisis un an pour ne la refaire que rarement.',
        ...(withStrava
          ? ['Garmin reste préférable à ton Strava payant. Choisis plutôt Strava (activités) avec Garmin (santé) seulement si tes sorties viennent de plusieurs appareils ou applis.']
          : stravaNote),
        ...accountNote,
      ],
    };
  }

  const health: HealthSource = a.google ? 'google' : 'none';
  const healthNote = a.google ? [] : ['Sans Google Health, la carte Récupération de Comprendre est masquée : la montre n’est pas lue pour la santé.'];
  if (a.strava === 'paid') {
    return {
      activities: 'strava',
      health,
      headline: 'Strava par son API : synchro automatique, avec les tracés des sorties récentes.',
      steps: [
        'Réglages › Synchro Strava : crée ta petite appli sur strava.com/settings/api (5 minutes, une seule fois) et colle son Client ID et son Client Secret.',
        '« Connecter Strava » : l’historique complet est lu à la première synchro.',
        ...(a.google ? [GOOGLE_HISTORY] : []),
      ],
      notes: [
        'Les tracés sont récupérés 40 sorties par synchro, et Strava limite le débit : les graphiques fins se complètent sur plusieurs synchros.',
        'Pour tout avoir tout de suite, tu peux aussi importer ton archive Strava une fois (elle contient les tracés de tout l’historique).',
        ...healthNote,
      ],
    };
  }
  if (a.strava === 'free') {
    return {
      activities: 'strava',
      health,
      headline: 'Strava gratuit ne donne pas d’API : l’archive Strava apporte tout l’historique d’un coup.',
      steps: [...ARCHIVE_STEPS, ...(a.google ? [GOOGLE_HISTORY] : [])],
      notes: [
        'Pas de mise à jour automatique : pour les sorties suivantes, redemande une archive de temps en temps (ou passe à Strava payant pour la synchro).',
        ...healthNote,
      ],
    };
  }
  return {
    activities: 'strava',
    health,
    headline: 'RunStat lit COROS, Garmin ou Strava. Sans l’un des deux premiers, le plus simple est Strava.',
    steps: [
      'Crée un compte Strava gratuit et fais-y synchroniser ta montre ou ton appli de course.',
      ...ARCHIVE_STEPS,
      ...(a.google ? [GOOGLE_HISTORY] : []),
    ],
    notes: ['Ton historique doit déjà être sur Strava pour être importé.', ...healthNote],
  };
}
