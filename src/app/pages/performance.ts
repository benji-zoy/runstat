import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { ScienceService } from '../core/science.service';
import { RecordsPage } from './records';
import { AnalysisSection } from '../sections/analysis';
import { SubTab, SubTabsComponent } from '../ui/subtabs';

/** Performance : de quoi suis-je capable ? Records, potentiel (prédictions), durabilité, profil (Runner Matrix). */
@Component({
  selector: 'app-performance',
  imports: [RecordsPage, AnalysisSection, SubTabsComponent],
  template: `
    <header class="page-head">
      <h1>Performance</h1>
      @if (analysis()) {
        <p class="lede">
          Modèles de la littérature scientifique (Runalyze, intervals.icu, TrainingPeaks, Enduraw) appliqués à
          {{ sci.fitCount() }} fichiers FIT seconde par seconde.
        </p>
      }
    </header>
    <app-subtabs #st [tabs]="subtabs" />

    @switch (st.current()) {
      @case ('records') {
        <app-records />
      }
      @case ('potentiel') {
        <app-analysis view="predictions" />
      }
      @case ('durabilite') {
        <app-analysis view="durabilite" />
      }
      @case ('profil') {
        <app-analysis view="matrice" />
      }
    }
  `,
})
export class PerformancePage {
  protected readonly sci = inject(ScienceService);
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  /** Le rappel des sources ne concerne que les analyses (pas les records) */
  protected readonly analysis = computed(() => !!this.params()?.get('section'));
  protected readonly subtabs: SubTab[] = [
    { id: 'records', label: 'Records' },
    { id: 'potentiel', label: 'Potentiel' },
    { id: 'durabilite', label: 'Durabilité' },
    { id: 'profil', label: 'Profil' },
  ];
}
