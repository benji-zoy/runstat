import { Component, DestroyRef, ElementRef, effect, inject, input, viewChild } from '@angular/core';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import { ThemeService } from '../core/theme.service';
import { cssVar, resolveColors } from './palette';

Chart.register(...registerables);
Chart.defaults.font.family = "'Inter Variable', 'Inter', system-ui, sans-serif";
Chart.defaults.font.size = 12;
Chart.defaults.plugins.legend.labels.boxWidth = 12;
Chart.defaults.plugins.legend.labels.boxHeight = 12;
Chart.defaults.plugins.legend.labels.useBorderRadius = true;
Chart.defaults.plugins.legend.labels.borderRadius = 3;
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 8;
Chart.defaults.maintainAspectRatio = false;

/** Couleurs par défaut (axes, grille, infobulles) du thème courant */
function applyThemeDefaults(): void {
  Chart.defaults.color = cssVar('--text-secondary');
  Chart.defaults.borderColor = cssVar('--border');
  Chart.defaults.plugins.tooltip.backgroundColor = cssVar('--surface-2');
  Chart.defaults.plugins.tooltip.borderColor = cssVar('--surface-3');
  Chart.defaults.plugins.tooltip.titleColor = cssVar('--text-primary');
  Chart.defaults.plugins.tooltip.bodyColor = cssVar('--text-secondary');
  Chart.defaults.plugins.tooltip.footerColor = cssVar('--text-secondary');
}

/** Enveloppe minimale autour de Chart.js : recrée le graphique quand la config ou le thème change. */
@Component({
  selector: 'app-chart',
  template: '<canvas #canvas></canvas>',
  styles: ':host { display: block; position: relative; height: var(--chart-h, 260px); }',
})
export class ChartComponent {
  readonly config = input.required<ChartConfiguration>();
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly theme = inject(ThemeService).theme;
  private chart?: Chart;

  constructor() {
    effect(() => {
      const config = this.config();
      this.theme();
      applyThemeDefaults();
      this.chart?.destroy();
      this.chart = new Chart(this.canvas().nativeElement, resolveColors(config));
    });
    inject(DestroyRef).onDestroy(() => this.chart?.destroy());
  }
}
