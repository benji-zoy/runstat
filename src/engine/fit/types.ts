// Structure de sortie de fit-file-parser (mode « list ») réduite aux champs utilisés ; les tracés sans FIT
// (fit/track.ts) produisent la même structure.

export interface FitRecord {
  timer_time?: number;
  distance?: number;
  heart_rate?: number;
  altitude?: number;
  enhanced_altitude?: number;
  position_lat?: number;
  position_long?: number;
  cadence?: number;
  power?: number;
  temperature?: number;
  /** Allure ajustée de Coros (champ développeur), m/s */
  'Effort Pace'?: number;
}

export interface FitLap {
  total_distance?: number;
  total_timer_time?: number;
}

export interface FitSession {
  avg_power?: number | null;
}

export interface FitData {
  records?: FitRecord[];
  laps?: FitLap[];
  sessions?: FitSession[];
}

/** Réglages de l'athlète utilisés par l'analyse (data-raw/athlete.json) */
export interface FitAthlete {
  hrMax: number;
  hrRest: number;
  lt1Hr?: number | null;
  lt2Hr?: number | null;
}

/** Résumé d'une sortie (data-raw/fit-derived/<clé>.json) */
export interface FitDerived {
  v: number;
  duration: number;
  distance: number;
  gapDistance: number;
  maxHr: number | null;
  lt: [number, number];
  zones5: number[];
  zones3: number[];
  trimp: number;
  efforts: Record<string, number | null>;
  effortsGap: Record<string, number | null>;
  curve: Record<string, number | null>;
  curveGap: Record<string, number | null>;
  climb: Record<string, number | null> | null;
  descent: Record<string, number | null> | null;
  /** Par tranche de pente : [secondes, distance m, distance ajustée m, D+ m, D− m, secondes avec FC, somme FC × s] */
  terrain: number[][] | null;
  decoupling: number | null;
  durability: (number | null)[] | null;
  lapCount: number;
  lapCv: number | null;
  sensorTemp: number | null;
  avgPower: number | null;
  splits: number[];
  km: number[][];
  route: string | null;
  altMean: number | null;
  headings: number[][] | null;
}

/** Cache d'une sortie sans analyse possible */
export interface FitEmpty {
  v: number;
  empty: true;
}
