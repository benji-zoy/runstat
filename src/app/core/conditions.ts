import { Activity, Athlete } from './models';
import { SessionType, efficiency, heatPenalty, isComparableEasy, theilSen } from './science';
import { REF_TEMP } from './matrix';
import { clock, num, pace } from './format';

// ---------------------------------------------------------------------------
// Coût des conditions d'une sortie (façon « rapport Enduraw ») : altitude, dénivelé, température et vent, en %
// du temps, par rapport à des conditions standard (plat, niveau de la mer, 12 °C, sans vent).
// Convention : pct < 0 = la condition a coûté ; temps standard = durée × Π(1 + pct / 100).
// ---------------------------------------------------------------------------

export type ConditionKey = 'altitude' | 'elevation' | 'heat' | 'wind';

export interface ConditionFactor {
  key: ConditionKey;
  emoji: string;
  label: string;
  pct: number;
  /** Raison courte, au format du rapport (« dû au manque d'oxygène ») */
  cause: string;
  /** Détail chiffré (« 620 m de moyenne ») */
  detail: string;
  /** Sans FIT : altitude du départ, D+ Coros ou caps uniformes */
  estimated: boolean;
  model: 'perso' | 'standard';
}

export interface ConditionsReport {
  factors: ConditionFactor[];
  totalPct: number;
  standardSec: number;
  /** Allure (s/km) en conditions standard */
  standardPace: number;
  /** Sortie sans FIT : le tracé affinerait le vent, l'altitude et le dénivelé */
  estimated: boolean;
}

/** Coefficients mesurés sur l'historique de l'athlète (null : pas assez de données, modèle standard) */
export interface PersonalCoefficients {
  /** Mètres « équivalent plat » nets par mètre de D+ sur une boucle (Minetti sur les FIT) */
  elevNet: number | null;
  /** Perte d'efficacité (EF) en % par °C au-dessus de 12 °C, sur des sorties d'environ 1 h */
  heatPerDeg: number | null;
}

// Modèle aérodynamique (Pugh 1971 ; di Prampero 1986)
const CD_A_REF = 0.24; // m², coureur de 1,8 m² de surface corporelle
const MUSCLE_EFFICIENCY = 0.5; // travail contre l'air → énergie métabolique
const RUN_COST = 3.6; // J/kg/m sur le plat, hors air (Minetti 2002, tapis)
const WIND_2M = 0.7; // vent à 10 m → hauteur du coureur (profil logarithmique, terrain dégagé)
const TAILWIND_GAIN = 0.5; // une poussée nette du vent n'est récupérée qu'à moitié (Davies 1980)
// Altitude : VO₂max −6,3 %/1000 m au-dessus de 300 m (Wehrlin & Hallén 2006) ; en course, environ 55 % de cette
// perte se retrouve sur le chrono (10 000 m de Mexico 1968, 2 240 m : +6,5 %)
const ALT_THRESHOLD = 300;
const ALT_VO2_PER_KM = 0.063;
const ALT_TRANSFER = 0.55;
// Dénivelé sans FIT : Minetti à ±8 % (montée nette / descente nette) et boucle typique
const ELEV_UP = 6.5;
const ELEV_DOWN = 4.2;
const ELEV_NET_DEFAULT = 1.4;
// Chaleur : la règle de Hadley vaut pour un marathon ; effet de moitié sur 30 min
const COLD_BELOW = 5;
const COLD_PER_DEG = 0.15;
const MIN_HEAT_RUNS = 15;
const MIN_ELEV_RUNS = 20;

const SECTORS = 16;
const COMPASS = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Masse volumique de l'air (kg/m³) selon l'altitude (atmosphère standard) et la température */
export function airDensity(altM: number, tempC: number): number {
  const p = 101325 * Math.pow(1 - 2.25577e-5 * Math.max(0, altM), 5.25588);
  return p / (287.05 * (tempC + 273.15));
}

/** Surface frontale × coefficient de traînée, à l'échelle de la surface corporelle (Du Bois) */
function cdA(ath: Athlete): number {
  const bsa = 0.007184 * Math.pow(ath.weightKg, 0.425) * Math.pow(ath.heightCm, 0.725);
  return (CD_A_REF * bsa) / 1.8;
}

/**
 * Puissance métabolique (W) à la vitesse v (m/s), avec un vent de face `head` (m/s, négatif = de dos)
 * et de travers `cross` : traînée ½·ρ·CdA·|V_rel|·(v + head), le long de la course.
 */
function metabolicPower(v: number, head: number, cross: number, rho: number, area: number, mass: number): number {
  const along = v + head;
  const rel = Math.hypot(along, cross);
  let drag = 0.5 * rho * area * rel * along;
  if (drag < 0) drag *= TAILWIND_GAIN;
  return mass * RUN_COST * v + (drag * v) / MUSCLE_EFFICIENCY;
}

/** Vitesse qui demande la même puissance métabolique sans vent (bissection) */
function speedAtPower(power: number, rho: number, area: number, mass: number): number {
  let lo = 0.1, hi = 15;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    metabolicPower(mid, 0, 0, rho, area, mass) > power ? (hi = mid) : (lo = mid);
  }
  return (lo + hi) / 2;
}

/** Durée → part de l'effet chaleur (½ à 30 min, plein à 2 h 30, comme le marathon de Hadley) */
function heatScale(sec: number): number {
  return clamp(0.5 + (0.5 * (sec - 1800)) / (9000 - 1800), 0.5, 1);
}

/** Coefficients personnels : dénivelé (FIT) et chaleur (EF des sorties faciles comparables) */
export function personalCoefficients(acts: Activity[], types: Map<string, SessionType>): PersonalCoefficients {
  // Boucles (D+ ≈ D−) avec FIT : équivalent plat net par mètre de D+
  const loops = acts
    .filter((a) => a.fit && (a.elevGain ?? 0) > 20 && a.elevLoss && Math.abs(a.elevGain! - a.elevLoss) < 0.2 * a.elevGain!)
    .map((a) => (a.fit!.gapDistance - a.fit!.distance) / a.elevGain!);
  const elevNet = loops.length >= MIN_ELEV_RUNS ? median(loops) : null;

  // Chaleur : pente Theil-Sen de l'EF au-delà de 12 °C, rapportée à l'EF médiane par temps frais (8-14 °C)
  const easy = acts
    .filter((a) => a.weather && isComparableEasy(a, types.get(a.id)))
    .map((a) => ({ x: a.weather!.temp, y: efficiency(a)! }));
  const warm = easy.filter((p) => p.x >= REF_TEMP);
  const cool = easy.filter((p) => p.x >= 8 && p.x <= 14).map((p) => p.y);
  let heatPerDeg: number | null = null;
  if (warm.length >= MIN_HEAT_RUNS && cool.length >= 5) {
    const slope = (theilSen(warm) / median(cool)) * 100;
    if (slope < 0) heatPerDeg = -slope;
  }
  return { elevNet, heatPerDeg };
}

function signed(pct: number): string {
  if (Math.abs(pct) < 0.05) return '0 %';
  return `${pct > 0 ? '+' : '−'}${num(Math.abs(pct), 1)} %`;
}

export function formatPct(pct: number): string {
  return signed(pct);
}

function altitudeFactor(a: Activity, alt: number, temp: number, ath: Athlete, fit: boolean): ConditionFactor {
  const oxygen = -ALT_TRANSFER * ALT_VO2_PER_KM * (Math.max(0, alt - ALT_THRESHOLD) / 1000) * 100;
  // Air moins dense : moins de traînée, à puissance égale (sans vent)
  const v = (a.distanceKm * 1000) / a.durationSec;
  const area = cdA(ath);
  const p = metabolicPower(v, 0, 0, airDensity(alt, temp), area, ath.weightKg);
  const vStd = speedAtPower(p, airDensity(0, REF_TEMP), area, ath.weightKg);
  const air = (v / vStd - 1) * 100;
  const pct = oxygen + air;
  const cause =
    pct <= -0.05 ? "dû au manque d'oxygène" : pct >= 0.05 ? "grâce à l'air plus léger" : 'au niveau de la mer ou presque';
  const detail = `${num(alt)} m${fit ? ' de moyenne' : ' au départ'}`;
  return { key: 'altitude', emoji: '🗻', label: 'Altitude', pct, cause, detail, estimated: !fit, model: 'standard' };
}

function elevationFactor(a: Activity, coef: PersonalCoefficients): ConditionFactor | null {
  const up = a.elevGain ?? 0;
  const down = a.elevLoss ?? 0;
  const dist = a.distanceKm * 1000;
  let extra: number;
  let estimated = false;
  let model: 'perso' | 'standard' = 'standard';
  if (a.fit && a.fit.distance > 0) {
    // Distance « équivalent plat » de Minetti, ramenée à la distance de la sortie
    extra = (a.fit.gapDistance / a.fit.distance - 1) * dist;
  } else {
    estimated = true;
    model = coef.elevNet !== null ? 'perso' : 'standard';
    const loop = Math.min(up, down);
    extra = loop * (coef.elevNet ?? ELEV_NET_DEFAULT) + ELEV_UP * Math.max(0, up - down) - ELEV_DOWN * Math.max(0, down - up);
  }
  if (!dist) return null;
  const pct = (dist / Math.max(1, dist + extra) - 1) * 100;
  const cause =
    Math.abs(pct) < 0.3
      ? 'parcours quasiment plat'
      : pct < 0
        ? "dû à l'effort nécessaire pour braver les côtes"
        : 'grâce à un parcours descendant';
  const detail = up || down ? `${num(up)} m D+ / ${num(down)} m D−` : 'sans dénivelé';
  return { key: 'elevation', emoji: '🚠', label: 'Dénivelé', pct, cause, detail, estimated, model };
}

function heatFactor(a: Activity, coef: PersonalCoefficients): ConditionFactor | null {
  const w = a.weather;
  if (!w) return null;
  let pct: number;
  let model: 'perso' | 'standard' = 'standard';
  if (w.temp < COLD_BELOW) {
    pct = -Math.min(3, COLD_PER_DEG * (COLD_BELOW - w.temp)) * heatScale(a.durationSec);
  } else if (coef.heatPerDeg !== null && w.temp > REF_TEMP) {
    // Pente mesurée sur des sorties d'environ 1 h, étendue à la durée de la sortie
    model = 'perso';
    pct = -Math.min(15, (coef.heatPerDeg * (w.temp - REF_TEMP) * heatScale(a.durationSec)) / heatScale(3600));
  } else {
    pct = -heatPenalty(w.temp, w.dew) * heatScale(a.durationSec);
  }
  const cause =
    w.temp < COLD_BELOW
      ? 'car froid, muscles moins efficaces'
      : pct > -0.3
        ? 'température idéale'
        : w.temp >= 25
          ? 'car très chaud, pas optimal pour les muscles'
          : w.dew >= 16
            ? 'car chaud et humide, le corps peine à se refroidir'
            : w.temp >= 20
              ? 'car chaud'
              : "un peu au-dessus de l'idéal (12 °C)";
  const detail = `${num(w.temp)} °C, rosée ${num(w.dew)} °C`;
  return { key: 'heat', emoji: '🔥', label: 'Température', pct, cause, detail, estimated: false, model };
}

function windFactor(a: Activity, alt: number, ath: Athlete): ConditionFactor | null {
  const w = a.weather;
  if (!w) return null;
  const wind = (w.wind / 3.6) * WIND_2M;
  const rho = airDensity(alt, w.temp);
  const area = cdA(ath);
  // Temps et distance par secteur de cap ; sans tracé, caps uniformes (boucle)
  const fromTrack = !!a.fit?.headings?.some(([t]) => t > 0);
  const sectors = fromTrack
    ? a.fit!.headings!
    : Array.from({ length: SECTORS }, () => [a.durationSec / SECTORS, (a.distanceKm * 1000) / SECTORS]);
  const known = w.dir !== undefined && fromTrack;
  const total = sectors.reduce((s, [t]) => s + t, 0);
  let tStd = 0;
  let headTime = 0;
  let tailTime = 0;
  sectors.forEach(([t, d], i) => {
    if (t <= 0 || d <= 0) return;
    const v = d / t;
    // Sans direction connue (ou sans tracé), on moyenne sur toutes les orientations du vent
    const angles = known ? [((w.dir! - i * (360 / SECTORS)) * Math.PI) / 180] : [...Array(SECTORS)].map((_, k) => (k * 2 * Math.PI) / SECTORS);
    let stdT = 0;
    for (const ang of angles) {
      const head = wind * Math.cos(ang);
      const cross = wind * Math.sin(ang);
      const p = metabolicPower(v, head, cross, rho, area, ath.weightKg);
      stdT += d / speedAtPower(p, rho, area, ath.weightKg);
      if (known) head > 0.3 ? (headTime += t) : head < -0.3 ? (tailTime += t) : null;
    }
    tStd += stdT / angles.length;
  });
  if (!total || !tStd) return null;
  const pct = (tStd / total - 1) * 100;
  const cause =
    w.wind < 5 || Math.abs(pct) < 0.05
      ? 'pas de vent notable'
      : Math.abs(pct) < 0.25
        ? 'vent faible, effet négligeable'
      : pct > 0
        ? 'car le vent était de dos et donc favorable'
        : known && headTime > 2 * tailTime
          ? 'car le vent était surtout de face'
          : 'le vent de face coûte plus que le vent de dos ne rend';
  const from = w.dir !== undefined ? ` de ${COMPASS[Math.round(w.dir / 45) % 8]}` : '';
  const detail = `${num(w.wind)} km/h${from}`;
  return { key: 'wind', emoji: '💨', label: 'Vent', pct, cause, detail, estimated: !fromTrack, model: 'standard' };
}

/** Rapport des conditions d'une sortie ; null pour le tapis et les sorties de moins de 10 min */
export function conditionsCost(a: Activity, ath: Athlete, coef: PersonalCoefficients): ConditionsReport | null {
  if (a.kind === 'indoor' || a.durationSec < 600 || a.distanceKm < 1) return null;
  const fitAlt = a.fit?.altMean ?? null;
  const alt = fitAlt ?? a.startAlt ?? null;
  const temp = a.weather?.temp ?? REF_TEMP;
  const factors = [
    alt !== null ? altitudeFactor(a, alt, temp, ath, fitAlt !== null) : null,
    elevationFactor(a, coef),
    heatFactor(a, coef),
    windFactor(a, alt ?? 0, ath),
  ].filter((f): f is ConditionFactor => f !== null);
  if (!factors.length) return null;
  const ratio = factors.reduce((r, f) => r * (1 + f.pct / 100), 1);
  const standardSec = a.durationSec * ratio;
  return {
    factors,
    totalPct: (ratio - 1) * 100,
    standardSec,
    standardPace: standardSec / a.distanceKm,
    estimated: !a.fit,
  };
}

/** 93 → « 1 min 33 », 42 → « 42 s », 4 000 → « 1:06:40 » */
function gapText(sec: number): string {
  const s = Math.round(Math.abs(sec));
  if (s < 60) return `${s} s`;
  if (s >= 3600) return clock(s);
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
}

/** Nom d'un facteur dans une phrase (« la chaleur », « le vent »…) */
function factorName(f: ConditionFactor, a: Activity): string {
  if (f.key === 'heat') return (a.weather?.temp ?? REF_TEMP) < COLD_BELOW ? 'le froid' : 'la chaleur';
  return { altitude: "l'altitude", elevation: 'le dénivelé', wind: 'le vent' }[f.key];
}

const joinFr = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} et ${xs.at(-1)}` : xs[0]);
/** « le vent » → « au vent », « la chaleur » → « à la chaleur », « l'altitude » → « à l'altitude » */
const toA = (name: string) => (name.startsWith('le ') ? `au ${name.slice(3)}` : `à ${name}`);

/**
 * Synthèse en une ou deux phrases : effet total, facteurs qui ont compté (≥ 0,3 %), et l'allure en conditions standard.
 * « Les conditions t'ont coûté environ 2,7 % (1 min 33), surtout la chaleur (−1,7 %) et le dénivelé (−0,8 %). … »
 */
export function conditionsSummary(a: Activity, r: ConditionsReport): string {
  const notable = r.factors.filter((f) => Math.abs(f.pct) >= 0.3).sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct));
  const named = (f: ConditionFactor) => ({ name: factorName(f, a), pct: ` (${signed(f.pct)})` });
  const costs = notable.filter((f) => f.pct < 0).slice(0, 2).map(named);
  const helps = notable.filter((f) => f.pct > 0).slice(0, 2).map(named);
  const list = (xs: { name: string; pct: string }[], form = (n: string) => n) => joinFr(xs.map((x) => form(x.name) + x.pct));
  const gap = a.durationSec - r.standardSec;
  const pace0 = pace(a.durationSec / a.distanceKm);
  if (Math.abs(r.totalPct) < 0.5 && !notable.length) {
    return `Conditions quasi idéales : ton allure de ${pace0} /km reflète bien ta forme du jour.`;
  }
  let first: string;
  if (Math.abs(r.totalPct) < 0.5) {
    first = `Les conditions se sont à peu près compensées${costs.length ? ` : ${list(costs)} d'un côté` : ''}${helps.length ? `, ${list(helps)} de l'autre` : ''}.`;
  } else if (r.totalPct < 0) {
    first =
      `Les conditions t'ont coûté environ ${num(-r.totalPct, 1)} % (${gapText(gap)})` +
      (costs.length ? `, surtout ${list(costs)}` : '') +
      (helps.length ? ` ; ${list(helps)} ${helps.length > 1 ? "t'ont" : "t'a"} un peu aidé` : '') +
      '.';
  } else {
    first =
      `Les conditions t'ont aidé d'environ ${num(r.totalPct, 1)} % (${gapText(gap)})` +
      (helps.length ? `, grâce ${list(helps, toA)}` : '') +
      (costs.length ? ` malgré ${list(costs)}` : '') +
      '.';
  }
  const second =
    Math.abs(r.totalPct) < 0.5
      ? ''
      : ` En conditions standard, tu aurais couru à ${pace(r.standardPace)} /km au lieu de ${pace0}.`;
  return first + second + (r.estimated ? ' Estimation sans tracé.' : '');
}

/** Texte à coller dans la description Strava / Coros */
export function reportText(a: Activity, r: ConditionsReport): string {
  const lines = r.factors.map((f) => `${f.label} ${f.emoji} : ${signed(f.pct)} ${f.cause}`);
  const gap = a.durationSec - r.standardSec;
  return [
    conditionsSummary(a, r),
    '',
    ...lines,
    '',
    `En conditions standard (plat, niveau de la mer, 12 °C, sans vent) : ${clock(r.standardSec)} soit ${pace(r.standardPace)} /km ` +
      `(${gap >= 0 ? '−' : '+'}${clock(Math.abs(gap))}).`,
    '— Analyse RunStat',
  ].join('\n');
}
