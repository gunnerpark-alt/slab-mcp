#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TABLE_URL = 'https://app.clay.com/workspaces/4515/workbooks/wb_0tabxixBHWC52M4pGXu/tables/t_0tabxuijDo9XbNJ96dy/views/gv_0tabxuin7niueJ9SEbf';

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

// 1. sync_table
console.log('=== sync_table ===');
const t0 = Date.now();
const syncResult = await send('tools/call', { name: 'sync_table', arguments: { url: TABLE_URL } });
console.log(`Done in ${Date.now() - t0}ms`);
const syncJson = JSON.parse(syncResult.result.content[0].text);
const tableId = syncJson.rootSchema?.tableId;
console.log('tableId:', tableId, '\n');

// 2. get_rows (export path, limit=5)
console.log('=== get_rows (limit=5, export path) ===');
const t1 = Date.now();
const rowsResult = await send('tools/call', { name: 'get_rows', arguments: { tableId, limit: 5 } });
console.log(`Done in ${Date.now() - t1}ms`);
console.log(rowsResult.result.content[0].text.substring(0, 800), '\n');

// 3. get_rows with search
console.log('=== get_rows (query="chapel", limit=1) ===');
const t2 = Date.now();
const searchResult = await send('tools/call', { name: 'get_rows', arguments: { tableId, query: 'chapel', limit: 1 } });
console.log(`Done in ${Date.now() - t2}ms`);
console.log(searchResult.result.content[0].text.substring(0, 500), '\n');

console.log('=== All tests complete ===');
server.kill();
process.exit(0);
