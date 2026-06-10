import crypto from 'crypto';

const ANTHROPIC_BETA = 'managed-agents-2026-04-01';
const ANTHROPIC_VERSION = '2023-06-01';

const threadSessions = new Map();
const seenEventIds = new Set();
const seenMessages = new Set();
let cachedBotUserId = null;

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

  // KB feedback: a 👎 reaction on the agent's own answer → a Notion inbox row.
  // Self-gates — no-op unless NOTION_TOKEN is configured.
  if (event.type === 'reaction_added') {
    if (config.notionToken && config.notionDbId) {
      handleReactionFeedback(event, config).catch((e) => console.error('reaction feedback failed:', e));
    }
    return;
  }

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
  const startMs = Date.now();
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
    const replyMrkdwn = toSlackMrkdwn(reply) || '_(empty response)_';
    const finalPayload = renderFinalMessage({
      trace,
      replyMrkdwn,
      elapsedMs: Date.now() - startMs,
    });
    await updateOrPost(config.botToken, channel, threadKey, placeholderTs, finalPayload);
  } catch (err) {
    console.error('Slack handler error:', err);
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    await updateOrPost(config.botToken, channel, threadKey, placeholderTs, `:warning: ${err.message}`);
  }
}

const LIVE_TRACE_TAIL = 10;
const SECTION_TEXT_LIMIT = 2900;
const TRACE_RESULT_PREVIEW = 240;

function traceLine(step) {
  const icon = step.status === 'done' ? ':white_check_mark:' : step.status === 'error' ? ':warning:' : ':wrench:';
  return `${icon} \`${step.name}\`${step.args}`;
}

function renderTrace(trace) {
  const lines = [':hourglass_flowing_sand: _Working on it…_', ''];
  const recent = trace.steps.slice(-LIVE_TRACE_TAIL);
  if (trace.steps.length > recent.length) {
    lines.push(`_+${trace.steps.length - recent.length} earlier step(s)…_`);
  }
  for (const step of recent) lines.push(traceLine(step));
  return lines.join('\n');
}

function renderFinalMessage({ trace, replyMrkdwn, elapsedMs }) {
  const blocks = answerBlocks(replyMrkdwn);
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: footerText(trace, elapsedMs) }],
  });
  const payload = { text: notificationText(replyMrkdwn), blocks };
  if (trace.steps.length) payload.attachments = [traceAttachment(trace)];
  return payload;
}

function answerBlocks(mrkdwn) {
  const blocks = [];
  let buf = '';
  for (const para of String(mrkdwn).split(/\n{2,}/)) {
    const next = buf ? `${buf}\n\n${para}` : para;
    if (next.length > SECTION_TEXT_LIMIT && buf) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: buf } });
      buf = para;
    } else {
      buf = next;
    }
  }
  if (buf) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: buf.slice(0, SECTION_TEXT_LIMIT) } });
  if (blocks.length === 0) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_(empty response)_' } });
  return blocks;
}

function traceAttachment(trace) {
  const lines = ['*✅ Slab*'];
  for (const step of trace.steps) lines.push(traceLine(step));
  return {
    color: 'good',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, SECTION_TEXT_LIMIT) } }],
  };
}

function footerText(trace, elapsedMs) {
  const seconds = (Math.max(0, elapsedMs) / 1000).toFixed(1);
  const n = trace.steps.length;
  return `Slab · ${seconds}s · ${n} tool ${n === 1 ? 'call' : 'calls'}`;
}

function previewText(mrkdwn) {
  if (!mrkdwn) return '';
  const stripped = String(mrkdwn)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/[*_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(stripped, TRACE_RESULT_PREVIEW);
}

function notificationText(mrkdwn) {
  const p = previewText(mrkdwn);
  return p || 'Slab reply';
}

function formatToolArgs(name, input) {
  if (!input || typeof input !== 'object') return '';
  switch (name) {
    case 'sync_table':
    case 'sync_workbook':
      return '';
    case 'get_rows': {
      if (input.query) return ` query "${truncate(input.query, 50)}"`;
      if (input.identifier_column) return ` column \`${input.identifier_column}\``;
      if (input.view) return ` view "${input.view}"`;
      return '';
    }
    case 'export_csv':
      return input.view ? ` view "${input.view}"` : '';
    case 'find_rows': {
      const parts = [];
      if (input.column) parts.push(`column \`${input.column}\``);
      if (Array.isArray(input.values)) parts.push(`${input.values.length} values`);
      return parts.length ? ` ${parts.join(', ')}` : '';
    }
    case 'get_record':
      return input.rowId ? ` row \`${input.rowId}\`` : '';
    case 'get_credits':
      if (input.rowId) return ` row \`${input.rowId}\``;
      if (input.full) return ' full table';
      return ` sample (${input.sampleSize || 50})`;
    case 'get_errors':
      return input.view ? ` view "${input.view}"` : '';
    case 'web_search':
      return input.query ? ` "${truncate(input.query, 60)}"` : '';
    case 'web_fetch':
      return input.url ? ` ${truncate(input.url, 60)}` : '';
    case 'bash':
      return input.command ? ` \`${truncate(input.command, 60)}\`` : '';
    case 'read':
    case 'write':
    case 'edit':
      return input.file_path ? ` \`${truncate(input.file_path, 50)}\`` : '';
    case 'glob':
      return input.pattern ? ` \`${input.pattern}\`` : '';
    case 'grep':
      return input.pattern ? ` /${truncate(input.pattern, 40)}/` : '';
    default:
      return '';
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function toSlackMrkdwn(text) {
  if (!text) return text;
  // Convert **bold** → *bold* before splitting on code spans, so that pairs
  // straddling an inline code span (e.g. `**Step 8 — \`column\`**`) still
  // match. The inner-class allows backticks/spaces but forbids `*` and
  // newlines, which keeps the match local.
  const preBolded = text.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*');
  const segments = preBolded.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return segments
    .map((seg, i) => {
      if (i % 2 === 1) return seg;
      return seg
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
        .replace(/__([^_\n]+?)__/g, '_$1_')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<$2|$1>');
    })
    .join('');
}

function asPayload(payload) {
  return typeof payload === 'string' ? { text: payload } : payload;
}

async function postMessage(botToken, channel, thread_ts, payload) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${botToken}` },
    body: JSON.stringify({ channel, thread_ts, ...asPayload(payload) }),
  });
  const json = await res.json();
  if (!json.ok) {
    console.error('chat.postMessage failed:', json);
    return null;
  }
  return json.ts;
}

async function updateOrPost(botToken, channel, thread_ts, ts, payload) {
  if (!ts) return postMessage(botToken, channel, thread_ts, payload);
  const res = await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${botToken}` },
    body: JSON.stringify({ channel, ts, ...asPayload(payload) }),
  });
  const json = await res.json();
  if (!json.ok) {
    console.error('chat.update failed:', json);
    return postMessage(botToken, channel, thread_ts, payload);
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
        const id = evt.id;
        if (onProgress && id) onProgress({ kind: 'tool_use', id, name: evt.name || 'tool', input: evt.input || {} });
      } else if (evt.type === 'agent.mcp_tool_result' || evt.type === 'agent.tool_result') {
        const id = evt.tool_use_id;
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

// ---------------------------------------------------------------------------
// KB feedback capture
// A 👎 reaction on one of the agent's own answers becomes a row in the Notion
// "KB Feedback Inbox" (capture-only — this never edits the KB). Reuses the
// existing /slack/events webhook, signature check, and event dedup.
// ---------------------------------------------------------------------------

const NOTION_VERSION = '2022-06-28';

async function slackApiGet(botToken, method, params) {
  const url = `https://slack.com/api/${method}?${new URLSearchParams(params)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
  return r.json();
}

async function getBotUserId(botToken) {
  if (cachedBotUserId !== null) return cachedBotUserId;
  try {
    const r = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const j = await r.json();
    cachedBotUserId = j.user_id || '';
  } catch {
    cachedBotUserId = '';
  }
  return cachedBotUserId;
}

async function resolveUserName(botToken, userId) {
  if (!userId) return '';
  try {
    const j = await slackApiGet(botToken, 'users.info', { user: userId });
    return j.ok ? (j.user?.real_name || j.user?.name || userId) : userId;
  } catch {
    return userId;
  }
}

async function getPermalink(botToken, channel, ts) {
  try {
    const j = await slackApiGet(botToken, 'chat.getPermalink', { channel, message_ts: ts });
    return j.ok ? j.permalink : '';
  } catch {
    return '';
  }
}

function threadTranscript(messages, botUserId) {
  const lines = [];
  for (const m of messages || []) {
    const who = m.user === botUserId || m.bot_id ? 'Agent' : 'User';
    const text = (m.text || '').replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim();
    if (text) lines.push(`${who}: ${text}`);
  }
  return lines.join('\n');
}

async function handleReactionFeedback(event, config) {
  const { botToken, feedbackEmojis } = config;
  if (event.item?.type !== 'message') return;
  if (!feedbackEmojis.includes(event.reaction)) return; // only the configured "not helpful" emoji(s)

  const channel = event.item.channel;
  const ts = event.item.ts;

  // The reacted message itself.
  const hist = await slackApiGet(botToken, 'conversations.history',
    { channel, latest: ts, inclusive: 'true', limit: '1' });
  const reacted = hist.messages?.[0];
  if (!reacted) return;

  // Only flag feedback on the agent's own answers.
  const botUserId = await getBotUserId(botToken);
  const isAgentAnswer = reacted.user === botUserId || (!botUserId && !!reacted.bot_id);
  if (!isAgentAnswer) return;

  // Dedup: one row per reacted message.
  const sourceId = `${channel}:${ts}`;
  if (await notionRowExists(config, sourceId)) {
    await ackFeedback(config, channel, event.user, reacted.thread_ts || ts, 'already');
    return;
  }

  // The surrounding thread (question + answer) for context.
  const root = reacted.thread_ts || ts;
  const repl = await slackApiGet(botToken, 'conversations.replies', { channel, ts: root, limit: '50' });
  const thread = repl.ok && repl.messages?.length ? repl.messages : [reacted];

  const [permalink, reactor] = await Promise.all([
    getPermalink(botToken, channel, ts),
    resolveUserName(botToken, event.user),
  ]);

  const userMsgs = thread.filter((m) => m.user && m.user !== botUserId && !m.bot_id && m.text);
  const question = userMsgs.length
    ? userMsgs[userMsgs.length - 1].text.replace(/<@[A-Z0-9]+>/g, '').trim()
    : '';
  const summary = `👎 ${truncate(question || 'Agent answer flagged not helpful', 90)}`;

  await createNotionFeedbackRow(config, {
    summary,
    context: `A 👎 reaction flagged this agent answer as not helpful.\n\nThread:\n${threadTranscript(thread, botUserId)}`,
    sourceUrl: permalink,
    submittedBy: reactor,
    sourceId,
  });

  await ackFeedback(config, channel, event.user, root, 'ok');
}

async function ackFeedback(config, channel, user, thread_ts, kind) {
  const text = kind === 'already'
    ? ':white_check_mark: Already flagged for KB review — thanks!'
    : ':memo: Flagged for KB review — thanks for the signal!';
  try {
    await fetch('https://slack.com/api/chat.postEphemeral', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.botToken}` },
      body: JSON.stringify({ channel, user, thread_ts, text }),
    });
  } catch (e) {
    console.error('feedback ack failed:', e);
  }
}

function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

async function notionRowExists(config, sourceId) {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${config.notionDbId}/query`, {
      method: 'POST',
      headers: notionHeaders(config.notionToken),
      body: JSON.stringify({
        filter: { property: 'Source ID', rich_text: { equals: sourceId } },
        page_size: 1,
      }),
    });
    const j = await r.json();
    return Array.isArray(j.results) && j.results.length > 0;
  } catch {
    return false;
  }
}

async function createNotionFeedbackRow(config, row) {
  const properties = {
    'Summary': { title: [{ text: { content: truncate(row.summary, 200) } }] },
    'Status': { select: { name: 'New' } },
    'Source': { select: { name: 'Slack feedback' } },
    'Type': { select: { name: 'Negative feedback' } },
    'Problem / context': { rich_text: [{ text: { content: truncate(row.context, 1900) } }] },
    'Submitted by': { rich_text: [{ text: { content: truncate(row.submittedBy || '', 100) } }] },
    'Source ID': { rich_text: [{ text: { content: row.sourceId } }] },
  };
  if (row.sourceUrl) properties['Source URL'] = { url: row.sourceUrl };
  const r = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: notionHeaders(config.notionToken),
    body: JSON.stringify({ parent: { database_id: config.notionDbId }, properties }),
  });
  if (!r.ok) console.error('Notion feedback row create failed:', r.status, await r.text());
}
