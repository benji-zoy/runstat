import { Injectable, computed, inject } from '@angular/core';
import { DataService } from './data.service';
import { PeriodService } from './period.service';
import { ScienceService } from './science.service';
import { Activity } from './models';
import { GoalEvaluation } from './goals';
import { AiInput, AiOptions } from './ai/context';
import { AiDoc, AiExportKind, PlanRequest, debriefExport, goalExport, planExport, profileExport, runExport } from './ai/exports';

/** Ce dont on veut discuter : une sortie, un objectif (à venir ou passé) ou le profil */
export type AiSubject = { run: Activity } | { goal: GoalEvaluation } | { profile: true };

export const KIND_LABELS: Record<AiExportKind, string> = {
  run: 'Cette sortie',
  goal: 'L\'objectif',
  plan: 'Plan d\'entraînement',
  debrief: 'Bilan de course',
  profile: 'Mon profil',
};

/**
 * Exports Markdown pour une IA (core/ai/) à partir des calculs déjà faits pour l'interface (ScienceService) :
 * rien ne quitte l'appareil, la personne copie, télécharge ou partage le texte elle-même.
 */
@Injectable({ providedIn: 'root' })
export class AiExportService {
  private readonly store = inject(DataService);
  private readonly sci = inject(ScienceService);
  private readonly today = inject(PeriodService).today;

  /** La santé n'est proposée que si l'instance en a (source choisie et données présentes) */
  readonly hasHealth = computed(() => this.sci.sources().health !== 'none' && !!this.store.data()?.health && Object.keys(this.store.data()!.health!.days).length > 0);

  private readonly input = computed<AiInput>(() => ({
    acts: this.store.activities(),
    types: this.sci.types(),
    athlete: this.sci.athlete(),
    health: this.hasHealth() ? this.store.data()?.health ?? null : null,
    fitness: this.store.data()?.fitness ?? null,
    caps: this.sci.caps(),
    today: this.today,
  }));

  /** Exports possibles pour un sujet, le premier par défaut */
  kinds(subject: AiSubject): AiExportKind[] {
    if ('run' in subject) return ['run'];
    if ('profile' in subject) return ['profile'];
    const e = subject.goal;
    if (e.daysLeft < 0 || e.result) return this.sci.debriefs().has(e.goal.id) ? ['debrief'] : [];
    // Le plan d'entraînement a son propre assistant (ui/forms/plan-wizard.ts)
    return ['goal'];
  }

  /** Export « Plan d'entraînement » à partir des choix de l'assistant */
  buildPlan(e: GoalEvaluation, opts: AiOptions, request: PlanRequest): AiDoc {
    return planExport(e, this.input(), { ...opts, health: opts.health && this.hasHealth() }, request);
  }

  build(subject: AiSubject, kind: AiExportKind, opts: AiOptions): AiDoc | null {
    const input = this.input();
    const o = { ...opts, health: opts.health && this.hasHealth() };
    if ('run' in subject) return runExport(subject.run, input, o, this.sci.conditions(subject.run));
    if ('profile' in subject) return profileExport(input, o, this.sci.matrix(), this.sci.goals());
    const e = subject.goal;
    if (kind === 'debrief') {
      const d = this.sci.debriefs().get(e.goal.id);
      return d ? debriefExport(e, d, input, o, this.sci.conditions(d.activity)) : null;
    }
    return goalExport(e, input, o);
  }
}
