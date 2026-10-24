// Autorisation d'une source sur le poste, en secours de Réglages › « Connecter … » (tokens écrits dans secrets/, ou RUNSTAT_SECRETS).
// Usage : npm run auth -- coros    (sur le poste : ouvre le navigateur, redirection loopback, PKCE)
//         npm run auth -- google   (sur le poste : ouvre le navigateur, redirection loopback)
//         npm run auth -- strava   (sur le poste, idem ; secrets/strava-client.json d'abord)
import { authorizeCoros } from './sync/coros.mjs';
import { authorizeGoogle } from './sync/google-health.mjs';
import { authorizeStrava } from './sync/strava.mjs';

const source = process.argv[2];
if (source === 'coros') await authorizeCoros();
else if (source === 'google') await authorizeGoogle();
else if (source === 'strava') await authorizeStrava();
else {
  console.error('Usage : npm run auth -- coros | google | strava');
  process.exit(1);
}
