#!/usr/bin/env node

/**
 * Quick test harness — spawns the MCP server and sends tool calls sequentially.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TABLE_URL = process.argv[2] || 'https://app.clay.com/workspaces/4515/workbooks/wb_0tabxixBHWC52M4pGXu/tables/t_0tabxuijDo9XbNJ96dy/views/gv_0tabxuin7niueJ9SEbf';

const server = spawn('node', [path.join(__dirname, 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe']
});

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

server.stderr.on('data', chunk => {
  process.stderr.write(chunk);
});

function send(method, params) {
  return new Promise(resolve => {
    const id = nextId++;
    pending.set(id, resolve);
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    server.stdin.write(msg + '\n');
  });
}

function notify(method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  server.stdin.write(msg + '\n');
}

// --- Run tests ---

console.log('=== Initializing MCP server ===\n');
const initResult = await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'test', version: '1.0.0' }
});
console.log('Server:', initResult.result.serverInfo.name, initResult.result.serverInfo.version);
console.log('Tools:', initResult.result.capabilities.tools ? 'yes' : 'no');
notify('notifications/initialized', {});

// 1. sync_table
console.log('\n=== sync_table ===\n');
const syncResult = await send('tools/call', {
  name: 'sync_table',
  arguments: { url: TABLE_URL }
});
const syncText = syncResult.result.content[0].text;
console.log(syncText.substring(0, 500));
if (syncText.length > 500) console.log(`\n... (${syncText.length} chars total)\n`);

// Extract tableId from the text
const tableIdMatch = syncText.match(/Table ID\s*\|\s*`(t_[a-zA-Z0-9]+)`/);
const tableId = tableIdMatch?.[1];
console.log('Resolved tableId:', tableId);

if (!tableId) {
  console.error('Could not extract tableId — stopping.');
  server.kill();
  process.exit(1);
}

// 2. get_rows (5 rows)
console.log('\n=== get_rows (limit=5) ===\n');
const rowsResult = await send('tools/call', {
  name: 'get_rows',
  arguments: { tableId, limit: 5 }
});
console.log(rowsResult.result.content[0].text.substring(0, 1500));

// 3. get_errors
console.log('\n=== get_errors ===\n');
const errorsResult = await send('tools/call', {
  name: 'get_errors',
  arguments: { tableId }
});
console.log(errorsResult.result.content[0].text.substring(0, 1500));

// 4. analyze_table
console.log('\n=== analyze_table ===\n');
const analysisResult = await send('tools/call', {
  name: 'analyze_table',
  arguments: { tableId }
});
console.log(analysisResult.result.content[0].text.substring(0, 1500));

// 5. get_record (first row from get_rows)
try {
  const rowsData = JSON.parse(rowsResult.result.content[0].text.replace(/^[^\[]*/, ''));
  const firstRowId = rowsData[0]?._rowId;
  if (firstRowId) {
    console.log('\n=== get_record ===\n');
    const recordResult = await send('tools/call', {
      name: 'get_record',
      arguments: { tableId, rowId: firstRowId }
    });
    console.log(recordResult.result.content[0].text.substring(0, 2000));
  }
} catch (e) {
  console.log('\nSkipping get_record (could not parse row ID):', e.message);
}

console.log('\n=== All tests complete ===');
server.kill();
process.exit(0);
