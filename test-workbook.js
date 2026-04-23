#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL = process.argv[2] || 'https://app.clay.com/workspaces/4515/workbooks/wb_0tabxixBHWC52M4pGXu/all-tables';

const server = spawn('node', [path.join(__dirname, 'index.js')], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
let nextId = 1;
const pending = new Map();

server.stdout.on('data', chunk => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

server.stderr.on('data', chunk => process.stderr.write(chunk));

function send(method, params) {
  return new Promise(resolve => {
    const id = nextId++;
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'test', version: '1.0.0' }
});
server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

console.log('=== sync_workbook ===\n');
const result = await send('tools/call', {
  name: 'sync_workbook',
  arguments: { url: URL }
});

console.log(result.result.content[0].text);

server.kill();
process.exit(0);
