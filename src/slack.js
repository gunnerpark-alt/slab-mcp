import crypto from 'crypto';

const ANTHROPIC_BETA = 'managed-agents-2026-04-01';
const ANTHROPIC_VERSION = '2023-06-01';

const threadSessions = new Map();
const seenEventIds = new Set();
const seenMessages = new Set();

export function verifySlackSignature(req, signingSecret) {
  const ts = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig || !req.rawBody) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false;
  const base = `v0:${ts}:${req.rawBody}`;
  const computed = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(computed));
  } catch {
    return false;
  }
}

export async function handleSlackEvents(req, res, config) {
  if (!verifySlackSignature(req, config.signingSecret)) {
    return res.status(401).json({ error: 'invalid signature' });
  }

  const body = req.body;

  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }

  if (req.headers['x-slack-retry-num']) {
    return res.status(200).send();
  }

  if (body.event_id) {
    if (seenEventIds.has(body.event_id)) {
      return res.status(200).send();
    }
    seenEventIds.add(body.event_id);
    if (seenEventIds.size > 1000) seenEventIds.clear();
  }

  res.status(200).send();

  if (body.type !== 'event_callback') return;
  const event = body.event;
  if (!event) return;

  const isMention = event.type === 'app_mention';
  const isThreadFollowup =
    event.type === 'message' &&
    !event.bot_id &&
    (!event.subtype || event.subtype === 'thread_broadcast') &&
    event.thread_ts &&
    threadSessions.has(event.thread_ts);

  if (!isMention && !isThreadFollowup) return;

  const messageKey = `${event.channel}:${event.ts}`;
  if (seenMessages.has(messageKey)) return;
  seenMessages.add(messageKey);
  if (seenMessages.size > 1000) seenMessages.clear();

  const { text, channel, thread_ts, ts } = event;
  const threadKey = thread_ts || ts;
  const cleanText = (text || '').replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!cleanText) {
    await postMessage(config.botToken, channel, threadKey, 'Mention me with a question or a Clay URL.');
    return;
  }

  let placeholderTs = null;
  const trace = { steps: [] };
  let pendingTimer = null;
  let lastFlush = 0;
  let dirty = false;

  const flush = async () => {
    pendingTimer = null;
    if (!dirty || !placeholderTs) return;
    dirty = false;
    lastFlush = Date.now();
    try {
      await updateOrPost(config.botToken, channel, threadKey, placeholderTs, renderTrace(trace));
    } catch (e) {
      console.error('progress update failed:', e);
    }
  };
  const scheduleUpdate = () => {
    dirty = true;
    if (pendingTimer) return;
    pendingTimer = setTimeout(flush, Math.max(0, 800 - (Date.now() - lastFlush)));
  };
  const onProgress = (ev) => {
    if (ev.kind === 'tool_use') {
      trace.steps.push({ id: ev.id, name: ev.name, args: formatToolArgs(ev.name, ev.input), status: 'running' });
      if (trace.steps.length > 10) trace.steps.shift();
      scheduleUpdate();
    } else if (ev.kind === 'tool_result') {
      const step = trace.steps.find((s) => s.id === ev.id);
      if (step) {
        step.status = ev.isError ? 'error' : 'done';
        scheduleUpdate();
      }
    }
  };

  try {
    let sessionId = threadSessions.get(threadKey);
    if (!sessionId) {
      sessionId = await createSession(config);
      threadSessions.set(threadKey, sessionId);
    }
    placeholderTs = await postMessage(config.botToken, channel, threadKey, ':hourglass_flowing_sand: _Working on it…_');
    const reply = await streamReply(config, sessionId, cleanText, onProgress);
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    await updateOrPost(config.botToken, channel, threadKey, placeholderTs, reply || '_(empty response)_');
  } catch (err) {
    console.error('Slack handler error:', err);
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    await updateOrPost(config.botToken, channel, threadKey, placeholderTs, `:warning: ${err.message}`);
  }
}

function renderTrace(trace) {
  const lines = [':hourglass_flowing_sand: _Working on it…_', ''];
  for (const step of trace.steps) {
    const icon = step.status === 'done' ? ':white_check_mark:' : step.status === 'error' ? ':warning:' : ':wrench:';
    lines.push(`${icon} \`${step.name}\`${step.args}`);
  }
  return lines.join('\n');
}

function formatToolArgs(_name, input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.url === 'string') return ` ${truncate(input.url, 70)}`;
  if (typeof input._rowId === 'string') return ` row \`${input._rowId}\``;
  if (typeof input.column === 'string') return ` column \`${input.column}\``;
  if (typeof input.tableId === 'string') return ` \`${input.tableId}\``;
  if (typeof input.query === 'string') return ` "${truncate(input.query, 50)}"`;
  if (typeof input.command === 'string') return ` \`${truncate(input.command, 50)}\``;
  if (typeof input.path === 'string') return ` \`${truncate(input.path, 50)}\``;
  return '';
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function postMessage(botToken, channel, thread_ts, text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${botToken}` },
    body: JSON.stringify({ channel, thread_ts, text }),
  });
  const json = await res.json();
  if (!json.ok) {
    console.error('chat.postMessage failed:', json);
    return null;
  }
  return json.ts;
}

async function updateOrPost(botToken, channel, thread_ts, ts, text) {
  if (!ts) return postMessage(botToken, channel, thread_ts, text);
  const res = await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${botToken}` },
    body: JSON.stringify({ channel, ts, text }),
  });
  const json = await res.json();
  if (!json.ok) {
    console.error('chat.update failed:', json);
    return postMessage(botToken, channel, thread_ts, text);
  }
  return json.ts;
}

async function createSession({ anthropicKey, agentId, environmentId, vaultId }) {
  const res = await fetch('https://api.anthropic.com/v1/sessions', {
    method: 'POST',
    headers: anthropicHeaders(anthropicKey),
    body: JSON.stringify({
      agent: agentId,
      environment_id: environmentId,
      vault_ids: vaultId ? [vaultId] : [],
    }),
  });
  if (!res.ok) throw new Error(`session create failed: ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

async function streamReply({ anthropicKey }, sessionId, message, onProgress) {
  const streamRes = await fetch(
    `https://api.anthropic.com/v1/sessions/${sessionId}/events/stream?beta=true`,
    { headers: { ...anthropicHeaders(anthropicKey), Accept: 'text/event-stream' } }
  );
  if (!streamRes.ok || !streamRes.body) {
    throw new Error(`stream open failed: ${streamRes.status} ${await streamRes.text()}`);
  }

  const sendPromise = fetch(`https://api.anthropic.com/v1/sessions/${sessionId}/events`, {
    method: 'POST',
    headers: anthropicHeaders(anthropicKey),
    body: JSON.stringify({
      events: [{ type: 'user.message', content: [{ type: 'text', text: message }] }],
    }),
  }).then(async (r) => {
    if (!r.ok) console.error('send event failed:', r.status, await r.text());
  });

  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalText = '';

  outer: while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }
      if (evt.type === 'agent.message' && Array.isArray(evt.content)) {
        for (const block of evt.content) {
          if (block.type === 'text' && block.text) finalText += block.text;
        }
      } else if (evt.type === 'agent.mcp_tool_use' || evt.type === 'agent.tool_use') {
        console.error('[slack][tool_use] raw event:', JSON.stringify(evt).slice(0, 500));
        const name = evt.name || evt.tool_name || evt.tool?.name || evt.tool_use?.name || 'tool';
        const id = evt.id || evt.tool_use_id || evt.tool?.id || evt.tool_use?.id;
        const input = evt.input || evt.tool?.input || evt.tool_use?.input || {};
        if (onProgress && id) onProgress({ kind: 'tool_use', id, name, input });
      } else if (evt.type === 'agent.mcp_tool_result' || evt.type === 'agent.tool_result') {
        console.error('[slack][tool_result] raw event:', JSON.stringify(evt).slice(0, 300));
        const id = evt.tool_use_id || evt.id || evt.tool_result?.tool_use_id;
        if (onProgress && id) onProgress({ kind: 'tool_result', id, isError: !!evt.is_error });
      } else if (evt.type === 'session.status_idle') {
        break outer;
      } else if (evt.type === 'session.error') {
        const msg = evt.error?.message || 'unknown';
        finalText += `\n_(session error: ${msg})_`;
        break outer;
      }
    }
  }

  await sendPromise;
  return finalText;
}

function anthropicHeaders(key) {
  return {
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': ANTHROPIC_BETA,
    'content-type': 'application/json',
  };
}
