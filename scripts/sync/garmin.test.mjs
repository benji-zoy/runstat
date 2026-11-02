// Clé personnelle Garmin sur le NAS (garmin.mjs) : validation, essai auprès de Garmin (fetch bouchonné) avant
// l'enregistrement, état sans la clé, retrait. Dossier de secrets temporaire.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const secrets = mkdtempSync(join(tmpdir(), 'runstat-garmin-'));
const { InvalidEntry } = await import('./entries.mjs');
const { garminStatus, removeGarminKey, saveGarminKey } = await import('./garmin.mjs');

const KEY = 'cle-personnelle-garmin-0123456789';
const b64url = (s) => Buffer.from(s).toString('base64url');
const JWT = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400 }))}.sig`;

let calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), method: init?.method });
  return new Headers(init?.headers).get('authorization') === `ApiKey ${KEY}` ? new Response(JWT) : new Response('', { status: 401 });
};
after(() => {
  globalThis.fetch = realFetch;
  rmSync(secrets, { recursive: true, force: true });
});
beforeEach(() => {
  calls = [];
  rmSync(join(secrets, 'garmin-key.json'), { force: true });
});

test('clé essayée auprès de Garmin puis enregistrée (600), jamais renvoyée', async () => {
  const status = await saveGarminKey(secrets, { apiKey: KEY, days: 365 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token');
  assert.equal(calls[0].method, 'POST');
  assert.equal(status.garminConnected, true);
  assert.match(status.garminExpiresOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!JSON.stringify(status).includes(KEY));
  const file = join(secrets, 'garmin-key.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).apiKey, KEY);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(removeGarminKey(secrets), { garminConnected: false, garminExpiresOn: null });
  assert.equal(existsSync(file), false);
});

test('clé refusée par Garmin ou saisie invalide : InvalidEntry, rien d’écrit', async () => {
  await assert.rejects(saveGarminKey(secrets, { apiKey: 'cle-inconnue-de-garmin-00000000', days: 90 }), (e) => e instanceof InvalidEntry && /refusée/.test(e.message));
  await assert.rejects(saveGarminKey(secrets, { apiKey: 'x', days: 90 }), InvalidEntry);
  await assert.rejects(saveGarminKey(secrets, { apiKey: KEY, days: 90, client_secret: 'y' }), /champ inconnu/);
  assert.equal(calls.length, 1);
  assert.deepEqual(garminStatus(secrets), { garminConnected: false, garminExpiresOn: null });
});
