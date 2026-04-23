/**
 * Credential manager for slab-mcp.
 * Session cookie: auto-read from Chrome's on-disk DB every call (always fresh).
 * Fallback: manually stored in ~/.slab/config.json.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { readClaySessionCookie } from './cookie-reader.js';

const CONFIG_PATH = path.join(os.homedir(), '.slab', 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch {}
  return {};
}

export function getSessionCookie() {
  // 1. Try Chrome's on-disk cookie DB (always freshest)
  try {
    const cookie = readClaySessionCookie();
    if (cookie) return cookie;
  } catch {}

  // 2. Fall back to manually stored cookie
  const config = loadConfig();
  if (config.sessionCookie) return config.sessionCookie;

  throw new Error(
    'No Clay session cookie found.\n' +
    '  Option 1: Make sure Chrome is open and you are logged into Clay.\n' +
    '  Option 2: Create ~/.slab/config.json with { "sessionCookie": "claysession=..." }'
  );
}

export function getInternalApiHeaders() {
  const cookie = getSessionCookie();
  return {
    'Cookie': cookie,
    'X-Clay-Frontend-Version': 'unknown',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://app.clay.com',
    'Referer': 'https://app.clay.com/'
  };
}
