import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const PREFIX = 'v1';

function keyFrom(appSecret: string): Buffer {
  if (!appSecret) {
    throw new Error('APP_SECRET is required to store AI provider secrets');
  }
  return createHash('sha256').update(appSecret).digest();
}

/**
 * Encrypts a provider secret with a key derived from APP_SECRET. The stored
 * shape is `v1:<iv>:<authTag>:<ciphertext>`, all base64, so the format can be
 * versioned later without guessing at the layout.
 */
export function encryptSecret(plain: string, appSecret: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyFrom(appSecret), iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);

  return [
    PREFIX,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Returns null instead of throwing when the payload cannot be decrypted, which
 * is what happens if APP_SECRET is rotated. Callers then fall back to the env
 * config rather than failing every AI request until an admin re-enters the key.
 */
export function decryptSecret(
  payload: string | null,
  appSecret: string,
): string | null {
  if (!payload) return null;

  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;

  try {
    const [, iv, authTag, data] = parts;
    const decipher = createDecipheriv(
      ALGORITHM,
      keyFrom(appSecret),
      Buffer.from(iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/** Preview shown to admins so they can tell which key is stored. */
export function maskSecret(secret: string | null): string | null {
  if (!secret) return null;
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 3)}••••${secret.slice(-4)}`;
}
