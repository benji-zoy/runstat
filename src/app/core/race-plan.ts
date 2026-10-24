/**
 * Stratégie de course d'un objectif : plan d'allure et temps de passage, cardio, ravitaillement, derniers jours,
 * échauffement, conditions, leçons des courses de référence.
 *
 * Repères usuels, personnalisés avec tes données : FC max et poids (athlete.json), chrono prédit, courses déjà faites
 * sur la distance, prévision météo. Nutrition : recommandations ACSM / Burke (glucides 30-60 g/h jusqu'à 2 h 30,
 * 60-90 g/h au-delà ; recharge 7-12 g/kg selon la durée). Chaleur : règle de Hadley.
 */
import type { RaceReference } from './goals';
import { Activity, Athlete, Goal } from './models';
import { heatPenalty, wallAnalysis } from './science';
import { clock, pace } from './format';
import { addDays, parseDay } from './stats';

export interface PlanInput {
  goal: Goal;
  daysLeft: number;
  ke: number;
  predicted: number;
  probability: number | null;
  raceRefs: RaceReference[];
  athlete: Athlete;
  acts: Activity[];
}

export interface PaceSegment {
  label: string;
  from: number;
  to: number;
  /** Allure (s/km) pour le chrono visé, et pour le chrono le plus probable */
  target: number | null;
  realistic: number;
  tip: string;
}

export interface Checkpoint {
  km: number;
  target: number | null;
  realistic: number;
}

export interface PlanBlock {
  icon: string;
  title: string;
  items: string[];
}

export interface RacePlan {
  segments: PaceSegment[];
  checkpoints: Checkpoint[];
  /** Allure à lire sur la montre : la distance GPS dépasse la distance officielle (mesuré sur tes courses) */
  watch: { drift: number; from: string; /** Allure réelle de croisière (objectif, sinon probable) */ actual: number; /** Allure affichée par la montre */ shown: number } | null;
  blocks: PlanBlock[];
}

// ---------------------------------------------------------------------------
// Allure
// ---------------------------------------------------------------------------

interface ProfilePart {
  label: string;
  /** Bornes en fraction de la distance quand `frac`, sinon en km */
  from: number;
  to: number;
  /** Route : écart à l'allure de base (s/km) ; trail : facteur multiplicatif */
  shift: number;
  tip: string;
}

/** Découpage de la course : départ prudent, croisière, final (route) ; quarts à fatigue croissante (trail) */
export function pacingProfile(distanceKm: number, kind: Goal['kind']): { label: string; from: number; to: number; shift: number; tip: string }[] {
  const D = distanceKm;
  let parts: ProfilePart[];
  if (kind === 'trail') {
    parts = [
      { label: 'Départ', from: 0, to: 0.25 * D, shift: 0.92, tip: 'Très prudent : marche dès que ça monte, tu dois pouvoir parler. Les bouchons du début ne sont pas du temps perdu.' },
      { label: 'Installation', from: 0.25 * D, to: 0.5 * D, shift: 0.98, tip: 'Trouve ton rythme, mange et bois avant d\'avoir faim ou soif.' },
      { label: 'Le dur', from: 0.5 * D, to: 0.75 * D, shift: 1.03, tip: 'Le passage difficile (souvent au plus froid de la nuit) : petits objectifs, de ravito en ravito.' },
      { label: 'Final', from: 0.75 * D, to: D, shift: 1.07, tip: 'Quadriceps fatigués : petits pas rapides en descente, relance sur le plat.' },
    ];
  } else if (D <= 12) {
    parts = [
      { label: 'Départ', from: 0, to: 2, shift: 3, tip: 'Ne te laisse pas embarquer par la foule : 2 à 3 s/km plus lent que la cible.' },
      { label: 'Croisière', from: 2, to: 8, shift: 0, tip: 'Allure cible, régulière ; épaules relâchées, respiration ample.' },
      { label: 'Final', from: 8, to: D, shift: -4, tip: 'Accélère progressivement, tout donner sur le dernier kilomètre.' },
    ];
  } else if (D <= 25) {
    parts = [
      { label: 'Mise en route', from: 0, to: 3, shift: 3, tip: 'Laisse partir la foule, 2 à 3 s/km plus lent : la FC met quelques minutes à se stabiliser.' },
      { label: 'Croisière', from: 3, to: 16, shift: 0, tip: 'Régularité : contrôle les temps de passage aux panneaux km plutôt que l\'allure instantanée.' },
      { label: 'Final', from: 16, to: D, shift: -3, tip: 'Plus que 5 km : si la FC le permet, accélère d\'un cran, puis vide le réservoir sur le dernier km.' },
    ];
  } else if (D <= 45) {
    parts = [
      { label: 'Mise en route', from: 0, to: 5, shift: 4, tip: 'Le piège du marathon : chaque seconde gagnée au départ se paie au 30e km.' },
      { label: 'Croisière', from: 5, to: 30, shift: 0, tip: 'Allure cible, ravitaillement régulier dès le 5e km, cherche un groupe.' },
      { label: 'Tenir', from: 30, to: D, shift: 0, tip: 'Tenir l\'allure ; ne relance qu\'après le 35e si tout va bien.' },
    ];
  } else {
    parts = [
      { label: 'Départ', from: 0, to: 0.15 * D, shift: 3, tip: 'Départ prudent.' },
      { label: 'Croisière', from: 0.15 * D, to: 0.75 * D, shift: 0, tip: 'Allure régulière.' },
      { label: 'Final', from: 0.75 * D, to: D, shift: -2, tip: 'Accélère si tu le peux.' },
    ];
  }
  return parts;
}

/** Allure (s/km) de chaque tronçon pour que la somme fasse exactement `total` secondes */
export function segmentPaces(total: number, distanceKm: number, kind: Goal['kind']): number[] {
  const parts = pacingProfile(distanceKm, kind);
  if (kind === 'trail') {
    const base = total / parts.reduce((s, p) => s + (p.to - p.from) * p.shift, 0);
    return parts.map((p) => base * p.shift);
  }
  const base = (total - parts.reduce((s, p) => s + (p.to - p.from) * p.shift, 0)) / distanceKm;
  return parts.map((p) => base + p.shift);
}

/** Temps de passage au km `x` avec des allures par tronçon */
export function passage(x: number, parts: { from: number; to: number }[], paces: number[]): number {
  return parts.reduce((t, p, i) => t + Math.max(0, Math.min(x, p.to) - p.from) * paces[i], 0);
}

function checkpointsKm(D: number, kind: Goal['kind']): number[] {
  const step = kind === 'trail' ? (D > 50 ? 20 : 10) : 5;
  const out = kind === 'trail' ? [] : [1];
  for (let k = step; k < D - 0.5; k += step) out.push(k);
  out.push(D);
  return out;
}

// ---------------------------------------------------------------------------
// Plan complet
// ---------------------------------------------------------------------------

const frNum = (x: number, digits = 0) => x.toLocaleString('fr-FR', { maximumFractionDigits: digits });
/** Arrondi à la dizaine : 494 → « 490 » */
const tens = (x: number) => frNum(Math.round(x / 10) * 10);
const hm = (sec: number) => `${Math.floor(sec / 3600)} h ${String(Math.round((sec % 3600) / 60)).padStart(2, '0')}`;
const dayLabel = (d: Date) => d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric' });
const shortDate = (d: Date) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
/** Minutes depuis minuit → « 9 h 15 » */
const hourLabel = (min: number) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
};

export function racePlan(p: PlanInput): RacePlan {
  const { goal, athlete } = p;
  const D = goal.distanceKm;
  const trail = goal.kind === 'trail';
  const hours = p.predicted / 3600;
  const race = parseDay(goal.date);
  const startMin = goal.startTime ? Number(goal.startTime.slice(0, 2)) * 60 + Number(goal.startTime.slice(3, 5)) : 9 * 60;
  const night = startMin >= 20 * 60 || startMin < 5 * 60;
  const w = athlete.weightKg;
  const roadRefs = trail ? [] : p.raceRefs;
  const ref = roadRefs[0] ?? null;

  // Allure par tronçon et temps de passage
  const parts = pacingProfile(D, goal.kind);
  const real = segmentPaces(p.predicted, D, goal.kind);
  const tgt = goal.targetSec ? segmentPaces(goal.targetSec, D, goal.kind) : null;
  const segments: PaceSegment[] = parts.map((s, i) => ({
    label: s.label, from: s.from, to: s.to, target: tgt?.[i] ?? null, realistic: real[i], tip: s.tip,
  }));
  const checkpoints = checkpointsKm(D, goal.kind).map((km) => ({
    km,
    target: tgt ? passage(km, parts, tgt) : null,
    realistic: passage(km, parts, real),
  }));

  // Écart GPS mesuré sur les courses de référence (la montre « mesure » plus long que le tracé officiel)
  const drifts = roadRefs.filter((r) => r.gpsDrift > 0 && r.gpsDrift < 0.04);
  const drift = drifts.length ? drifts.reduce((s, r) => s + r.gpsDrift, 0) / drifts.length : 0;
  const cruise = parts.findIndex((s) => s.shift === 0);
  const actual = cruise >= 0 ? (tgt ?? real)[cruise] : 0;
  const watch = drift > 0.002 && cruise >= 0
    ? { drift, from: drifts.map((r) => r.activity.name).join(', '), actual, shown: actual / (1 + drift) }
    : null;

  const blocks: PlanBlock[] = [];

  // Cardio
  const [lo, hi] = trail ? (hours > 6 ? [0.68, 0.78] : [0.75, 0.85]) : D <= 12 ? [0.9, 0.95] : D <= 25 ? [0.86, 0.91] : [0.8, 0.86];
  const bpm = (x: number) => Math.round(x * athlete.hrMax);
  const cardio = [`Zone de croisière : ${bpm(lo)} à ${bpm(hi)} bpm (${Math.round(lo * 100)} à ${Math.round(hi * 100)} % de ta FC max de ${athlete.hrMax}).`];
  for (const r of roadRefs.slice(0, 2)) {
    const a = r.activity;
    if (!a.avgHr) continue;
    const km = (a.km ?? []).filter((k) => k[2] > 0 && k[0] >= 900);
    const third = Math.floor(km.length / 3);
    const avgHr = (xs: number[][]) => Math.round(xs.reduce((s, k) => s + k[2], 0) / xs.length);
    cardio.push(
      `${a.name} : ${a.avgHr} bpm de moyenne (${Math.round((r.hrPct ?? 0) * 100)} %) à ${pace(r.pace)} /km` +
        (third >= 2 ? `, de ${avgHr(km.slice(0, third))} bpm sur le premier tiers à ${avgHr(km.slice(-third))} sur le dernier.` : '.'),
    );
  }
  cardio.push(
    trail
      ? `En montée la FC grimpe vite : passe en marche active dès qu'elle dépasse ${bpm(hi)} bpm. C'est la clé pour durer.`
      : `Garde-fou : au-dessus de ${bpm(hi) + 2} bpm avant le km ${Math.round((2 * D) / 3)}, ralentis de 5 s/km. Ne regarde pas la FC avant le 3e km, elle n'est pas encore stabilisée.`,
  );
  blocks.push({ icon: '❤️', title: 'Cardio', items: cardio });

  // Ravitaillement
  const temp = goal.forecast?.temp ?? null;
  const water = temp !== null && temp >= 20 ? '600 à 900 ml' : temp !== null && temp < 10 ? '300 à 500 ml' : '400 à 700 ml';
  const food: string[] = [];
  if (hours < 1.25) {
    food.push('Pas besoin de glucides pendant la course : le petit-déjeuner et un gel 10 min avant le départ suffisent.');
    food.push('Quelques gorgées d\'eau aux ravitaillements, surtout au-delà de 18 °C.');
  } else if (hours < 2.5) {
    const gels = hours < 1.75 ? [0.45] : [0.35, 0.7];
    food.push(`≈ ${hm(p.predicted)} de course : 30 à 60 g de glucides par heure, soit ${gels.length + 1} gels au total.`);
    food.push(`Un gel 10 à 15 min avant le départ, puis ${gels.map((f) => `au km ${Math.round(f * D)} (≈ ${Math.round(passage(f * D, parts, real) / 60)}e minute)`).join(' et ')}, avec de l'eau.`);
    food.push(`Quelques gorgées à chaque ravitaillement (${water} par heure selon la chaleur) ; prends ton gel juste avant un ravito.`);
  } else {
    food.push(`≈ ${hm(p.predicted)} d'effort : 60 à 90 g de glucides par heure, soit ${frNum(60 * hours)} à ${frNum(90 * hours)} g (≈ ${Math.round((60 * hours) / 25)} à ${Math.round((90 * hours) / 25)} gels ou équivalent).`);
    food.push(`Commence dès la 30e minute, puis toutes les 20 à 30 min, sans attendre la faim. Eau : ${water} par heure.`);
    if (hours > 3) food.push('Sodium : 300 à 600 mg par heure (boisson d\'effort ou pastilles de sel), davantage si tu transpires beaucoup.');
    if (hours > 6) food.push('Alterne sucré et salé dès la 3e heure (compote, bouillon, pain, fromage, soupe) : l\'estomac sature des gels.');
    if (trail && night) food.push('La nuit, une boisson chaude à chaque ravito aide à garder la température.');
  }
  const wall = [...p.acts].reverse().find((a) => a.distanceKm >= 40 && wallAnalysis(a)?.wall);
  if (wall && (D >= 30 || trail)) {
    food.push(`${wall.name} s'est terminé au mur au km ${wallAnalysis(wall)!.wallKm} : l'énergie est ton point faible, ne saute aucune prise.`);
  }
  food.push('Rien de nouveau le jour J : uniquement des produits déjà testés à l\'entraînement.');
  blocks.push({ icon: '🍌', title: 'Ravitaillement', items: food });

  // Derniers jours
  if (p.daysLeft >= 0) {
    const days: string[] = [];
    if (hours < 1.5) days.push(`La veille : repas riches en glucides (≈ ${frNum(7 * w)} g dans la journée, 7 g/kg), pauvres en fibres et en graisses.`);
    else if (hours < 4) days.push(`Recharge J-2 et J-1 : 7 à 10 g de glucides par kg, soit ${tens(7 * w)} à ${tens(10 * w)} g par jour (pâtes, riz, pain, semoule, jus), en réduisant fibres et graisses.`);
    else days.push(`Recharge de J-3 à J-1 : 10 à 12 g de glucides par kg, soit ${tens(10 * w)} à ${tens(12 * w)} g par jour, fractionnés (collations, jus, compotes).`);
    days.push(
      night
        ? `Départ à ${hourLabel(startMin)} : vrai repas riche en glucides vers ${hourLabel(startMin - 240)}, collation 1 h avant, et essaie de dormir 1 à 2 h l'après-midi.`
        : `Petit-déjeuner vers ${hourLabel(startMin - 180)} (3 h avant) : 1 à 2 g de glucides par kg (${tens(w)} à ${tens(2 * w)} g), aliments habituels, peu de fibres.`,
    );
    if (!trail && p.daysLeft <= 7) {
      const plan: Record<number, string> = {
        4: '40 min faciles',
        3: '30 à 40 min faciles avec 3 × 1 km à allure cible',
        2: 'repos ou 20 min très faciles',
        1: '15 à 20 min faciles et 4 lignes droites',
      };
      const steps = [4, 3, 2, 1].filter((n) => n <= p.daysLeft).map((n) => {
        const d = addDays(race, -n);
        return `${n === p.daysLeft ? 'aujourd\'hui' : dayLabel(d)} : ${plan[n]}`;
      });
      if (steps.length) days.push(`Dernières sorties : ${steps.join(' ; ')}.`);
    } else if (p.daysLeft > 7) {
      const taper = trail || D > 30 ? 14 : 10;
      days.push(`Affûtage à partir du ${shortDate(addDays(race, -taper))} : volume −30 % puis −50 %, en gardant de courtes séances à allure course.`);
    }
    days.push(`La nuit de J-2 compte plus que celle de la veille (souvent agitée) : couche-toi tôt dès ${dayLabel(addDays(race, -2))}.`);
    days.push(`Prépare tout la veille : dossard, épingles, gels, tenue déjà portée, montre chargée${trail ? ', frontale et batteries de rechange, matériel obligatoire' : ''}.`);
    blocks.push({ icon: '🍝', title: 'Les derniers jours', items: days });
  }

  // Échauffement et départ
  const warm: string[] = [];
  if (trail) {
    warm.push('Pas d\'échauffement : les 30 premières minutes très lentes en tiennent lieu.');
    warm.push('Place-toi au milieu du peloton : assez devant pour éviter les gros bouchons, assez loin pour ne pas partir trop vite.');
    if (night) warm.push('Allume la frontale avant le départ et vérifie son autonomie (mode éco sur les portions roulantes).');
  } else if (D > 30) {
    warm.push(`Échauffement minimal vers ${hourLabel(startMin - 20)} : 5 à 10 min de trottinement et 2 accélérations. Les premiers km plus lents font le reste.`);
    warm.push('Place-toi dans le sas de ton allure cible, pas devant.');
  } else {
    warm.push(`Sur place vers ${hourLabel(startMin - 60)}. Échauffement de ${hourLabel(startMin - 30)} à ${hourLabel(startMin - 15)} : 10 à 15 min de footing très facile, quelques gammes et 3 ou 4 accélérations progressives de 80 m.`);
    warm.push('Reste au chaud jusqu\'au départ (vieux t-shirt à jeter si frais) et place-toi dans le sas de ton allure cible.');
  }
  blocks.push({ icon: '🔥', title: 'Échauffement et départ', items: warm });

  // Conditions et tenue
  const cond: string[] = [];
  const f = goal.forecast;
  if (f) {
    cond.push(`Prévision : ${Math.round(f.temp)} °C, point de rosée ${Math.round(f.dew)} °C, vent ${Math.round(f.wind)} km/h.`);
    cond.push(
      f.temp < 5 ? 'Froid : manches longues, gants et bonnet légers, couche jetable au départ.'
        : f.temp < 10 ? 'Frais : t-shirt et manchettes (ou manches longues fines), gants légers, vieux pull à jeter dans le sas.'
        : f.temp < 17 ? 'Conditions idéales : t-shirt et short.'
        : f.temp < 22 ? 'Doux : tenue légère, casquette, bois dès le premier ravitaillement.'
        : 'Chaleur : casquette, mouille-toi la nuque à chaque ravitaillement, et ralentis dès le départ.',
    );
    const heat = heatPenalty(f.temp, f.dew);
    if (heat > 0.3) cond.push(`Chaleur et humidité coûtent ≈ ${frNum(heat, 1)} % (règle de Hadley), soit ${Math.round((heat / 100) * (p.predicted / D))} s/km : intègre-les dès le départ plutôt que de les subir à la fin.`);
    if (f.wind >= 15) cond.push(`Vent de ${Math.round(f.wind)} km/h : abrite-toi dans un groupe sur les portions face au vent.`);
    if (ref?.activity.weather) cond.push(`Pour comparer, il faisait ${Math.round(ref.activity.weather.temp)} °C à ${ref.activity.name}.`);
  } else {
    cond.push(p.daysLeft > 15 ? 'Prévision météo disponible à J-15 (npm run weather puis npm run data).' : 'Pas encore de prévision : lance npm run weather puis npm run data.');
  }
  const month = race.getMonth();
  if (trail && night && (month >= 9 || month <= 2)) {
    cond.push('Nuit d\'automne ou d\'hiver : prévois du froid (proche de 0 °C sur les hauteurs) : couches techniques, gants, bonnet, veste imperméable, couverture de survie.');
  }
  blocks.push({ icon: '🌦️', title: 'Conditions et tenue', items: cond });

  // Leçons des courses de référence
  const lessons: string[] = [];
  for (const r of p.raceRefs.slice(0, 3)) {
    const a = r.activity;
    if (trail) {
      lessons.push(`${a.name} : ${frNum(a.distanceKm, 1)} km, ${frNum(a.elevGain ?? 0)} m D+ en ${hm(a.durationSec)}, soit ${pace(r.pace)} par km-effort ; l'objectif fait ${frNum(p.ke / (a.distanceKm + (a.elevGain ?? 0) / 100), 1)} fois plus.`);
      continue;
    }
    if (r.splitDiff !== null) {
      const d = Math.round(r.splitDiff);
      lessons.push(
        d <= -2 ? `${a.name} : 2e moitié ${-d} s/km plus rapide que la 1re. Tu avais de la réserve : fais confiance à ton allure cible dès le 3e km.`
          : d >= 4 ? `${a.name} : 2e moitié ${d} s/km plus lente que la 1re. Départ trop rapide : sois patient sur les premiers km.`
          : `${a.name} : allure très régulière (${d >= 0 ? '+' : '−'}${Math.abs(d)} s/km entre les deux moitiés). C'est la gestion à reproduire.`,
      );
    }
    const s = a.splits ?? [];
    const last = s.length >= 3 ? s.slice(-2).reduce((m, x) => Math.min(m, x), Infinity) : null;
    if (last && last < r.pace - 10) lessons.push(`Ton dernier km complet y était en ${pace(last)}, ${Math.round(r.pace - last)} s plus vite que ta moyenne : il restait de l'énergie au finish.`);
    if (goal.targetSec) {
      const gap = a.durationSec - goal.targetSec;
      lessons.push(
        gap > 0
          ? `L'objectif ${clock(goal.targetSec)} demande ${clock(gap)} de mieux qu'à ${a.name} (${Math.round(gap / D)} s/km, −${frNum((gap / a.durationSec) * 100, 1)} %).`
          : `Tu as déjà couru plus vite que l'objectif à ${a.name} (${clock(a.durationSec)}).`,
      );
    }
    const wa = D >= 40 ? wallAnalysis(a) : null;
    if (wa?.wall) lessons.push(`Mur au km ${wa.wallKm} : l'allure s'est effondrée de ${Math.round((wa.fade - 1) * 100)} %. Départ plus prudent et ravitaillement dès le 5e km.`);
  }
  if (lessons.length) blocks.unshift({ icon: '📜', title: 'Leçons de tes courses', items: lessons });

  return { segments, checkpoints, watch, blocks };
}
