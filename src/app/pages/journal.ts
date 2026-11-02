import { Component } from '@angular/core';
import { SubTab, SubTabsComponent } from '../ui/subtabs';
import { ActivitiesPage } from './activities';
import { VolumeSection } from '../sections/volume';

/** Journal : qu'est-ce que j'ai fait ? Liste des sorties et volume (semaine, mois, année, calendrier, régularité). */
@Component({
  selector: 'app-journal',
  imports: [SubTabsComponent, ActivitiesPage, VolumeSection],
  template: `
    <header class="page-head">
      <h1>Journal</h1>
    </header>
    <app-subtabs #st [tabs]="subtabs" />

    @switch (st.current()) {
      @case ('journal') {
        <app-activities />
      }
      @case ('volume') {
        <app-volume />
      }
    }
  `,
})
export class JournalPage {
  protected readonly subtabs: SubTab[] = [
    { id: 'journal', label: 'Sorties' },
    { id: 'volume', label: 'Volume' },
  ];
}
