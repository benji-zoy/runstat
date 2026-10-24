// Vérification WebAuthn (passkeys) côté serveur, sans dépendance : CBOR minimal (attestationObject, clé COSE), données de
// l'authentificateur, signature par node:crypto. Attestation « none » : à l'enregistrement, rien n'est signé, la sécurité vient
// du code d'invitation présenté avec le challenge (public-api.mjs). Algorithmes -7 (ES256) et -257 (RS256) seulement.
import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

export const ALGORITHMS = [-7, -257];

export class WebAuthnError extends Error {}
const fail = (msg) => {
  throw new WebAuthnError(msg);
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64url = (s) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s) || s.length > 100_000) fail('encodage base64url invalide');
  return Buffer.from(s, 'base64url');
};
const sha256 = (data) => createHash('sha256').update(data).digest();

/** CBOR (RFC 8949) : entiers, chaînes d'octets et de texte, tableaux, tables, simples ; pas de flottants ni de longueur indéfinie */
export function decodeCbor(buf, { allowTrailing = false } = {}) {
  let pos = 0;
  const need = (n) => (pos + n > buf.length ? fail('CBOR tronqué') : undefined);
  const length = (info) => {
    if (info < 24) return info;
    const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info] ?? fail('CBOR : longueur indéfinie non prise en charge');
    need(size);
    const v = size === 8 ? Number(buf.readBigUInt64BE(pos)) : buf.readUIntBE(pos, size);
    pos += size;
    if (!Number.isSafeInteger(v)) fail('CBOR : entier trop grand');
    return v;
  };
  let depth = 0;
  const item = () => {
    if (++depth > 16) fail('CBOR trop imbriqué');
    need(1);
    const head = buf[pos++];
    const major = head >> 5;
    const info = head & 31;
    let out;
    if (major === 0) out = length(info);
    else if (major === 1) out = -1 - length(info);
    else if (major === 2 || major === 3) {
      const n = length(info);
      need(n);
      const bytes = buf.subarray(pos, pos + n);
      pos += n;
      out = major === 2 ? Buffer.from(bytes) : bytes.toString('utf8');
    } else if (major === 4) {
      const n = length(info);
      if (n > 1000) fail('CBOR : tableau trop long');
      out = Array.from({ length: n }, item);
    } else if (major === 5) {
      const n = length(info);
      if (n > 1000) fail('CBOR : table trop longue');
      out = new Map();
      for (let i = 0; i < n; i++) {
        const k = item();
        out.set(k, item());
      }
    } else if (major === 7 && info >= 20 && info <= 22) out = info === 20 ? false : info === 21 ? true : null;
    else fail(`CBOR : type ${major}/${info} non pris en charge`);
    depth--;
    return out;
  };
  const value = item();
  if (!allowTrailing && pos !== buf.length) fail('CBOR : octets en trop');
  return { value, end: pos };
}

/** Données de l'authentificateur : hachage du rpId, drapeaux, compteur, identifiant et clé COSE (à l'enregistrement) */
export function parseAuthData(buf) {
  if (buf.length < 37) fail('authenticatorData trop court');
  const flags = buf[32];
  const out = {
    rpIdHash: buf.subarray(0, 32),
    up: Boolean(flags & 0x01),
    uv: Boolean(flags & 0x04),
    at: Boolean(flags & 0x40),
    ed: Boolean(flags & 0x80),
    signCount: buf.readUInt32BE(33),
  };
  if (out.at) {
    if (buf.length < 55) fail('données de la clé absentes');
    const idLen = buf.readUInt16BE(53);
    if (idLen < 16 || idLen > 1023 || buf.length < 55 + idLen) fail('identifiant de clé invalide');
    out.credentialId = buf.subarray(55, 55 + idLen);
    const { value, end } = decodeCbor(buf.subarray(55 + idLen), { allowTrailing: true });
    out.cose = value;
    if (!out.ed && 55 + idLen + end !== buf.length) fail('authenticatorData : octets en trop');
  }
  return out;
}

/** Clé COSE → clé publique (SPKI DER en base64url) et algorithme */
export function coseToSpki(cose) {
  if (!(cose instanceof Map)) fail('clé COSE invalide');
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (!ALGORITHMS.includes(alg)) fail(`algorithme ${alg} refusé`);
  let jwk;
  if (alg === -7) {
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (kty !== 2 || cose.get(-1) !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32)
      fail('clé ES256 invalide');
    jwk = { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) };
  } else {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (kty !== 3 || !Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length < 256) fail('clé RS256 invalide (2048 bits au moins)');
    jwk = { kty: 'RSA', n: b64url(n), e: b64url(e) };
  }
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  return { alg, publicKey: b64url(key.export({ type: 'spki', format: 'der' })) };
}

const sameBytes = (a, b) => a.length === b.length && timingSafeEqual(a, b);

/**
 * clientDataJSON (octets bruts, jamais re-sérialisés) : type, challenge attendu, origine autorisée, pas d'appel imbriqué.
 * Renvoie l'origine et le rpId attendu (hôte de l'origine).
 */
function checkClientData(raw, { type, challenge, origins }) {
  let cd;
  try {
    cd = JSON.parse(raw.toString('utf8'));
  } catch {
    fail('clientDataJSON illisible');
  }
  if (cd.type !== type) fail(`type ${cd.type} inattendu`);
  if (typeof cd.challenge !== 'string' || !sameBytes(fromB64url(cd.challenge), fromB64url(challenge))) fail('challenge inattendu');
  if (!origins.includes(cd.origin)) fail(`origine ${cd.origin} refusée`);
  if (cd.crossOrigin === true) fail('appel depuis une page tierce refusé');
  return { origin: cd.origin, rpId: new URL(cd.origin).hostname };
}

/** Challenge contenu dans clientDataJSON (pour retrouver la demande en attente avant vérification complète) */
export function challengeOf(clientDataB64) {
  try {
    const c = JSON.parse(fromB64url(clientDataB64).toString('utf8')).challenge;
    return typeof c === 'string' && c.length <= 200 ? c : null;
  } catch {
    return null;
  }
}

/**
 * Enregistrement : { clientDataJSON, attestationObject } (base64url) → { credentialId, publicKey (SPKI), alg, signCount }.
 * Exige présence et vérification de l'utilisateur (UP, UV).
 */
export function verifyRegistration(response, { challenge, origins }) {
  const clientData = fromB64url(response?.clientDataJSON);
  const { rpId } = checkClientData(clientData, { type: 'webauthn.create', challenge, origins });
  const { value: att } = decodeCbor(fromB64url(response?.attestationObject));
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) fail('attestationObject invalide');
  const auth = parseAuthData(att.get('authData'));
  if (!sameBytes(auth.rpIdHash, sha256(rpId))) fail('rpId inattendu');
  if (!auth.up || !auth.uv) fail('présence et vérification de l’utilisateur exigées');
  if (!auth.at || !auth.credentialId) fail('aucune clé dans la réponse');
  const { alg, publicKey } = coseToSpki(auth.cose);
  return { credentialId: b64url(auth.credentialId), publicKey, alg, signCount: auth.signCount };
}

/**
 * Connexion : { clientDataJSON, authenticatorData, signature } (base64url) et la clé enregistrée → { signCount }.
 * Compteur : refusé seulement s'il régresse alors que l'authentificateur en tient un (iCloud, Google renvoient toujours 0).
 */
export function verifyAssertion(response, credential, { challenge, origins }) {
  const clientData = fromB64url(response?.clientDataJSON);
  const authData = fromB64url(response?.authenticatorData);
  const signature = fromB64url(response?.signature);
  const { rpId } = checkClientData(clientData, { type: 'webauthn.get', challenge, origins });
  const auth = parseAuthData(authData);
  if (!sameBytes(auth.rpIdHash, sha256(rpId))) fail('rpId inattendu');
  if (!auth.up || !auth.uv) fail('présence et vérification de l’utilisateur exigées');
  const key = createPublicKey({ key: fromB64url(credential.publicKey), format: 'der', type: 'spki' });
  const data = Buffer.concat([authData, sha256(clientData)]);
  // ES256 : signature DER (format par défaut de node:crypto) ; RS256 : PKCS#1 v1.5
  if (!cryptoVerify('sha256', data, key, signature)) fail('signature invalide');
  if (credential.signCount > 0 && auth.signCount <= credential.signCount) fail('compteur de la clé en recul : clé clonée ?');
  return { signCount: auth.signCount };
}
