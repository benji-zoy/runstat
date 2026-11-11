// Envoi d'un plan importé dans le calendrier COROS : un vrai plan d'entraînement COROS (createTrainingPlan), réécrit d'un bloc
// au renvoi (updateTrainingPlan sur le plan en cours de même nom). Contraintes de COROS : 4 à 16 semaines naturelles (lundi →
// dimanche), début dans les 14 jours, séances structurées ; pas de renfo ni de suppression d'un plan par cette voie.
import { parseSteps, type PlanKind, type PlanSession, type Step, type StepIntensity, type TrainingPlan } from './plan.ts';

const DAY = 86_400_000;
const utc = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const ymd = (d: string) => Number(d.replaceAll('-', ''));
/** Lundi de la semaine d'un jour */
const monday = (d: string) => iso(utc(d) - ((new Date(utc(d)).getUTCDay() + 6) % 7) * DAY);
const days = (a: string, b: string) => Math.round((utc(b) - utc(a)) / DAY);

export const COROS_MAX_WEEKS = 16;
export const COROS_MIN_WEEKS = 4;
export const COROS_START_WINDOW = 14;

/** Phases COROS : 1 préparation, 2 foncier, 3 développement, 4 pic, 5 course, 6 transition */
export function phaseType(name: string | undefined): number {
  const t = (name ?? '').toLowerCase();
  if (/aff[ûu]t|course|taper|race/.test(t)) return 5;
  if (/pic|peak|sp[ée]cifique/.test(t)) return 4;
  if (/d[ée]velopp|build|qualit|seuil/.test(t)) return 3;
  if (/r[ée]cup|transition|coupure/.test(t)) return 6;
  if (/pr[ée]pa|reprise|adapt/.test(t)) return 1;
  return 2;
}

/** Zone par défaut d'une étape sans intensité */
const DEFAULT_ZONE: Record<PlanKind, number> = { easy: 2, long: 2, quality: 3, race: 4, strength: 1, other: 2 };

function intensityFields(it: StepIntensity | undefined, fallbackZone: number) {
  if (!it) return { intensityType: 1, sectionIntensity: fallbackZone };
  if (it.type === 'zone') return { intensityType: 1, sectionIntensity: Math.min(6, Math.max(1, it.zone)) };
  if (it.type === 'hr') return { intensityType: 1, intensityValueStart: clamp(it.from, 30, 240), intensityValueEnd: clamp(it.to, 30, 240) };
  return { intensityType: 2, intensityValueStart: clamp(it.from, 120, 1499), intensityValueEnd: clamp(it.to, 120, 1499) };
}
const clamp = (x: number, a: number, b: number) => Math.round(Math.min(b, Math.max(a, x)));

function section(step: Step, sectionType: number, zone: number) {
  const target = step.target.type === 'time' ? { targetType: 2, targetValue: Math.max(1, Math.round(step.target.sec)) } : { targetType: 1, targetValue: Math.max(1, Math.round(step.target.m)) };
  return { sectionType, ...target, ...intensityFields(step.intensity, sectionType === 2 ? zone : 1) };
}

/** Sections COROS d'une séance : étapes lues, sinon une seule section sur la durée (ou la distance) */
export function corosSections(s: PlanSession): unknown[] {
  const zone = DEFAULT_ZONE[s.kind];
  const parts = s.steps ? parseSteps(s.steps) : null;
  if (parts) {
    return parts.map((p, i) => {
      if ('repeat' in p)
        return { intervalGroup: true, repeats: p.repeat, sets: p.steps.map((st, j) => section(st, j === 0 ? 2 : 3, zone)) };
      // Plusieurs étapes : la première échauffe, la dernière ramène au calme
      const type = parts.length > 1 && i === 0 ? 1 : parts.length > 1 && i === parts.length - 1 ? 4 : 2;
      return section(p.step, type, zone);
    });
  }
  const step: Step = s.durationMin
    ? { target: { type: 'time', sec: s.durationMin * 60 } }
    : { target: { type: 'distance', m: Math.round((s.distanceKm ?? 5) * 1000) } };
  return [section(step, 2, zone)];
}

const describe = (s: PlanSession) =>
  [s.steps, s.durationMin ? `≈ ${s.durationMin} min` : null, s.distanceKm ? `≈ ${s.distanceKm} km` : null, 'Plan préparé avec RunStat.']
    .filter(Boolean)
    .join(' · ')
    .slice(0, 500);

const course = (s: PlanSession, dayNo: number) => ({ dayNo, sportType: 1, courseName: s.name.slice(0, 100), courseDescription: describe(s), sections: corosSections(s) });
const rest = (dayNo: number) => ({ dayNo, sportType: 4, courseName: 'Repos', courseDescription: 'Jour de repos', sections: [] });

/** Les séances que COROS peut recevoir (pas de renfo ni d'autre sport) */
export const corosSessions = (plan: TrainingPlan) => plan.sessions.filter((s) => s.kind !== 'strength' && s.kind !== 'other');

/** Phases semaine par semaine, regroupées ; la première commence au début du plan, les autres un lundi */
function periodization(start: string, weeks: number, sessions: PlanSession[]) {
  const first = monday(start);
  const types: number[] = [];
  for (let w = 0; w < weeks; w++) {
    const from = iso(utc(first) + w * 7 * DAY);
    const to = iso(utc(first) + (w * 7 + 6) * DAY);
    const named = sessions.filter((s) => s.date >= from && s.date <= to && s.phase);
    const counts = new Map<number, number>();
    for (const s of named) counts.set(phaseType(s.phase), (counts.get(phaseType(s.phase)) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    types.push(best ?? types.at(-1) ?? 2);
  }
  const out: { phaseType: number; startDate: number; endDate: number; durationWeeks: number }[] = [];
  types.forEach((t, w) => {
    const last = out.at(-1);
    const end = ymd(iso(utc(first) + (w * 7 + 6) * DAY));
    if (last && last.phaseType === t) {
      last.endDate = end;
      last.durationWeeks++;
    } else out.push({ phaseType: t, startDate: ymd(w === 0 ? start : iso(utc(first) + w * 7 * DAY)), endDate: end, durationWeeks: 1 });
  });
  return out;
}

export interface CorosPlanDraft {
  start: string;
  weeks: number;
  /** Séances envoyées */
  sessions: PlanSession[];
  /** Dernier jour couvert (dimanche de la dernière semaine) */
  end: string;
  /** Séances non envoyées (au-delà de 16 semaines) */
  later: number;
}

/**
 * Ce que COROS recevrait : à partir d'aujourd'hui (ou du début du plan COROS en cours), 16 semaines au plus.
 * Erreur en clair si COROS ne peut pas le prendre.
 */
export function corosDraft(plan: TrainingPlan, today: string, planStart?: string): CorosPlanDraft {
  const future = corosSessions(plan).filter((s) => s.date >= today);
  if (!future.length) throw new Error('aucune séance de course à venir dans le plan');
  const start = planStart ?? today;
  if (!planStart && days(today, future[0].date) > COROS_START_WINDOW)
    throw new Error(`le plan commence le ${future[0].date} : COROS n'accepte un nouveau plan que s'il commence dans les ${COROS_START_WINDOW} jours`);
  const lastAllowed = iso(utc(monday(start)) + (COROS_MAX_WEEKS * 7 - 1) * DAY);
  const sent = future.filter((s) => s.date <= lastAllowed);
  const lastWeek = monday(sent.at(-1)!.date);
  const weeks = Math.max(COROS_MIN_WEEKS, days(monday(start), lastWeek) / 7 + 1);
  if (weeks > COROS_MAX_WEEKS) throw new Error('plan COROS limité à 16 semaines');
  const end = iso(utc(monday(start)) + (weeks * 7 - 1) * DAY);
  if (sent.at(-1)!.date < iso(utc(end) - 6 * DAY)) throw new Error(`COROS demande ${COROS_MIN_WEEKS} semaines de plan au moins, avec une séance la dernière semaine`);
  return { start, weeks, sessions: sent, end, later: future.length - sent.length };
}

export const corosPlanName = (goalName: string) => `RunStat · ${goalName}`.slice(0, 90);

/** Arguments de createTrainingPlan */
export function corosCreateArgs(plan: TrainingPlan, goalName: string, draft: CorosPlanDraft) {
  return {
    planInfo: {
      planName: corosPlanName(goalName),
      planOverview: `Plan pour ${goalName}, préparé avec une IA à partir de tes données RunStat. Le renforcement reste dans RunStat.`.slice(0, 800),
      planStartDate: ymd(draft.start),
      totalWeeks: draft.weeks,
    },
    phaseInfo: { periodization: periodization(draft.start, draft.weeks, plan.sessions) },
    courseList: draft.sessions.map((s) => course(s, days(draft.start, s.date))),
  };
}

/**
 * Arguments de updateTrainingPlan pour un plan COROS en cours commencé le `planStart` : chaque jour d'aujourd'hui à la fin
 * est réécrit (séance, ou repos pour effacer l'ancienne). Les jours déjà faits sont laissés tels quels par COROS.
 */
export function corosUpdateArgs(plan: TrainingPlan, planId: string, planStart: string, draft: CorosPlanDraft, today: string) {
  const byDay = new Map<string, PlanSession[]>();
  for (const s of draft.sessions) byDay.set(s.date, [...(byDay.get(s.date) ?? []), s]);
  const courseList: unknown[] = [];
  for (let t = utc(today); t <= utc(draft.end); t += DAY) {
    const d = iso(t);
    const n = days(planStart, d);
    const list = byDay.get(d);
    if (list) courseList.push(...list.map((s) => course(s, n)));
    else courseList.push(rest(n));
  }
  return {
    planInfo: { planId, totalWeeks: draft.weeks },
    phaseInfo: { periodization: periodization(planStart, draft.weeks, plan.sessions) },
    courseList,
  };
}

export interface CorosLibraryRow {
  name: string;
  status: string;
  planId: string;
  role: string;
  editable: boolean;
  start?: string;
}

/** Lignes du texte de queryTrainingPlanLibrary */
export function parsePlanLibrary(text: string): CorosLibraryRow[] {
  return text
    .split(/\n(?=\d+\.\s)/)
    .map((block) => {
      const head = block.match(/^\d+\.\s+(.*?)\s+\[([^\]]+)\]/m);
      const id = block.match(/Plan ID:\s*(\d+)/);
      if (!head || !id) return null;
      const dates = block.match(/Dates:\s*(\d{4}-\d{2}-\d{2})/);
      return {
        name: head[1].trim(),
        status: head[2].trim().toLowerCase(),
        planId: id[1],
        role: block.match(/Record role:\s*(\w+)/)?.[1] ?? 'unknown',
        editable: /Editable via MCP:\s*yes/i.test(block),
        ...(dates ? { start: dates[1] } : {}),
      };
    })
    .filter((r): r is CorosLibraryRow => !!r);
}

export interface CorosWriter {
  callTool(name: string, args?: Record<string, unknown>): Promise<any>;
  callWriteTool(name: string, args: Record<string, unknown>): Promise<any>;
  toolText(result: any): string;
}

/**
 * Envoie le plan à COROS : met à jour le plan RunStat en cours de cet objectif s'il existe et se modifie, sinon en crée un.
 * Renvoie l'état à garder dans le plan (`coros`) ; une erreur de COROS lève une exception au message lisible.
 */
export async function pushPlanToCoros(client: CorosWriter, plan: TrainingPlan, goalName: string, today: string, now = new Date()) {
  const name = corosPlanName(goalName);
  const library = parsePlanLibrary(client.toolText(await client.callTool('queryTrainingPlanLibrary', { statusList: [0, 1] })));
  const mine = library.filter((r) => r.name === name);
  const running = mine.find((r) => r.role === 'execution' && r.editable && r.status.includes('progress'));
  let draft: CorosPlanDraft;
  let result: any;
  if (running?.start) {
    draft = corosDraft(plan, today, running.start);
    result = await client.callWriteTool('updateTrainingPlan', corosUpdateArgs(plan, running.planId, running.start, draft, today));
  } else {
    if (mine.some((r) => r.status.includes('not started') && r.role === 'execution'))
      throw new Error('un plan RunStat pour cet objectif attend déjà son début dans COROS : supprime-le dans l’appli COROS avant de renvoyer');
    draft = corosDraft(plan, today);
    result = await client.callWriteTool('createTrainingPlan', corosCreateArgs(plan, goalName, draft));
  }
  if (result?.isError) throw new Error(client.toolText(result).slice(0, 400) || 'refusé par COROS');
  return {
    sentAt: now.toISOString(),
    start: running?.start ?? draft.start,
    weeks: draft.weeks,
    sessions: draft.sessions.length,
    ...(draft.later ? { until: draft.end } : {}),
  };
}
