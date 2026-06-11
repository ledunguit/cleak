/**
 * TypeORM column transformer that encrypts a string at rest with AES-256-GCM.
 *
 * GitHub OAuth tokens must not sit in the database as plaintext (a DB dump or
 * volume read would hand them out). When `TOKEN_ENC_KEY` is set, values are
 * stored as `enc:v1:<iv>:<tag>:<ciphertext>` (all base64). When it is unset,
 * values pass through as plaintext — so existing dev databases keep working —
 * and `main.ts` warns at startup. Reads auto-detect the prefix, so a column can
 * hold a mix of legacy-plaintext and encrypted rows during migration.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { ValueTransformer } from 'typeorm';

const PREFIX = 'enc:v1:';

/** Derive a stable 32-byte key from TOKEN_ENC_KEY (any length) via SHA-256. */
function keyOrNull(): Buffer | null {
  const raw = process.env.TOKEN_ENC_KEY;
  if (!raw) return null;
  return createHash('sha256').update(raw).digest();
}

function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(stored: string, key: Buffer): string {
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(':');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/** A TypeORM transformer for a secret string column (apply via `{ transformer }`). */
export const encryptedColumn: ValueTransformer = {
  // entity → db
  to(value?: string | null): string | null | undefined {
    if (value == null) return value;
    const key = keyOrNull();
    return key ? encrypt(value, key) : value;
  },
  // db → entity
  from(value?: string | null): string | null | undefined {
    if (value == null || typeof value !== 'string') return value;
    if (!value.startsWith(PREFIX)) return value; // legacy plaintext row
    const key = keyOrNull();
    if (!key) return value; // key removed — can't decrypt; surface the ciphertext
    try {
      return decrypt(value, key);
    } catch {
      return value;
    }
  },
};
