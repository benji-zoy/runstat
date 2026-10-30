import { Component, computed, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DataService } from '../core/data.service';
import { ScienceService } from '../core/science.service';
import { topicById } from '../core/topics';
import { AnalysisSection } from '../sections/analysis';
import { RecoveryComponent } from '../sections/recovery';
import { RaceStandingSection } from '../sections/race-standing';
import { PlacesSection } from '../sections/places';
import { HabitsPage } from './habits';
import { RecordsPage } from './records';
import { IconComponent } from '../ui/icon';

/** Une question de Comprendre en grand : tous ses graphiques (agrandissables) et sa méthode. */
@Component({
  selector: 'app-topic',
  imports: [RouterLink, IconComponent, AnalysisSection, RecoveryComponent, RaceStandingSection, PlacesSection, HabitsPage, RecordsPage],
  template: `
    @if (topic(); as t) {
      <a class="back" routerLink="/comprendre"><app-icon name="back" />Comprendre</a>
      <header class="page-head">
        <h1>{{ t.question }}</h1>
        <p class="lede">{{ t.lede }}</p>
        @if (analysis()) {
          <p class="lede">Modèles de la littérature scientifique appliqués à {{ sci.fitCount() }} fichiers FIT seconde par seconde.</p>
        }
      </header>

      @switch (t.id) {
        @case ('potentiel') { <app-analysis view="predictions" /> }
        @case ('records') { <app-records /> }
        @case ('classements') { <app-race-standing /> }
        @case ('recuperation') { <app-recovery /> }
        @case ('charge') { <app-analysis view="charge" /> }
        @case ('progres') { <app-analysis view="efficacite" /> }
        @case ('endurance') { <app-analysis view="durabilite" /> }
        @case ('seances') { <app-analysis view="seances" /> }
        @case ('habitudes') { <app-habits /> }
        @case ('carte') { <app-places /> }
        @case ('profil') { <app-analysis view="matrice" /> }
      }
    }
  `,
  styles: `
    :host { display: block; }
    .back {
      display: inline-flex; align-items: center; gap: 0.25rem; min-height: 44px; margin-top: 1rem; margin-bottom: -1rem;
      color: var(--accent-text); font-weight: 600; text-decoration: none;
    }
    h1 { text-transform: none; }
  `,
})
export class TopicPage {
  private readonly params = toSignal(inject(ActivatedRoute).paramMap);
  private readonly store = inject(DataService);
  protected readonly sci = inject(ScienceService);

  protected readonly topic = computed(() => {
    const t = topicById(this.params()?.get('sujet'));
    // « Suis-je prêt ? » vit dans Courses ; la récupération demande une source de santé
    if (!t || t.link || (t.health && !this.store.data()?.health)) return null;
    return t;
  });
  /** Rappel des sources pour les analyses scientifiques (pas pour les records, habitudes, carte) */
  protected readonly analysis = computed(() =>
    ['potentiel', 'charge', 'progres', 'endurance', 'seances', 'profil'].includes(this.topic()?.id ?? ''),
  );

  constructor() {
    const router = inject(Router);
    effect(() => {
      const id = this.params()?.get('sujet');
      const t = topicById(id);
      if (t?.link) void router.navigateByUrl(t.link, { replaceUrl: true });
      else if (!this.topic() && this.store.data()) void router.navigateByUrl('/comprendre', { replaceUrl: true });
    });
  }
}
