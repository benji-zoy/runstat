/**
 * Exports Markdown à donner à une IA (ChatGPT, Claude, Gemini, Mistral…), un par point d'entrée : une sortie, un objectif
 * à venir, un plan d'entraînement vers un objectif, le bilan d'une course passée, le profil du coureur.
 *
 * Structure commune : titre et présentation, glossaire des notions employées, contenu, consigne (+ question de la personne).
 * Rien qui identifie la personne ou un tiers : ni nom, ni coordonnées GPS, ni lieu ; les noms de sortie sont omis (ils
 * contiennent parfois un prénom ou un lieu), sauf le nom d'épreuve d'une course. La santé est facultative (`opts.health`).
 */
import { Activity, Goal } from '../models';
import { GoalEvaluation } from '../goals';
import { RaceDebrief } from '../debrief';
import { ConditionsReport } from '../conditions';
import { RunnerMatrix } from '../matrix';
import { durability, durabilitySummary } from '../durability';
import { bestEfforts, efficiency, kmEffort, wallAnalysis } from '../science';
import { EFFORT_DISTANCES, WEEKDAYS, daytimeStats, notables, topEfforts, weekdayStats } from '../insights';
import { isoDay, parseDay } from '../stats';
import { MdDoc, clock, dayLabel, hm, inline, n, pace, signedPct } from './md';
import {
  AiInput, AiOptions, KIND_LABEL, RUN_HEAD, athleteSection, distLabel, healthSection, keySessions, levelSection, runRow, similarRuns,
  thresholds, trainingSection, typeLabel, weeks,
} from './context';

export type AiExportKind = 'run' | 'goal' | 'plan' | 'debrief' | 'profile';

export interface PlanConstraints {
  /** Jours où courir (0 = lundi … 6 = dimanche) ; vide = indifférent */
  days: number[];
  sessionsPerWeek?: number | null;
  maxKmPerWeek?: number | null;
  /** Blessures, gênes, antécédents */
  injuries?: string;
  /** Séances imposées (club, autres sports), contraintes d'agenda */
  notes?: string;
}

export interface AiDoc {
  title: string;
  /** Nom de fichier proposé (sans caractère spécial) */
  filename: string;
  markdown: string;
  /** Estimation grossière du nombre de jetons (≈ 3,5 caractères par jeton en français) */
  tokens: number;
}

const DAY_MS = 86_400_000;
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY_MS);
const isoToday = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const INTRO =
  'Ce document est un export de RunStat, le tableau de bord d\'un coureur amateur qui te le confie pour en discuter. ' +
  'Les chiffres sont calculés à partir des données de sa montre ; les définitions sont dans le glossaire. ' +
  'Réponds en français, en le tutoyant, de façon concrète et chiffrée. Signale les données qui te paraissent douteuses ' +
  '(capteur cardio, GPS) au lieu de les interpréter, et pose des questions si une information importante manque.';

function slug(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'export';
}

/** Noms génériques, laissés tels quels : ce sont aussi des mots du texte (types de séance, titres) */
const GENERIC = new Set(['course', 'seuil', 'sortie', 'sortie longue', 'footing', 'endurance', 'fractionné', 'récupération', 'tempo', 'trail', 'running', 'course à pied', 'tapis', 'piste']);

/**
 * Les textes repris des calculs (notes des modèles, conseils, leçons) citent parfois une sortie par son nom libre, qui
 * peut contenir un prénom ou un lieu : il est remplacé par « une sortie », sauf pour les courses (nom d'épreuve).
 */
export function scrubNames(text: string, input: AiInput): string {
  const names = new Set<string>();
  for (const a of input.acts) {
    const name = a.name?.trim();
    if (!name || name.length < 5 || a.result || input.types.get(a.id) === 'race' || GENERIC.has(name.toLowerCase())) continue;
    names.add(name);
  }
  // Les plus longs d'abord : « Boucle du parc 2 » avant « Boucle du parc »
  for (const name of [...names].sort((x, y) => y.length - x.length)) {
    if (text.includes(name)) text = text.split(name).join('une sortie');
  }
  return text;
}

/** Assemble titre, présentation, glossaire, contenu et consigne */
function finish(doc: MdDoc, title: string, file: string, input: AiInput, prompt: string[], opts: AiOptions): AiDoc {
  const q = opts.question?.trim();
  const consigne = ['## Ce que j\'attends de toi', prompt.map((p) => `- ${p}`).join('\n')];
  if (q) consigne.push('### Ma question', q);
  const markdown = [
    `# ${title}`,
    `> ${INTRO}`,
    `Export du ${isoToday(input.today)}, niveau de détail : ${opts.detail === 'full' ? 'complet' : 'résumé'}${opts.health ? '' : ' ; données de santé non partagées'}.`,
    doc.glossary(),
    scrubNames(doc.body(), input),
    consigne.join('\n\n'),
  ].filter(Boolean).join('\n\n') + '\n';
  return { title, filename: `runstat-${file}-${isoToday(input.today)}.md`, markdown, tokens: Math.round(markdown.length / 3.5) };
}

// ---------------------------------------------------------------------------
// Une sortie
// ---------------------------------------------------------------------------

/** Nom affichable : l'épreuve pour une course déclarée, sinon le type (les noms libres peuvent contenir un prénom ou un lieu) */
function runTitle(a: Activity, input: AiInput): string {
  return a.result?.event ?? `${typeLabel(input.types.get(a.id))} ${KIND_LABEL[a.kind] === 'route' ? '' : `(${KIND_LABEL[a.kind]}) `}de ${n(a.distanceKm, 1)} km`.replace(/\s+/g, ' ');
}

/** Tours au km [distance m, temps s, FC, D+, D−, allure ajustée, puissance, cadence], regroupés en ~10 blocs en résumé */
function lapRows(a: Activity, full: boolean): { head: string[]; rows: (string | number | null)[][]; grouped: number } | null {
  const laps = a.km?.length ? a.km : a.splits?.map((t) => [1000, t]) ?? null;
  if (!laps?.length) return null;
  const size = full || laps.length <= 12 ? 1 : Math.ceil(laps.length / 10);
  const rows: (string | number | null)[][] = [];
  let km = 0;
  for (let i = 0; i < laps.length; i += size) {
    const g = laps.slice(i, i + size);
    const d = g.reduce((s, l) => s + l[0], 0);
    const t = g.reduce((s, l) => s + l[1], 0);
    const tw = (k: number) => {
      const xs = g.filter((l) => l[k] > 0);
      const T = xs.reduce((s, l) => s + l[1], 0);
      return T ? xs.reduce((s, l) => s + l[k] * l[1], 0) / T : null;
    };
    const dw = (k: number) => {
      const xs = g.filter((l) => l[k] > 0);
      const D = xs.reduce((s, l) => s + l[0], 0);
      return D ? xs.reduce((s, l) => s + l[k] * l[0], 0) / D : null;
    };
    const sum = (k: number) => (g.some((l) => l[k] != null) ? g.reduce((s, l) => s + (l[k] ?? 0), 0) : null);
    const from = km;
    km += d / 1000;
    rows.push([
      size === 1 ? n(km, 2) : `${n(from, 1)} → ${n(km, 1)}`, clock(t), pace(t / (d / 1000)), tw(2) ? n(tw(2)) : null,
      sum(3) !== null ? n(sum(3)) : null, sum(4) !== null ? n(sum(4)) : null, dw(5) ? pace(dw(5)) : null, tw(7) ? n(tw(7)) : null, tw(6) ? n(tw(6)) : null,
    ]);
  }
  const head = ['km', 'Temps', 'Allure', 'FC', 'D+', 'D−', 'Allure ajustée', 'Cadence', 'Puissance (W)'];
  // Colonnes toujours vides retirées (splits sans FC, pas de puissance…)
  const keep = head.map((_, j) => j < 3 || rows.some((r) => r[j] !== null));
  return { head: head.filter((_, j) => keep[j]), rows: rows.map((r) => r.filter((_, j) => keep[j])), grouped: size };
}

function runFacts(doc: MdDoc, a: Activity, input: AiInput): void {
  const dPlus = a.elevGain != null ? `${n(a.elevGain)} m D+${a.elevLoss != null ? ` / ${n(a.elevLoss)} m D−` : ''}` : null;
  const start = a.start ? new Date(a.start * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null;
  const ef = efficiency(a);
  doc.use('allure', 'types');
  doc.facts([
    ['Date', dayLabel(a.date) + (start ? `, départ ${start}` : '')],
    ['Type de séance', typeLabel(input.types.get(a.id))],
    ['Terrain', KIND_LABEL[a.kind]],
    ['Distance (montre)', `${n(a.distanceKm, 2)} km`],
    ['Durée', clock(a.durationSec)],
    ['Allure moyenne', `${pace(a.durationSec / a.distanceKm)} /km`],
    ['Dénivelé', dPlus],
    ['Km-effort', a.elevGain ? n(kmEffort(a), 1) : null],
    ['FC moyenne', a.avgHr ? `${a.avgHr} bpm (${n((a.avgHr / input.athlete.hrMax) * 100)} % de la FC max)` : null],
    ['FC max de la sortie', a.fit?.maxHr ? `${a.fit.maxHr} bpm` : null],
    ['Efficacité (EF)', ef ? n(ef, 2) : null],
    ['Cadence', a.cadence ? `${a.cadence} pas/min` : null],
    ['Longueur de foulée', a.stride ? `${n(a.stride, 2)} m` : null],
    ['Puissance', a.power ? `${a.power} W` : null],
    [input.caps.loadLabel, a.trainingLoad ? n(a.trainingLoad) : null],
    ['Effet d\'entraînement', input.caps.trainingEffect && a.aerobicTE != null ? `aérobie ${n(a.aerobicTE, 1)}, anaérobie ${n(a.anaerobicTE, 1)}${a.focus ? `, focus ${a.focus}` : ''}` : null],
    ['Météo', a.weather ? `${n(a.weather.temp)} °C, point de rosée ${n(a.weather.dew)} °C, humidité ${n(a.weather.rh)} %, vent ${n(a.weather.wind)} km/h` : null],
    ['Fichier seconde par seconde', a.fit ? 'oui' : 'non (moins de détails : pas de zones, de découplage ni de meilleurs efforts)'],
  ]);
  if (ef) doc.use('ef');
  if (a.trainingLoad) doc.use('charge');
  if (input.caps.trainingEffect && a.aerobicTE != null) doc.use('te');
  if (a.elevGain) doc.use('kmEffort');
}

function officialResult(doc: MdDoc, a: Activity): void {
  const r = a.result;
  if (!r) return;
  doc.h(3, 'Course officielle').use('gps');
  doc.facts([
    ['Épreuve', inline(r.event) + (r.course ? ` (${inline(r.course)})` : '')],
    ['Distance officielle', r.distanceKm ? `${n(r.distanceKm, 3)} km` : null],
    ['Temps officiel', r.officialSec ? clock(r.officialSec) : null],
    ['Classement', r.rank ? `${r.rank}${r.finishers ? ` / ${r.finishers}` : ''}` : null],
    ['Classement par sexe', r.sexRank ? `${r.sexRank}${r.sexCount ? ` / ${r.sexCount}` : ''}` : null],
    ['Catégorie', r.catRank ? `${r.category ?? ''} ${r.catRank}${r.catCount ? ` / ${r.catCount}` : ''}`.trim() : null],
  ]);
}

function lapsSection(doc: MdDoc, a: Activity, opts: AiOptions): void {
  const laps = lapRows(a, opts.detail === 'full');
  if (!laps) return;
  doc.h(3, laps.grouped > 1 ? `Déroulé (par blocs de ${laps.grouped} km)` : 'Déroulé kilomètre par kilomètre');
  if (laps.head.includes('Allure ajustée')) doc.use('gap');
  doc.table(laps.head, laps.rows);
}

function intensitySection(doc: MdDoc, a: Activity, input: AiInput): void {
  const f = a.fit;
  if (!f) return;
  const total = f.zones3.reduce((s, x) => s + x, 0) || 1;
  const z5 = f.zones5.reduce((s, x) => s + x, 0) || 1;
  const [lt1, lt2] = thresholds(input.athlete);
  doc.h(3, 'Intensité').use('zones', 'decouplage');
  doc.facts([
    ['Temps par zone', `sous LT1 (< ${lt1} bpm) ${n((100 * f.zones3[0]) / total)} %, entre LT1 et LT2 ${n((100 * f.zones3[1]) / total)} %, au-dessus de LT2 (> ${lt2} bpm) ${n((100 * f.zones3[2]) / total)} %`],
    ['Zones en % de FC max', f.zones5.map((s, i) => `Z${i + 1} ${n((100 * s) / z5)} %`).join(', ')],
    ['TRIMP', n(f.trimp)],
    ['Découplage Pa:HR', f.decoupling != null ? `${n(f.decoupling, 1)} %` : null],
    ['Variabilité des tours', f.lapCv != null ? `${n(f.lapCv * 100)} % (au-delà de 12 % : séance fractionnée)` : null],
    ['Distance équivalent plat (GAP)', f.gapDistance ? `${n(f.gapDistance / 1000, 2)} km` : null],
  ]);
}

function durabilitySection(doc: MdDoc, a: Activity): void {
  const d = durability(a);
  if (!d) return;
  doc.h(3, 'Durabilité').use('durabilite');
  doc.facts([
    ['Perte d\'efficacité (dernier tiers / premier)', signedPct(d.efLoss)],
    ['Ralentissement de l\'allure ajustée', signedPct(d.paceFade)],
    ['Dérive de FC à allure égale', d.hrDrift != null ? `${n(d.hrDrift, 1)} bpm/h` : null],
    ['Début de la dégradation', d.onset != null ? `après ${hm(d.onset)}` : 'l\'efficacité a tenu'],
    ['Montée (m/h), 1re puis 2e moitié', d.climb ? `${n(d.climb[0])} → ${n(d.climb[1])}` : null],
    ['Descente (km/h), 1re puis 2e moitié', d.descent ? `${n(d.descent[0], 1)} → ${n(d.descent[1], 1)}` : null],
    ['Cadence, premier puis dernier tiers', d.cadence ? `${n(d.cadence[0])} → ${n(d.cadence[1])} pas/min` : null],
    ['Allure régulière', d.steady ? 'oui' : 'non (fin nettement plus rapide : comparaison faussée)'],
  ]);
  const w = wallAnalysis(a);
  if (w?.wall) {
    doc.p(`Mur détecté vers le km ${w.wallKm} : allure des 20 premiers km ${pace(w.basePace)} /km, pire tronçon de 5 km ${n((w.fade - 1) * 100)} % plus lent${w.potential ? ` ; sans le mur, environ ${clock(w.potential)}` : ''}.`);
  }
}

function effortsSection(doc: MdDoc, a: Activity, input: AiInput): void {
  if (!a.fit) return;
  const year = bestEfforts(input.acts.filter((x) => x.date <= a.date), parseDay(a.date), 365, false);
  const rows = Object.entries(a.fit.efforts)
    .filter(([, t]) => t)
    .map(([d, t]) => {
      const best = year.get(Number(d));
      return [distLabel(Number(d)), clock(t!), pace(t! / (Number(d) / 1000)), best?.activity.id === a.id ? 'oui' : best ? `non (${clock(best.time)})` : null];
    });
  if (!rows.length) return;
  doc.h(3, 'Meilleurs efforts dans cette sortie').use('efforts');
  doc.table(['Distance', 'Temps', 'Allure', 'Meilleur sur 12 mois ?'], rows);
}

function conditionsSection(doc: MdDoc, report: ConditionsReport | null): void {
  if (!report) return;
  doc.h(3, 'Coût des conditions').use('conditions');
  doc.table(['Facteur', 'Effet', 'Raison', 'Détail'], report.factors.map((f) => [f.label, signedPct(f.pct), f.cause, f.detail + (f.estimated ? ' (estimé)' : '')]));
  doc.p(`Effet total ${signedPct(report.totalPct)} ; en conditions standard : ${clock(report.standardSec)} soit ${pace(report.standardPace)} /km${report.estimated ? ' (estimation sans tracé)' : ''}.`);
}

function similarSection(doc: MdDoc, a: Activity, input: AiInput, opts: AiOptions): void {
  const xs = similarRuns(a, input, opts.detail === 'full' ? 8 : 4);
  if (!xs.length) return;
  doc.h(3, 'Sorties semblables des 6 mois précédents').use('ef');
  doc.p('Même type et même terrain, distance à ±25 %.');
  doc.table([...RUN_HEAD, 'EF'], [...xs, a].map((x) => {
    const row = runRow(x, input.types);
    if (x.id === a.id) row[0] = `**${row[0]} (cette sortie)**`;
    return [...row, efficiency(x) ? n(efficiency(x)!, 2) : null];
  }));
}

export function runExport(a: Activity, input: AiInput, opts: AiOptions, conditions: ConditionsReport | null): AiDoc {
  const doc = new MdDoc();
  const ref = parseDay(a.date);
  doc.h(2, 'La sortie');
  runFacts(doc, a, input);
  officialResult(doc, a);
  lapsSection(doc, a, opts);
  intensitySection(doc, a, input);
  durabilitySection(doc, a);
  effortsSection(doc, a, input);
  conditionsSection(doc, conditions);
  similarSection(doc, a, input, opts);
  const notes = notables(a, input.acts);
  if (notes.length) doc.h(3, 'À noter').list(notes);
  athleteSection(doc, input, opts);
  trainingSection(doc, input, opts, ref, 'Entraînement avant cette sortie');
  healthSection(doc, input, opts, ref);
  return finish(doc, `Analyse d'une sortie : ${runTitle(a, input)}, ${a.date}`, `sortie-${a.date}`, input, [
    'Analyse cette sortie : ce qui s\'est bien passé, ce qui pose question (gestion de l\'allure, cardio, dérive, conditions) et pourquoi.',
    'Situe-la dans mon entraînement des semaines précédentes et face aux sorties semblables.',
    'Termine par deux ou trois enseignements concrets pour mes prochaines séances.',
  ], opts);
}

// ---------------------------------------------------------------------------
// Un objectif
// ---------------------------------------------------------------------------

function goalFacts(doc: MdDoc, g: Goal, e: GoalEvaluation): void {
  doc.use('kmEffort');
  doc.facts([
    ['Course', inline(g.name)],
    ['Date', dayLabel(g.date) + (g.startTime ? `, départ ${g.startTime}` : '')],
    ['Dans', e.daysLeft > 0 ? `${e.daysLeft} jours` : e.daysLeft === 0 ? 'aujourd\'hui' : `passée depuis ${-e.daysLeft} jours`],
    ['Type', g.kind === 'trail' ? 'trail' : 'route'],
    ['Catégorie de calcul', e.category === 'ultra' ? 'ultra' : e.category === 'trail' ? 'trail' : 'route'],
    ['Distance', `${n(g.distanceKm, 2)} km`],
    ['Dénivelé', g.elevGain ? `${n(g.elevGain)} m D+ / ${n(g.elevLoss ?? g.elevGain)} m D−` : null],
    ['Km-effort', n(e.ke, 1)],
    ['Distance équivalent plat pour ce coureur', g.kind === 'trail' || g.elevGain ? `${n(e.effortKm, 1)} km` : null],
    ['Chrono visé', g.targetSec ? clock(g.targetSec) + (g.stretchSec ? ` (fourchette ambitieuse : ${clock(g.stretchSec)})` : '') : 'finir'],
    ['Profil du parcours', g.course ? `tracé GPX importé${g.course.waypoints?.length ? `, points de passage : ${g.course.waypoints.map((w) => `${inline(w.name)} km ${n(w.km, 1)}`).join(', ')}` : ''}` : 'pas de tracé : profil synthétique'],
    ['Prévision météo', g.forecast ? `${n(g.forecast.temp)} °C, point de rosée ${n(g.forecast.dew)} °C, vent ${n(g.forecast.wind)} km/h` : null],
  ]);
  if (g.kind === 'trail' || g.elevGain) doc.use('equivPlat');
}

function evaluationSection(doc: MdDoc, e: GoalEvaluation, opts: AiOptions, withModels: boolean): void {
  doc.h(2, 'Évaluation de RunStat').use('prediction');
  doc.facts([
    ['Chrono le plus probable', clock(e.predicted)],
    ['Intervalle à 80 %', `${clock(e.low)} – ${clock(e.high)}`],
    ['Probabilité de passer sous l\'objectif', e.probability !== null ? `${n(e.probability * 100)} % (${e.verdict.label.toLowerCase()})` : null],
    ['Probabilité du chrono ambitieux', e.stretchProbability !== null ? `${n(e.stretchProbability * 100)} %` : null],
    ['Indice de préparation', `${n(e.readinessScore * 100)}/100 aujourd'hui, ${n(e.readinessProjected * 100)}/100 projeté${e.probability === null ? ` → ${e.verdict.label.toLowerCase()}` : ''}`],
    ['Incertitude (écart-type relatif)', `${n(e.sigma * 100, 1)} % (modèles ${n(e.uncertainty.models * 100, 1)} %, jour de course ${n(e.uncertainty.day * 100, 1)} %${e.uncertainty.extrapolation ? `, extrapolation ${n(e.uncertainty.extrapolation * 100, 1)} %` : ''})`],
  ]);
  doc.use('preparation');
  doc.p(`Méthode : ${e.method}`);
  if (withModels && e.models.length) {
    doc.h(3, 'Modèles');
    doc.table(['Modèle', 'Temps', 'Poids', 'Note'], e.models.map((m) => [m.label, clock(m.seconds), n(m.weight, 2), m.note]));
    doc.p(`Consensus brut : ${clock(e.base)}.`);
  }
  // Sans la santé, ni l'ajustement « Récupération » (son signe et sa taille disent l'état de la VFC et de la FC de repos),
  // ni le critère, ni son conseil (sommeil)
  const adjustments = e.adjustments.filter((a) => opts.health || a.label !== 'Récupération');
  if (adjustments.length) {
    doc.h(3, 'Ajustements du jour J');
    doc.table(['Ajustement', 'Effet sur le temps', 'Détail'], adjustments.map((a) => [a.label, signedPct(a.pct), a.note]));
    doc.p(adjustments.length < e.adjustments.length ? 'Effet positif = plus lent. Un ajustement tiré des données de santé n\'est pas partagé.' : 'Effet positif = plus lent.');
  }
  const items = e.readiness.filter((r) => opts.health || r.label !== 'Récupération');
  const hidden = new Set(e.readiness.filter((r) => !items.includes(r)).map((r) => r.advice));
  if (items.length) {
    doc.h(3, 'Préparation, critère par critère');
    doc.table(['Critère', 'Aujourd\'hui', 'Repère', 'Score', 'Projeté', 'Poids'], items.map((r) => [r.label, r.value, r.target, n(r.score * 100), n(r.projected * 100), n(r.weight, 1)]));
  }
  const advice = [...e.advice, ...items.map((r) => r.advice)].filter((x, i, xs): x is string => !!x && !hidden.has(x) && xs.indexOf(x) === i);
  if (advice.length) doc.h(3, 'Conseils de RunStat').list(advice);
}

function referencesSection(doc: MdDoc, e: GoalEvaluation, opts: AiOptions): void {
  if (e.raceRefs.length) {
    doc.h(3, 'Courses de référence').use('gps');
    doc.table(['Date', 'Épreuve', 'Distance', 'Temps', 'Allure', '% FC max', 'Écart 2e − 1re moitié', 'Écart GPS', 'Chaleur'], e.raceRefs.map((r) => [
      r.activity.date, r.activity.result?.event ? inline(r.activity.result.event) : 'course', `${n(r.dist / 1000, 2)} km${r.effortKm ? ` (${n(r.effortKm, 1)} km éq. plat)` : ''}`,
      clock(r.activity.result?.officialSec ?? r.activity.durationSec), `${pace(r.pace)} /km${r.effortKm ? ' éq. plat' : ''}`, r.hrPct ? `${n(r.hrPct * 100)} %` : null,
      r.splitDiff !== null ? `${r.splitDiff > 0 ? '+' : '−'}${n(Math.abs(r.splitDiff))} s/km` : null, signedPct(r.gpsDrift * 100), r.heatPct ? signedPct(r.heatPct) : null,
    ]));
  }
  const p = e.progression;
  if (p && opts.detail === 'full') {
    doc.h(3, `Progression depuis la course du ${p.reference.date}`);
    doc.table(['Critère', 'Avant cette course', 'Aujourd\'hui', 'Effet', 'Note'], p.rows.map((r) => [r.label, r.before, r.now, r.factor !== null ? signedPct((r.factor - 1) * 100) : null, r.note]));
    doc.p(`Temps projeté : ${clock(p.projected)} (référence sans la chaleur ${clock(p.neutral)}, effet retenu ${signedPct((p.factor - 1) * 100)}).`);
  }
}

function strategySection(doc: MdDoc, e: GoalEvaluation, opts: AiOptions): void {
  const plan = e.plan;
  doc.h(2, 'Stratégie de course proposée par RunStat');
  if (plan.watch) {
    doc.use('gps').p(`Allure à lire sur la montre : ${pace(plan.watch.shown)} /km pour une allure réelle de ${pace(plan.watch.actual)} /km (écart GPS mesuré de ${signedPct(plan.watch.drift * 100)}, ${plan.watch.from}).`);
  }
  if (plan.segments.length) {
    const trail = plan.segments.some((s) => s.realisticSec);
    doc.table(
      trail ? ['Tronçon', 'km', 'D+ / D−', 'Durée (objectif)', 'Durée (probable)', 'Conseil'] : ['Tronçon', 'km', 'Allure (objectif)', 'Allure (probable)', 'Conseil'],
      plan.segments.map((s) => trail
        ? [s.label, `${n(s.from, 1)} → ${n(s.to, 1)}`, s.gain != null ? `${n(s.gain)} / ${n(s.loss)} m` : null, s.targetSec ? hm(s.targetSec) : null, hm(s.realisticSec), s.tip]
        : [s.label, `${n(s.from, 1)} → ${n(s.to, 1)}`, s.target ? pace(s.target) : null, pace(s.realistic), s.tip]),
    );
  }
  if (opts.detail === 'full' && plan.checkpoints.length) {
    doc.h(3, 'Temps de passage');
    doc.table(['km', 'Point', 'Objectif', 'Probable'], plan.checkpoints.map((c) => [n(c.km, 1), c.name ? inline(c.name) : null, c.target ? clock(c.target) : null, clock(c.realistic)]));
  }
  for (const b of plan.blocks) {
    if (opts.detail === 'summary' && !/allure|cardio|ravit|nutri/i.test(b.title)) continue;
    doc.h(3, b.title).list(opts.health ? b.items : (b.withoutWeight ?? b.items));
  }
}

export function goalExport(e: GoalEvaluation, input: AiInput, opts: AiOptions): AiDoc {
  const doc = new MdDoc();
  doc.h(2, 'L\'objectif');
  goalFacts(doc, e.goal, e);
  evaluationSection(doc, e, opts, true);
  referencesSection(doc, e, opts);
  strategySection(doc, e, opts);
  athleteSection(doc, input, opts);
  levelSection(doc, input, opts, input.today);
  trainingSection(doc, input, opts, input.today);
  healthSection(doc, input, opts, input.today);
  return finish(doc, `Objectif : ${inline(e.goal.name)} (${e.goal.date})`, `objectif-${slug(e.goal.name)}`, input, [
    'Donne-moi ton avis sur cet objectif : l\'évaluation de RunStat te paraît-elle réaliste, trop prudente ou trop optimiste, et pourquoi ?',
    'Dis-moi ce qui compte le plus d\'ici la course, compte tenu de mon entraînement actuel et du temps restant.',
    'Commente la stratégie de course proposée et ce que tu changerais.',
  ], opts);
}

// ---------------------------------------------------------------------------
// Plan d'entraînement vers un objectif
// ---------------------------------------------------------------------------

function constraintsSection(doc: MdDoc, c: PlanConstraints): void {
  doc.h(2, 'Mes contraintes');
  doc.facts([
    ['Jours où je peux courir', c.days.length ? [...c.days].sort().map((d) => WEEKDAYS[d].toLowerCase()).join(', ') : 'indifférent'],
    ['Séances par semaine', c.sessionsPerWeek ? String(c.sessionsPerWeek) : null],
    ['Volume maximal', c.maxKmPerWeek ? `${c.maxKmPerWeek} km/semaine` : null],
    ['Blessures, gênes', c.injuries?.trim() ? inline(c.injuries) : 'aucune signalée'],
    ['Autres contraintes', c.notes?.trim() ? inline(c.notes) : null],
  ]);
}

function habitsLine(input: AiInput, ref: Date): string | null {
  const recent = input.acts.filter((a) => {
    const age = daysBetween(parseDay(a.date), ref);
    return age >= 0 && age < 84;
  });
  if (!recent.length) return null;
  const days = weekdayStats(recent).filter((d) => d.count).sort((a, b) => b.count - a.count).map((d) => `${d.day.toLowerCase()} ${d.count}`);
  return `Jours de sortie sur les 12 dernières semaines : ${days.join(', ')}.`;
}

export function planExport(e: GoalEvaluation, input: AiInput, opts: AiOptions, c: PlanConstraints): AiDoc {
  const doc = new MdDoc();
  const g = e.goal;
  doc.h(2, 'L\'objectif');
  goalFacts(doc, g, e);
  evaluationSection(doc, e, opts, opts.detail === 'full');
  constraintsSection(doc, c);
  athleteSection(doc, input, opts);
  levelSection(doc, input, opts, input.today, true);
  trainingSection(doc, input, { ...opts, detail: 'full' }, input.today);
  doc.p(habitsLine(input, input.today));
  keySessions(doc, input, input.today, opts.detail === 'full' ? 12 : 6);
  const year = weeks(input.acts, input.types, input.today, 52);
  const peak = year.reduce((m, w) => (w.km > m.km ? w : m), year[0]);
  if (peak?.km) doc.p(`Plus grosse semaine des 12 derniers mois : ${n(peak.km, 1)} km (semaine du ${isoDay(peak.start)}).`);
  healthSection(doc, input, opts, input.today);
  const weeksLeft = Math.max(1, Math.ceil(e.daysLeft / 7));
  return finish(doc, `Plan d'entraînement : ${inline(g.name)} (${g.date})`, `plan-${slug(g.name)}`, input, [
    `Propose-moi un plan d'entraînement de ${weeksLeft} semaine${weeksLeft > 1 ? 's' : ''}, d'aujourd'hui (${isoToday(input.today)}) jusqu'à la course (${g.date}), qui part de mon volume actuel et respecte mes contraintes.`,
    'Explique d\'abord en quelques lignes la logique du plan (phases, progression du volume, séances clés, affûtage), puis donne un tableau par semaine : jour, séance, durée ou distance, allure ou FC cible, but de la séance.',
    'Utilise mes allures d\'entraînement et mes zones de FC ; augmente le volume prudemment (pas plus de 10 % par semaine en général) et prévois une semaine plus légère toutes les 3 ou 4 semaines.',
    'Indique les séances qui me diront si l\'objectif reste réaliste, et ce qu\'il faudrait ajuster si je rate une semaine.',
  ], opts);
}

// ---------------------------------------------------------------------------
// Bilan d'une course passée
// ---------------------------------------------------------------------------

export function debriefExport(e: GoalEvaluation, d: RaceDebrief, input: AiInput, opts: AiOptions, conditions: ConditionsReport | null): AiDoc {
  const doc = new MdDoc();
  const g = e.goal;
  const a = d.activity;
  doc.h(2, 'La course').use('gps', 'allure');
  goalFacts(doc, g, e);
  doc.h(2, 'Résultat');
  doc.facts([
    ['Temps', `${clock(d.official)}${d.fromChip ? ' (temps puce)' : ' (montre)'}, ${pace(d.pace)} /km`],
    ['Face à l\'objectif', d.targetGap !== null ? `${d.targetGap > 0 ? '+' : '−'}${clock(Math.abs(d.targetGap))}` : null],
    ['Face à la prédiction de la veille', `${d.predictedGap > 0 ? '+' : '−'}${clock(Math.abs(d.predictedGap))} (prédiction ${clock(e.predicted)})`],
    ['Probabilité de l\'objectif la veille', d.probability !== null ? `${n(d.probability * 100)} %` : null],
    ['Part des scénarios de la veille plus lents que le résultat', `${n(d.beatShare * 100)} %`],
    ['Écart GPS', signedPct(d.gpsDrift * 100)],
    ['Moitiés', d.halves ? `${clock(d.halves[0])} puis ${clock(d.halves[1])}` : null],
    ['Tiers', d.thirds ? d.thirds.map(clock).join(', ') : null],
    ['Précédente édition', d.previous ? `${clock(d.previous.seconds)} (${d.previous.date})` : null],
    ['VDOT de la course', n(d.vdot, 1)],
    ['Équivalences (Daniels)', d.equivalents.map((x) => `${x.label} ${clock(x.seconds)}`).join(', ')],
    ['Gels pris (km)', g.debrief?.gelsKm?.length ? g.debrief.gelsKm.map((k) => n(k, 1)).join(', ') : null],
  ]);
  doc.use('prediction', 'vdot');
  officialResult(doc, a);
  if (g.debrief?.notes?.length) doc.h(3, 'Mon ressenti').list(g.debrief.notes.map(inline));

  if (opts.detail === 'full' && d.kms.length) {
    doc.h(3, 'Kilomètre par kilomètre face au plan de la veille');
    doc.table(['km', 'Allure montre', 'Allure réelle', 'FC', 'Cadence', 'Plan objectif', 'Plan probable', 'Écart cumulé (objectif)', 'Écart cumulé (probable)', 'Gel'], d.kms.map((k) => [
      k.km, pace(k.watchPace), pace(k.realPace), k.hr ? `${k.hr}${k.hrDoubtful ? ' (douteuse)' : ''}` : null, k.cadence ? n(k.cadence) : null,
      k.targetPace ? pace(k.targetPace) : null, pace(k.predictedPace), k.vsTarget !== null ? `${k.vsTarget > 0 ? '+' : '−'}${n(Math.abs(k.vsTarget))} s` : null,
      `${k.vsPredicted > 0 ? '+' : '−'}${n(Math.abs(k.vsPredicted))} s`, k.gel ? 'oui' : null,
    ]));
    doc.p('Écart cumulé positif = en retard sur le plan.');
  }
  if (d.segments.length) {
    doc.h(3, 'Par tronçon');
    doc.table(['Tronçon', 'km', 'Allure visée', 'Allure probable', 'Allure réelle'], d.segments.map((s) => [s.label, `${n(s.from, 1)} → ${n(s.to, 1)}`, s.target ? pace(s.target) : null, pace(s.predicted), pace(s.actual)]));
  }
  if (d.models.length) {
    doc.h(3, 'Les modèles de la veille face au résultat');
    doc.table(['Modèle', 'Prédiction', 'Écart', 'Note'], d.models.map((m) => [m.label, clock(m.seconds), signedPct(m.error * 100), m.note]));
    doc.p('Écart positif = le modèle était trop lent.');
  }
  intensitySection(doc, a, input);
  durabilitySection(doc, a);
  conditionsSection(doc, conditions);
  for (const b of d.blocks) doc.h(3, b.title).list(b.items);
  if (d.lessons.length) doc.h(3, 'Leçons tirées par RunStat').list(d.lessons);
  athleteSection(doc, input, opts);
  trainingSection(doc, input, opts, parseDay(a.date), 'Entraînement avant la course');
  healthSection(doc, input, opts, parseDay(a.date));
  return finish(doc, `Bilan de course : ${inline(g.name)} (${g.date})`, `bilan-${slug(g.name)}`, input, [
    'Fais le bilan de cette course : gestion de l\'allure, cardio, ravitaillement, conditions, et où j\'ai gagné ou perdu du temps.',
    'Dis-moi si ma préparation (les semaines d\'avant) expliquait ce résultat.',
    'Donne-moi les trois leçons les plus utiles pour ma prochaine course, et ce que je devrais travailler en priorité.',
  ], opts);
}

// ---------------------------------------------------------------------------
// Profil du coureur
// ---------------------------------------------------------------------------

export function profileExport(input: AiInput, opts: AiOptions, matrix: RunnerMatrix | null, goals: GoalEvaluation[]): AiDoc {
  const doc = new MdDoc();
  const { acts, today } = input;
  athleteSection(doc, input, opts);
  levelSection(doc, input, opts, today, true);

  // Records : meilleur effort de tous les temps et des 12 derniers mois
  const recent = acts.filter((a) => daysBetween(parseDay(a.date), today) <= 365);
  const rows = EFFORT_DISTANCES.filter((e) => e.m >= 1000).map((e) => {
    const all = topEfforts(acts, e, 1)[0];
    const year = topEfforts(recent, e, 1)[0];
    return all ? [e.label, clock(all.time), all.activity.date, year ? clock(year.time) : null, year ? year.activity.date : null] : null;
  }).filter((r): r is (string | null)[] => r !== null);
  if (rows.length) {
    doc.h(2, 'Records').use('efforts');
    doc.table(['Distance', 'Record', 'Date', 'Meilleur sur 12 mois', 'Date'], rows);
  }

  if (matrix) {
    doc.h(2, 'Profil Runner Matrix').use('matrix');
    doc.table(['Branche', 'Score aujourd\'hui', 'Il y a 6 mois', '% mondial', 'Fiabilité', 'Ce qu\'elle mesure'], matrix.branches.map((b) => [
      b.label, b.score !== null ? n(b.score) : null, b.scoreThen !== null ? n(b.scoreThen) : null, b.abs !== null ? `${n(b.abs)} %` : null, b.confidence, b.text,
    ]));
    if (opts.detail === 'full') {
      const metrics = matrix.branches.flatMap((b) => b.metrics.filter((m) => opts.health || (m.def.id !== 'rhr' && m.def.id !== 'hrv')).map((m) => [b.label, m.def.label, m.score !== null ? n(m.score) : null, m.scoreThen !== null ? n(m.scoreThen) : null, m.n]));
      doc.h(3, 'Détail des métriques');
      doc.table(['Branche', 'Métrique', 'Score', 'Il y a 6 mois', 'Échantillons'], metrics);
    }
  }

  const dur = durabilitySummary(acts, today, 365, (a) => ['interval', 'tempo', 'race'].includes(input.types.get(a.id) ?? ''));
  if (dur.road || dur.trail) {
    doc.h(2, 'Durabilité sur 12 mois').use('durabilite');
    doc.facts([
      ['Route', dur.road ? `perte d'efficacité médiane ${signedPct(dur.road.median)} (${dur.road.n} sorties), ${signedPct(dur.road.perHour)} par heure de plus` : null],
      ['Trail', dur.trail ? `perte d'efficacité médiane ${signedPct(dur.trail.median)} (${dur.trail.n} sorties), ${signedPct(dur.trail.perHour)} par heure de plus` : null],
      ['Dérive de FC médiane', dur.hrDrift !== null ? `${n(dur.hrDrift, 1)} bpm/h` : null],
      ['Tendance sur les sorties de plus de 1 h 30', dur.trend !== null ? `${dur.trend > 0 ? '+' : '−'}${n(Math.abs(dur.trend), 1)} point par mois (${dur.trend > 0 ? 'se dégrade' : 's\'améliore'})` : null],
    ]);
  }

  // Habitudes et volume par année
  doc.h(2, 'Habitudes');
  const byYear = new Map<number, { km: number; count: number; elev: number }>();
  for (const a of acts) {
    const y = Number(a.date.slice(0, 4));
    const v = byYear.get(y) ?? { km: 0, count: 0, elev: 0 };
    v.km += a.distanceKm; v.count++; v.elev += a.elevGain ?? 0;
    byYear.set(y, v);
  }
  doc.table(['Année', 'Sorties', 'km', 'D+ (m)'], [...byYear.entries()].sort((x, y) => x[0] - y[0]).map(([y, v]) => [y, v.count, n(v.km), n(v.elev)]));
  const terrain = new Map<string, number>();
  for (const a of recent) terrain.set(KIND_LABEL[a.kind], (terrain.get(KIND_LABEL[a.kind]) ?? 0) + 1);
  doc.list([
    recent.length ? `Terrain sur 12 mois : ${[...terrain.entries()].sort((x, y) => y[1] - x[1]).map(([k, c]) => `${k} ${c}`).join(', ')}.` : null,
    recent.length ? `Moments de la journée sur 12 mois : ${daytimeStats(recent).filter((d) => d.count).map((d) => `${d.label.toLowerCase()} ${d.count}`).join(', ')}.` : null,
    habitsLine(input, today),
  ]);

  const upcoming = goals.filter((x) => x.daysLeft >= 0 && !x.result);
  const past = goals.filter((x) => x.daysLeft < 0 || x.result).slice(0, opts.detail === 'full' ? 10 : 4);
  if (upcoming.length || past.length) {
    doc.h(2, 'Objectifs').use('prediction');
    doc.table(['Course', 'Date', 'Distance', 'Objectif', 'Prédiction / résultat'], [...upcoming, ...past].map((x) => [
      inline(x.goal.name), x.goal.date, `${n(x.goal.distanceKm, 1)} km${x.goal.elevGain ? `, ${n(x.goal.elevGain)} m D+` : ''}`,
      x.goal.targetSec ? clock(x.goal.targetSec) : 'finir',
      x.result ? `résultat ${clock(x.goal.debrief?.chipSec ?? x.result.result?.officialSec ?? x.result.durationSec)}` : `${clock(x.predicted)} (${x.verdict.label.toLowerCase()})`,
    ]));
  }
  trainingSection(doc, input, opts, today);
  healthSection(doc, input, opts, today);
  return finish(doc, 'Profil du coureur', 'profil', input, [
    'Dresse mon profil de coureur : mes points forts, mes points faibles et le type d\'épreuves qui me correspond.',
    'Dis-moi ce qui limite le plus ma progression aujourd\'hui, et les deux ou trois priorités d\'entraînement des prochains mois.',
    'Appuie-toi sur les chiffres, et dis-moi si certains te paraissent incohérents.',
  ], opts);
}
