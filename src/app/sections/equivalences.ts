import { Component, computed, inject, input } from '@angular/core';
import { DataService } from '../core/data.service';
import { Period, Summary } from '../core/models';
import { EIFFEL, FUN, FUN_GROUPS, FunMetric, HEIGHTS, LEGENDS, funValue, headlineHeight, tripFor } from '../core/equivalences';
import { duration, km, num, smart } from '../core/format';

/** "× 3,2" quand on dépasse le repère, "45 %" sinon */
function ratioText(ratio: number): string {
  return ratio >= 1 ? `× ${smart(ratio)}` : `${num(ratio * 100, ratio < 0.01 ? 2 : 0)} %`;
}

@Component({
  selector: 'app-equivalences',
  template: `
    <section class="section">
      <h2>C'est l'équivalent de… <small>{{ period().phrase }}</small></h2>

      <div class="layout">
        <!-- Trajet entre villes -->
        <article class="card trip">
          <h3>🗺️ Trajet</h3>
          @if (trip().done; as t) {
            <p class="statement">
              Tu aurais pu aller de <b>{{ t.from }}</b> à <b>{{ t.to }}</b>
            </p>
            <p class="muted">{{ km(t.km) }} à vol d'oiseau</p>
            @if (summary().km / t.km >= 2) {
              <p class="muted">… et même faire {{ smart(summary().km / t.km) }} fois le trajet.</p>
            }
          } @else {
            <p class="statement">Premiers kilomètres au compteur&nbsp;!</p>
          }

          @if (trip().next; as n) {
            <div class="route">
              <div class="route-ends">
                <span>{{ n.from }}</span>
                <span>{{ n.to }}</span>
              </div>
              <div class="route-line">
                <span class="route-fill" [style.width.%]="(summary().km / n.km) * 100"></span>
                <span class="runner" [style.left.%]="(summary().km / n.km) * 100">🏃</span>
              </div>
              <p class="muted small">
                Prochaine étape&nbsp;: <b class="txt">{{ n.from }} → {{ n.to }}</b> ({{ km(n.km) }}),
                plus que <b class="txt">{{ km(n.km - summary().km) }}</b> —
                {{ num((summary().km / n.km) * 100) }} % du chemin.
              </p>
            </div>
          }
        </article>

        <!-- Dénivelé -->
        <article class="card heights">
          <h3>⛰️ Dénivelé</h3>
          @if (summary().elev > 0) {
            <p class="statement">
              <span class="display hl">{{ smart(summary().elev / headline().value) }}</span>
              fois {{ headline().name }} {{ headline().icon }}
            </p>
            @if (headline() !== eiffel && summary().elev >= eiffel.value / 2) {
              <p class="sub">
                ou <b>{{ smart(summary().elev / eiffel.value) }}</b> tours Eiffel {{ eiffel.icon }}
              </p>
            }
            <p class="muted">{{ num(summary().elev) }} m de D+ cumulés</p>
            <ul class="ladder">
              @for (h of heights(); track h.name) {
                <li [class.reached]="h.ratio >= 1">
                  <span class="icon">{{ h.icon }}</span>
                  <span class="name">{{ h.name }} <span class="muted">· {{ num(h.value) }} m</span></span>
                  <span class="ratio">{{ ratioText(h.ratio) }}</span>
                </li>
              }
            </ul>
          } @else {
            <p class="muted">Pas de dénivelé sur cette période.</p>
          }
        </article>

        <!-- Repères mythiques -->
        <article class="card legends">
          <h3>🏆 Repères mythiques</h3>
          <ul class="bars">
            @for (l of legends(); track l.name) {
              <li>
                <div class="bar-head">
                  <span>{{ l.icon }} {{ l.name }} <span class="muted">· {{ km(l.value) }}</span></span>
                  <b>{{ ratioText(l.ratio) }}</b>
                </div>
                <div class="progress"><span [style.width.%]="Math.min(100, l.ratio * 100)"></span></div>
              </li>
            }
          </ul>
        </article>

        <!-- Fun -->
        <article class="card fun">
          <h3>🤪 Pour le fun</h3>
          <p class="muted">
            Chaque chiffre divise un total de la période par la taille d'un repère du quotidien. Par exemple,
            {{ km(summary().km) }} ÷ 65 cm = <b class="txt">{{ smart((summary().km * 1000) / 0.65) }} baguettes</b>
            mises bout à bout.
          </p>
          <div class="fun-groups">
            @for (g of fun(); track g.metric) {
              <section class="fun-group">
                <header class="fun-head">
                  <span class="fun-title">{{ g.icon }} {{ g.title }}</span>
                  <b class="fun-total">{{ g.total }}</b>
                  <span class="muted small">{{ g.how }}</span>
                </header>
                <div class="tiles">
                  @for (t of g.tiles; track t.name) {
                    <div class="tile">
                      <span class="tile-icon">{{ t.icon }}</span>
                      <span class="display tile-value">{{ t.count }}</span>
                      <span class="tile-label">{{ t.label }}</span>
                      <span class="tile-ref">{{ t.ref }}</span>
                    </div>
                  }
                </div>
              </section>
            }
          </div>
        </article>
      </div>
    </section>
  `,
  styleUrl: './equivalences.scss',
})
export class EquivalencesComponent {
  readonly period = input.required<Period>();
  readonly summary = input.required<Summary>();

  protected readonly Math = Math;
  protected readonly km = km;
  protected readonly num = num;
  protected readonly smart = smart;
  protected readonly ratioText = ratioText;
  protected readonly eiffel = EIFFEL;

  private readonly store = inject(DataService);
  protected readonly trip = computed(() => tripFor(this.summary().km, this.store.data()?.athlete?.homeCity));
  protected readonly headline = computed(() => headlineHeight(this.summary().elev));

  /** Les repères de hauteur autour du dénivelé réalisé (2 sous, 3 au-dessus). */
  protected readonly heights = computed(() => {
    const elev = this.summary().elev;
    const all = HEIGHTS.map((h) => ({ ...h, ratio: elev / h.value }));
    const firstAbove = all.findIndex((h) => h.ratio < 1);
    const pivot = firstAbove === -1 ? all.length : firstAbove;
    return all.slice(Math.max(0, pivot - 2), pivot + 3);
  });

  /** Les repères mythiques pertinents : le marathon, puis jusqu'aux deux premiers non atteints. */
  protected readonly legends = computed(() => {
    const d = this.summary().km;
    const all = LEGENDS.map((l) => ({ ...l, ratio: d / l.value }));
    const firstAbove = all.findIndex((l) => l.ratio < 1);
    const pivot = firstAbove === -1 ? all.length : firstAbove;
    const shown = all.slice(Math.max(0, pivot - 4), pivot + 2);
    // Le marathon reste toujours affiché : « × 117 marathons » parle à tout le monde
    return shown[0] === all[0] ? shown : [all[0], ...shown];
  });

  /** Les comparaisons absurdes, regroupées par total divisé (distance, pas, calories, temps). */
  protected readonly fun = computed(() => {
    const s = this.summary();
    const totals: Record<FunMetric, (v: number) => string> = {
      meters: () => km(s.km),
      steps: (v) => `${num(v)} pas`,
      calories: (v) => `${num(v)} kcal`,
      minutes: () => duration(s.sec),
    };
    return FUN_GROUPS.map((g) => {
      const v = funValue(g.metric, s);
      const tiles = v
        ? FUN.filter((f) => f.metric === g.metric && v / f.value >= 0.1).map((f) => ({
            icon: f.icon,
            name: f.name,
            count: smart(v / f.value),
            label: f.plural ?? f.name,
            ref: f.ref,
          }))
        : [];
      return { ...g, total: v ? totals[g.metric](v) : '', tiles };
    }).filter((g) => g.tiles.length > 0);
  });
}
