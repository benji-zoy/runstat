/**
 * Définitions des notions de RunStat, pour qu'une IA interprète les chiffres comme le tableau de bord.
 * Chaque export n'en recopie que celles qu'il emploie (`MdDoc.use`). À tenir à jour si un calcul change.
 */
export const GLOSSARY = {
  allure: { term: 'Allure', text: 'temps au kilomètre, en minutes:secondes par km (5:12 = 5 min 12 s/km). Plus petit = plus rapide.' },
  zones: {
    term: 'Zones de FC',
    text: 'trois zones sous LT1 (endurance), entre LT1 et LT2 (seuil), au-dessus de LT2 (VO₂max et plus). LT1 / LT2 = seuils ventilatoires saisis par le coureur, sinon 80 % et 89 % de la FC max. Les zones en % de FC max sont < 60, 60-70, 70-80, 80-90, > 90 %.',
  },
  gap: { term: 'Allure ajustée à la pente (GAP)', text: 'allure équivalente sur le plat, d\'après le coût énergétique de la pente (Minetti 2002 en montée, modèle révisé de Strava en descente).' },
  ef: { term: 'Efficacité aérobie (EF)', text: 'vitesse ajustée à la pente (m/min) divisée par la FC moyenne (Friel). Plus haut = plus économe ; ne se compare qu\'entre sorties d\'endurance semblables (plat, 30 à 100 min).' },
  decouplage: { term: 'Découplage Pa:HR', text: 'dérive du rapport allure / FC entre la première et la seconde moitié, en %. Positif = la FC monte à allure égale. Repère (Friel) : < 5 % = bonne endurance aérobie, > 10 % = effort au-dessus du seuil aérobie ou fatigue.' },
  durabilite: { term: 'Durabilité', text: 'perte d\'efficacité (vitesse ajustée / FC) entre le premier et le dernier tiers d\'une sortie, en % (positif = dégradation) ; dérive de FC à allure égale en bpm par heure ; début de la dégradation = moment où l\'efficacité passe durablement sous 95 % de son niveau de départ (Maunder 2021, Jones 2024).' },
  charge: { term: 'Charge', text: 'charge d\'entraînement d\'une sortie : celle de la montre COROS, sinon TRIMP (durée pondérée par la FC, Banister).' },
  pmc: { term: 'Forme, fatigue, fraîcheur', text: 'modèle de Banister sur la charge quotidienne : forme = moyenne exponentielle sur 42 jours (CTL), fatigue = sur 7 jours (ATL), fraîcheur = forme − fatigue (TSB). Fraîcheur de +5 à +25 = idéal pour courir vite ; de −10 à −30 = fatigue productive ; sous −30 = surcharge.' },
  te: { term: 'Effet d\'entraînement (TE)', text: 'indices COROS de 0 à 5, aérobie et anaérobie : 3 = améliore, 4 = améliore beaucoup, 5 = surcharge.' },
  types: { term: 'Types de séance', text: 'classés automatiquement par RunStat (course / test, fractionné, tempo / seuil, sortie longue ≥ 1 h 30 ou bien plus longue que d\'habitude, trail, récupération, endurance) d\'après la FC, la variabilité des tours, le dénivelé et le nom de la séance. Peut se tromper.' },
  vdot: { term: 'VDOT', text: 'indice de performance de Daniels & Gilbert calculé sur un chrono : il donne les temps équivalents sur les autres distances et les allures d\'entraînement.' },
  riegel: { term: 'Exposant de Riegel', text: 't₂ = t₁ × (d₂ / d₁)^k : k ≈ 1,06 en moyenne ; plus il est bas, mieux le coureur tient sur les longues distances. L\'exposant perso est mesuré sur ses courses.' },
  vc: { term: 'Vitesse critique', text: 'vitesse tenable très longtemps en théorie, et réserve anaérobie D′ (m), ajustées sur les meilleurs efforts de 2 à 25 min des 16 dernières semaines (souvent sous-maximaux, donc prudentes).' },
  efforts: { term: 'Meilleurs efforts', text: 'meilleur passage sur une distance n\'importe où dans une sortie (fichier FIT seconde par seconde), brut ou ajusté à la pente.' },
  kmEffort: { term: 'Km-effort', text: 'distance + D+ / 100 + D− / 300 (barème ITRA modifié).' },
  equivPlat: { term: 'Distance équivalent plat', text: 'distance d\'un parcours ramenée au plat avec la courbe vitesse / pente propre au coureur (mesurée sur ses fichiers FIT des 12 derniers mois).' },
  conditions: { term: 'Coût des conditions', text: 'effet de l\'altitude, du dénivelé, de la température et du vent sur le temps, en % face à des conditions standard (plat, niveau de la mer, 12 °C, sans vent) ; négatif = la condition a coûté du temps. Temps standard = durée × Π(1 + %).' },
  gps: { term: 'Écart GPS', text: 'la montre mesure souvent plus que la distance officielle (trajectoires, GPS) ; les allures « réelles » ramènent chaque km à la distance officielle.' },
  prediction: { term: 'Prédiction et probabilité', text: 'chrono le plus probable = moyenne géométrique pondérée de plusieurs modèles, puis ajustements du jour J. L\'incertitude suit une loi log-normale (dispersion des modèles ⊕ variabilité d\'un jour de course ⊕ extrapolation en ultra) ; la probabilité est celle de passer sous le chrono visé. Libellés : ≥ 75 % très probable, ≥ 50 % probable, ≥ 25 % jouable, ≥ 10 % ambitieux, sinon hors de portée.' },
  preparation: { term: 'Indice de préparation', text: 'note de 0 à 100 pondérée sur des critères (volume, sortie la plus longue, D+, expérience, régularité, durabilité, récupération…) ; « projeté » = ce qu\'il deviendrait en suivant les conseils jusqu\'à l\'affûtage.' },
  matrix: { term: 'Runner Matrix', text: 'six branches (endurance, montée, descente, vitesse, résilience, physiologie) notées de 0 à 100 par rang face au propre historique du coureur (100 = sa meilleure période), pas face aux autres. Valeur de performance = meilleure sur 120 jours ; d\'état = médiane. « % mondial » = part de la vitesse des records du monde sur la même durée.' },
  vfc: { term: 'VFC', text: 'variabilité de la fréquence cardiaque nocturne (RMSSD, ms), comparée à la base personnelle des 30 jours précédents : nettement sous la base = fatigue, stress ou maladie possibles.' },
  fcRepos: { term: 'FC de repos', text: 'fréquence cardiaque au repos (bpm) ; plusieurs bpm au-dessus de la base personnelle = récupération incomplète possible.' },
  allures: { term: 'Allures d\'entraînement', text: 'déduites du VDOT actuel (Daniels) : E endurance, M marathon, T seuil (≈ 1 h de course), I intervalles (≈ VO₂max, 3-5 min), R répétitions (vitesse).' },
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
