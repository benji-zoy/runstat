export type RunKind = 'road' | 'indoor' | 'trail' | 'track' | 'other';

export type ActivitySource = 'coros' | 'strava';
export type HealthSource = 'google' | 'coros' | 'none';

export interface Activity {
  /** LabelId COROS, ou « strava:<id> » */
  id: string;
  /** Absent dans les instantanés d'avant le choix des sources : COROS */
  source?: ActivitySource;
  /** Code de sport COROS (100 route, 101 tapis, 102 trail, 103 piste), aussi pour Strava */
  sportType: number;
  kind: RunKind;
  /** Jour local au format YYYY-MM-DD */
  date: string;
  name: string;
  start: number | null;
  durationSec: number;
  distanceKm: number;
  avgHr: number | null;
  calories: number | null;
  lat: number | null;
  lon: number | null;
  // Champs issus du détail de l'activité (absents si non enrichie)
  elevGain?: number | null;
  elevLoss?: number | null;
  cadence?: number | null;
  stride?: number | null;
  power?: number | null;
  trainingLoad?: number | null;
  aerobicTE?: number | null;
  anaerobicTE?: number | null;
  focus?: string | null;
  bestKmSec?: number | null;
  /** Marquée « course » dans Strava (workout_type) */
  race?: boolean;
  /** Analyse du fichier FIT (seconde par seconde), si téléchargé */
  fit?: FitAnalysis;
  /** Temps (s) de chaque kilomètre complet */
  splits?: number[];
  /** Tours au km : [distance m, temps s, FC, D+, D−, allure ajustée s/km, puissance W, cadence] (FIT ou tours Coros) */
  km?: number[][];
  /** Classement officiel (data-raw/results), pour une course */
  result?: RaceResult;
  /** Météo moyenne pendant la sortie (Open-Meteo) ; vent à 10 m en km/h, `dir` = d'où il vient (°) */
  weather?: { temp: number; dew: number; rh: number; wind: number; dir?: number };
  /** Altitude du point de départ (m, modèle de terrain), pour les sorties sans FIT */
  startAlt?: number;
}

/**
 * Classement d'une course, relevé sur la page de résultats officielle (organisateur ou chronométreur).
 * Seuls des effectifs sont conservés, aucun nom d'autre coureur.
 */
export interface RaceResult {
  event: string;
  /** Format couru (« 10 km », « parcours L »…) */
  course: string | null;
  distanceKm: number | null;
  elevGain?: number | null;
  officialSec: number | null;
  gunSec?: number | null;
  rank: number | null;
  finishers: number | null;
  sex: 'M' | 'F' | null;
  sexRank: number | null;
  sexCount: number | null;
  category: string | null;
  catRank: number | null;
  catCount: number | null;
  label?: string | null;
  source: string;
  timing?: string | null;
  fetchedAt: string;
  note?: string | null;
  /** Classement pas encore relevé (résultats inaccessibles aux robots) : à recopier depuis `source` */
  pending?: boolean;
  /** Fichier rattaché par la date (`date-AAAA-MM-JJ-<km>.json`), remplacé par `<id>.json` à la saisie */
  file?: string;
}

export interface FitAnalysis {
  duration: number;
  distance: number;
  /** Distance « équivalent plat » (Minetti 2002) */
  gapDistance: number;
  maxHr: number | null;
  /** Seuils de FC utilisés pour les 3 zones */
  lt: [number, number];
  /** Secondes dans les zones < 60 / 60-70 / 70-80 / 80-90 / > 90 % FCmax */
  zones5: number[];
  /** Secondes sous LT1, entre LT1 et LT2, au-dessus de LT2 */
  zones3: number[];
  trimp: number;
  /** Meilleur temps (s) par distance (m), brut et ajusté à la pente */
  efforts: Record<string, number | null>;
  effortsGap: Record<string, number | null>;
  /** Distance maximale (m) par durée (s) */
  curve: Record<string, number | null>;
  /** Distance ajustée à la pente maximale (m) par durée (s) */
  curveGap?: Record<string, number | null>;
  /** Meilleur D+ / D− cumulé (m) par durée (s) : 5 min … 3 h */
  climb?: Record<string, number | null> | null;
  descent?: Record<string, number | null> | null;
  /**
   * Par tranche de pente (< −15 %, −15/−8, −8/−3, ±3 %, 3/8, 8/15, > 15 %) :
   * [secondes, distance m, distance ajustée m, D+ m, D− m, secondes avec FC, somme FC × s]
   */
  terrain?: number[][] | null;
  /** Découplage Pa:HR en % (positif = la FC dérive) */
  decoupling: number | null;
  /** Efficacité par bloc de 15 min, relative au bloc 15-30 min */
  durability: (number | null)[] | null;
  lapCount: number;
  lapCv: number | null;
  avgPower: number | null;
  /** Température moyenne du capteur de la montre (°C) */
  sensorTemp?: number | null;
  /** Altitude moyenne pondérée par le temps (m) */
  altMean?: number | null;
  /** Par secteur de cap de 22,5° depuis le nord (16) : [secondes, mètres] */
  headings?: number[][] | null;
}

export interface Athlete {
  /** Poids forcé d'une course dans les calculs (0 = ignorée), par identifiant de sortie */
  raceWeights?: Record<string, number>;
  hrMax: number;
  hrRest: number;
  /** Seuils ventilatoires (FC), sinon 80 % et 89 % de la FC max (zones de build-fit) */
  lt1Hr?: number;
  lt2Hr?: number;
  sex: 'M' | 'F';
  weightKg: number;
  heightCm: number;
  birthday: string;
  /** Ville de départ des trajets des équivalences (CITY_NAMES), Paris par défaut */
  homeCity?: string;
}

export interface Fitness {
  vo2max: number | null;
  runningLevel: number | null;
  thresholdPace: string | null;
  predictions: Record<string, string | null>;
}

export interface LoadDay {
  date: string;
  comment: string | null;
  shortTerm: number;
  longTerm: number;
  ratio: number;
}

export interface HealthDay {
  /** FC de repos (bpm) */
  rhr?: number;
  /** VFC nocturne (RMSSD, ms) */
  hrv?: number;
  nremHr?: number;
  /** Score de préparation Google/Fitbit (0-100) */
  readiness?: number;
  breath?: number;
  skinTemp?: number;
  spo2?: number;
  /** Minutes de sommeil (toutes sessions) et de la nuit principale */
  sleepMin?: number;
  sleepMain?: number;
  awakeMin?: number;
  sleepScore?: number | null;
  deepMin?: number | null;
  remPct?: number | null;
  sleepGoal?: number | null;
}

export interface Health {
  importedAt: string;
  /** Dernière synchronisation de l'API Google Health (scripts/sync/run.mjs) */
  syncedAt?: string;
  /** Par date locale (YYYY-MM-DD) ; le sommeil est rattaché à la date du réveil */
  days: Record<string, HealthDay>;
  weight: { date: string; kg: number }[];
}

/** Objectif de course (data-raw/goals.json) */
export interface Goal {
  id: string;
  name: string;
  /** Jour local du départ (YYYY-MM-DD) */
  date: string;
  /** Heure de départ « HH:MM » */
  startTime?: string;
  distanceKm: number;
  elevGain?: number;
  /** Dénivelé négatif (m) ; absent = égal au D+ (boucle) */
  elevLoss?: number;
  /** Chrono visé (s) ; absent = objectif « finir » */
  targetSec?: number;
  /** Chrono ambitieux d'une fourchette (« 10 h 30 / 11 h » : targetSec = 11 h, stretchSec = 10 h 30) */
  stretchSec?: number;
  kind: 'road' | 'trail';
  /** Lieu du départ pour la météo (sinon : ton lieu de sortie habituel) */
  lat?: number;
  lon?: number;
  /** Prévision Open-Meteo pendant la course (disponible ~15 jours avant) */
  forecast?: { temp: number; dew: number; rh: number; wind: number; fetchedAt: string } | null;
  /** Après la course : temps officiel (puce), gels pris (km), ressenti */
  debrief?: GoalDebriefNotes;
}

export interface GoalDebriefNotes {
  chipSec?: number;
  gelsKm?: number[];
  notes?: string[];
}

export interface CorosData {
  generatedAt: string;
  /** Sources de l'instance (data-raw/sources.json) ; absent : COROS + Google Health */
  sources?: { activities: ActivitySource; health: HealthSource };
  athlete: Athlete | null;
  health: Health | null;
  goals?: Goal[];
  activities: Activity[];
  fitness: Fitness | null;
  load: LoadDay[];
}

export interface Summary {
  count: number;
  km: number;
  sec: number;
  elev: number;
  /** Nombre d'activités pour lesquelles le dénivelé est connu */
  elevKnown: number;
  calories: number;
  steps: number;
  avgPaceSec: number | null;
  avgHr: number | null;
}

export interface Period {
  key: string;
  gran: 'week' | 'month' | 'year' | 'all';
  /** Libellé affiché dans le navigateur de période */
  label: string;
  /** Complète « Vous avez parcouru X km … » */
  phrase: string;
  start: Date;
  /** Exclusif ; s'arrête à demain pour une période en cours */
  end: Date;
  /** La période contient aujourd'hui */
  current: boolean;
  prev: { start: Date; end: Date; label: string } | null;
}
