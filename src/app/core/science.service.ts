import { Injectable, computed, inject } from '@angular/core';
import { DataService } from './data.service';
import { PeriodService } from './period.service';
import { SessionType, bestEfforts, classifyAll, criticalSpeed, personalExponentFromRaces, references } from './science';
import { GoalEvaluation, evaluateGoal, goalContext, goalResult } from './goals';
import { RaceDebrief, raceDebrief } from './debrief';
import { runnerMatrix } from './matrix';
import { Activity, Athlete } from './models';
import { ConditionsReport, conditionsCost, personalCoefficients } from './conditions';
import { CAPABILITIES, HEALTH_LABELS, sourcesOf } from './sources';

const DEFAULT_ATHLETE: Athlete = { hrMax: 190, hrRest: 55, sex: 'M', weightKg: 70, heightCm: 175, birthday: '1990-01-01' };

/** Résultats d'analyse partagés entre les onglets (calculés une seule fois). */
@Injectable({ providedIn: 'root' })
export class ScienceService {
  private readonly store = inject(DataService);
  private readonly today = inject(PeriodService).today;

  readonly athlete = computed(() => this.store.data()?.athlete ?? DEFAULT_ATHLETE);
  /** Sources de l'instance et ce qu'elles fournissent (core/sources.ts) */
  readonly sources = computed(() => sourcesOf(this.store.data()));
  readonly caps = computed(() => CAPABILITIES[this.sources().activities]);
  readonly healthLabel = computed(() => HEALTH_LABELS[this.sources().health]);
  /** Types de séance ; la sortie d'un objectif passé est une course, quel que soit son nom */
  readonly types = computed<Map<string, SessionType>>(() => {
    const acts = this.store.activities();
    const types = classifyAll(acts, this.athlete());
    for (const g of this.store.data()?.goals ?? []) {
      const r = goalResult(g, acts);
      if (r) types.set(r.id, 'race');
    }
    // Une sortie retrouvée dans des résultats officiels, ou marquée « course » dans Strava, est une course
    for (const a of acts) if ((a.result && !a.result.pending) || a.race) types.set(a.id, 'race');
    return types;
  });
  readonly references = computed(() => references(this.store.activities(), this.types(), this.today));
  readonly exponent = computed(() => personalExponentFromRaces(this.store.activities(), this.types(), this.athlete(), this.today));

  /** Meilleurs efforts FIT ajustés à la pente sur 16 semaines (fenêtre de Smyth & Muniz-Pumares) */
  readonly recentEfforts = computed(() => bestEfforts(this.store.activities(), this.today, 112));
  readonly criticalSpeed = computed(() =>
    criticalSpeed([...this.recentEfforts().entries()].map(([dist, e]) => ({ dist, time: e.time }))),
  );
  readonly fitCount = computed(() => this.store.activities().filter((a) => a.fit).length);

  /** Runner Matrix : six branches par rapport à ton propre historique, et grille durée × terrain */
  readonly matrix = computed(() =>
    runnerMatrix({
      acts: this.store.activities(),
      athlete: this.athlete(),
      types: this.types(),
      health: this.store.data()?.health ?? null,
      today: this.today,
      corosVo2max: this.store.data()?.fitness?.vo2max ?? null,
    }),
  );

  /** Coût des conditions : coefficients perso (dénivelé, chaleur) mesurés une fois sur tout l'historique */
  readonly conditionsCoef = computed(() => personalCoefficients(this.store.activities(), this.types()));
  conditions(a: Activity): ConditionsReport | null {
    return conditionsCost(a, this.athlete(), this.conditionsCoef());
  }

  /** Objectifs évalués : à venir (du plus proche au plus lointain), puis passés (du plus récent) */
  readonly goals = computed<GoalEvaluation[]>(() => {
    const d = this.store.data();
    if (!d?.goals?.length) return [];
    const acts = this.store.activities();
    const evals = d.goals
      .map((g) => evaluateGoal(g, goalContext(g, acts, this.types(), this.athlete(), this.today, d.fitness?.predictions ?? {}, d.health), this.today, acts))
      .filter((e): e is GoalEvaluation => e !== null);
    const upcoming = evals.filter((e) => e.daysLeft >= 0).sort((a, b) => a.daysLeft - b.daysLeft);
    const past = evals.filter((e) => e.daysLeft < 0).sort((a, b) => b.daysLeft - a.daysLeft);
    return [...upcoming, ...past];
  });

  /** Objectifs à venir et terminés (sous-onglet Archives : dès que le résultat est synchronisé) */
  readonly upcomingGoals = computed(() => this.goals().filter((e) => !isArchived(e)));
  readonly archivedGoals = computed(() => this.goals().filter(isArchived));

  /** Bilans des objectifs terminés, par identifiant d'objectif */
  readonly debriefs = computed(() => {
    const acts = this.store.activities();
    const next = this.upcomingGoals()[0]?.goal ?? null;
    const out = new Map<string, RaceDebrief>();
    for (const e of this.archivedGoals()) {
      if (e.result) out.set(e.goal.id, raceDebrief(e, e.result, this.athlete(), acts, next));
    }
    return out;
  });
}

function isArchived(e: GoalEvaluation): boolean {
  return e.daysLeft < 0 || e.result !== null;
}
