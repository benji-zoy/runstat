import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';

const SUFFIX = ' · RunStat';

/**
 * Titre de l'onglet : celui de la route, sauf si la page en donne un plus précis (nom d'un objectif ou d'un cycle) par
 * `usePageTitle`. Les deux ordres d'arrivée (fin de navigation, données chargées) donnent le même résultat.
 */
@Injectable({ providedIn: 'root' })
export class PageTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private routeTitle = '';
  private readonly detail = signal<string | null>(null);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    this.routeTitle = this.buildTitle(snapshot) ?? '';
    this.apply();
  }

  set(name: string | null): void {
    this.detail.set(name);
    this.apply();
  }

  private apply(): void {
    const d = this.detail();
    const t = d ? d + SUFFIX : this.routeTitle;
    if (t) this.title.setTitle(t);
  }
}

/** À appeler dans un contexte d'injection (champ du composant) : `name` vide = titre de la route */
export function usePageTitle(name: () => string | null | undefined): void {
  const strategy = inject(PageTitleStrategy);
  effect(() => strategy.set(name() || null));
  inject(DestroyRef).onDestroy(() => strategy.set(null));
}
