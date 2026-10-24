import { Component } from '@angular/core';
import { SubTab, SubTabsComponent } from '../ui/subtabs';
import { ActivitiesPage } from './activities';
import { HabitsPage } from './habits';
import { VolumeSection } from '../sections/volume';
import { AnalysisSection } from '../sections/analysis';

/** Entraînement : qu'est-ce que j'ai fait ? Journal, volume, habitudes, types de séances. */
@Component({
  selector: 'app-training',
  imports: [SubTabsComponent, ActivitiesPage, HabitsPage, VolumeSection, AnalysisSection],
  template: `
    <header class="page-head">
      <h1>Entraînement</h1>
    </header>
    <app-subtabs #st [tabs]="subtabs" />

    @switch (st.current()) {
      @case ('journal') {
        <app-activities />
      }
      @case ('volume') {
        <app-volume />
      }
      @case ('habitudes') {
        <app-habits />
      }
      @case ('seances') {
        <app-analysis view="seances" />
      }
    }
  `,
})
export class TrainingPage {
  protected readonly subtabs: SubTab[] = [
    { id: 'journal', label: 'Journal' },
    { id: 'volume', label: 'Volume' },
    { id: 'habitudes', label: 'Habitudes' },
    { id: 'seances', label: 'Séances' },
  ];
}
