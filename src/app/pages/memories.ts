import { Component, computed, inject } from '@angular/core';
import { DataService } from '../core/data.service';
import { PeriodService } from '../core/period.service';
import { inRange, summarize } from '../core/stats';
import { RecapPage } from './recap';
import { BadgesPage } from './badges';
import { EquivalencesComponent } from '../sections/equivalences';
import { PeriodNavComponent } from '../ui/period-nav';
import { SubTab, SubTabsComponent } from '../ui/subtabs';

/** Souvenirs : pour le plaisir. Récap de l'année, niveau et badges, jalons, équivalences. */
@Component({
  selector: 'app-memories',
  imports: [RecapPage, BadgesPage, EquivalencesComponent, PeriodNavComponent, SubTabsComponent],
  template: `
    <header class="page-head">
      <h1>Souvenirs</h1>
    </header>
    <app-subtabs #st [tabs]="subtabs" />

    @switch (st.current()) {
      @case ('recap') {
        <app-recap />
      }
      @case ('badges') {
        <app-badges view="badges" />
      }
      @case ('jalons') {
        <app-badges view="jalons" />
      }
      @case ('equivalences') {
        <app-period-nav />
        <app-equivalences [period]="period()" [summary]="summary()" />
      }
    }
  `,
})
export class MemoriesPage {
  private readonly store = inject(DataService);
  private readonly ps = inject(PeriodService);
  protected readonly period = this.ps.period;
  protected readonly summary = computed(() => summarize(inRange(this.store.activities(), this.period().start, this.period().end)));

  protected readonly subtabs: SubTab[] = [
    { id: 'recap', label: 'Récap' },
    { id: 'badges', label: 'Badges' },
    { id: 'jalons', label: 'Jalons' },
    { id: 'equivalences', label: 'Équivalences' },
  ];
}
