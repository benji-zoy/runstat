import { Component, ElementRef, afterRenderEffect, computed, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';

export interface SubTab {
  id: string;
  label: string;
  /** Pastille discrète après le libellé (J-47, nombre d'archives…) */
  badge?: string;
}

/**
 * Sous-onglets d'une page. Le sous-onglet actif est dans l'URL (?section=…, ou `param` pour un second niveau) : retour arrière et liens fonctionnent,
 * et la période choisie est conservée. La page lit `current()` via une variable de gabarit :
 * `<app-subtabs #st [tabs]="…" /> @switch (st.current()) { … }`
 *
 * Deux apparences : `tabs` (onglets soulignés, sections d'une page) et `segment` (bascule de vue à l'intérieur d'une section).
 */
@Component({
  selector: 'app-subtabs',
  imports: [RouterLink],
  host: { '[class]': 'variant()' },
  template: `
    <nav class="bar" role="tablist" [attr.aria-label]="variant() === 'tabs' ? 'Sections' : 'Vue'">
      @for (t of tabs(); track t.id; let first = $first) {
        <a
          role="tab"
          [routerLink]="[]"
          [queryParams]="query(t.id, first)"
          queryParamsHandling="merge"
          [class.active]="current() === t.id"
          [attr.aria-selected]="current() === t.id"
        >
          {{ t.label }}
          @if (t.badge) {
            <span class="badge">{{ t.badge }}</span>
          }
        </a>
      }
    </nav>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    :host([hidden]) { display: none; }
    .bar { display: flex; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
    .bar::-webkit-scrollbar { display: none; }
    a { flex: none; display: inline-flex; align-items: center; gap: 0.4rem; text-decoration: none; font-weight: 600; white-space: nowrap; }
    .badge { font-size: 0.72rem; font-weight: 700; color: var(--text-muted); background: var(--surface-2); border-radius: 999px; padding: 0.05rem 0.45rem; }

    :host(.tabs) { margin-top: 0.9rem; border-bottom: 1px solid var(--border); }
    :host(.tabs) .bar { gap: 1.4rem; }
    :host(.tabs) a {
      color: var(--text-muted); font-size: 0.95rem; padding: 0.55rem 0 0.7rem; min-height: 44px;
      box-shadow: inset 0 -2px 0 transparent; transition: color 0.15s, box-shadow 0.15s;
    }
    :host(.tabs) a:hover { color: var(--text-primary); }
    :host(.tabs) a.active { color: var(--text-primary); box-shadow: inset 0 -2px 0 var(--accent); }
    :host(.tabs) a.active .badge { color: var(--accent); background: var(--accent-soft); }

    :host(.segment) { margin-top: 1.25rem; }
    :host(.segment) .bar {
      display: inline-flex; max-width: 100%; padding: 3px; gap: 2px; background: var(--surface-1);
      border: 1px solid var(--border); border-radius: 10px;
    }
    :host(.segment) a { color: var(--text-secondary); font-size: 0.86rem; padding: 0.45rem 0.9rem; border-radius: 7px; min-height: 36px; }
    :host(.segment) a:hover { color: var(--text-primary); }
    :host(.segment) a.active { background: var(--surface-3); color: var(--text-primary); }
  `,
})
export class SubTabsComponent {
  readonly tabs = input.required<SubTab[]>();
  /** Paramètre d'URL du sous-onglet actif (second niveau : un autre nom, retiré lui aussi par la navigation principale) */
  readonly param = input('section');
  readonly variant = input<'tabs' | 'segment'>('tabs');
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected query = (id: string, first: boolean) => ({ [this.param()]: first ? null : id });

  readonly current = computed(() => {
    const id = this.params()?.get(this.param());
    const tabs = this.tabs();
    return tabs.find((t) => t.id === id)?.id ?? tabs[0]?.id ?? '';
  });

  constructor() {
    // Sur téléphone, l'onglet actif reste visible quand la barre défile
    afterRenderEffect(() => {
      this.current();
      const active = this.host.nativeElement.querySelector<HTMLElement>('a.active');
      const bar = active?.parentElement;
      if (!active || !bar || bar.scrollWidth <= bar.clientWidth) return;
      const left = active.getBoundingClientRect().left - bar.getBoundingClientRect().left + bar.scrollLeft;
      bar.scrollTo({ left: left - (bar.clientWidth - active.offsetWidth) / 2 });
    });
  }
}
