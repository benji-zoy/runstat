import { Component, computed, inject } from '@angular/core';
import { DataService } from '../core/data.service';
import { RecoveryComponent } from '../sections/recovery';
import { AnalysisSection } from '../sections/analysis';
import { SubTab, SubTabsComponent } from '../ui/subtabs';

/** Forme : comment va mon corps ? Récupération (Google Health), charge et efficacité. */
@Component({
  selector: 'app-fitness-page',
  imports: [RecoveryComponent, AnalysisSection, SubTabsComponent],
  template: `
    <header class="page-head">
      <h1>Forme</h1>
    </header>
    <app-subtabs #st [tabs]="subtabs()" />

    @switch (st.current()) {
      @case ('recuperation') {
        <app-recovery />
      }
      @case ('charge') {
        <app-analysis view="charge" />
      }
      @case ('efficacite') {
        <app-analysis view="efficacite" />
      }
    }
  `,
})
export class FitnessPage {
  private readonly store = inject(DataService);
  /** Sans source de santé (ou sans données), pas de Récupération */
  protected readonly subtabs = computed<SubTab[]>(() => [
    ...(this.store.data()?.health ? [{ id: 'recuperation', label: 'Récupération' }] : []),
    { id: 'charge', label: 'Charge' },
    { id: 'efficacite', label: 'Efficacité' },
  ]);
}
