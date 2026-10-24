import { Component, computed, inject } from '@angular/core';
import { ScienceService } from '../core/science.service';
import { parseDay } from '../core/stats';
import { GoalCardComponent } from './goal-card';
import { RaceDebriefComponent } from './race-debrief';
import { SubTab, SubTabsComponent } from '../ui/subtabs';
import { EntriesService } from '../core/entries.service';
import { DebriefFormComponent } from '../ui/forms/debrief-form';
import { IconComponent } from '../ui/icon';

const dayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

/** Sous-onglet Archives des objectifs : bilan de chaque course terminée, puis l'indice tel qu'il était la veille. */
@Component({
  selector: 'app-goal-archive',
  imports: [GoalCardComponent, RaceDebriefComponent, SubTabsComponent, DebriefFormComponent, IconComponent],
  template: `
    <app-subtabs #st param="course" variant="segment" [tabs]="subtabs()" [hidden]="goals().length < 2" />

    <app-debrief-form #debriefForm />
    @for (e of goals(); track e.goal.id) {
      @if (e.goal.id === st.current()) {
        @if (entries.available()) {
          <div class="row-actions">
            <button type="button" class="btn small" (click)="debriefForm.open(e.goal)">
              <app-icon [name]="e.goal.debrief ? 'edit' : 'plus'" />{{ e.goal.debrief ? 'Modifier le bilan' : 'Temps puce, gels, ressenti' }}
            </button>
          </div>
        }
        @if (debriefs().get(e.goal.id); as d) {
          <app-race-debrief [ev]="e" [debrief]="d" />
        } @else {
          <div class="card">
            <p>Pas de sortie trouvée pour {{ e.goal.name }} le jour de la course (même jour ou lendemain, distance à ±15 %) : synchronise les données {{ sci.caps().label }}.</p>
          </div>
        }
        <h2 class="eve">L'indice de la veille <small>calculé avec les données du {{ eve(e.goal.date) }}</small></h2>
        <app-goal-card [ev]="e" [archived]="true" />
      }
    }
  `,
  styles: `
    :host { display: grid; gap: 1.25rem; }
    app-subtabs { margin-top: 0; }
    .eve { margin: 1rem 0 -0.25rem; }
    .row-actions { display: flex; justify-content: flex-end; margin-bottom: -0.6rem; }
  `,
})
export class GoalArchiveComponent {
  protected readonly sci = inject(ScienceService);
  protected readonly entries = inject(EntriesService);
  protected readonly goals = this.sci.archivedGoals;
  protected readonly debriefs = this.sci.debriefs;
  protected readonly subtabs = computed<SubTab[]>(() =>
    this.goals().map((e) => ({
      id: e.goal.id,
      label: `${e.goal.name} · ${parseDay(e.goal.date).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' })}`,
    })),
  );
  protected eve = (iso: string) => dayFmt.format(new Date(parseDay(iso).getTime() - 86_400_000));
}
