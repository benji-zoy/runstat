/**
 * Bilan d'un objectif passé (Objectifs › Archives) : résultat face à l'objectif et à la prédiction de la veille, déroulé
 * kilomètre par kilomètre comparé au plan d'allure, cardio, foulée, ravitaillement, conditions, leçons pour la suite.
 *
 * Distances : la montre mesure plus que la distance officielle (trajectoires, GPS). Les allures « réelles » ramènent
 * chaque kilomètre GPS à la distance officielle (écart supposé réparti uniformément), et les temps de passage sont
 * recalés sur le temps officiel (puce) quand il est connu.
 */
import { GoalEvaluation, chance } from './goals';
import { PlanBlock, passage, pacingProfile, segmentPaces } from './race-plan';
import { Activity, Athlete, Goal } from './models';
import { heatPenalty, kmEffort, timeForVdot, vdot } from './science';
import { clock, pace } from './format';
import { addDays, parseDay } from './stats';

export interface DebriefKm {
  /** Numéro du km à la montre (le dernier peut être partiel) */
  km: number;
  /** Distance GPS du tour (m) */
  dist: number;
  /** Allure affichée par la montre et allure sur la distance officielle (s/km) */
  watchPace: number;
  realPace: number;
  hr: number | null;
  /** FC aberrante (décrochage du capteur) : exclue des calculs */
  hrDoubtful: boolean;
  cadence: number | null;
  /** Longueur de foulée (m) */
  stride: number | null;
  power: number | null;
  /** Allures du plan de la veille sur ce km (objectif, probable) */
  targetPace: number | null;
  predictedPace: number;
  /** Écart cumulé (s) en fin de km au plan objectif et au plan probable : positif = en retard */
  vsTarget: number | null;
  vsPredicted: number;
  gel: boolean;
}

export interface DebriefSegment {
  label: string;
  from: number;
  to: number;
  target: number | null;
  predicted: number;
  actual: number;
}

export interface ModelCheck {
  label: string;
  note: string;
  seconds: number;
  /** Écart relatif au temps officiel (positif = le modèle était trop lent) */
  error: number;
}

export interface RaceDebrief {
  activity: Activity;
  official: number;
  fromChip: boolean;
  pace: number;
  /** Distance GPS / officielle − 1 */
  gpsDrift: number;
  targetGap: number | null;
  /** Probabilité de l'objectif la veille, et part des scénarios de la veille plus lents que le résultat */
  probability: number | null;
  beatShare: number;
  predictedGap: number;
  previous: { name: string; date: string; seconds: number } | null;
  previousBest: number | null;
  kms: DebriefKm[];
  segments: DebriefSegment[];
  halves: [number, number] | null;
  thirds: number[] | null;
  models: ModelCheck[];
  vdot: number;
  equivalents: { label: string; seconds: number }[];
  blocks: PlanBlock[];
  lessons: string[];
  notes: string[];
}

const frNum = (x: number, digits = 0) => x.toLocaleString('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const signed = (sec: number) => `${sec < 0 ? '−' : '+'}${clock(Math.abs(sec))}`;
const pct = (x: number, digits = 1) => `${x < 0 ? '−' : '+'}${frNum(Math.abs(x * 100), digits)} %`;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

/** Tours au km de la sortie : FIT ou tours Coros, à défaut les splits (temps seuls) */
function laps(a: Activity): number[][] {
  if (a.km?.length) return a.km;
  const s = a.splits ?? [];
  const rows = s.map((t) => [1000, t]);
  const rest = a.distanceKm * 1000 - s.length * 1000;
  if (rest > 50) rows.push([rest, a.durationSec - s.reduce((x, y) => x + y, 0)]);
  return rows;
}

export function raceDebrief(e: GoalEvaluation, a: Activity, athlete: Athlete, acts: Activity[], next: Goal | null): RaceDebrief {
  const goal = e.goal;
  const notes = goal.debrief ?? {};
  const trail = goal.kind === 'trail';
  const D = goal.distanceKm;
  const official = notes.chipSec ?? a.durationSec;
  const gpsKm = a.distanceKm;
  /** Distance officielle par km GPS, et temps officiel par seconde de montre */
  const f = trail ? 1 : D / gpsKm;
  const rows = laps(a);
  const watchTotal = rows.reduce((s, r) => s + r[1], 0) || a.durationSec;
  const ts = official / watchTotal;

  // Plan de la veille, recalculé pour pouvoir le comparer à n'importe quelle distance
  const parts = pacingProfile(D, goal.kind);
  const tgtPaces = goal.targetSec ? segmentPaces(goal.targetSec, D, goal.kind) : null;
  const predPaces = segmentPaces(e.predicted, D, goal.kind);

  // Kilomètres
  const hrs = rows.map((r) => r[2]).filter((h): h is number => !!h);
  const hrMed = median(hrs);
  const gels = notes.gelsKm ?? [];
  let cumD = 0, cumT = 0;
  const cum: { d: number; t: number }[] = [{ d: 0, t: 0 }];
  const kms: DebriefKm[] = rows.map((r, i) => {
    const [dist, time, hr, , , , power, cad] = r;
    cumD += dist;
    cumT += time;
    cum.push({ d: cumD, t: cumT });
    const offKm = (cumD / 1000) * f;
    const mid = offKm - (dist / 2000) * f;
    const found = parts.findIndex((p) => mid >= p.from && mid < p.to);
    const part = found >= 0 ? found : parts.length - 1;
    return {
      km: i + 1,
      dist,
      watchPace: time / (dist / 1000),
      realPace: (time * ts) / ((dist / 1000) * f),
      hr: hr || null,
      // Le premier km est la montée en régime ; ensuite, une chute brutale sans ralentissement est un décrochage
      hrDoubtful: i > 0 && !!hr && hr < hrMed - 8,
      cadence: cad || null,
      stride: cad ? dist / ((time * cad) / 60) : null,
      power: power || null,
      targetPace: tgtPaces?.[part] ?? null,
      predictedPace: predPaces[part],
      vsTarget: tgtPaces ? cumT * ts - passage(offKm, parts, tgtPaces) : null,
      vsPredicted: cumT * ts - passage(offKm, parts, predPaces),
      // « Gel au km 7 » : pris en arrivant au panneau, donc dans le 7e km
      gel: gels.some((g) => Math.max(1, Math.round(g)) === i + 1),
    };
  });

  /** Temps officiel (s) au km officiel `x`, interpolé sur les tours */
  const timeAt = (x: number) => {
    const d = (x / f) * 1000;
    for (let i = 1; i < cum.length; i++) {
      if (cum[i].d >= d) {
        const p = cum[i - 1], q = cum[i];
        return (p.t + ((d - p.d) / Math.max(1, q.d - p.d)) * (q.t - p.t)) * ts;
      }
    }
    return official;
  };
  const span = (from: number, to: number) => (Math.min(timeAt(to), official) - timeAt(from)) / (to - from);

  const segments: DebriefSegment[] = trail ? [] : parts.map((p, i) => ({
    label: p.label, from: p.from, to: p.to, target: tgtPaces?.[i] ?? null, predicted: predPaces[i], actual: span(p.from, p.to),
  }));
  const enough = kms.length >= 6;
  const halves: [number, number] | null = enough ? [timeAt(D / 2), official - timeAt(D / 2)] : null;
  const thirds = enough ? [span(0, D / 3), span(D / 3, (2 * D) / 3), span((2 * D) / 3, D)] : null;

  // Prédictions de la veille
  const models = e.models
    .map((m) => ({ label: m.label, note: m.note, seconds: m.seconds, error: m.seconds / official - 1 }))
    .sort((x, y) => Math.abs(x.error) - Math.abs(y.error));
  const raceDay = parseDay(goal.date);
  const before = acts.filter((x) => parseDay(x.date) < raceDay);
  const prevEfforts = trail ? [] : before
    .map((x) => x.fit?.efforts[String(Math.round(D * 1000))] ?? x.fit?.efforts[String(Math.floor(D * 1000))] ?? null)
    .filter((x): x is number => !!x);
  const refTimes = e.raceRefs.map((r) => r.activity.durationSec);
  const previousBest = [...prevEfforts, ...(trail ? [] : refTimes)].reduce<number | null>((m, x) => (m === null || x < m ? x : m), null);
  const prevRef = e.raceRefs[0]?.activity ?? null;

  const v = vdot(D * 1000, official);
  const equivalents = trail ? [] : [
    { label: '5 km', seconds: timeForVdot(v, 5000) },
    { label: '10 km', seconds: timeForVdot(v, 10000) },
    { label: 'Semi', seconds: timeForVdot(v, 21097.5) },
    { label: 'Marathon', seconds: timeForVdot(v, 42195) },
  ].filter((x) => Math.abs(x.seconds - official) > 60);

  const debrief: RaceDebrief = {
    activity: a,
    official,
    fromChip: notes.chipSec != null,
    pace: official / (trail ? kmEffort(a) : D),
    gpsDrift: gpsKm / D - 1,
    targetGap: goal.targetSec ? official - goal.targetSec : null,
    probability: e.probability,
    beatShare: 1 - chance(official, e.predicted, e.sigma),
    predictedGap: official - e.predicted,
    previous: prevRef ? { name: prevRef.name, date: prevRef.date, seconds: prevRef.durationSec } : null,
    previousBest,
    kms,
    segments,
    halves,
    thirds,
    models,
    vdot: v,
    equivalents,
    blocks: [],
    lessons: [],
    notes: notes.notes ?? [],
  };
  debrief.blocks = analysisBlocks(debrief, e, athlete);
  debrief.lessons = lessons(debrief, e, athlete, next);
  return debrief;
}

/** Blocs d'analyse : allure, cardio, foulée, ravitaillement, conditions */
function analysisBlocks(d: RaceDebrief, e: GoalEvaluation, athlete: Athlete): PlanBlock[] {
  const goal = e.goal;
  const a = d.activity;
  const blocks: PlanBlock[] = [];
  const full = d.kms.filter((k) => k.dist >= 900);

  // Allure
  const paceItems: string[] = [];
  if (d.halves) {
    const [h1, h2] = d.halves;
    const diff = h2 - h1;
    paceItems.push(`Moitiés en ${clock(h1)} et ${clock(h2)} : ${Math.abs(diff) < 30 ? 'course quasi régulière' : diff > 0 ? 'deuxième moitié plus lente' : 'deuxième moitié plus rapide (negative split)'} (${signed(diff)}).`);
  }
  if (d.thirds) {
    paceItems.push(`Par tiers : ${d.thirds.map((t) => pace(t)).join(' → ')} /km.`);
  }
  if (full.length >= 6) {
    const cv = Math.sqrt(mean(full.map((k) => (k.realPace - mean(full.map((x) => x.realPace))) ** 2))) / mean(full.map((x) => x.realPace));
    paceItems.push(`Variabilité des km : ${frNum(cv * 100, 1)} % (${cv < 0.02 ? 'très régulier' : cv < 0.035 ? 'régulier' : 'irrégulier'}).`);
    const w = slowestWindow(full);
    if (w) paceItems.push(`Passage le plus lent : km ${w.from} à ${w.to} en ${pace(w.pace)} /km, ${frNum(w.pace - d.pace)} s/km plus lent que ta moyenne.`);
    const last = d.kms.at(-1)!;
    const lastFull = full.at(-1)!;
    const kick = last.dist < 900 ? lastFull : last;
    if (kick.realPace < d.pace - 5) paceItems.push(`Final : dernier km en ${pace(kick.realPace)} /km, ${frNum(d.pace - kick.realPace)} s/km plus vite que ta moyenne${last.dist < 900 ? `, et les ${frNum(last.dist)} derniers mètres à ${pace(last.realPace)}` : ''}.`);
  }
  if (d.gpsDrift > 0.002) {
    const planned = e.plan.watch?.drift;
    paceItems.push(`Montre : ${frNum(a.distanceKm, 2)} km mesurés, ${pct(d.gpsDrift)}${planned ? ` (prévu : ${pct(planned)})` : ''}. Allure montre ${pace(a.durationSec / a.distanceKm)} /km pour ${pace(d.pace)} /km réels.`);
  }
  blocks.push({ icon: '⏱️', title: 'Allure', items: paceItems });

  // Cardio
  const f = a.fit;
  if (a.avgHr) {
    const items: string[] = [];
    items.push(`FC moyenne ${a.avgHr} bpm (${frNum((a.avgHr / athlete.hrMax) * 100)} % de ta FC max)${f?.maxHr ? `, max ${f.maxHr}` : ''}.`);
    if (f?.zones3 && f.lt) {
      const total = f.zones3.reduce((s, x) => s + x, 0);
      items.push(`${clock(f.zones3[2])} au-dessus de ton seuil (${f.lt[1]} bpm), soit ${frNum((f.zones3[2] / total) * 100)} % de la course${f.zones3[2] / total > 0.8 ? ' : un effort au seuil tenu de bout en bout' : ''}.`);
    }
    const ok = d.kms.filter((k) => k.hr && !k.hrDoubtful && k.km > 2 && k.dist >= 900);
    if (ok.length >= 6) {
      const h = ok.length >> 1;
      const drift = mean(ok.slice(h).map((k) => k.hr!)) - mean(ok.slice(0, h).map((k) => k.hr!));
      items.push(`Dérive : ${drift >= 0 ? '+' : '−'}${frNum(Math.abs(drift), 1)} bpm de la première à la seconde moitié (hors 2 premiers km)${f?.decoupling != null ? `, découplage allure/FC ${frNum(f.decoupling, 1)} %${f.decoupling < 5 ? ' (faible : bonne endurance aérobie)' : ''}` : ''}.`);
    }
    const doubtful = d.kms.filter((k) => k.hrDoubtful);
    if (doubtful.length) items.push(`Capteur : FC aberrante au km ${doubtful.map((k) => k.km).join(', ')} (chute sans ralentissement), exclue de l'analyse.`);
    blocks.push({ icon: '❤️', title: 'Cardio', items });
  }

  // Foulée
  const withStride = full.filter((k) => k.stride && k.cadence);
  if (withStride.length >= 10) {
    const n = withStride.length;
    // Début : km 2 à 6 (le 1er est dans la foule) ; fin : les 5 km avant le dernier (sprint final exclu)
    const first = withStride.slice(1, 6);
    const last = withStride.slice(Math.max(6, n - 6), n - 1);
    const sd = mean(last.map((k) => k.stride!)) / mean(first.map((k) => k.stride!)) - 1;
    const cd = mean(last.map((k) => k.cadence!)) / mean(first.map((k) => k.cadence!)) - 1;
    const items = [
      `Foulée ${frNum(mean(first.map((k) => k.stride!)), 2)} → ${frNum(mean(last.map((k) => k.stride!)), 2)} m (${pct(sd)}), cadence ${frNum(mean(first.map((k) => k.cadence!)))} → ${frNum(mean(last.map((k) => k.cadence!)))} pas/min (${pct(cd)}) entre le début et la fin de course.`,
    ];
    const pw = withStride.filter((k) => k.power);
    if (pw.length >= 10) {
      const p1 = mean(first.filter((k) => k.power).map((k) => k.power!));
      const p2 = mean(last.filter((k) => k.power).map((k) => k.power!));
      items.push(`Puissance ${frNum(p1)} → ${frNum(p2)} W (${pct(p2 / p1 - 1)}).`);
    }
    if (sd < -0.03 && cd > 0) {
      items.push(`Signature classique de la fatigue musculaire : la foulée raccourcit et la cadence compense. Le moteur cardio tenait, ce sont les jambes (raideur, ressort) qui ont cédé en premier.`);
    }
    blocks.push({ icon: '🦵', title: 'Foulée', items });
  }

  // Ravitaillement
  const gels = goal.debrief?.gelsKm ?? [];
  if (gels.length) {
    const items = [`${gels.length} gel${gels.length > 1 ? 's' : ''} pris au${gels.length > 1 ? 'x' : ''} km ${gels.join(' et ')}.`];
    const costs = d.kms
      .map((k, i) => ({ k, prev: d.kms[i - 1], next: d.kms[i + 1] }))
      .filter((x) => x.k.gel && x.prev && x.next && x.next.dist >= 900)
      .map((x) => ({ km: x.k.km, cost: x.k.realPace - (x.prev!.realPace + x.next!.realPace) / 2 }));
    if (costs.length) {
      items.push(`Coût estimé (km du gel comparé à ses voisins) : ${costs.map((c) => `km ${c.km} ${c.cost >= 0 ? '+' : '−'}${frNum(Math.abs(c.cost))} s`).join(', ')}.`);
    }
    const planGel = e.plan.blocks.find((b) => b.title === 'Ravitaillement')?.items[1];
    if (planGel) items.push(`Le plan prévoyait : ${planGel.charAt(0).toLowerCase()}${planGel.slice(1)}`);
    blocks.push({ icon: '🍌', title: 'Ravitaillement', items });
  }

  // Conditions
  const w = a.weather;
  if (w) {
    const heat = heatPenalty(w.temp, w.dew);
    const items = [`${frNum(w.temp)} °C, point de rosée ${frNum(w.dew)} °C, vent ${frNum(w.wind)} km/h${heat < 0.3 ? ' : conditions idéales, le chrono reflète ton vrai niveau' : ` : environ ${pct(heat / 100)} sur le temps (règle de Hadley)`}.`];
    if (goal.forecast) items.push(`Prévision de la veille : ${frNum(goal.forecast.temp)} °C, rosée ${frNum(goal.forecast.dew)} °C, vent ${frNum(goal.forecast.wind)} km/h.`);
    const elev = a.elevGain;
    if (elev != null) items.push(`Parcours : ${frNum(elev)} m D+ / ${frNum(a.elevLoss ?? 0)} m D−.`);
    blocks.push({ icon: '🌦️', title: 'Conditions', items });
  }
  return blocks;
}

/** Fenêtre de 3 km la plus lente (hors premier et dernier km) */
function slowestWindow(full: DebriefKm[]): { from: number; to: number; pace: number } | null {
  let best: { from: number; to: number; pace: number } | null = null;
  for (let i = 1; i + 3 <= full.length - 1; i++) {
    const p = mean(full.slice(i, i + 3).map((k) => k.realPace));
    if (!best || p > best.pace) best = { from: full[i].km, to: full[i + 2].km, pace: p };
  }
  return best;
}

/** Leçons pour la suite */
function lessons(d: RaceDebrief, e: GoalEvaluation, athlete: Athlete, next: Goal | null): string[] {
  const goal = e.goal;
  const out: string[] = [];
  const best = d.models[0];

  // Prédiction
  if (Math.abs(d.predictedGap) / e.predicted < 0.005) {
    out.push(`La prédiction de la veille (${clock(e.predicted)}) était juste à ${clock(Math.abs(d.predictedGap))} près.`);
  } else if (d.predictedGap < 0) {
    out.push(`${clock(-d.predictedGap)} de mieux que la prédiction de la veille (${clock(e.predicted)}) : meilleur que ${frNum(d.beatShare * 100)} % des scénarios. Les modèles te sous-estimaient un peu ; le plus juste était « ${best.label} » (${pct(best.error)}), le plus loin « ${d.models.at(-1)!.label} » (${pct(d.models.at(-1)!.error)}).`);
  } else {
    out.push(`${clock(d.predictedGap)} de plus que la prédiction de la veille (${clock(e.predicted)}). Le modèle le plus juste était « ${best.label} » (${pct(best.error)}).`);
  }

  // Objectif
  if (d.targetGap !== null && goal.targetSec) {
    if (d.targetGap <= 0) {
      out.push(`Objectif ${clock(goal.targetSec)} atteint avec ${clock(-d.targetGap)} d'avance${d.probability !== null ? `, alors qu'il n'avait que ${frNum(d.probability * 100)} % de chances la veille` : ''}.`);
    } else {
      const perKm = d.targetGap / goal.distanceKm;
      out.push(`Objectif ${clock(goal.targetSec)} manqué de ${clock(d.targetGap)}, soit ${frNum(perKm, 1)} s/km${d.probability !== null ? ` ; la veille, il n'avait que ${frNum(d.probability * 100)} % de chances : ambitieux plutôt qu'irréaliste` : ''}.`);
    }
  }

  // Progrès
  if (d.previous) {
    const gain = d.previous.seconds - d.official;
    out.push(gain > 0
      ? `${clock(gain)} de mieux qu'à ${d.previous.name} (${pct(-gain / d.previous.seconds)})${d.previousBest !== null && d.official < d.previousBest ? ' : nouveau record sur la distance' : ''}.`
      : `${clock(-gain)} de plus qu'à ${d.previous.name}.`);
  }

  // Départ
  if (d.thirds && d.segments.length) {
    const [t1, t2] = d.thirds;
    const start = d.segments[0];
    const planShift = start.predicted - d.segments[1].predicted;
    if (t1 < t2 - 2) {
      const cruise = d.segments[1].target ?? d.segments[1].predicted;
      const t3 = d.thirds[2];
      out.push(`Départ un peu rapide : premier tiers en ${pace(t1)} /km, ${frNum(t2 - t1)} s/km plus vite que le deuxième, alors que le plan prévoyait de partir ${frNum(planShift)} s/km plus lent que la croisière. Tu as couru le début près de l'allure ${d.segments[1].target !== null ? 'de l\'objectif' : 'prévue'} (${pace(cruise)}) plutôt qu'à celle de ta forme du jour, et le milieu de course l'a payé${t3 < t2 - 2 ? ` avant un dernier tiers retrouvé (${pace(t3)}) grâce au final` : ''}. La prochaine fois, cale les 5 premiers km sur le chrono probable et ne vise l'objectif qu'à partir de la mi-course si les sensations suivent.`);
    } else if (t1 > t2 + 2) {
      out.push(`Départ prudent (premier tiers ${frNum(t1 - t2)} s/km plus lent que le deuxième) : conforme au plan.`);
    }
  }

  // Foulée → entraînement
  const legs = d.blocks.find((b) => b.title === 'Foulée')?.items.some((i) => i.startsWith('Signature'));
  if (legs) {
    out.push(`Pour repousser la fatigue des jambes : côtes et sprints en côte, renforcement (squats, fentes, mollets), pliométrie légère, et des fins de sortie longue à allure semi.`);
  }

  // Niveau
  if (d.equivalents.length) {
    out.push(`Ce chrono vaut un VDOT de ${frNum(d.vdot, 1)} : équivalences ${d.equivalents.map((x) => `${x.label} ${clock(x.seconds)}`).join(', ')} (Daniels, à préparation égale).`);
  }

  // Récupération et suite
  const raceDay = parseDay(goal.date);
  const recovery = Math.round((goal.kind === 'trail' ? goal.distanceKm + (goal.elevGain ?? 0) / 100 : goal.distanceKm) / 1.609);
  const until = addDays(raceDay, recovery).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  let rec = `Récupération : pas de séance intense pendant environ ${recovery} jours (règle « un jour par mile »), soit jusqu'à ${until} ; footings faciles dès que les jambes le permettent.`;
  if (next) {
    const days = Math.round((parseDay(next.date).getTime() - raceDay.getTime()) / 86_400_000);
    rec += ` Ensuite, cap sur ${next.name} dans ${days} jours.`;
  }
  out.push(rec);
  return out;
}
