/**
 * Credential manager for slab-mcp (API-key edition).
 * Source order: CLAY_API_KEY env var → ~/.slab/config.json ({ "apiKey": "..." }) → throw.
 *
 * The key is sent as `Authorization: <raw-key>` (no `Bearer` prefix) — that's the
 * shape Clay's public v3 API expects. Get a key from
 * https://app.clay.com/workspaces/<your-workspace>/settings/account.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const CONFIG_PATH = path.join(os.homedir(), '.slab', 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch {}
  return {};
}

export function getApiKey() {
  const fromEnv = process.env.CLAY_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const config = loadConfig();
  if (config.apiKey && String(config.apiKey).trim()) return String(config.apiKey).trim();

  throw new Error(
    'No Clay API key found.\n' +
    '  Option 1 (recommended): set CLAY_API_KEY in your MCP server config\'s env block.\n' +
    '  Option 2: create ~/.slab/config.json with { "apiKey": "<your-key>" }\n' +
    '  Get your key at https://app.clay.com/workspaces/<workspace-id>/settings/account'
  );
}

export function getInternalApiHeaders() {
  return {
    'Authorization': getApiKey(),
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
}
