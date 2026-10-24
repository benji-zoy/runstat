// Chiffrement de bout en bout de la sauvegarde (mode local-first) : WebCrypto seulement (navigateur, Node).
// - Clé de données : 32 octets aléatoires, jamais stockés en clair hors de la mémoire. Enveloppée (AES-GCM) par une clé dérivée
//   de la phrase de passe (PBKDF2-SHA256, 600 000 itérations au moins, sel de 16 octets), et en option par un code de secours.
//   Changer de phrase de passe ne fait que la ré-envelopper ; une mauvaise phrase de passe échoue au déchiffrement (étiquette GCM).
// - Clés de travail dérivées par HKDF de la clé de données, non extractibles : chiffrement (AES-GCM 256) et empreinte (HMAC-SHA256).
// - Objets : identifiant = HMAC du contenu en clair (dédoublonnage sans rien révéler), puis IV aléatoire ‖ AES-GCM, l'identifiant
//   en données associées (un objet ne peut pas être servi à la place d'un autre) ; recalculé après déchiffrement.
// - Manifeste : AES-GCM, données associées « rs-manifest-v1|compte|version » (ni rejoué sous une autre version, ni d'un autre compte).

export const MIN_ITERATIONS = 600_000;
const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();

export class WrongPassphrase extends Error {}
export class TamperedData extends Error {}

export const b64url = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromB64url = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const random = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));
const buf = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

/** Enveloppe de la clé de données dans l'en-tête clair du manifeste */
export interface KeyWrap {
  kind: 'passphrase' | 'recovery';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ct: string;
}

/** Clés de travail, non extractibles (gardables telles quelles dans IndexedDB) */
export interface WorkKeys {
  enc: CryptoKey;
  mac: CryptoKey;
}

async function kek(secret: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  // Le serveur fournit l'en-tête : jamais moins que le minimum, quoi qu'il dise
  if (!(iterations >= MIN_ITERATIONS) || iterations > 10_000_000) throw new TamperedData('dérivation de clé trop faible');
  const base = await subtle().importKey('raw', enc.encode(secret.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export const newDataKey = (): Uint8Array => random(32);

/** Enveloppe la clé de données par une phrase de passe ou un code de secours */
export async function wrapKey(dataKey: Uint8Array, secret: string, kind: KeyWrap['kind'], iterations = MIN_ITERATIONS): Promise<KeyWrap> {
  const salt = random(16);
  const iv = random(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: enc.encode(`rs-wrap-v1|${kind}`) }, await kek(secret, salt, iterations), buf(dataKey));
  return { kind, kdf: 'PBKDF2-SHA256', iterations, salt: b64url(salt), iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
}

/** Clé de données d'après la phrase de passe (ou le code de secours) ; WrongPassphrase si aucune enveloppe ne s'ouvre */
export async function unwrapKey(wraps: KeyWrap[], secret: string, kind: KeyWrap['kind'] = 'passphrase'): Promise<Uint8Array> {
  for (const w of wraps.filter((x) => x.kind === kind)) {
    try {
      const key = await kek(secret, fromB64url(w.salt), w.iterations);
      const plain = await subtle().decrypt({ name: 'AES-GCM', iv: buf(fromB64url(w.iv)), additionalData: enc.encode(`rs-wrap-v1|${kind}`) }, key, buf(fromB64url(w.ct)));
      return new Uint8Array(plain);
    } catch (e) {
      if (e instanceof TamperedData) throw e;
    }
  }
  throw new WrongPassphrase(kind === 'recovery' ? 'Code de secours incorrect' : 'Phrase de passe incorrecte');
}

/** Clés de travail dérivées de la clé de données (HKDF), non extractibles */
export async function workKeys(dataKey: Uint8Array): Promise<WorkKeys> {
  const base = await subtle().importKey('raw', buf(dataKey), 'HKDF', false, ['deriveKey']);
  const derive = (info: string, alg: AesKeyGenParams | HmacKeyGenParams, usages: KeyUsage[]) =>
    subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) }, base, alg, false, usages);
  return {
    enc: await derive('rs-enc-v1', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    mac: await derive('rs-mac-v1', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
  };
}

/** Identifiant d'un contenu : HMAC-SHA256 en hexadécimal (64 caractères) */
export async function objectId(keys: WorkKeys, plain: Uint8Array): Promise<string> {
  return hex(await subtle().sign('HMAC', keys.mac, buf(plain)));
}

export async function encryptObject(keys: WorkKeys, plain: Uint8Array): Promise<{ id: string; data: Uint8Array }> {
  const id = await objectId(keys, plain);
  const iv = random(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: enc.encode(`rs-obj-v1|${id}`) }, keys.enc, buf(plain)));
  const data = new Uint8Array(12 + ct.length);
  data.set(iv);
  data.set(ct, 12);
  return { id, data };
}

/** Déchiffre un objet et vérifie qu'il correspond à son identifiant ; TamperedData sinon */
export async function decryptObject(keys: WorkKeys, id: string, data: Uint8Array): Promise<Uint8Array> {
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(data.slice(0, 12)), additionalData: enc.encode(`rs-obj-v1|${id}`) }, keys.enc, buf(data.slice(12))));
  } catch {
    throw new TamperedData(`objet ${id.slice(0, 8)}… illisible ou altéré`);
  }
  if ((await objectId(keys, plain)) !== id) throw new TamperedData(`objet ${id.slice(0, 8)}… ne correspond pas à son identifiant`);
  return plain;
}

const manifestAad = (account: string, version: number) => enc.encode(`rs-manifest-v1|${account}|${version}`);

export async function encryptManifest(keys: WorkKeys, account: string, version: number, value: unknown): Promise<string> {
  const iv = random(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: manifestAad(account, version) }, keys.enc, enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64url(out);
}

export async function decryptManifest<T>(keys: WorkKeys, account: string, version: number, blob: string): Promise<T> {
  const data = fromB64url(blob);
  try {
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: buf(data.slice(0, 12)), additionalData: manifestAad(account, version) }, keys.enc, buf(data.slice(12)));
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    throw new TamperedData('manifeste illisible : autre clé, autre compte, autre version ou altéré');
  }
}

/** Code de secours : 24 caractères Crockford base32 (120 bits), groupés par 4 pour la lecture */
export function recoveryCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = random(24);
  const chars = [...bytes].map((b) => alphabet[b & 31]).join('');
  return chars.match(/.{4}/g)!.join('-');
}
export const normalizeRecovery = (s: string): string => s.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').match(/.{1,4}/g)?.join('-') ?? '';
