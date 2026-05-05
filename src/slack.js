import crypto from 'crypto';

const ANTHROPIC_BETA = 'managed-agents-2026-04-01';
const ANTHROPIC_VERSION = '2023-06-01';

const threadSessions = new Map();
const seenEventIds = new Set();

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

  if (body.type !== 'event_callback' || body.event?.type !== 'app_mention') {
    return;
  }

  const { text, channel, thread_ts, ts } = body.event;
  const threadKey = thread_ts || ts;
  const cleanText = (text || '').replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!cleanText) {
    await postMessage(config.botToken, channel, threadKey, 'Mention me with a question or a Clay URL.');
    return;
  }

  try {
    let sessionId = threadSessions.get(threadKey);
    if (!sessionId) {
      sessionId = await createSession(config);
      threadSessions.set(threadKey, sessionId);
    }
    const reply = await streamReply(config, sessionId, cleanText);
    await postMessage(config.botToken, channel, threadKey, reply || '_(empty response)_');
  } catch (err) {
    console.error('Slack handler error:', err);
    await postMessage(config.botToken, channel, threadKey, `:warning: ${err.message}`);
  }
}

async function postMessage(botToken, channel, thread_ts, text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${botToken}` },
    body: JSON.stringify({ channel, thread_ts, text }),
  });
  const json = await res.json();
  if (!json.ok) console.error('chat.postMessage failed:', json);
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
  const text = await res.text();
  if (!res.ok) throw new Error(`session create failed: ${res.status} ${text}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`session create returned non-JSON: ${text.slice(0, 200)}`); }
  const id = json.id || json.session?.id || json.data?.id;
  console.error('[slack] session created:', id, '(raw keys:', Object.keys(json).join(','), ')');
  if (!id) throw new Error(`no session id in response: ${text.slice(0, 200)}`);
  return id;
}

async function streamReply({ anthropicKey }, sessionId, message) {
  const candidates = [
    `https://api.anthropic.com/v1/sessions/${sessionId}/stream?beta=true`,
    `https://api.anthropic.com/v1/sessions/${sessionId}/events/stream?beta=true`,
    `https://api.anthropic.com/v1/sessions/${sessionId}/stream`,
  ];
  let streamRes;
  let lastErr = '';
  for (const url of candidates) {
    console.error('[slack] trying stream URL:', url);
    streamRes = await fetch(url, {
      headers: { ...anthropicHeaders(anthropicKey), Accept: 'text/event-stream' },
    });
    if (streamRes.ok && streamRes.body) {
      console.error('[slack] stream opened at:', url);
      break;
    }
    lastErr = `${streamRes.status} ${await streamRes.text()}`;
    console.error('[slack] stream URL failed:', url, lastErr);
  }
  if (!streamRes?.ok || !streamRes.body) {
    throw new Error(`stream open failed: ${lastErr}`);
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
