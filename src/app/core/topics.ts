/**
 * Comprendre : une carte par question du coureur, rangées par thème. Chaque carte ouvre `/comprendre/<id>`
 * (sauf « Suis-je prêt ? », qui mène au plan de la prochaine course dans Courses).
 */
export type TopicId =
  | 'pret' | 'potentiel' | 'records' | 'classements'
  | 'recuperation' | 'charge' | 'progres' | 'endurance'
  | 'seances' | 'habitudes' | 'carte' | 'profil';

export interface Topic {
  id: TopicId;
  /** Question complète : titre de la carte et de la page */
  question: string;
  /** Phrase sous le titre de la page de détail */
  lede: string;
  /** Lien de la carte quand il ne s'agit pas de `/comprendre/<id>` */
  link?: string;
  /** Besoin de données de santé (Google Health ou COROS) */
  health?: true;
}

export interface TopicGroup {
  label: string;
  topics: Topic[];
}

export const TOPIC_GROUPS: TopicGroup[] = [
  {
    label: 'Courses et chronos',
    topics: [
      { id: 'pret', question: 'Suis-je prêt pour ma course ?', lede: 'Chrono probable et préparation de ta prochaine course.', link: '/courses' },
      { id: 'potentiel', question: 'Quel est mon potentiel ?', lede: 'Ton chrono possible sur chaque distance, ton allure plafond et ta courbe d\'allure.' },
      { id: 'records', question: 'Quels sont mes records ?', lede: 'Tes meilleures sorties, tes meilleurs passages et tes années.' },
      { id: 'classements', question: 'Où je me situe face aux autres ?', lede: 'Barème FFA et classements officiels de tes courses.' },
    ],
  },
  {
    label: 'Forme',
    topics: [
      { id: 'recuperation', question: 'Suis-je en forme ?', lede: 'Préparation du jour, VFC, FC de repos et sommeil.', health: true },
      { id: 'charge', question: 'Ma charge est-elle bien dosée ?', lede: 'Frais ou fatigué, charge qui monte trop vite, intensité des séances.' },
      { id: 'progres', question: 'Est-ce que je progresse ?', lede: 'Cours-tu plus vite pour le même effort ? Et l\'effet de la chaleur.' },
      { id: 'endurance', question: 'Mon endurance tient-elle ?', lede: 'Tiens-tu ton allure jusqu\'au bout, et ton cœur s\'emballe-t-il en sortie facile ?' },
    ],
  },
  {
    label: 'Entraînement',
    topics: [
      { id: 'seances', question: 'Comment je m\'entraîne ?', lede: 'Types de séances, reconnus automatiquement.' },
      { id: 'habitudes', question: 'Quelles sont mes habitudes ?', lede: 'Quand et comment tu cours.' },
      { id: 'carte', question: 'Où je cours le plus ?', lede: 'Carte thermique de tes parcours et lieux de départ.' },
      { id: 'profil', question: 'Quel coureur suis-je ?', lede: 'Tes points forts et tes points faibles, sur six axes.' },
    ],
  },
];

export const TOPICS: Topic[] = TOPIC_GROUPS.flatMap((g) => g.topics);

export const topicById = (id: string | null | undefined): Topic | undefined => TOPICS.find((t) => t.id === id);
