/**
 * Reads the Clay session cookie directly from Chrome's on-disk SQLite cookie DB.
 * macOS only. Uses the Chrome Safe Storage key from Keychain to decrypt.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';

const CHROME_PROFILES = ['Default', 'Profile 1', 'Profile 2', 'Profile 3'];
const CHROME_BASE = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');

function findCookieDb() {
  for (const profile of CHROME_PROFILES) {
    const p = path.join(CHROME_BASE, profile, 'Cookies');
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Chrome cookie DB not found. Checked: ${CHROME_PROFILES.map(p => path.join(CHROME_BASE, p, 'Cookies')).join(', ')}`);
}

function getChromePassword() {
  try {
    return execSync(
      'security find-generic-password -w -s "Chrome Safe Storage" -a Chrome',
      { stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim();
  } catch {
    throw new Error('Could not read Chrome Safe Storage from Keychain. Is Chrome installed?');
  }
}

function deriveKey(password) {
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

function decryptValue(encryptedBuf, key) {
  const prefix = encryptedBuf.slice(0, 3).toString();

  if (prefix === 'v10' || prefix === 'v11') {
    const ciphertext = encryptedBuf.slice(3);
    const iv = Buffer.alloc(16, ' ');
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
      decipher.setAutoPadding(true);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return decrypted.slice(32).toString('utf-8');
    } catch {
      return null;
    }
  }

  return encryptedBuf.toString('utf-8');
}

export function readClaySessionCookie() {
  const dbPath = findCookieDb();
  const password = getChromePassword();
  const key = deriveKey(password);

  const tmpPath = path.join(os.tmpdir(), `slab-mcp-cookies-${process.pid}.db`);
  try {
    fs.copyFileSync(dbPath, tmpPath);

    for (const ext of ['-wal', '-shm']) {
      const src = dbPath + ext;
      if (fs.existsSync(src)) {
        try { fs.copyFileSync(src, tmpPath + ext); } catch {}
      }
    }

    const db = new Database(tmpPath, { readonly: true, fileMustExist: true });

    const rows = db.prepare(`
      SELECT name, encrypted_value
      FROM cookies
      WHERE host_key LIKE '%clay.com%' OR host_key LIKE '%clay.run%'
      ORDER BY last_access_utc DESC
    `).all();

    db.close();

    if (!rows || rows.length === 0) return null;

    const decrypted = [];
    for (const row of rows) {
      const val = decryptValue(Buffer.from(row.encrypted_value), key);
      if (val) decrypted.push(`${row.name}=${val}`);
    }

    return decrypted.length > 0 ? decrypted.join('; ') : null;
  } finally {
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpPath + ext); } catch {}
    }
  }
}
