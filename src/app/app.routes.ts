import { inject } from '@angular/core';
import { Router, Routes, UrlTree } from '@angular/router';
import { IconName } from './ui/icon';

export interface Tab {
  path: string;
  label: string;
  icon: IconName;
  /** Absent de la barre du bas sur téléphone (accessible depuis l'en-tête) */
  mobileHidden?: boolean;
}

/** Six espaces, une question chacun */
export const TABS: Tab[] = [
  { path: 'aujourdhui', label: "Aujourd'hui", icon: 'today' },
  { path: 'entrainement', label: 'Entraînement', icon: 'training' },
  { path: 'forme', label: 'Forme', icon: 'heart' },
  { path: 'performance', label: 'Performance', icon: 'bolt' },
  { path: 'courses', label: 'Courses', icon: 'flag' },
  { path: 'souvenirs', label: 'Souvenirs', icon: 'star', mobileHidden: true },
];

/** Paramètres d'URL propres à un onglet, retirés quand on change d'onglet principal */
export const TAB_PARAMS = { section: null, onglet: null, course: null };

/**
 * Anciennes adresses (10 onglets) → nouvelle place : les liens et favoris continuent de fonctionner.
 * Clé : `ancien-onglet` ou `ancien-onglet?section`.
 */
const LEGACY: Record<string, [string, string | null, string | null]> = {
  apercu: ['aujourdhui', null, null],
  objectifs: ['courses', null, null],
  sorties: ['entrainement', null, null],
  records: ['performance', null, null],
  'records?efforts': ['performance', null, 'segments'],
  'records?annees': ['performance', null, 'annees'],
  'records?situer': ['courses', 'classements', null],
  'records?regularite': ['entrainement', 'volume', null],
  progression: ['entrainement', 'volume', null],
  'progression?tendances': ['forme', 'efficacite', null],
  habitudes: ['entrainement', 'habitudes', null],
  'habitudes?comment': ['entrainement', 'habitudes', 'comment'],
  'habitudes?ou': ['entrainement', 'habitudes', 'ou'],
  'forme?charge': ['forme', 'charge', null],
  labo: ['performance', 'potentiel', null],
  'labo?matrice': ['performance', 'profil', null],
  'labo?forme': ['forme', 'efficacite', null],
  'labo?durabilite': ['performance', 'durabilite', null],
  'labo?charge': ['forme', 'charge', null],
  'labo?chaleur': ['forme', 'efficacite', null],
  'labo?seances': ['entrainement', 'seances', null],
  badges: ['souvenirs', 'badges', null],
  'badges?jalons': ['souvenirs', 'jalons', null],
  recap: ['souvenirs', null, null],
};

function legacy(old: string) {
  return (route: { queryParams: Record<string, string> }): UrlTree => {
    const { section, ...rest } = route.queryParams;
    const exact = LEGACY[`${old}?${section}`];
    const [path, mapped, onglet] = exact ?? LEGACY[old];
    // Objectifs : les sous-onglets (un par course, Archives) gardent leur identifiant
    const newSection = exact || old !== 'objectifs' ? mapped : (section ?? null);
    return inject(Router).createUrlTree(['/' + path], {
      queryParams: { ...rest, ...(newSection ? { section: newSection } : {}), ...(onglet ? { onglet } : {}) },
    });
  };
}

const OLD_TABS = ['apercu', 'objectifs', 'sorties', 'records', 'progression', 'habitudes', 'labo', 'badges', 'recap'];

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'aujourdhui' },
  { path: 'aujourdhui', title: "Aujourd'hui · RunStat", loadComponent: () => import('./pages/today').then((m) => m.TodayPage) },
  { path: 'entrainement', title: 'Entraînement · RunStat', loadComponent: () => import('./pages/training').then((m) => m.TrainingPage) },
  { path: 'forme', title: 'Forme · RunStat', loadComponent: () => import('./pages/fitness').then((m) => m.FitnessPage) },
  { path: 'performance', title: 'Performance · RunStat', loadComponent: () => import('./pages/performance').then((m) => m.PerformancePage) },
  { path: 'courses', title: 'Courses · RunStat', loadComponent: () => import('./pages/goals').then((m) => m.GoalsPage) },
  { path: 'souvenirs', title: 'Souvenirs · RunStat', loadComponent: () => import('./pages/memories').then((m) => m.MemoriesPage) },
  ...OLD_TABS.map((old) => ({ path: old, redirectTo: legacy(old) })),
  { path: '**', redirectTo: 'aujourdhui' },
];
