import { Component, input } from '@angular/core';

export interface Brief {
  title: string;
  points: string[];
}

/** « En bref » : le constat d'une page en une phrase et quelques points, avant le détail */
@Component({
  selector: 'app-brief',
  template: `
    @if (brief(); as b) {
      <div class="card brief">
        <span class="label">En bref</span>
        <b class="title">{{ b.title }}</b>
        @if (b.points.length) {
          <ul>
            @for (p of b.points; track p) {
              <li>{{ p }}</li>
            }
          </ul>
        }
      </div>
    }
  `,
  styles: `
    :host { display: block; margin-top: 1.25rem; }
    :host:empty { display: none; }
    .brief {
      display: grid; gap: 0.4rem;
      border-left: 3px solid var(--accent);
      background: linear-gradient(90deg, var(--accent-soft), var(--surface-1) 45%);
    }
    .label { color: var(--accent); }
    .title { font-family: var(--font-display); font-size: 1.45rem; font-weight: 700; line-height: 1.15; text-wrap: balance; }
    ul { margin: 0.15rem 0 0; padding-left: 1.1rem; display: grid; gap: 0.3rem; color: var(--text-secondary); font-size: 0.9rem; }
    @media (max-width: 600px) { .title { font-size: 1.25rem; } ul { font-size: 0.86rem; } }
  `,
})
export class BriefComponent {
  readonly brief = input<Brief | null>(null);
}
