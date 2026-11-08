/**
 * Parties communes des exports vers une IA : le coureur, l'entraînement récent, le niveau actuel, la santé.
 * Fonctions pures sur les données du snapshot (aucune dépendance à Angular) : réutilisables par un futur serveur MCP local.
 */
import { Activity, Athlete, Fitness, Health } from '../models';
import { Capabilities } from '../sources';
import {
  ExponentEstimate, CriticalSpeed, Reference, SESSION_TYPES, SessionType, bestEfforts, criticalSpeed, personalExponentFromRaces,
  references, timeForVdot, vo2AtSpeed,
} from '../science';
import { freshnessState, pmc } from '../insights';
import { baselineSeries, hrvStatus, rhrStatus, sleepDebt } from '../health';
import { addDays, isoDay, parseDay, startOfWeek } from '../stats';
import { MdDoc, clock, dayLabel, hm, n, pace } from './md';

const DAY_MS = 86_400_000;
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY_MS);

/** Données de l'athlète nécessaires aux exports (toutes celles de l'instance, triées par date croissante) */
export interface AiInput {
  acts: Activity[];
  types: Map<string, SessionType>;
  athlete: Athlete;
  health: Health | null;
  fitness: Fitness | null;
  caps: Capabilities;
  today: Date;
}

export type AiDetail = 'summary' | 'full';

export interface AiOptions {
  detail: AiDetail;
  /** Joindre la santé (sommeil, VFC, FC de repos, poids) */
  health: boolean;
  /** Question libre de la personne, ajoutée à la consigne */
  question?: string;
}

export const KIND_LABEL: Record<Activity['kind'], string> = { road: 'route', indoor: 'tapis / virtuel', trail: 'trail', track: 'piste', other: 'autre' };
export const typeLabel = (t: SessionType | undefined) => SESSION_TYPES[t ?? 'easy'].label;

/** Âge en années révolues */
export function age(birthday: string | undefined, today: Date): number | null {
  if (!birthday || !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return null;
  const b = parseDay(birthday);
  if (Number.isNaN(b.getTime())) return null;
  let y = today.getFullYear() - b.getFullYear();
  if (today.getMonth() < b.getMonth() || (today.getMonth() === b.getMonth() && today.getDate() < b.getDate())) y--;
  return y > 0 && y < 120 ? y : null;
}

/** Seuils de FC retenus (saisis, sinon 80 % et 89 % de la FC max) */
export const thresholds = (ath: Athlete): [number, number] => [ath.lt1Hr ?? Math.round(ath.hrMax * 0.8), ath.lt2Hr ?? Math.round(ath.hrMax * 0.89)];

/** Le coureur : âge, sexe, FC de référence ; poids et taille seulement avec la santé */
export function athleteSection(doc: MdDoc, input: AiInput, opts: AiOptions): void {
  const a = input.athlete;
  const [lt1, lt2] = thresholds(a);
  doc.h(2, 'Le coureur').use('zones');
  doc.facts([
    ['Sexe', a.sex === 'F' ? 'femme' : 'homme'],
    ['Âge', age(a.birthday, input.today) !== null ? `${age(a.birthday, input.today)} ans` : null],
    ['FC max', `${a.hrMax} bpm`],
    ['FC de repos (réglage)', `${a.hrRest} bpm`],
    ['Seuils', `LT1 ${lt1} bpm, LT2 ${lt2} bpm${a.lt1Hr || a.lt2Hr ? '' : ' (par défaut : 80 % et 89 % de la FC max)'}`],
    ['Poids', opts.health && a.weightKg ? `${n(a.weightKg, 1)} kg` : null],
    ['Taille', opts.health && a.heightCm ? `${a.heightCm} cm` : null],
    ['Montre / source', input.caps.label],
  ]);
}

interface Week {
  start: Date;
  count: number;
  km: number;
  sec: number;
  elev: number;
  longest: number;
  quality: number;
  load: number;
}

/** Semaines (lundi → dimanche) qui précèdent `ref` inclus, de la plus ancienne à la plus récente */
export function weeks(acts: Activity[], types: Map<string, SessionType>, ref: Date, count: number): Week[] {
  const first = addDays(startOfWeek(ref), -7 * (count - 1));
  const out: Week[] = Array.from({ length: count }, (_, i) => ({ start: addDays(first, 7 * i), count: 0, km: 0, sec: 0, elev: 0, longest: 0, quality: 0, load: 0 }));
  const end = isoDay(ref);
  for (const a of acts) {
    if (a.date > end) continue;
    const i = Math.floor(daysBetween(first, parseDay(a.date)) / 7);
    if (i < 0 || i >= count) continue;
    const w = out[i];
    w.count++;
    w.km += a.distanceKm;
    w.sec += a.durationSec;
    w.elev += a.elevGain ?? 0;
    w.longest = Math.max(w.longest, a.distanceKm);
    const t = types.get(a.id);
    if (t === 'interval' || t === 'tempo' || t === 'race') w.quality++;
    w.load += a.trainingLoad ?? 0;
  }
  return out;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** Une ligne par sortie : date, type, distance, durée, allure, FC, D+ */
export function runRow(a: Activity, types: Map<string, SessionType>): (string | number | null)[] {
  return [
    dayLabel(a.date), typeLabel(types.get(a.id)) + ((a.kind === 'trail' && types.get(a.id) !== 'trail') || a.kind === 'indoor' ? ` (${KIND_LABEL[a.kind]})` : ''),
    n(a.distanceKm, 1), hm(a.durationSec), pace(a.durationSec / a.distanceKm), a.avgHr ?? null, a.elevGain != null ? n(a.elevGain) : null,
  ];
}
export const RUN_HEAD = ['Date', 'Type', 'km', 'Durée', 'Allure', 'FC moy.', 'D+ (m)'];

/**
 * Entraînement jusqu'à `ref` : moyennes, tableau hebdomadaire, répartition des séances, forme / fatigue / fraîcheur,
 * puis (complet) le détail des dernières sorties.
 */
export function trainingSection(doc: MdDoc, input: AiInput, opts: AiOptions, ref: Date, title = 'Entraînement récent'): void {
  const { acts, types } = input;
  const count = opts.detail === 'full' ? 16 : 8;
  const done = acts.filter((a) => a.date <= isoDay(ref));
  doc.h(2, title).use('types', 'charge');
  if (!done.length) {
    doc.p('Aucune sortie enregistrée avant cette date.');
    return;
  }
  // Moyennes et tableau à partir de la semaine de la première sortie enregistrée (historique court)
  const firstWeek = isoDay(startOfWeek(parseDay(done[0].date)));
  const since = (w: Week) => isoDay(w.start) >= firstWeek;
  const ws = weeks(acts, types, ref, count).filter(since);
  const year = weeks(acts, types, ref, 52).filter(since);
  const last4 = ws.slice(-4);
  doc.facts([
    ['Moyenne des 4 dernières semaines', `${n(avg(last4.map((w) => w.km)), 1)} km/sem, ${n(avg(last4.map((w) => w.count)), 1)} sorties/sem, ${hm(avg(last4.map((w) => w.sec)))}/sem`],
    [`Moyenne des ${ws.length} dernières semaines`, ws.length > 4 ? `${n(avg(ws.map((w) => w.km)), 1)} km/sem` : null],
    [year.length < 52 ? `Depuis le début (${year.length} semaines)` : '52 dernières semaines', `${n(year.reduce((s, w) => s + w.km, 0))} km en ${year.reduce((s, w) => s + w.count, 0)} sorties (${n(avg(year.map((w) => w.km)), 1)} km/sem), ${n(year.reduce((s, w) => s + w.elev, 0))} m D+`],
    ['Historique', `${done.length} sorties depuis le ${done[0].date}`],
  ]);
  doc.p(`Semaines (du lundi au dimanche ; la dernière peut être en cours au ${isoDay(ref)}) :`);
  doc.table(
    ['Semaine du', 'Sorties', 'km', 'Durée', 'D+ (m)', 'Plus longue (km)', 'Qualité', input.caps.loadLabel],
    ws.map((w) => [isoDay(w.start), w.count, n(w.km, 1), hm(w.sec), n(w.elev), w.longest ? n(w.longest, 1) : null, w.quality, w.load ? n(w.load) : null]),
  );
  doc.p('« Qualité » = fractionné, tempo / seuil et courses.');

  const window = done.filter((a) => daysBetween(parseDay(a.date), ref) < 7 * count);
  const mix = new Map<SessionType, number>();
  for (const a of window) mix.set(types.get(a.id) ?? 'easy', (mix.get(types.get(a.id) ?? 'easy') ?? 0) + 1);
  if (mix.size) {
    doc.p(`Répartition des séances sur ${count} semaines : ${[...mix.entries()].sort((x, y) => y[1] - x[1]).map(([t, c]) => `${typeLabel(t)} ${c}`).join(', ')}.`);
  }

  const day = pmc(done, ref).at(-1);
  if (day && day.ctl > 0) {
    const tsb = day.ctl - day.atl;
    doc.use('pmc').p(`Charge au ${isoDay(ref)} : forme ${n(day.ctl)}, fatigue ${n(day.atl)}, fraîcheur ${tsb >= 0 ? '+' : '−'}${n(Math.abs(tsb))} (${freshnessState(tsb).label.toLowerCase()}).`);
  }

  const recent = done.filter((a) => daysBetween(parseDay(a.date), ref) < (opts.detail === 'full' ? 28 : 14));
  if (recent.length) {
    doc.h(3, `Sorties des ${opts.detail === 'full' ? 4 : 2} dernières semaines`).use('allure');
    doc.table(RUN_HEAD, recent.map((a) => runRow(a, types)));
  }
}

/** Séances clés (fractionné, tempo, sorties longues, courses) des `weeksBack` dernières semaines */
export function keySessions(doc: MdDoc, input: AiInput, ref: Date, weeksBack: number): void {
  const xs = input.acts.filter((a) => {
    const t = input.types.get(a.id);
    const age = daysBetween(parseDay(a.date), ref);
    return age >= 0 && age < 7 * weeksBack && (t === 'interval' || t === 'tempo' || t === 'long' || t === 'race' || t === 'trail');
  });
  if (!xs.length) return;
  doc.h(3, `Séances clés des ${weeksBack} dernières semaines`).use('allure', 'types');
  doc.table([...RUN_HEAD, 'Découplage'], xs.map((a) => [...runRow(a, input.types), a.fit?.decoupling != null ? `${n(a.fit.decoupling, 1)} %` : null]));
}

/** Vitesse (m/min) pour une fraction de VO₂max donnée (inverse de `vo2AtSpeed`) */
function speedAt(vo2: number): number {
  const a = 0.000104, b = 0.182258, c = -4.6 - vo2;
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}
const paceAtFraction = (v: number, f: number) => 60000 / speedAt(v * f);

/** Allures d'entraînement de Daniels pour un VDOT */
export function trainingPaces(v: number): { label: string; pace: string }[] {
  return [
    { label: 'E (endurance)', pace: `${pace(paceAtFraction(v, 0.74))} à ${pace(paceAtFraction(v, 0.65))}` },
    { label: 'M (marathon)', pace: pace(timeForVdot(v, 42195) / 42.195) },
    { label: 'T (seuil)', pace: pace(paceAtFraction(v, 0.88)) },
    { label: 'I (intervalles)', pace: pace(paceAtFraction(v, 0.98)) },
    { label: 'R (répétitions)', pace: pace(timeForVdot(v, 1609) / 1.609) },
  ];
}

const DIST_LABEL: Record<number, string> = { 400: '400 m', 800: '800 m', 1000: '1 km', 1609: '1 mile', 3000: '3 km', 5000: '5 km', 10000: '10 km', 15000: '15 km', 21097: 'semi', 21097.5: 'semi', 30000: '30 km', 42195: 'marathon' };
export const distLabel = (m: number) => DIST_LABEL[m] ?? `${n(m / 1000, 1)} km`;

export interface Level {
  refs: Reference[];
  vdot: number | null;
  exponent: ExponentEstimate | null;
  cs: CriticalSpeed | null;
}

export function currentLevel(input: AiInput, ref: Date): Level {
  const acts = input.acts.filter((a) => parseDay(a.date) <= ref);
  const refs = references(acts, input.types, ref);
  return {
    refs,
    vdot: refs[0]?.vdot ?? null,
    exponent: personalExponentFromRaces(acts, input.types, input.athlete, ref),
    cs: criticalSpeed([...bestEfforts(acts, ref, 112).entries()].map(([dist, e]) => ({ dist, time: e.time }))),
  };
}

/** Niveau actuel : meilleures références, VDOT, allures d'entraînement, exposant, vitesse critique, montre */
export function levelSection(doc: MdDoc, input: AiInput, opts: AiOptions, ref: Date, withPaces = false): void {
  const lv = currentLevel(input, ref);
  doc.h(2, 'Niveau actuel').use('vdot');
  if (lv.refs.length) {
    doc.p('Performances de référence (courses sur route des 18 derniers mois et meilleurs efforts des 16 dernières semaines), de la meilleure à la moins bonne :');
    doc.table(['Date', 'Distance', 'Temps', 'Allure', 'VDOT', 'Origine'],
      lv.refs.slice(0, opts.detail === 'full' ? 8 : 4).map((r) => [r.date, distLabel(r.dist), clock(r.time), pace(r.time / (r.dist / 1000)), n(r.vdot, 1), r.source === 'course' ? 'course' : 'meilleur effort (FIT, ajusté à la pente)']));
  } else {
    doc.p('Aucune course sur route récente ni meilleur effort mesuré : niveau difficile à estimer.');
  }
  if (lv.vdot && withPaces) {
    doc.use('allures').p(`Allures d'entraînement pour un VDOT de ${n(lv.vdot, 1)} (min/km) :`);
    doc.table(['Allure', 'min/km'], trainingPaces(lv.vdot).map((p) => [p.label, p.pace]));
  }
  if (lv.exponent) doc.use('riegel').p(`Exposant de Riegel personnel : ${n(lv.exponent.k, 2)} (brut ${n(lv.exponent.raw, 2)}, a priori 1,07).`);
  if (lv.cs) doc.use('vc').p(`Vitesse critique : ${pace(1000 / lv.cs.cs)} /km, D′ ${n(lv.cs.dPrime)} m.`);
  const f = input.fitness;
  if (input.caps.corosFitness && f) {
    const preds = Object.entries(f.predictions).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`);
    doc.p(`Selon la montre : VO₂max ${f.vo2max ?? '–'}${f.thresholdPace ? `, allure seuil ${f.thresholdPace}` : ''}${preds.length ? `, prédictions ${preds.join(', ')}` : ''}.`);
  }
}

/** Santé des derniers jours jusqu'à `ref` : FC de repos, VFC, sommeil, face à la base personnelle */
export function healthSection(doc: MdDoc, input: AiInput, opts: AiOptions, ref: Date): void {
  const h = input.health;
  if (!opts.health || !h) return;
  const days = opts.detail === 'full' ? 14 : 7;
  const from = addDays(ref, -(days - 1));
  const rows: (string | number | null)[][] = [];
  for (let d = from; d <= ref; d = addDays(d, 1)) {
    const x = h.days[isoDay(d)];
    if (!x) continue;
    rows.push([dayLabel(isoDay(d)), x.rhr ?? null, x.hrv != null ? n(x.hrv) : null, x.sleepMin != null ? hm(x.sleepMin * 60) : null, x.sleepScore ?? null, x.readiness ?? null]);
  }
  doc.h(2, 'Santé et récupération').use('vfc', 'fcRepos');
  if (!rows.length) {
    doc.p(`Pas de données de santé sur les ${days} jours précédant le ${isoDay(ref)}.`);
    return;
  }
  const last = rows.length ? parseDay(Object.keys(h.days).filter((k) => k <= isoDay(ref)).sort().at(-1)!) : ref;
  const hrv = baselineSeries(h, 'hrv', last, last)[0];
  const rhr = baselineSeries(h, 'rhr', last, last)[0];
  const hs = hrvStatus(hrv);
  const rs = rhrStatus(rhr);
  const sleep = sleepDebt(h, last);
  doc.facts([
    ['VFC (moyenne 7 j)', hrv?.avg7 ? `${n(hrv.avg7)} ms, base ${n(hrv.mean)} ± ${n(hrv.sd)} ms${hs ? ` → ${hs.label.toLowerCase()}` : ''}` : null],
    ['FC de repos (moyenne 7 j)', rhr?.avg7 ? `${n(rhr.avg7, 1)} bpm, base ${n(rhr.mean, 1)} bpm${rs ? ` (${rs.label})` : ''}` : null],
    ['Sommeil (7 nuits)', sleep ? `${hm(sleep.avg * 60)} par nuit en moyenne` : null],
  ]);
  doc.table(['Jour', 'FC repos', 'VFC (ms)', 'Sommeil', 'Score sommeil', 'Préparation'], rows);
  const w = h.weight.filter((x) => x.date <= isoDay(ref)).at(-1);
  if (w) doc.p(`Dernier poids mesuré : ${n(w.kg, 1)} kg (${w.date}).`);
}

/** Sorties semblables avant `a` : même type, distance à ±25 %, 6 mois */
export function similarRuns(a: Activity, input: AiInput, max: number): Activity[] {
  const t = input.types.get(a.id);
  const ref = parseDay(a.date);
  return input.acts
    .filter((x) => x.id !== a.id && x.kind === a.kind && input.types.get(x.id) === t)
    .filter((x) => {
      const age = daysBetween(parseDay(x.date), ref);
      return age > 0 && age <= 183 && Math.abs(x.distanceKm / a.distanceKm - 1) <= 0.25;
    })
    .slice(-max);
}
