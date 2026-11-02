import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DataService } from '../core/data.service';
import { ScienceService } from '../core/science.service';
import { TOPIC_GROUPS, Topic } from '../core/topics';
import { clock } from '../core/format';
import { AnalysisSection } from '../sections/analysis';
import { RecoveryComponent } from '../sections/recovery';
import { RaceStandingSection } from '../sections/race-standing';
import { PlacesSection } from '../sections/places';
import { HabitsPage } from './habits';
import { RecordsPage } from './records';
import { IconComponent } from '../ui/icon';

/**
 * Comprendre : toutes les analyses en petites cartes, une question chacune, avec le constat et une vignette.
 * Une carte ouvre la page de la question (graphiques en grand, méthode).
 */
@Component({
  selector: 'app-understand',
  imports: [RouterLink, IconComponent, AnalysisSection, RecoveryComponent, RaceStandingSection, PlacesSection, HabitsPage, RecordsPage],
  template: `
    <header class="page-head">
      <h1>Comprendre</h1>
      <p class="lede">Une question par carte. Touche-la pour le détail, les graphiques en grand et la méthode.</p>
    </header>

    @for (g of groups(); track g.label) {
      <section class="section">
        <h2>{{ g.label }}</h2>
        <div class="tiles">
          @for (t of g.topics; track t.id) {
            <a class="card tile" [routerLink]="t.link ?? '/comprendre/' + t.id">
              <h3>{{ t.question }}</h3>
              <div class="body">
                @switch (t.id) {
                  @case ('pret') {
                    @if (nextGoal(); as e) {
                      <p class="verdict">{{ e.goal.name }} · {{ e.daysLeft ? 'J-' + e.daysLeft : 'Jour J' }}</p>
                      <div class="race">
                        <span class="big">{{ clock(e.predicted) }}</span>
                        <span class="muted">{{ e.probability !== null ? e.index + ' % sous ' + clock(e.goal.targetSec!) : 'préparation ' + e.index + '/100' }}</span>
                      </div>
                      <div class="progress" aria-hidden="true"><span [style.width.%]="e.index"></span></div>
                    } @else {
                      <p class="verdict">Pas de course prévue : ajoute ton prochain objectif dans Courses.</p>
                    }
                  }
                  @case ('potentiel') { <app-analysis view="predictions" [compact]="true" /> }
                  @case ('records') { <app-records [compact]="true" /> }
                  @case ('classements') { <app-race-standing [compact]="true" /> }
                  @case ('recuperation') { <app-recovery [compact]="true" /> }
                  @case ('charge') { <app-analysis view="charge" [compact]="true" /> }
                  @case ('progres') { <app-analysis view="efficacite" [compact]="true" /> }
                  @case ('endurance') { <app-analysis view="durabilite" [compact]="true" /> }
                  @case ('seances') { <app-analysis view="seances" [compact]="true" /> }
                  @case ('habitudes') { <app-habits [compact]="true" /> }
                  @case ('carte') { <app-places [compact]="true" /> }
                  @case ('profil') { <app-analysis view="matrice" [compact]="true" /> }
                }
              </div>
              <span class="more">{{ t.link ? 'Plan de course' : 'Détail' }} <app-icon name="arrow" /></span>
            </a>
          }
        </div>
      </section>
    }
  `,
  styles: `
    .tiles { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fill, minmax(min(46%, 250px), 1fr)); }
    .tile {
      display: grid; grid-template-rows: auto 1fr auto; gap: 0.6rem; color: inherit; text-decoration: none;
      transition: border-color 0.15s, background 0.15s;
    }
    .tile:hover { border-color: var(--accent); }
    .tile:focus-visible { outline-offset: 3px; }
    .tile h3 { font-size: 0.98rem; line-height: 1.25; }
    .body { display: grid; align-content: start; gap: 0.5rem; min-width: 0; }
    .body :is(app-analysis, app-records, app-race-standing, app-recovery, app-habits, app-places) { display: grid; gap: 0.5rem; min-width: 0; }
    .body .verdict { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .race { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.2rem 0.6rem; }
    .race .big { font: 600 1.6rem var(--font-mono); }
    .race .muted { font-size: 0.82rem; }
    .more { display: inline-flex; align-items: center; gap: 0.3rem; color: var(--accent-text); font-size: 0.82rem; font-weight: 600; --icon: 0.9rem; }
    @media (max-width: 600px) {
      .tiles { gap: 0.6rem; }
      .tile { padding: 0.85rem; }
      .tile h3 { font-size: 0.9rem; }
      .race .big { font-size: 1.3rem; }
    }
  `,
})
export class UnderstandPage {
  private readonly store = inject(DataService);
  private readonly sci = inject(ScienceService);
  protected readonly clock = clock;
  protected readonly nextGoal = computed(() => this.sci.upcomingGoals()[0] ?? null);

  /** Sans source de santé, pas de carte Récupération */
  protected readonly groups = computed(() => {
    const health = !!this.store.data()?.health;
    return TOPIC_GROUPS.map((g) => ({ ...g, topics: g.topics.filter((t: Topic) => health || !t.health) }));
  });
}
