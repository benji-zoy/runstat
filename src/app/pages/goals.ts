import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ScienceService } from '../core/science.service';
import { GoalArchiveComponent } from '../sections/goal-archive';
import { GoalCardComponent } from '../sections/goal-card';
import { SubTab, SubTabsComponent } from '../ui/subtabs';
import { EntriesService } from '../core/entries.service';
import { GoalFormComponent } from '../ui/forms/goal-form';
import { IconComponent } from '../ui/icon';

/**
 * Courses : objectifs à venir (indice de confiance, chrono probable, préparation, conseils) et Archives (bilans des courses
 * terminées). Les classements (barème FFA) sont dans Comprendre › Où je me situe face aux autres ?
 */
@Component({
  selector: 'app-goals',
  imports: [GoalArchiveComponent, GoalCardComponent, SubTabsComponent, GoalFormComponent, IconComponent],
  template: `
    <header class="page-head">
      <h1>Courses</h1>
      <p class="lede">Indice de confiance calculé sur tes données, mis à jour à chaque synchro</p>
      @if (entries.available()) {
        <button type="button" class="btn small add" (click)="goalForm.open()"><app-icon name="plus" />Objectif</button>
      }
    </header>
    <app-goal-form #goalForm />

    <app-subtabs #st [tabs]="subtabs()" />

    @if (st.current() === 'archives') {
      <app-goal-archive />
    } @else {
      @for (e of goals(); track e.goal.id) {
        @if (e.goal.id === st.current()) {
          @if (entries.available()) {
            <div class="row-actions">
              <button type="button" class="btn small" (click)="goalForm.open(e.goal)"><app-icon name="edit" />Modifier l'objectif</button>
            </div>
          }
          <app-goal-card [ev]="e" />
        }
      } @empty {
        <div class="card">
          @if (entries.available()) {
            <p>Pas encore d'objectif : ajoute ta prochaine course pour suivre ta préparation et ton chrono probable.</p>
            <button type="button" class="btn primary" (click)="goalForm.open()"><app-icon name="plus" />Ajouter un objectif</button>
          } @else {
            <p>Ajoute tes prochains objectifs dans <code>data-raw/goals.json</code> puis lance <code>npm run data</code> :</p>
            <pre>[{{ '{' }} "id": "semi-2026", "name": "Semi", "date": "2026-10-11", "startTime": "09:30",
  "distanceKm": 21.0975, "targetSec": 5700, "kind": "road" {{ '}' }}]</pre>
          }
        </div>
      }
    }

    <details class="card method">
      <summary>Comment l'indice est calculé</summary>
      <ul>
        <li><b>Objectif chrono</b> : plusieurs modèles prédisent le temps (Coros, VDOT de Daniels, Riegel avec ton exposant pondéré,
          VDOT actualisé par ta progression d'efficacité, vitesse critique). Leur moyenne géométrique est corrigée par la fraîcheur
          projetée, la récupération (VFC, FC de repos), la météo (règle de Hadley) et la préparation spécifique. L'incertitude combine
          le désaccord entre modèles et la variabilité d'un jour de course (2,5 % sur route, 7 % en trail) : l'indice est la
          probabilité de passer sous le chrono visé.</li>
        <li><b>Objectif « finir »</b> : indice de préparation pondéré (volume, sortie la plus longue, D+, expérience en km-effort,
          sorties de nuit, régularité, récupération). Le chrono trail est extrapolé de tes trails récents au km-effort ITRA
          (Riegel, exposant 1,10).</li>
        <li><b>Course de référence</b> : ta dernière course sur la même distance (moins de 2 ans) est un modèle à part entière, de poids 1,5
          (le plus spécifique). Son chrono, ramené à des conditions neutres (Hadley), donne ton niveau de ce jour-là ; il est projeté à
          aujourd'hui en comparant les 8 semaines qui l'ont précédé aux 8 dernières : effet du volume (Tanda) × progrès de forme
          (moyenne de l'allure moyenne d'entraînement et de la moitié du gain d'efficacité aérobie), plafonné à ±10 %.</li>
        <li><b>Stratégie</b> : allure par tronçon calée pour que la somme fasse le chrono visé (départ 2-3 s/km plus lent, final plus
          rapide), zones de FC selon la distance, glucides 30-60 g/h jusqu'à 2 h 30 puis 60-90 g/h (ACSM, Burke), recharge 7-12 g/kg.</li>
        <li>Les seuils de préparation sont des repères d'entraînement usuels, pas des lois : l'indice indique où porter l'effort.</li>
      </ul>
    </details>
  `,
  styles: `
    :host { display: grid; gap: 1.25rem; }
    :host > app-subtabs { margin-top: -0.6rem; }
    .page-head { margin-top: 1.75rem; position: relative; }
    .add { position: absolute; right: 0; top: 0.2rem; }
    .row-actions { display: flex; justify-content: flex-end; margin-bottom: -0.6rem; }
    .method ul { gap: 0.5rem; }
    pre { background: var(--surface-2); padding: 0.8rem; border-radius: 8px; overflow-x: auto; font-size: 0.82rem; }
  `,
})
export class GoalsPage {
  constructor() {
    // Ancienne adresse Courses › Classements
    if (inject(ActivatedRoute).snapshot.queryParamMap.get('section') === 'classements') {
      void inject(Router).navigateByUrl('/comprendre/classements', { replaceUrl: true });
    }
  }

  private readonly sci = inject(ScienceService);
  protected readonly entries = inject(EntriesService);
  protected readonly goals = this.sci.upcomingGoals;
  protected readonly subtabs = computed<SubTab[]>(() => [
    ...this.goals().map((e) => ({ id: e.goal.id, label: e.goal.name, badge: e.daysLeft > 0 ? 'J-' + e.daysLeft : 'Jour J' })),
    ...(this.sci.archivedGoals().length ? [{ id: 'archives', label: 'Archives', badge: String(this.sci.archivedGoals().length) }] : []),
  ]);
}
