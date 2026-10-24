// Phrase de passe proposée : 6 mots tirés au hasard (crypto.getRandomValues) parmi 256 mots courants, soit 48 bits ; avec
// PBKDF2 à 600 000 itérations, la deviner hors ligne coûterait des siècles de calcul. La personne peut aussi écrire la sienne.
const WORDS = (
  'abeille abricot acier agneau aigle album algue amande ancre anneau araignee arbre ardoise argent atlas aube autruche avion ' +
  'avoine azur badge baie balcon baleine bambou banane barque bassin bateau baton biche bijou bison blason bocal bois bonnet ' +
  'bougie bouleau bouton branche brebis brioche brise bronze brume bureau cabane cacao cactus cadre caillou calme camion canal ' +
  'canard canne canoe capuche carafe carnet carotte carte castor cerf cerise chalet chameau champ chanson chapeau charbon chat ' +
  'chemin chene cheval chocolat cigale citron clairiere cloche clou coquille corde cornet coton couleur coussin crabe crayon ' +
  'cristal cuivre cygne dauphin delta desert diamant dragon dune ecorce ecureuil eglantine elan enclume epice equerre erable ' +
  'escalier etoile falaise faucon fenetre fer feuille ficelle figue flamme fleur flute foret fougere fourmi fraise framboise ' +
  'frene fromage fusee galet gazelle girafe glace glacier gland goeland gomme gorille grain granit grenade grenouille griffe ' +
  'grotte guitare hamac hamster harpe herisson hibou hirondelle horloge houx igloo ile iris jardin jasmin jonquille kayak kiwi ' +
  'lac lagune laine lampe lanterne lapin laurier lavande lezard lievre lilas lime lion loutre lune lynx macaron marmotte marron ' +
  'menthe meteore miel mimosa moineau montagne mouette mousse moulin muguet myrtille navire neige noisette nuage ocean olive ' +
  'ombre orage orange orchidee ours outil pagaie paille palmier panda papillon parapluie pelican pepite perle phare piano pigeon ' +
  'pin pinceau pivoine plage plume poivre pollen pomme pont potiron prairie prune puits quartz radis raisin rameau renard requin ' +
  'riviere rocher roseau rubis ruisseau sable safran sapin saule savon sentier serpent silex sirop soleil source tambour tasse ' +
  'tigre tilleul tomate tonnerre torrent tortue toupie tournesol trefle tulipe vague vallee vanille velo vent verger violon zebre'
).split(' ').slice(0, 256); // 256 exactement : un octet aléatoire = un mot, sans biais

export const PASSPHRASE_WORDS = WORDS.length;

export function suggestPassphrase(count = 6): string {
  const pick = new Uint8Array(count);
  crypto.getRandomValues(pick);
  return [...pick].map((b) => WORDS[b]).join(' ');
}

/** Robustesse grossière : 6 mots proposés, ou 16 caractères au moins avec des mots ou des signes variés */
export function passphraseProblem(p: string): string | null {
  const s = p.trim();
  if (s.length < 16) return '16 caractères au moins (ou utilise la phrase proposée)';
  if (new Set(s.toLowerCase()).size < 8) return 'trop répétitive';
  return null;
}
