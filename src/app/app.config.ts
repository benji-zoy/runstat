import {
  ApplicationConfig,
  inject,
  LOCALE_ID,
  provideBrowserGlobalErrorListeners,
  isDevMode,
} from '@angular/core';
import { registerLocaleData } from '@angular/common';
import { ActivatedRouteSnapshot, provideRouter, withInMemoryScrolling, withViewTransitions } from '@angular/router';
import { MotionService } from './ui/motion';
import localeFr from '@angular/common/locales/fr';
import { routes } from './app.routes';
import { provideServiceWorker } from '@angular/service-worker';

registerLocaleData(localeFr);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled' }),
      // Transitions de page (motion.scss) : seulement quand la page change, pas pour un sous-onglet ou une période (?…)
      withViewTransitions({
        skipInitialTransition: true,
        onViewTransitionCreated: ({ transition, from, to }) => {
          const motion = inject(MotionService);
          if (pathOf(from) === pathOf(to)) transition.skipTransition();
          transition.finished.finally(() => motion.clearMorph());
        },
      }),
    ),
    { provide: LOCALE_ID, useValue: 'fr-FR' },
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};

/** Chemin d'une navigation, sans les paramètres : `/sortie/123` */
function pathOf(root: ActivatedRouteSnapshot): string {
  const parts: string[] = [];
  for (let s: ActivatedRouteSnapshot | null = root; s; s = s.firstChild) parts.push(...s.url.map((u) => u.path));
  return parts.join('/');
}
