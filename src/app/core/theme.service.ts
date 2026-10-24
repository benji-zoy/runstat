import { Injectable, signal } from '@angular/core';

export type Theme = 'dark' | 'light';
const KEY = 'runstat-theme';

/** Thème sombre (par défaut) ou clair, mémorisé dans le navigateur. Les graphiques lisent `theme()` pour se redessiner. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<Theme>(read());

  constructor() {
    apply(this.theme());
  }

  toggle(): void {
    const next: Theme = this.theme() === 'dark' ? 'light' : 'dark';
    this.theme.set(next);
    apply(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // stockage indisponible (navigation privée) : le choix vaut pour la session
    }
  }
}

function read(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function apply(t: Theme): void {
  document.documentElement.dataset['theme'] = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#0c0d10' : '#f6f4ef');
}
