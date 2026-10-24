import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LOCAL_MODE } from '../core/runtime';

/**
 * Confidentialité (RGPD) : ce qui va où selon le mode, tiers contactés, durées de conservation, droits. Publique, dans les deux
 * constructions (appli publique et site du NAS). À tenir à jour avec les flux réels (CLAUDE.md, Comptes et Appli publique).
 */
@Component({
  selector: 'app-privacy',
  imports: [RouterLink],
  template: `
    <article class="card privacy">
      <h1>Confidentialité</h1>
      <p class="lead">RunStat n'a <b>ni traceur, ni publicité, ni cookie de suivi</b>. Il n'y a pas de serveur RunStat central : tes
        données restent sur ton appareil ou sur le NAS de la personne qui t'héberge. Tes données de santé (fréquence cardiaque, sommeil,
        poids…) relèvent de l'article 9 du RGPD : elles ne sont traitées qu'avec ton consentement explicite, donné à l'ouverture de ton
        compte, et que tu retires à tout moment en effaçant tes données.</p>

      <h2>Qui est responsable</h2>
      <p>La personne qui t'a invité et héberge ton compte sur son NAS (le « propriétaire ») est responsable de ce qui s'y trouve.
        L'appli publique (GitHub Pages) ne fait que fournir le code : GitHub voit ton adresse IP quand tu la charges, comme pour tout site.</p>

      <h2>Où vont tes données</h2>
      <h3>Appli publique (mode local-first{{ local ? ', celui que tu utilises' : '' }})</h3>
      <ul>
        <li>Tout reste <b>sur ton appareil</b> (stockage du navigateur) : sorties, tracés, santé, objectifs, réglages ; les calculs s'y font.</li>
        <li>Avec un compte, le NAS reçoit une <b>sauvegarde chiffrée de bout en bout</b> (AES-GCM, clé tirée de ta phrase de passe, qui ne
          quitte jamais l'appareil). Le propriétaire ne peut pas la lire ; il voit seulement ton nom de compte, le nom de tes appareils, la
          taille, le nombre et la date des envois. Tes jetons de connexion aux services sont dans cette sauvegarde, chiffrés.</li>
        <li>Google Health passe par un relais du NAS (l'appli Google du propriétaire) : tes jetons Google y <b>transitent en clair</b> à
          chaque renouvellement, sans y être conservés.</li>
        <li>Sans compte, rien n'est envoyé à un NAS.</li>
      </ul>
      <h3>Tableau de bord hébergé sur le NAS (par Tailscale{{ local ? '' : ', celui que tu utilises' }})</h3>
      <ul>
        <li>Tes données sont <b>en clair</b> dans ton dossier sur le NAS : le propriétaire, administrateur de la machine, peut les lire.</li>
        <li>Tes jetons de connexion (COROS, Strava, Google) y sont gardés, jamais affichés.</li>
      </ul>

      <h2>Services contactés, seulement ceux que tu choisis</h2>
      <ul>
        <li><b>COROS</b> (activités, fichiers FIT, santé) et <b>Strava</b> (activités, tracés) : lecture seule, avec ton autorisation.</li>
        <li><b>Google Health</b> (santé et sommeil) : lecture seule, par le relais du NAS (voir plus haut).</li>
        <li><b>Open-Meteo</b> (météo de tes sorties et de tes courses) : coordonnées arrondies à 0,1° (environ 10 km) et dates.</li>
        <li><b>OpenStreetMap</b> (fonds de carte) : ton adresse IP et la zone affichée.</li>
      </ul>
      <p>Chacun applique sa propre politique de confidentialité. RunStat n'écrit jamais chez eux.</p>

      <h2>Combien de temps</h2>
      <ul>
        <li>Sur ton appareil, et dans ton dossier sur le NAS : jusqu'à ce que tu les effaces. Safari peut effacer les données d'un site non
          visité depuis 7 jours, sauf si l'appli est ajoutée à l'écran d'accueil.</li>
        <li>Sauvegarde chiffrée : chaque version est gardée 30 jours, la dernière toujours. Après suppression, elle reste récupérable
          30 jours, puis elle est purgée.</li>
        <li>Sessions : 30 jours sans visite (180 au plus) ; invitations : 7 jours ; liens de connexion : 15 minutes.</li>
        <li>Journaux du NAS : méthode, adresse type, résultat et compte, jamais le contenu ni les jetons ; conservés selon la rotation des
          journaux du NAS. Les copies de sauvegarde du NAS lui-même (par exemple Hyper Backup) suivent la rotation choisie par le propriétaire.</li>
      </ul>

      <h2>Tes droits</h2>
      <ul>
        <li><b>Accès et portabilité</b> : « Exporter mes données » (zip lisible, sans les jetons) dans
          {{ local ? 'Compte et sauvegarde (icône nuage)' : 'Réglages' }}.</li>
        <li><b>Effacement et retrait du consentement</b> : {{ local ? '« Tout effacer » dans Compte et sauvegarde (compte sur le NAS, puis données de l’appareil)' : '« Supprimer mon compte » dans Réglages' }}.</li>
        <li><b>Rectification</b> : Réglages, objectifs et classements se modifient dans l'appli.</li>
        <li>Pour toute autre demande, adresse-toi à la personne qui t'héberge. Tu peux aussi saisir la CNIL (cnil.fr).</li>
      </ul>

      <h2>Le code</h2>
      <p>Le code de RunStat est ouvert (<a href="https://github.com/benji-zoy/runstat" target="_blank" rel="noopener">github.com/benji-zoy/runstat</a>).
        L'appli publique se met à jour automatiquement : la personne qui la publie pourrait en modifier le code. Si tu préfères garder la
        main, tu peux héberger ta propre copie (docs/auto-hebergement.md du dépôt).</p>
      <a class="btn" routerLink="/aujourdhui">Retour</a>
    </article>
  `,
  styles: `
    .privacy { max-width: 720px; margin: 1.5rem auto; line-height: 1.55; }
    .privacy h1 { margin: 0 0 0.6rem; font-family: var(--font-display); font-size: 1.6rem; }
    .privacy h2 { margin: 1.4rem 0 0.4rem; font-size: 1.05rem; }
    .privacy h3 { margin: 0.8rem 0 0.2rem; font-size: 0.95rem; }
    .privacy ul { margin: 0.2rem 0; padding-left: 1.2rem; display: grid; gap: 0.3rem; }
    .privacy p { margin: 0.3rem 0; }
    .privacy a:not(.btn) { color: var(--accent); }
    .privacy .btn { margin-top: 1rem; }
  `,
})
export class PrivacyPage {
  protected readonly local = LOCAL_MODE;
}
