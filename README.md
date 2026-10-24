# RunStat 🏃

Dashboard personnel de course à pied construit à partir des données Coros :
cumuls par période, équivalences (trajets entre villes, dénivelé en tours Eiffel,
repères mythiques, comparaisons absurdes), progression, records, forme et charge.

## Lancer le site

```bash
npm install
npm start
```

Puis ouvrir http://localhost:4200.

## Mettre à jour les données

Coros n'a pas d'API publique : les données sont extraites par Claude via le
connecteur Coros, puis transformées en `public/data/coros.json`.

Il suffit de demander à Claude (Claude Code, dans ce dossier) :

> Mets à jour les données RunStat

La procédure détaillée est dans [CLAUDE.md](CLAUDE.md). Après une mise à jour, recharger la page.

## Onglets

| Onglet | Contenu |
|---|---|
| Aperçu | Cumuls de la période, comparaison, projection de fin d'année, graphique cliquable (année → mois → semaine), moments forts, équivalences |
| Objectifs | Indice de confiance par objectif (`data-raw/goals.json`) : probabilité de battre le chrono visé ou indice de préparation pour finir, chrono probable et fourchette, modèles, ajustements du jour J (fraîcheur, récupération, météo), préparation et conseils |
| Sorties | Liste triable et filtrable, journal calendrier, fiche détaillée avec « notables » |
| Records | Podiums (tous temps ou par année), tableau année par année, Eddington, séries |
| Progression | Cumul annuel comparé + projection, volume hebdo, calendrier, allure / FC / cadence |
| Habitudes | Profil, heure × jour, moments de la journée, distributions, carte des départs |
| Forme | Récupération (VFC, FC de repos, sommeil, préparation, poids via Google Health), VO2max, prédictions, forme / fatigue / fraîcheur, charge |
| Labo | Algorithmes de référence : prédictions comparées, vitesse critique, courbe d'allure, efficacité et anomalies, découplage, durabilité, intensité, charge, chaleur, types de séances |
| Badges | Niveau (façon Nike Run Club), badges, jalons |
| Récap | Bilan annuel en « stories » (← → pour naviguer) |

La période (Semaine / Mois / Année / Tout + ‹ ›) est partagée entre les onglets et stockée dans l'URL.

## Organisation

| Dossier | Contenu |
|---|---|
| `data-raw/` | Exports bruts du connecteur Coros (liste, détails par activité, forme, charge) |
| `src/engine/` | Moteur portable (TypeScript sans Node ni Angular) : analyse FIT, parseurs des sources, construction du snapshot, stockage (fichiers, IndexedDB) |
| `scripts/build-fit.mjs` | Analyse les fichiers FIT seconde par seconde (cache dans `data-raw/fit-derived/`), par le moteur |
| `scripts/fetch-weather.mjs` | Météo historique Open-Meteo par lieu de départ (`npm run weather`) |
| `scripts/import-health.mjs` | Import santé/sommeil d'un export Google Takeout (`npm run health -- "<dossier>"`) |
| `scripts/build-data.mjs` | Fusionne tout dans `public/data/coros.json` et `routes.json` (`npm run data`), par le moteur |
| `src/app/core/` | Modèles, période (`period.service.ts`), calculs (`stats.ts`, `insights.ts`), badges, équivalences |
| `src/app/pages/` | Un composant par onglet |
| `src/app/sections/` | Blocs réutilisés par l'Aperçu (hero, équivalences, moments forts) |
| `src/app/ui/` | Navigation de période, graphique Chart.js, carte Leaflet, fiche sortie |

Pour ajouter une équivalence (une ville, un monument, un repère fun), il suffit
d'éditer les listes de `src/app/core/equivalences.ts`. Pour un badge : `src/app/core/badges.ts`.

## Tests

```bash
npx ng test --watch=false
```
