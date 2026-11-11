import { GoalEvaluation, taperDays } from './goals';
import { parseDay } from './stats';

/**
 * Objectifs secondaires face à l'objectif principal : trop proches, trop rapprochés, trop longs, trop ambitieux. Ordres de
 * grandeur d'entraîneur (récupération ≈ 1 jour par km de course au-delà du semi, une semaine pour un 10 km), affichés dans
 * l'assistant de plan et écrits dans l'export pour que l'IA en tienne compte.
 */
export interface PlanCheck {
  /** Objectif secondaire concerné, null pour une remarque d'ensemble */
  goalId: string | null;
  level: 'warning' | 'info';
  text: string;
}

const DAY = 86_400_000;
const gapDays = (a: string, b: string) => Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / DAY);
const fr = (x: number) => x.toLocaleString('fr-FR', { maximumFractionDigits: 0 });

/** km-effort pour un trail, distance sinon */
export const effortKm = (e: GoalEvaluation) => (e.goal.kind === 'trail' ? e.ke : e.goal.distanceKm);

/** Jours pour récupérer d'une course faite à fond */
export function recoveryDays(km: number): number {
  if (km <= 12) return 7;
  if (km <= 25) return 10;
  if (km <= 45) return 21;
  return Math.min(42, Math.round(28 + (km - 45) / 5));
}

export function secondaryChecks(main: GoalEvaluation, secondaries: GoalEvaluation[]): PlanCheck[] {
  const out: PlanCheck[] = [];
  const mainKm = effortKm(main);
  const taper = taperDays(main.goal);
  const list = [...secondaries].filter((s) => s.goal.date < main.goal.date).sort((a, b) => a.goal.date.localeCompare(b.goal.date));
  list.forEach((s, i) => {
    const g = s.goal;
    const km = effortKm(s);
    const rec = recoveryDays(km);
    const gap = gapDays(g.date, main.goal.date);
    if (gap <= taper) {
      out.push({
        goalId: g.id,
        level: km <= 10 ? 'info' : 'warning',
        text: `${g.name} tombe pendant l'affûtage de ${main.goal.name} (${gap} jours avant) : à courir comme une séance, sans aller au bout de toi.`,
      });
    } else if (gap - rec < taper + 7) {
      out.push({
        goalId: g.id,
        level: 'warning',
        text: `${g.name} est proche de ${main.goal.name} (${gap} jours avant) : il faut ≈ ${rec} jours pour en récupérer, il reste peu de temps pour s'entraîner avant l'affûtage.`,
      });
    }
    if (km >= mainKm * 0.9) {
      out.push({
        goalId: g.id,
        level: 'warning',
        text: `${g.name} (${fr(km)} km${s.goal.kind === 'trail' ? '-effort' : ''}) est aussi long que ${main.goal.name} : la fatigue risque de déborder sur la préparation.`,
      });
    }
    const next = list[i + 1];
    if (next) {
      const between = gapDays(g.date, next.goal.date);
      if (between < rec) {
        out.push({
          goalId: next.goal.id,
          level: 'warning',
          text: `${g.name} et ${next.goal.name} sont à ${between} jours d'écart : il en faut ≈ ${rec} pour récupérer du premier.`,
        });
      }
    }
    if (g.targetSec && s.probability !== null && s.probability < 0.25) {
      out.push({
        goalId: g.id,
        level: 'warning',
        text: `Le chrono visé sur ${g.name} est très ambitieux (${fr(s.probability * 100)} % de chances aujourd'hui) : risque d'une course à fond qui coûte plus qu'elle n'apporte.`,
      });
    }
  });
  const long = list.filter((s) => effortKm(s) >= 21 && gapDays(s.goal.date, main.goal.date) <= 84);
  if (long.length > 2) {
    out.push({
      goalId: null,
      level: 'warning',
      text: `${long.length} courses de 21 km ou plus dans les 12 semaines avant ${main.goal.name} : c'est beaucoup, garde-en une ou deux à fond au plus.`,
    });
  }
  return out;
}
