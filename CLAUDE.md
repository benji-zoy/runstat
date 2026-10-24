# RunStat

Dashboard Angular 21 (standalone + signals, Chart.js) alimenté par un snapshot JSON (`public/data/coros.json`, nom historique)
des données COROS ou Strava (voir Sources).
Interface en français. Node local : 24.14 → rester sur Angular 21 (le CLI 22 exige Node ≥ 24.15).

## Synchronisation automatique (NAS, `scripts/sync/`)

Le conteneur `runstat-sync` (NAS, `scripts/sync/server.mjs`) lance `scripts/sync/run.mjs` au démarrage, toutes les 3 h
et à la demande (bouton de l'en-tête, `core/sync.service.ts` → `/api/sync`, proxy nginx ; masqué sans ce service ; `POST /api/fit?id=` →
`run.mjs --fit <id>` : le FIT d'une seule sortie puis build-fit + build-data, sans toucher à la fenêtre de synchro) : COROS (activités des derniers jours
fusionnées dans `records.txt`, détails, forme, charge cumulée dans `load.txt`, FIT jusqu'au quota) et Google Health API
(santé quotidienne + sommeil → `data-raw/health-api.json`, prioritaire sur `health.json` de Takeout), recouvrement de
3 jours, puis build-fit, build-data, fit-queue, météo. **Le NAS fait foi pour `data-raw/`** : `npm run nas -- pull` avant
de travailler sur les données. Les objectifs, bilans, classements et réglages se saisissent dans le site (voir Saisie) ; à la main,
`npm run nas -- push goals.json athlete.json results` (pris en compte au run suivant). FC max/repos ou seuils modifiés dans
`athlete.json` → `build-fit --force` (empreinte `athleteFit` dans l'état ; poids, taille, `raceWeights` ne recalculent pas les FIT). État : `data-raw/sync-state.json` (dernier succès,
dernière erreur, ré-autorisation) ; réponses brutes : `data-raw/raw/<source>/<type>/`. Logs : Container Manager.
- Clients : `coros.mjs` (MCP HTTP sans session, **liste blanche `READ_TOOLS`**, aucun outil d'écriture),
  `google-health.mjs` (API v4 ; filtres en snake_case `daily_resting_heart_rate.date`, contrairement à la doc).
  Pas de score de préparation, de score de sommeil ni de FC intraday par l'API.
- Tokens dans `secrets/` (poste) ou le volume `/secrets` (NAS), jamais affichés. Ré-autorisation sur le poste :
  `npm run auth -- coros | google` (Strava : depuis Réglages, voir Sources) (navigateur + loopback), puis copier le fichier de tokens dans `secrets/` du NAS.
  Le refresh token COROS change à chaque renouvellement : un seul détenteur (le NAS), sinon l'autre est révoqué.
- `npm run test:sync` (parseurs, fusions idempotentes, liste blanche, validation de la saisie ; `strava.test.mjs` : archive Strava,
  tracés, santé COROS sur les fixtures fictives de `scripts/sync/fixtures/` ; `strava-connect.test.mjs` : connexion Strava, fetch bouchonné), `npm run spike -- coros | google` (dumps bruts).

## Sources au choix (`data-raw/sources.json`, `scripts/sync/sources.mjs`, `core/sources.ts`)

`{ "activities": "coros" | "strava", "health": "google" | "coros" | "none" }`, absent = COROS + Google Health ; modifiable dans
Réglages (`GET|PUT /api/sources`, reconstruction complète). Une seule source d'activités par instance, sans dédoublonnage.
`run.mjs` ne synchronise que les sources choisies ; `build-data` les recopie dans `sources` et chaque sortie porte `source`.
L'interface lit `ScienceService.caps()` (`CAPABILITIES`) pour masquer ce que la source ne fournit pas (charge, TE et focus,
VO₂max et prédictions de la montre, ratio de charge, quota FIT) ; sans santé, Forme › Récupération disparaît.
- **Strava** : identifiants `strava:<id>`, fichiers `strava-<id>` (`fileKey`, pas de « : » sur le partage SMB), `sportType` au code
  COROS (100 route, 101 tapis/virtuel, 102 trail). Sorties dans `data-raw/strava/activities.json` (`src/engine/parsers/strava.ts`).
  Replis dans `build-data` : charge = TRIMP (`fit.trimp`, sinon FC moyenne), meilleur km = effort FIT de 1 000 m, départ = premier
  point du tracé ; `fitness: null`, `load: []` ; le modèle Coros sort seul du consensus de prédiction ; `workout_type` course → `race`.
- **Archive Strava** (historique, conforme : ses propres données) : `npm run strava -- <export.zip>` sur le poste, ou Réglages ›
  « Importer l'archive » (`POST /api/strava/archive`, flux vers `data-raw/import/`, 2 Gio au plus, puis `run.mjs --import-strava`,
  zip supprimé). `activities.csv` (en-têtes anglais ou français, colonnes en double, dates UTC → Europe/Paris), FIT décompressés
  dans `fit/`, GPX/TCX dans `tracks/*.gz` lus par `src/engine/fit/track.ts` (même structure que `fit-file-parser`, puis `analyse()` du moteur).
  Lecteur zip maison (`zip.mjs`, zip64, sans dépendance). Le numéro du fichier de l'archive n'est pas l'id de l'activité.
- **API REST Strava** (`strava.mjs`, GET sur la liste blanche `READ_PATHS`) : le MCP officiel `mcp.strava.com` est réservé à Claude et aux
  abonnés, et la politique API interdit de le relayer. Pas d'appli commune : chacun crée la sienne sur strava.com/settings/api
  (abonnement Strava requis pour la créer ; sinon, l'archive), avec pour **Authorization Callback Domain l'hôte ts.net du site**
  (`<nas>.<tailnet>.ts.net`, première adresse HTTPS de `SYNC_PUBLIC_ORIGINS` ; localhost est toujours accepté). Réglages › Synchro Strava : Client ID + Client Secret
  (`PUT /api/strava/client` → `secrets/strava-client.json`, jamais relu par le site ; changer d'appli efface les jetons), puis
  « Connecter Strava » (`strava-connect.mjs`) : `GET /api/strava/connect` (state aléatoire en mémoire, 10 min, usage unique ; 302 vers
  l'autorisation Strava, scope `read,activity:read_all`, `redirect_uri` = origine du site lue dans X-Forwarded-Host / Host et
  X-Forwarded-Proto, transmis par nginx, acceptée seulement si elle est dans `SYNC_PUBLIC_ORIGINS` de `docker-compose.yml`, sinon
  localhost seul), `GET /api/strava/callback` (state vérifié, sans en-tête X-RunStat puisque c'est une navigation : rien n'est écrit
  sans state valide ; échange du code, `strava-tokens.json` avec le scope accordé, `reauthSince` levé, synchro lancée) puis
  `/aujourdhui?strava=ok|refus&raison=…` (message sous le bouton de synchro, paramètres retirés). `GET /api/sync` ajoute
  `stravaClient`, `stravaConnected`, `stravaAthlete` (prénom et n° d'athlète, jamais les jetons) et `stravaOrigin` (première adresse HTTPS
  de la liste : Réglages y envoie le bouton et l'affiche comme domaine de rappel dans le guide pas à pas). En secours : `npm run auth -- strava`
  sur le poste, puis copier `strava-tokens.json` sur le NAS. Un seul athlète par instance pour l'instant. Synchro : activités depuis la dernière date − 3 jours,
  streams de 40 sorties par run → `tracks/strava-<id>.json.gz`, arrêt à 90 % du quota des 15 min. `STRAVA_API_URL` pour la nouvelle
  adresse obligatoire au 1er juin 2027. Politique Strava : cache de 7 jours au plus (§ 6.2), assumé pour l'historique personnel ;
  accès révoqué → supprimer `data-raw/strava` et les fichiers `strava-*` sous 30 jours.
- **Santé COROS** (`src/engine/parsers/coros-health.ts`, source `corosHealth` de l'état, jetons COROS) : `queryDailyHealthData` (sommeil, score),
  `querySleepHrv` (VFC, 7 jours par appel), `queryRestingHeartRate` → `data-raw/health-coros.json` (un an au premier passage).
  Pas de poids, de préparation ni de température.

## Moteur portable (`src/engine/`)

Tout ce qui transforme les données brutes en snapshot (`coros.json`, `routes.json`) est du TypeScript sans API Node ni Angular,
pour tourner aussi dans le navigateur (local-first, phase 4) : `fit/` (`analyse()`, tracés GPX/TCX/streams, lecture FIT par
`fit-file-parser` + polyfill `buffer`, gunzip par `DecompressionStream`), `parsers/` (COROS, Google Health, Strava, santé COROS),
`snapshot/` (`buildSnapshot` = ex-build-data, textes COROS), `pipeline/build-fit.ts` (cache `fit-derived/` par `FIT_VERSION`),
`fit-queue.ts`, `sources.ts`. Entrées-sorties par `storage/` : `FileStore` (`list`, `read`, `readText`, `write`, `remove`), deux zones
`raw` (data-raw) et `snapshot` (public/data) ; `MemoryStore`, `IndexedDbStore` (base `runstat-engine`, un magasin par zone), et
`NodeStore` côté Node (`scripts/node-storage.mjs`, écriture atomique). Restent en Node : clients API, `run.mjs`, `server.mjs`,
`zip.mjs` / `strava-archive.mjs`, `import-health.mjs`, `fetch-weather.mjs`.
- Node exécute les `.ts` directement (**type stripping** de Node 24, sans build) : les scripts importent `#engine/…` (champ `imports`
  de `package.json`), le moteur importe avec l'extension `.ts` (`rewriteRelativeImportExtensions` côté Angular) et reste en syntaxe
  effaçable (pas d'enum, de namespace ni de propriété de paramètre : `npm run check:engine`). `src/engine/package.json` le déclare en ESM.
- `npm run deploy` copie le moteur dans `app/scripts/engine/` et y réécrit `#engine/*` : le YAML de Container Manager ne change pas.
- Tests : `src/engine/**/*.spec.ts` (`ng test`), sur les données fictives de `scripts/sync/fixtures/engine/` (`sortie.fit` généré par
  `make-fit.mjs`, instances `raw/` COROS + Google et `raw-strava/`, sorties attendues `expected/` produites par l'ancien pipeline Node),
  chargées par l'option `loader` d'angular.json. Le moteur doit redonner ces sorties à l'identique, y compris avec IndexedDB (fake-indexeddb).
  Dans Vitest, les paquets npm restent externes (`buffer` natif de Node) : le polyfill n'est éprouvé que dans un vrai bundle navigateur.
- Changement du moteur : `npm run data` avant / après sur la même copie de `data-raw/`, puis
  `node scripts/compare-snapshot.mjs <avant> <après>` (coros.json hors generatedAt, routes.json, fit-derived/, missing-details.txt) :
  zéro écart attendu, sauf changement voulu (alors incrémenter `FIT_VERSION` si l'analyse FIT change).

## Saisie depuis le site (`scripts/sync/entries.mjs`, `core/entries.service.ts`, `ui/forms/`)

`GET|PUT /api/goals`, `GET|PUT /api/athlete`, `GET|PUT /api/sources`, `GET|PUT|DELETE /api/results/<id>[?replaces=date-….json]` (même garde
`X-RunStat` que `/api/sync`, corps ≤ 64 Ko) : validation stricte (champs connus seulement, aucun nom de tiers), écriture atomique
dans `data-raw/`, puis `run.mjs --rebuild` (reconstruction sans les sources ; une saisie pendant un run en relance une à la fin).
Le site applique le changement tout de suite (objectifs et bilans sont évalués côté client) puis recharge après la reconstruction.
Formulaires dans un `<dialog>` commun (`ui/forms/form-dialog.ts`, Reactive Forms, styles `.fields`, `.field`, `.btn` de `styles.scss`) :
objectif (Courses : « Objectif », « Modifier l'objectif »), bilan (Archives), classement + poids de la course (Classements : « Saisir »),
réglages et sources (bouton de l'en-tête). Masqués sans service de synchro (`ng serve` ; avec le service local
`node scripts/sync/server.mjs --no-schedule`, config `runstat-sync`, la config `runstat-api` de `.claude/launch.json` relaie `/api` par `proxy.conf.json`). Durées lues par `parseDuration` (`core/format.ts`).
Pas d'authentification : quiconque atteint le site peut écrire (LAN + Tailscale), à revoir avant d'ouvrir à d'autres personnes.

## Rafraîchissement manuel (secours, par le connecteur Coros de Claude)

Seulement si la synchro du NAS est en panne : `npm run nas -- pull`, la procédure ci-dessous, puis
`npm run nas -- push records.txt details fitness.txt load.txt fit`. Inutile de télécharger tout l'historique FIT :
la file est triée par utilité.

1. Liste complète des courses : `mcp__coros__querySportRecords` avec `startDate: "20100101"`, `endDate` = aujourd'hui,
   `sportTypeCodes: [100, 101, 102, 103]`, `limit: 1000`, filtres numériques à 0 / grandes valeurs, chaînes vides.
   La sortie dépasse la limite et est sauvegardée dans un fichier : le copier tel quel dans `data-raw/records.txt`.
2. `npm run data` → écrit `data-raw/missing-details.txt` (activités sans détail, format `<labelId> <sportType> <date>`).
3. Pour chaque ligne manquante, `mcp__coros__getActivityDetail` puis ajouter une ligne à
   `data-raw/details/part-AAAAMMJJ.jsonl` :
   `{"id":"…","elevGain":25,"elevLoss":20,"cadence":171,"stride":1.04,"power":223,"trainingLoad":93,"aerobicTE":2.6,"anaerobicTE":1.2,"focus":"Base","bestKm":"4:59"}`
   (null si absent). Au-delà d'une cinquantaine, répartir entre sous-agents.
4. `mcp__coros__queryFitnessAssessmentOverview` → texte brut dans `data-raw/fitness.txt`.
   `mcp__coros__queryTrainingLoadAssessment` avec `days: 365` (Coros ne renvoie que ~31 jours) → fusionner dans
   `data-raw/load.txt` par date (`mergeLoad` de `src/engine/parsers/coros.ts`), sans écraser l'historique accumulé.
5. Fichiers FIT (seconde par seconde) : `npm run fit-queue` régénère `data-raw/fit-queue.txt` (courses → sorties
   longues → fractionné/tempo → reste).
   Pour chacune, `mcp__coros__queryActivityFitFileDownloadUrls` avec **uniquement** `labelId` + `sportType`
   (les requêtes par plage de dates déclenchent une protection anti-abus), puis `sh scripts/fetch-fit.sh <URL…>`.
   **Limite Coros : 50 fichiers FIT par jour.** S'arrêter au premier message d'erreur ou de quota.
6. `npm run weather` (météo Open-Meteo, coordonnées arrondies à 0,1°, avec cache) puis `npm run data`
   (analyse des FIT avec cache dans `data-raw/fit-derived/`, puis fusion) : doit annoncer 0 activité sans détail.

Splits au km : calculés depuis les FIT ; pour une course sans FIT, `mcp__coros__queryActivityLapData` (ne compte pas
dans le quota FIT) → tours de 1 km recopiés dans `data-raw/splits/<id>.json` (`{"km": [...], "rest": {...}}`, vérifier
que la somme = durée). Ils servent à détecter le mur (`wallAnalysis`).

Tours au km (durabilité, `src/app/core/durability.ts`) : pour les sorties longues (≥ 75 min, trail ≥ 60 min) sans FIT,
`mcp__coros__queryActivityLapData` (hors quota) → `data-raw/laps/<id>.json` au format
`{"km":[[distance m, temps s, FC, D+, D−, allure ajustée s/km, puissance, cadence],...]}`. Prendre le groupe dont
`lapDistance` = 100000 qui contient vraiment des tours de ~1 km (souvent `type:10` sur route, `type:2` en trail ;
l'autre peut être découpé par étapes de séance). Répartir entre sous-agents, puis `node scripts/check-laps.mjs`
(somme des temps et distance ≈ sortie). Les FIT produisent le même format (« Effort Pace » Coros comme allure ajustée).

Réglages de l'athlète (FC max, FC repos, seuils `lt1Hr`/`lt2Hr`, sexe, poids…) : `data-raw/athlete.json`, modifiable par le bouton
Réglages de l'en-tête. `raceWeights: { "<id>": 0.5 }` force le poids d'une course dans l'exposant de fatigue (0 = ignorée), réglable
sur la course dans Classements. Modifié à la main : `node scripts/build-fit.mjs --force` en local puis `npm run nas -- push athlete.json`.

## Santé & sommeil (Google Health)

Export Google Takeout (« Google Health », ex-Fitbit), laissé dans le dossier de l'utilisateur (≈ 2 Go, données
sensibles) : `npm run health -- "<chemin vers Takeout/Google Health>"` (chemin mémorisé dans `data-raw/health-source.txt`),
puis `npm run data`. Ne lit que FC de repos, VFC, préparation, respiration, température, SpO2, sommeil, poids.
Attention : le nom du dossier contient une espace insécable, et chaque nuit existe en `sleep_session_v1` et `v2`
(on garde la plus récente). Depuis, l'API complète automatiquement (`health-api.json`, voir Synchronisation) ; le Takeout reste
utile pour l'historique et le score de préparation. Affiché dans Forme › Récupération (`src/app/core/health.ts`, `sections/recovery.ts`) et en résumé sur Aujourd'hui.

## Objectifs (onglet Courses, `src/app/core/goals.ts`)

Saisis dans Courses (bouton « Objectif », « Modifier l'objectif ») ou dans `data-raw/goals.json` (non versionné) : `[{ "id", "name", "date": "AAAA-MM-JJ", "startTime": "HH:MM", "distanceKm",
"elevGain"?, "targetSec"? (absent = objectif « finir »), "stretchSec"? (bas d'une fourchette, ex. 10 h 30 pour « 10 h 30 / 11 h »), "kind": "road" | "trail", "lat"?, "lon"? }]`.
`npm run weather` télécharge la prévision des objectifs à moins de 15 jours (lieu indiqué, sinon lieu de sortie habituel)
dans `data-raw/weather/forecast-<id>.json`, puis `npm run data`.
Chrono : consensus géométrique des modèles (Coros, course de référence = dernière course sur la même distance à poids 1,5,
projetée à aujourd'hui par `progressionSince` : volume Tanda × moyenne(allure d'entraînement, ½ gain d'EF), 8 sem. avant / 8 dernières,
VDOT, Riegel pondéré, VDOT actualisé par l'EF, vitesse critique à poids 0,5) × ajustements (fraîcheur projetée, VFC/FC repos, Hadley, nuit, préparation) ; incertitude log-normale →
probabilité. Finir : indice de préparation pondéré ; chrono trail extrapolé au km-effort (Riegel k = 1,10).
Stratégie de course (`src/app/core/race-plan.ts`) : allures par tronçon et temps de passage, allure montre corrigée de
l'écart GPS mesuré sur les courses de référence, cardio, ravitaillement, derniers jours, échauffement, tenue, leçons.
Une course n'est « référence » que si elle est classée `race` (`RACE_NAME` dans `science.ts` : nom d'épreuve ou millésime ;
la sortie d'un objectif passé l'est toujours, quel que soit son nom).

## Coût des conditions (fiche d'une sortie et Aujourd'hui, `src/app/core/conditions.ts`, `ui/conditions-card.ts`)

Façon « rapport Enduraw » : altitude 🗻, dénivelé 🚠, température 🔥, vent 💨 en % (négatif = coût) face à des conditions standard
(plat, niveau de la mer, 12 °C, sans vent) ; temps standard = durée × Π(1 + %). Calculé pour toutes les sorties (hors tapis).
Altitude : Wehrlin & Hallén (−6,3 % VO₂max/1000 m au-dessus de 300 m) × 0,55 (Mexico 1968) moins le gain d'air, `fit.altMean` sinon
`startAlt` (API elevation d'Open-Meteo, `data-raw/weather/elevation.json`). Dénivelé : `gapDistance` Minetti, sinon D+/D− Coros
avec le coefficient de boucle perso. Chaleur : pente perso de l'EF au-delà de 12 °C (≥ 15 sorties), sinon Hadley, selon la durée.
Vent : traînée de Pugh par secteur de cap (`fit.headings`, 16 × [s, m]) avec `weather.dir` ; sans FIT, caps uniformes (« estimé »).
Sortie sans FIT : bouton « Affiner avec le tracé » (`SyncService.refineFit`, quota de 50 FIT/jour). « Copier le rapport » : texte
à coller dans Strava / COROS (aucune écriture externe).

## Archives (Courses › Archives, `src/app/core/debrief.ts`)

Un objectif passe dans Courses › Archives (`sections/goal-archive.ts`, une course par sous-onglet `?course=`) dès que sa sortie est synchronisée (même jour ou lendemain, distance à ±15 %).
Bilan : temps officiel vs objectif et prédiction de la veille, km par km ramenés à la distance officielle face au plan,
allure, cardio (décrochages du capteur exclus), foulée, gels, conditions, modèles, leçons ; puis l'indice de la veille
(`sections/goal-card.ts`, partagé avec les objectifs à venir). Après la course, l'utilisateur saisit temps puce, gels, ressenti
dans Archives (« Temps puce, gels, ressenti ») ; à la main : `"debrief": { "chipSec": 5816, "gelsKm": [7, 14], "notes": ["…"] }` dans l'objectif.

## Algorithmes

`src/app/core/science.ts` (affichés par `sections/analysis.ts`, réparti entre Performance, Forme et Entraînement) : Daniels/VDOT, Riegel (+ exposant perso mesuré sur les
courses), Tanda, Vickers, vitesse critique (Smyth & Muniz-Pumares), indice de forme Runalyze, marathon shape,
TRIMP, Foster, ACWR, classification des séances, EF + anomalies (z-score MAD), Theil-Sen, chaleur (règle de Hadley),
km-effort ITRA, index de polarisation. `src/engine/fit/analyse.ts` (lancé par `scripts/build-fit.mjs`) : meilleurs efforts, courbe d'allure, GAP (Minetti),
zones, découplage Pa:HR, durabilité, tours au km, TRIMP seconde par seconde, tracé GPS.
Les meilleurs efforts FIT (meilleur passage sur 400 m … marathon dans n'importe quelle sortie) alimentent Performance › Records › Segments (bascule « Ajusté à la pente » : GAP, 16 semaines / tous les FIT)
(`effortIn` dans `insights.ts` : sans FIT, meilleur km Coros ou allure moyenne d'une sortie de la distance à +5 %).
`src/app/core/durability.ts` : perte d'efficacité 1er/dernier tiers, dérive de FC à allure égale, début de dégradation,
montées/descentes en trail, courbe de durabilité heure par heure (sorties régulières seulement).

## Runner Matrix (Performance › Profil, `src/app/core/matrix.ts`, `sections/runner-matrix.ts`)

Inspirée d'Enduraw (méthode non publiée : construction propre). Six branches (Endurance, Montée, Descente, Vitesse,
Résilience, Physiologie), chacune = moyenne de rangs 0-100 de ses métriques par rapport à l'historique de l'athlète
(fenêtres hebdomadaires ; performance = meilleure valeur sur 120 j, état = médiane), radar aujourd'hui / il y a 26 semaines.
Résilience, EF et VO₂max FC corrigées de la chaleur (pente Theil-Sen personnelle, ramenées à 12 °C). Grille durée × terrain
(5 min → 3 h) : `curveGap`, `climb`, `descent` de `analyse()` (`src/engine/fit/analyse.ts`) (D+/D− cumulés avec hystérésis de 1 m, sauts > 1 m/s ignorés) ;
`terrain` = temps, distances et FC par tranche de pente (rendement en côte ≥ 8 %, vitesse ajustée en descente ≤ −8 % face au plat).
Lecture absolue à côté (bascule du radar) : % du niveau mondial, barème du classement par âge (60 % locale … 90 % mondiale),
pour Vitesse et Endurance (loi puissance entre les records du 1 500 m et du marathon, `WORLD_RECORDS` à mettre à jour si un
record tombe) et Physiologie (VO₂max Coros, historique par l'estimation FC recalée, face au VDOT du record du marathon).
Montée, Descente, Résilience : pas d'étalon mondial fiable, volontairement.

## Se situer (Courses › Classements, `src/app/core/ffa.ts`, `sections/race-standing.ts`)

Barème FFA route (athle.fr htmlid=125 hommes / 122 femmes, au 1er janvier 2010, IA → D7, recopié dans `ffa.ts`) : niveau de
chaque course à 5 / 10 / 15 / 20 km, semi, marathon (temps officiel > temps puce du bilan > montre), niveau acquis = 2 perfs
sur 12 mois. Classements : `data-raw/results/<activityId>.json` (ou `date-AAAA-MM-JJ-<km>.json`, rattaché par date et
distance), relevés sur la page de résultats officielle de l'organisateur / du chronométreur, **jamais bases.athle.fr**
(`robots.txt` : `Disallow: /`) ni MyDataRun (compte) ; vérifier le `robots.txt` du site, ne garder que les effectifs
(aucun nom d'autre coureur) : `{ event, course, distanceKm, elevGain?, officialSec, gunSec?, rank, finishers, sex, sexRank,
sexCount, category, catRank, catCount, label?, source, timing?, fetchedAt, note? }`. Saisie par « Saisir » sur la course
(remplace un éventuel `date-….json`, signalé par `result.file`). Après une nouvelle course, à la demande : retrouver la ligne
de l'athlète (son nom, jamais écrit dans le dépôt), écrire le fichier, puis `npm run data`.

## Interface

Six espaces, une question chacun (`TABS` dans `app.routes.ts`, icônes au trait `ui/icon.ts`) :
- **Aujourd'hui** (`pages/today.ts`) : en bref, prochaine course, forme du jour (Google Health + fraîcheur), année en cours, dernières sorties, 3 moments forts.
- **Entraînement** (`pages/training.ts`) : Journal (`pages/activities.ts`, cartes sur téléphone), Volume (`sections/volume.ts` : période, cumul, hebdo, calendrier, régularité),
  Habitudes (`pages/habits.ts`, Quand / Comment / Où), Séances (classification auto + focus Coros).
- **Forme** (`pages/fitness.ts`) : Récupération, Charge (Banister, charge hebdo + monotonie, Seiler, ACWR avec le ratio Coros), Efficacité (EF, tendances mensuelles, chaleur).
- **Performance** (`pages/performance.ts`) : Records (`pages/records.ts` : Sorties / Segments / Par année), Potentiel (prédictions, vitesse critique, courbe d'allure),
  Durabilité, Profil (Runner Matrix).
- **Courses** (`pages/goals.ts`) : un sous-onglet par objectif, Archives, Classements.
- **Souvenirs** (`pages/memories.ts`) : Récap, Badges, Jalons, Équivalences. Sur téléphone, accessible par l'étoile et la pastille de niveau de l'en-tête.

Les analyses scientifiques sont dans `sections/analysis.ts` (`<app-analysis view="predictions | matrice | efficacite | durabilite | charge | seances">`),
chaque vue ouvre sur un « En bref » (`ui/brief.ts`). Les anciennes adresses (`/labo`, `/records?section=…`, `/apercu`…) sont redirigées (`LEGACY` dans `app.routes.ts`).

Sous-onglets avec `ui/subtabs.ts` (`<app-subtabs #st [tabs]="…" />` puis `@switch (st.current())`) : onglets soulignés (`?section=`), ou bascule
`variant="segment"` pour un second niveau (`param="onglet"` ou `course`) ; ces paramètres sont retirés quand on change d'espace (`TAB_PARAMS`).
Ne jamais lire `#st` avant sa déclaration dans le gabarit. Trois contrôles, trois apparences : onglets soulignés (navigation), `.seg` (bascule de vue, période),
`.chip` (filtres). Explications méthodologiques repliées dans `<details class="method"><summary>Méthode</summary>…</details>`.

Thème sombre par défaut, clair au choix (bouton de l'en-tête, `core/theme.service.ts`, `data-theme` sur `<html>`). Toutes les couleurs sont des variables CSS
(`styles.scss`) ; dans les graphiques Chart.js et les cartes Leaflet, utiliser les jetons de `ui/palette.ts` (`C.s1`, `alpha(C.accent, 0.3)`…), résolus au dessin
(`resolveColors` dans `ui/chart.ts`), jamais de couleur hexadécimale en dur. Interface en tutoiement.

Appli installable (PWA) : `@angular/service-worker` (`ngsw-config.json` : coquille en cache, `data/` en `freshness` 4 s puis cache,
`/api/` jamais), `public/manifest.webmanifest`, icônes `public/icons/` (tracé de `ui/icon.ts` sur fond sombre, `favicon.svg`),
polices auto-hébergées (`@fontsource`, `angular.json`), bandeaux « Nouvelle version » et « Hors ligne » (`core/pwa.service.ts`).
Le service worker n'est actif qu'en HTTPS (adresse Tailscale Serve) ou sur localhost, et seulement en build de production.

## Déploiement (NAS Synology)

Projet Container Manager dans `/docker/runstat` (`deploy/docker-compose.yml`) : `runstat` (nginx, port 8080, `deploy/nginx.conf` :
fallback vers `index.html` pour les routes Angular, `data/`, `index.html`, `ngsw-worker.js`, `ngsw.json` et le manifeste en no-cache, `/api/` vers runstat-sync,
`/api/strava/archive` sans tampon jusqu'à 2 Go) et `runstat-sync` (node:24-alpine,
uid 1026:100, voir Synchronisation). `npm run deploy` (`scripts/deploy.sh`) : `ng build`, puis rsync de la config, de
`dist/runstat/browser/` vers `<destination>/html/` (**sauf `data/`**, produit sur le NAS) et des scripts + `fit-file-parser`
vers `<destination>/app/` (relus à chaque synchro, sans redémarrage). Destination dans `data-raw/nas.txt` (SSH
`user@nas:/volume1/docker/runstat` ou partage monté `/Volumes/docker/runstat`). Mise en place initiale : `npm run nas -- init`
(copie `data-raw/`, les données du site et `secrets/`, refuse si le NAS a déjà des données), puis recréer le projet dans
Container Manager. `server.mjs` ou `nginx.conf` modifié : Projet › runstat › Arrêter puis Construire. `docker-compose.yml` modifié :
Container Manager garde **sa propre copie du YAML** (celle copiée par le déploiement est ignorée) → recopier le changement dans
Projet › runstat › YAML, puis Arrêter › Nettoyer › Construire (un simple Construire redémarre sans recréer : nouvelles variables
d'environnement ignorées ; vérifier `stravaOrigin` dans `GET /api/sync`). Accès hors du réseau
local via Tailscale uniquement : données personnelles, ne pas ouvrir de port.

## Vérifier

- `npx ng test --watch=false` (tests de `src/app/core` et du moteur `src/engine`)
- `npm run check:engine` (syntaxe compatible avec le type stripping de Node)
- `npx ng build`
- `npm run test:sync` (synchro, `node:test`)
