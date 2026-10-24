import { Summary } from './models';

// ---------------------------------------------------------------------------
// Trajets entre villes (distances à vol d'oiseau, calculées par haversine)
// ---------------------------------------------------------------------------

const CITIES: Record<string, [number, number]> = {
  Paris: [48.8566, 2.3522],
  Versailles: [48.8049, 2.1204],
  Lyon: [45.764, 4.8357],
  Marseille: [43.2965, 5.3698],
  Toulouse: [43.6047, 1.4442],
  Nice: [43.7102, 7.262],
  Nantes: [47.2184, -1.5536],
  Montpellier: [43.6108, 3.8767],
  Strasbourg: [48.5734, 7.7521],
  Bordeaux: [44.8378, -0.5792],
  Lille: [50.6292, 3.0573],
  Rennes: [48.1173, -1.6778],
  Reims: [49.2583, 4.0317],
  'Le Havre': [49.4944, 0.1079],
  'Saint-Étienne': [45.4397, 4.3872],
  Toulon: [43.1242, 5.928],
  Grenoble: [45.1885, 5.7245],
  Dijon: [47.322, 5.0415],
  Angers: [47.4784, -0.5632],
  Nîmes: [43.8367, 4.3601],
  'Aix-en-Provence': [43.5297, 5.4474],
  'Clermont-Ferrand': [45.7772, 3.087],
  'Le Mans': [48.0061, 0.1996],
  Brest: [48.3904, -4.4861],
  Tours: [47.3941, 0.6848],
  Amiens: [49.8941, 2.2958],
  Limoges: [45.8336, 1.2611],
  Annecy: [45.8992, 6.1294],
  Perpignan: [42.6887, 2.8948],
  Metz: [49.1193, 6.1757],
  Besançon: [47.2378, 6.0241],
  Orléans: [47.903, 1.9093],
  Rouen: [49.4432, 1.0999],
  Caen: [49.1829, -0.3707],
  Nancy: [48.6921, 6.1844],
  Avignon: [43.9493, 4.8055],
  Poitiers: [46.5802, 0.3404],
  'La Rochelle': [46.1603, -1.1511],
  Pau: [43.2951, -0.3708],
  Bayonne: [43.4929, -1.4748],
  Ajaccio: [41.9192, 8.7386],
  Bruxelles: [50.8503, 4.3517],
  Genève: [46.2044, 6.1432],
  Barcelone: [41.3874, 2.1686],
  Madrid: [40.4168, -3.7038],
  Lisbonne: [38.7223, -9.1393],
  Londres: [51.5074, -0.1278],
  Berlin: [52.52, 13.405],
  Rome: [41.9028, 12.4964],
  Athènes: [37.9838, 23.7275],
  Istanbul: [41.0082, 28.9784],
  Moscou: [55.7558, 37.6173],
  Marrakech: [31.6295, -7.9811],
  Dakar: [14.7167, -17.4677],
  'Le Caire': [30.0444, 31.2357],
  Montréal: [45.5017, -73.5673],
  'New York': [40.7128, -74.006],
  Tokyo: [35.6762, 139.6503],
  Sydney: [-33.8688, 151.2093],
};

/** Villes proposées comme point de départ des trajets (réglage `homeCity` de l'athlète) */
export const CITY_NAMES = Object.keys(CITIES).sort((a, b) => a.localeCompare(b, 'fr'));
export const DEFAULT_CITY = 'Paris';

/** Grands classiques, quelle que soit la ville de départ */
const CLASSICS: [string, string][] = [
  ['Paris', 'Versailles'],
  ['Lille', 'Marseille'],
  ['Brest', 'Strasbourg'],
  ['Londres', 'Rome'],
  ['Lisbonne', 'Berlin'],
  ['Lisbonne', 'Moscou'],
];

export function haversineKm([lat1, lon1]: [number, number], [lat2, lon2]: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export interface Trip {
  from: string;
  to: string;
  km: number;
}

/** Trajets depuis la ville de départ vers toutes les autres, plus les grands classiques, du plus court au plus long */
export function tripsFrom(home: string = DEFAULT_CITY): Trip[] {
  const from = CITIES[home] ? home : DEFAULT_CITY;
  const pairs = [...Object.keys(CITIES).filter((c) => c !== from).map((to) => [from, to] as [string, string]), ...CLASSICS];
  const seen = new Set<string>();
  return pairs
    .filter(([a, b]) => {
      const key = [a, b].sort().join('|');
      return !seen.has(key) && seen.add(key);
    })
    .map(([a, b]) => ({ from: a, to: b, km: haversineKm(CITIES[a], CITIES[b]) }))
    .sort((a, b) => a.km - b.km);
}

export const TRIPS: Trip[] = tripsFrom();

/** Le plus long trajet déjà « couvert » et le prochain à atteindre. */
export function tripFor(distanceKm: number, home?: string): { done: Trip | null; next: Trip | null } {
  let done: Trip | null = null;
  let next: Trip | null = null;
  for (const t of home ? tripsFrom(home) : TRIPS) {
    if (t.km <= distanceKm) done = t;
    else {
      next = t;
      break;
    }
  }
  return { done, next };
}

// ---------------------------------------------------------------------------
// Repères (dénivelé, distances mythiques, comparaisons absurdes)
// ---------------------------------------------------------------------------

export interface Landmark {
  icon: string;
  name: string;
  /** Valeur de référence dans l'unité de la métrique comparée */
  value: number;
  unit: string;
  /** Nom de l'unité au pluriel quand on compte des objets (« baguettes ») */
  plural?: string;
  /** Repère moins « parlant », jamais mis en avant */
  abstract?: boolean;
}

/** Dénivelé positif, en mètres */
export const HEIGHTS: Landmark[] = [
  { icon: '🏛️', name: "l'Arc de Triomphe", value: 50, unit: 'm' },
  { icon: '⛪', name: 'les tours de Notre-Dame de Paris', value: 69, unit: 'm' },
  { icon: '🗽', name: 'la statue de la Liberté', value: 93, unit: 'm' },
  { icon: '🔺', name: 'la pyramide de Khéops', value: 139, unit: 'm' },
  { icon: '🏢', name: 'la tour Montparnasse', value: 210, unit: 'm' },
  { icon: '🗼', name: 'la tour Eiffel', value: 330, unit: 'm' },
  { icon: '🏙️', name: 'le Burj Khalifa', value: 828, unit: 'm' },
  { icon: '🔭', name: 'le Pic du Midi de Bigorre', value: 2877, unit: 'm' },
  { icon: '🏔️', name: 'le Mont Blanc', value: 4806, unit: 'm' },
  { icon: '🏔️', name: "l'Everest", value: 8849, unit: 'm' },
  { icon: '✈️', name: "l'altitude de croisière d'un avion de ligne", value: 11_000, unit: 'm', abstract: true },
  { icon: '🚀', name: "la limite de l'espace (ligne de Kármán)", value: 100_000, unit: 'm' },
  { icon: '🛰️', name: "l'orbite de l'ISS", value: 400_000, unit: 'm' },
];

/** Distances mythiques, en km */
export const LEGENDS: Landmark[] = [
  { icon: '🏅', name: 'Marathon', value: 42.195, unit: 'km' },
  { icon: '⛰️', name: 'UTMB', value: 171, unit: 'km' },
  { icon: '🥾', name: 'Chemin de Compostelle (Camino francés)', value: 780, unit: 'km' },
  { icon: '🏞️', name: 'GR10 (traversée des Pyrénées)', value: 900, unit: 'km' },
  { icon: '🚴', name: 'Tour de France', value: 3400, unit: 'km' },
  { icon: '🛣️', name: 'Route 66', value: 3940, unit: 'km' },
  { icon: '🧱', name: 'Grande Muraille de Chine', value: 21_196, unit: 'km' },
  { icon: '🌍', name: 'Tour de la Terre (équateur)', value: 40_075, unit: 'km' },
  { icon: '🌕', name: 'Terre → Lune', value: 384_400, unit: 'km' },
];

/** Comparaisons absurdes. `metric` indique la donnée de la période à utiliser. */
export interface FunItem extends Landmark {
  metric: FunMetric;
  /** L'équivalence affichée sous la tuile : « 1 baguette ≈ 65 cm » */
  ref: string;
}

export type FunMetric = 'meters' | 'steps' | 'calories' | 'minutes';

/** Les familles de comparaisons, dans l'ordre d'affichage, avec la source du total divisé. */
export const FUN_GROUPS: { metric: FunMetric; icon: string; title: string; how: string }[] = [
  { metric: 'meters', icon: '📏', title: 'En distance', how: 'les kilomètres parcourus, mis bout à bout' },
  { metric: 'steps', icon: '👟', title: 'En pas', how: 'estimés : cadence moyenne × durée de chaque sortie' },
  { metric: 'calories', icon: '🔥', title: 'En calories', how: 'dépense estimée par la montre Coros' },
  { metric: 'minutes', icon: '⏱️', title: 'En temps', how: 'le temps passé à courir' },
];

export const FUN: FunItem[] = [
  { icon: '🥖', name: 'baguette', plural: 'baguettes', ref: '1 baguette ≈ 65 cm', value: 0.65, unit: 'm', metric: 'meters' },
  { icon: '🏊', name: 'longueur', plural: 'longueurs de piscine olympique', ref: '1 longueur = 50 m', value: 50, unit: 'm', metric: 'meters' },
  { icon: '⚽', name: 'terrain de foot', plural: 'terrains de foot', ref: '1 terrain ≈ 105 m', value: 105, unit: 'm', metric: 'meters' },
  { icon: '🗼', name: 'escalier Eiffel', plural: "montées des marches de la tour Eiffel", ref: '1 montée = 1 665 marches', value: 1665, unit: 'pas', metric: 'steps' },
  { icon: '🥐', name: 'chocolatine', plural: 'chocolatines', ref: '1 chocolatine ≈ 280 kcal', value: 280, unit: 'kcal', metric: 'calories' },
  { icon: '🍔', name: 'Big Mac', plural: 'Big Mac', ref: '1 Big Mac ≈ 500 kcal', value: 500, unit: 'kcal', metric: 'calories' },
  { icon: '🍲', name: 'cassoulet', plural: 'assiettes de cassoulet', ref: '1 assiette ≈ 750 kcal', value: 750, unit: 'kcal', metric: 'calories' },
  { icon: '🍕', name: 'pizza', plural: 'pizzas margherita', ref: '1 pizza entière ≈ 850 kcal', value: 850, unit: 'kcal', metric: 'calories' },
  { icon: '🎬', name: 'Titanic', plural: 'fois Titanic', ref: '1 film = 3 h 14', value: 194, unit: 'min', metric: 'minutes' },
  { icon: '💍', name: 'Seigneur des Anneaux', plural: 'fois la trilogie du Seigneur des Anneaux', ref: 'version longue = 11 h 46', value: 706, unit: 'min', metric: 'minutes' },
  { icon: '🛋️', name: 'Friends', plural: "fois l'intégrale de Friends", ref: '236 épisodes ≈ 86 h', value: 236 * 22, unit: 'min', metric: 'minutes' },
];

export function funValue(metric: FunMetric, s: Summary): number | null {
  switch (metric) {
    case 'meters':
      return s.km * 1000;
    case 'calories':
      return s.calories || null;
    case 'minutes':
      return s.sec / 60;
    case 'steps':
      return s.steps || null;
  }
}

/** Repère de hauteur mis en avant : le plus haut qu'on dépasse au moins une fois. */
export function headlineHeight(elev: number): Landmark {
  let best = HEIGHTS[0];
  for (const h of HEIGHTS) if (elev >= h.value && !h.abstract) best = h;
  return best;
}

export const EIFFEL = HEIGHTS.find((h) => h.name === 'la tour Eiffel')!;
