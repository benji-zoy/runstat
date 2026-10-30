import { inject } from '@angular/core';
import { Router, Routes, UrlTree } from '@angular/router';
import { IconName } from './ui/icon';
import { topicById } from './core/topics';

export interface Tab {
  path: string;
  label: string;
  icon: IconName;
}

/** Quatre espaces au quotidien ; « Moi » (profil, amis, souvenirs, réglages) est l'avatar de l'en-tête */
export const TABS: Tab[] = [
  { path: 'aujourdhui', label: "Aujourd'hui", icon: 'today' },
  { path: 'journal', label: 'Journal', icon: 'list' },
  { path: 'courses', label: 'Courses', icon: 'flag' },
  { path: 'comprendre', label: 'Comprendre', icon: 'chart' },
];

/** Paramètres d'URL propres à un onglet, retirés quand on change d'onglet principal */
export const TAB_PARAMS = { section: null, onglet: null, course: null };

/**
 * Anciennes adresses (10 puis 6 espaces) → nouvelle place : les liens et favoris continuent de fonctionner.
 * Clé : `ancien-onglet` ou `ancien-onglet?section`. Valeur : [chemin, section, onglet].
 */
const LEGACY: Record<string, [string, string | null, string | null]> = {
  apercu: ['aujourdhui', null, null],
  objectifs: ['courses', null, null],
  sorties: ['journal', null, null],
  records: ['comprendre/records', null, null],
  'records?efforts': ['comprendre/records', null, 'segments'],
  'records?annees': ['comprendre/records', null, 'annees'],
  'records?situer': ['comprendre/classements', null, null],
  'records?regularite': ['journal', 'volume', null],
  progression: ['journal', 'volume', null],
  'progression?tendances': ['comprendre/progres', null, null],
  habitudes: ['comprendre/habitudes', null, null],
  'habitudes?comment': ['comprendre/habitudes', null, 'comment'],
  'habitudes?ou': ['comprendre/carte', null, null],
  labo: ['comprendre/potentiel', null, null],
  'labo?matrice': ['comprendre/profil', null, null],
  'labo?forme': ['comprendre/progres', null, null],
  'labo?durabilite': ['comprendre/endurance', null, null],
  'labo?charge': ['comprendre/charge', null, null],
  'labo?chaleur': ['comprendre/progres', null, null],
  'labo?seances': ['comprendre/seances', null, null],
  badges: ['souvenirs', 'badges', null],
  'badges?jalons': ['souvenirs', 'jalons', null],
  recap: ['souvenirs', null, null],
  // Six espaces (2026) : Entraînement, Forme, Performance rangés dans Journal et Comprendre
  entrainement: ['journal', null, null],
  'entrainement?volume': ['journal', 'volume', null],
  'entrainement?habitudes': ['comprendre/habitudes', null, null],
  'entrainement?seances': ['comprendre/seances', null, null],
  forme: ['comprendre', null, null],
  'forme?recuperation': ['comprendre/recuperation', null, null],
  'forme?charge': ['comprendre/charge', null, null],
  'forme?efficacite': ['comprendre/progres', null, null],
  performance: ['comprendre/records', null, null],
  'performance?potentiel': ['comprendre/potentiel', null, null],
  'performance?durabilite': ['comprendre/endurance', null, null],
  'performance?profil': ['comprendre/profil', null, null],
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

const OLD_TABS = [
  'apercu', 'objectifs', 'sorties', 'records', 'progression', 'habitudes', 'labo', 'badges', 'recap', 'entrainement', 'forme', 'performance',
];

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'aujourdhui' },
  { path: 'aujourdhui', title: "Aujourd'hui · RunStat", loadComponent: () => import('./pages/today').then((m) => m.TodayPage) },
  { path: 'journal', title: 'Journal · RunStat', loadComponent: () => import('./pages/journal').then((m) => m.JournalPage) },
  { path: 'courses', title: 'Courses · RunStat', loadComponent: () => import('./pages/goals').then((m) => m.GoalsPage) },
  { path: 'comprendre', title: 'Comprendre · RunStat', loadComponent: () => import('./pages/understand').then((m) => m.UnderstandPage) },
  {
    path: 'comprendre/:sujet',
    title: (route) => `${topicById(route.paramMap.get('sujet'))?.question ?? 'Comprendre'} · RunStat`,
    loadComponent: () => import('./pages/topic').then((m) => m.TopicPage),
  },
  { path: 'sortie/:id', title: 'Sortie · RunStat', loadComponent: () => import('./pages/run').then((m) => m.RunPage) },
  { path: 'moi', title: 'Moi · RunStat', loadComponent: () => import('./pages/me').then((m) => m.MePage) },
  { path: 'souvenirs', title: 'Souvenirs · RunStat', loadComponent: () => import('./pages/memories').then((m) => m.MemoriesPage) },
  // Appli publique (local-first) : invitation et connexion d'un autre appareil, hors des espaces
  { path: 'rejoindre', title: 'Rejoindre · RunStat', data: { mode: 'rejoindre' }, loadComponent: () => import('./pages/join').then((m) => m.JoinPage) },
  { path: 'connexion', title: 'Connexion · RunStat', data: { mode: 'connexion' }, loadComponent: () => import('./pages/join').then((m) => m.JoinPage) },
  { path: 'confidentialite', title: 'Confidentialité · RunStat', loadComponent: () => import('./pages/privacy').then((m) => m.PrivacyPage) },
  // Retour d'une autorisation COROS, Strava ou Google lancée depuis Réglages (synchro sur l'appareil)
  { path: 'connexion/:source', title: 'Connexion · RunStat', loadComponent: () => import('./pages/oauth-return').then((m) => m.OAuthReturnPage) },
  ...OLD_TABS.map((old) => ({ path: old, redirectTo: legacy(old) })),
  { path: '**', redirectTo: 'aujourdhui' },
];
