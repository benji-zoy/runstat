import { Component, DestroyRef, ElementRef, effect, inject, input, signal, viewChild } from '@angular/core';
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

type ScaleOptions = Record<string, unknown> & { ticks?: Record<string, unknown>; grid?: Record<string, unknown>; title?: { display?: boolean } };
type Scales = Record<string, ScaleOptions>;

/** Graphiques à axes x / y (les camemberts et radars n'en ont pas) */
const cartesian = (config: ChartConfiguration) => !['doughnut', 'pie', 'radar', 'polarArea'].includes(config.type as string);

/**
 * Axes affichés, y compris ceux que la configuration masquait. `small` : vignette (3-4 graduations, police 10, grille
 * horizontale seulement) ; sinon fenêtre agrandie (police 13, titre de l'axe vertical tiré des séries qu'il porte).
 */
function withAxes(config: ChartConfiguration, small: boolean): Scales {
  const scales = (config.options?.scales ?? { x: {}, y: {} }) as Scales;
  const datasets = config.data.datasets as { label?: string; yAxisID?: string }[];
  return Object.fromEntries(
    Object.entries(scales).map(([id, s]) => {
      if (id === 'r') return [id, s];
      const vertical = id.startsWith('y');
      const ticks = small
        ? { ...s.ticks, display: true, maxTicksLimit: vertical ? 3 : 4, maxRotation: 0, autoSkip: true, font: { size: 10 } }
        : { ...s.ticks, display: true, font: { size: 13 } };
      const labels = datasets.filter((d) => (d.yAxisID ?? 'y') === id && d.label).map((d) => d.label!);
      const title = small
        ? { display: false }
        : vertical && !s.title?.display && labels.length && labels.length <= 2
          ? { display: true, text: labels.join(' · '), font: { size: 13 } }
          : s.title;
      return [id, { ...s, display: true, ticks, title, grid: small ? { ...s.grid, display: vertical, drawTicks: false } : s.grid }];
    }),
  );
}

/**
 * Version vignette d'un graphique (cartes de Comprendre) : mêmes données, sans légende, infobulles ni animation ;
 * axes masqués sur téléphone, discrets sur grand écran (`axes`). Les options d'origine ne sont pas modifiées.
 */
export function miniConfig(config: ChartConfiguration, axes = false): ChartConfiguration {
  const options = config.options ?? {};
  const scales = axes && cartesian(config)
    ? withAxes(config, true)
    : Object.fromEntries(Object.entries(options.scales ?? { x: {}, y: {} }).map(([id, s]) => [id, { ...s, display: false }]));
  return {
    ...config,
    data: {
      ...config.data,
      datasets: config.data.datasets.map((d) => {
        const scatter = (d as { type?: string }).type === 'scatter' || config.type === 'scatter';
        return { ...d, pointRadius: scatter ? 1.5 : 0, pointHoverRadius: 0, borderWidth: Math.min(Number((d as { borderWidth?: number }).borderWidth ?? 2), 2) };
      }),
    } as ChartConfiguration['data'],
    options: {
      ...options,
      animation: false,
      events: [],
      layout: { padding: 2 },
      scales,
      plugins: { ...options.plugins, legend: { display: false }, tooltip: { enabled: false }, title: { display: false } },
    } as ChartConfiguration['options'],
  };
}

/** Version agrandie : tous les axes avec leurs graduations, et le titre de l'axe vertical */
export function zoomConfig(config: ChartConfiguration): ChartConfiguration {
  if (!cartesian(config)) return config;
  return { ...config, options: { ...config.options, scales: withAxes(config, false) } as ChartConfiguration['options'] };
}

/**
 * Enveloppe minimale autour de Chart.js : recrée le graphique quand la config ou le thème change.
 * `mini` : vignette (cartes) ; sinon un bouton ouvre le même graphique en grand, avec tous ses axes, dans une fenêtre.
 */
@Component({
  selector: 'app-chart',
  template: `
    <canvas #canvas></canvas>
    @if (!mini()) {
      <button type="button" class="zoom" (click)="openZoom()" aria-label="Agrandir le graphique" title="Agrandir">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
      </button>
      <dialog #dialog class="zoom-dialog" (close)="closeZoom()" (click)="backdrop($event)">
        <div class="zoom-body">
          <button type="button" class="zoom-close" (click)="dialog.close()" aria-label="Fermer">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
          <div class="zoom-chart"><canvas #big></canvas></div>
        </div>
      </dialog>
    }
  `,
  styles: `
    :host { display: block; position: relative; height: var(--chart-h, 260px); }
    :host(.mini) { height: var(--mini-h, 72px); pointer-events: none; }
    :host(.mini.axes) { height: var(--mini-h-axes, 128px); }
    svg { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .zoom {
      position: absolute; top: -0.25rem; right: -0.25rem; display: grid; place-items: center; width: 2rem; height: 2rem;
      border: 1px solid var(--border); border-radius: 8px; background: color-mix(in srgb, var(--surface-1) 88%, transparent);
      color: var(--text-muted); cursor: pointer; opacity: 0.55; transition: opacity 0.15s, color 0.15s;
    }
    :host(:hover) .zoom, .zoom:focus-visible { opacity: 1; color: var(--text-primary); }
    .zoom-dialog {
      width: min(96vw, 1200px); max-width: none; height: min(86vh, 760px); max-height: none; padding: 0;
      border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-1); color: var(--text-primary);
    }
    .zoom-dialog::backdrop { background: rgb(0 0 0 / 0.6); }
    .zoom-body { position: relative; height: 100%; box-sizing: border-box; padding: 3rem 1.25rem 1.25rem; }
    .zoom-chart { position: relative; height: 100%; }
    .zoom-close {
      position: absolute; top: 0.6rem; right: 0.6rem; display: grid; place-items: center; width: 2.5rem; height: 2.5rem;
      border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); color: var(--text-primary); cursor: pointer;
    }
  `,
  host: { '[class.mini]': 'mini()', '[class.axes]': 'mini() && wide()' },
})
export class ChartComponent {
  readonly config = input.required<ChartConfiguration>();
  /** Vignette : sans axes ni interactions, pas de bouton d'agrandissement */
  readonly mini = input(false);
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly big = viewChild<ElementRef<HTMLCanvasElement>>('big');
  private readonly theme = inject(ThemeService).theme;
  private chart?: Chart;
  private zoomed?: Chart;
  /** Grand écran : les vignettes gardent des axes discrets */
  protected readonly wide = signal(matchMedia('(min-width: 1024px)').matches);

  constructor() {
    const media = matchMedia('(min-width: 1024px)');
    const onMedia = (e: MediaQueryListEvent) => this.wide.set(e.matches);
    media.addEventListener('change', onMedia);
    effect(() => {
      const config = this.mini() ? miniConfig(this.config(), this.wide()) : this.config();
      this.theme();
      applyThemeDefaults();
      this.chart?.destroy();
      this.chart = new Chart(this.canvas().nativeElement, resolveColors(config));
    });
    inject(DestroyRef).onDestroy(() => {
      media.removeEventListener('change', onMedia);
      this.chart?.destroy();
      this.zoomed?.destroy();
    });
  }

  protected openZoom(): void {
    const dialog = this.dialog()?.nativeElement;
    const big = this.big()?.nativeElement;
    if (!dialog || !big) return;
    dialog.showModal();
    applyThemeDefaults();
    this.zoomed?.destroy();
    this.zoomed = new Chart(big, resolveColors(zoomConfig(this.config())));
  }

  protected closeZoom(): void {
    this.zoomed?.destroy();
    this.zoomed = undefined;
  }

  /** Un clic sur le fond (hors du contenu) ferme la fenêtre */
  protected backdrop(e: MouseEvent): void {
    if (e.target === this.dialog()?.nativeElement) this.dialog()!.nativeElement.close();
  }
}
