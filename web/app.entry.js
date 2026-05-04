/**
 * Discord UI for Rabbit R1 (bundled via esbuild for Netlify / Express).
 */
import { r1 } from 'r1-create';

const urlParams = new URLSearchParams(location.search);
const TOKEN = urlParams.get('token') || '';

function stripUrl(u) {
  return String(u ?? '').trim().replace(/\/$/, '');
}

/** ngrok free tier shows an interstitial for browser traffic; fetch then fails CORS unless this header is sent. */
function ngrokBypassHeaders(targetUrl) {
  let hostname = '';
  try {
    const u = new URL(String(targetUrl).trim());
    hostname = u.hostname;
  } catch (_) {
    return {};
  }
  if (!/ngrok/i.test(hostname)) return {};
  return { 'ngrok-skip-browser-warning': '69420' };
}

function isNetlifyHost() {
  return /\.netlify\.app$/i.test(location.hostname);
}

/** WebSocket host (tunnel URL). */
let BACKEND = '';
/** REST fetch base (`location.origin` on Netlify when proxy rules are baked, else BACKEND). */
let HTTP_API_BASE = '';
let useNetlifyDiscordProxy = false;

async function bootstrapNetworking() {
  const fromQuery = stripUrl(urlParams.get('backend'));
  let proxyFlag = false;
  let bundledBackend = '';

  try {
    const url = new URL('auto-backend.json', location.href).href;
    const r = await fetch(url, {
      cache: 'no-store',
      headers: ngrokBypassHeaders(url),
    });
    if (r.ok) {
      const j = await r.json();
      proxyFlag = Boolean(j.discordNetlifyProxy);
      bundledBackend = stripUrl(j.backend);
    }
  } catch (_) {}

  /** Explicit tunnel override — always hits ngrok/origin cross-origin REST (needs ngrok bypass header etc.). */
  if (fromQuery) {
    BACKEND = fromQuery;
    useNetlifyDiscordProxy = false;
    HTTP_API_BASE = BACKEND;
    return;
  }

  /** Built with R1_DISCORD_BACKEND_URL: Netlify proxies /guilds,/channels,... to tunnel (same-origin fetch for WebView). WS still goes to BACKEND below. */
  if (proxyFlag && isNetlifyHost() && bundledBackend) {
    BACKEND = bundledBackend;
    useNetlifyDiscordProxy = true;
    HTTP_API_BASE = stripUrl(location.origin);
    return;
  }

  let tunnel = bundledBackend;
  try {
    const stored = stripUrl(localStorage.getItem('r1_discord_backend'));
    if (stored) tunnel = stored;
  } catch (_) {}

  if (!tunnel) {
    const h = location.hostname;
    tunnel =
      h === 'localhost' || h === '127.0.0.1'
        ? stripUrl(location.origin)
        : stripUrl(location.origin);
  }

  BACKEND = tunnel;
  useNetlifyDiscordProxy = false;
  HTTP_API_BASE = BACKEND;
}

/** Absolute API URL: avoids `//` when BACKEND has a trailing slash. */
function apiUrl(path) {
  const base = stripUrl(HTTP_API_BASE || BACKEND);
  const p = path.startsWith('/') ? path : '/' + path;
  return base + p;
}

function formatApiFailure(err) {
  if (err && err.message === 'missing-backend') return '';
  if (err && err.message === 'NETWORK')
    return 'Cannot reach API (offline or wrong URL)';
  if (err && String(err.message).startsWith('HTTP_401'))
    return 'Unauthorized — check ?token= matches R1_AUTH_TOKEN';
  if (err && String(err.message).startsWith('HTTP_'))
    return 'API error ' + err.message.slice(5);
  return 'Failed to load servers';
}
const pageOrigin = location.origin.replace(/\/$/, '');
const defaultGenrePath = '/api/genrenator-genre';
/** Set in DOMContentLoaded after BACKEND is known (tunnel / ?backend). */
let resolvedGenreApiUrl = '';

let guilds = [];
let currentGuild = null;
let channels = [];
let currentChannel = null;
let messages = [];
let selectedIdx = 0;
let currentScreen = '';
let ws = null;
let wsReconnectDelay = 1000;
let recognition = null;
let recordingMode = null;
let voiceMicStream = null;
let mediaRecorder = null;
let recordedChunks = [];

let isRecording = false;
let genreBtnBusy = false;

let mentionMembers = [];
let mentionSelectedIdx = 0;
let mentionSearchTimer = null;

const $ = (id) => document.getElementById(id);
const recIndicator = $('recording-indicator');
const loadingEl = $('loading-overlay');
const loadingTextEl = $('loading-text');
const toastEl = $('toast');
const guildListEl = $('guild-list');
const channelListEl = $('channel-list');
const messageListEl = $('message-list');
const composeTA = $('compose-textarea');
const logListEl = $('log-list');
const memberPickerListEl = $('member-picker-list');
const memberSearchInput = $('member-search-input');

function setDefaultRecordingLabel() {
  recIndicator.innerHTML = '&#9679; RECORDING';
}

/** Screen to return to when leaving the Log view. */
let logReturnScreen = 'guilds';

function openLogScreen() {
  if (currentScreen !== 'log') logReturnScreen = currentScreen;
  showScreen('log');
}

const LOG_CAP = 300;
/** @param {'info' | 'warn' | 'error'} level */
function appLog(level, message) {
  if (!logListEl) return;
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  const d = new Date();
  const ts = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  const tag = level === 'info' ? '' : '[' + level.toUpperCase() + '] ';
  const text = '[' + ts + '] ' + tag + String(message).slice(0, 600);
  const row = document.createElement('div');
  row.className = 'log-line log-' + level;
  row.textContent = text;
  logListEl.appendChild(row);
  while (logListEl.childElementCount > LOG_CAP)
    logListEl.removeChild(logListEl.firstElementChild);
  logListEl.scrollTop = logListEl.scrollHeight;
}

function showScreen(name) {
  currentScreen = name;
  $('screen-guilds').classList.toggle('active', name === 'guilds');
  $('screen-channels').classList.toggle('active', name === 'channels');
  $('screen-messages').classList.toggle('active', name === 'messages');
  $('screen-compose').classList.toggle('active', name === 'compose');
  $('screen-mention').classList.toggle('active', name === 'mention');
  $('screen-log').classList.toggle('active', name === 'log');
  if (name === 'compose') setTimeout(() => composeTA.focus(), 50);
  if (name === 'mention' && memberSearchInput)
    setTimeout(() => memberSearchInput.focus(), 60);
  if (name === 'log') {
    requestAnimationFrame(() => {
      if (logListEl) logListEl.scrollTop = logListEl.scrollHeight;
    });
  }
}

function showLoading(text) {
  loadingTextEl.textContent = text || 'Loading…';
  loadingEl.classList.remove('hidden');
}
function hideLoading() {
  loadingEl.classList.add('hidden');
}

let toastTimer = null;
function showToast(msg, duration) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration || 2200);
}

/** Must use r1.messaging.onMessage — do not set window.onPluginMessage (that breaks LLM replies). */
r1.messaging.onMessage(function (data) {
  if (!data || typeof data !== 'object') return;
  if (data.type === 'sttEnded') {
    recordingMode = null;
    isRecording = false;
    recIndicator.classList.remove('active');
    setDefaultRecordingLabel();
    const text = (data.transcript || '').trim();
    if (text) {
      composeTA.value = text;
      showScreen('compose');
      appLog('info', 'STT transcript OK');
    } else {
      showToast('No speech detected');
      appLog('warn', 'STT empty transcript');
    }
  }
});

function relativeTime(tsMs) {
  const diff = Date.now() - tsMs;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Collapse whitespace and trim for Discord message bodies. */
function normalizeDiscordText(str) {
  return String(str ?? '')
    .replace(/\uFEFF/g, '')
    .replace(/[\r\n]+/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

/**
 * Turn nested JSON / objects / arrays into user-facing plain text (no HTML).
 * Prefers common message keys, then longest string found in the tree.
 */
function valueToPlainText(val, depth) {
  const d = depth == null ? 0 : depth;
  if (d > 8) return '';
  if (val == null) return '';
  if (typeof val === 'string') {
    const t = val.trim();
    if (!t) return '';
    if (
      (t.startsWith('{') && t.endsWith('}')) ||
      (t.startsWith('[') && t.endsWith(']'))
    ) {
      try {
        const inner = valueToPlainText(JSON.parse(t), d + 1);
        if (inner) return inner;
      } catch (_) {
        /* keep raw string */
      }
    }
    return t;
  }
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    const chunks = [];
    for (let i = 0; i < val.length; i++) {
      const p = valueToPlainText(val[i], d + 1);
      if (p) chunks.push(p);
    }
    return normalizeDiscordText(chunks.join('\n'));
  }
  if (typeof val === 'object') {
    const preferred = [
      'message',
      'text',
      'response',
      'content',
      'answer',
      'reply',
      'body',
      'output',
      'result',
      'transcript',
      'genre',
      'title',
      'description',
    ];
    let best = '';
    for (let k = 0; k < preferred.length; k++) {
      if (val[preferred[k]] !== undefined) {
        const got = valueToPlainText(val[preferred[k]], d + 1);
        if (got.length > best.length) best = got;
      }
    }
    const keys = Object.keys(val);
    for (let i = 0; i < keys.length; i++) {
      const got = valueToPlainText(val[keys[i]], d + 1);
      if (got.length > best.length) best = got;
    }
    if (best) return best;
    try {
      return normalizeDiscordText(JSON.stringify(val));
    } catch (_) {
      return '';
    }
  }
  return '';
}

/** Genre API can return bare JSON strings, `{ "genre": "..." }`, arrays, etc. */
function parseGenreLabelFromBody(parsed, rawText) {
  const fromParsed = normalizeDiscordText(valueToPlainText(parsed, 0));
  if (fromParsed) return fromParsed.slice(0, 500);

  const t = normalizeDiscordText(rawText);
  if (t) return t.replace(/^["']|["']$/g, '').slice(0, 500);

  throw new Error('Genre response shape unknown');
}

async function fetchRandomGenre(apiUrl) {
  const res = await fetch(apiUrl, {
    credentials: 'omit',
    mode: 'cors',
    headers: ngrokBypassHeaders(apiUrl),
  });
  if (!res.ok) throw new Error('Genre HTTP ' + res.status);

  const rawText = await res.text();
  let parsed = rawText;

  try {
    parsed = JSON.parse(rawText);
  } catch (_) {
    parsed = rawText.trim();
  }

  return parseGenreLabelFromBody(parsed, rawText);
}

function genreBanner(msg) {
  const el = $('genre-banner');
  if (!msg) {
    el.textContent = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.textContent = msg;
}

/** Human-readable snippet from thrown api()/fetch errors */
function summarizeSendError(err) {
  if (!err) return 'Unknown error';
  if (err.message === 'NETWORK') return 'No network — check tunnel & ?backend';
  const m = String(err.message || err);
  if (m.startsWith('HTTP_')) {
    const colon = m.indexOf(':');
    const codePart = colon > 0 ? m.slice(5, colon) : m.slice(5);
    const rest = (err.detail || (colon > 0 ? m.slice(colon + 1).trim() : '')).trim();
    return rest ? codePart + ': ' + rest : codePart || m;
  }
  return m;
}

async function onGenreExploreClick() {
  genreBanner('');
  if (genreBtnBusy) return;

  if (currentScreen !== 'messages') {
    showToast('Genre works in a channel chat', 3500);
    appLog('warn', 'Genre ignored (open a channel chat)');
    return;
  }
  if (!currentChannel) {
    genreBanner('Open a channel first, then tap Genre.');
    showToast('Pick a channel first', 3500);
    appLog('warn', 'Genre ignored (no channel)');
    return;
  }

  const genreUrl = resolvedGenreApiUrl || pageOrigin + defaultGenrePath;

  genreBtnBusy = true;
  showLoading('Fetching genre…');
  appLog('info', 'Genre start #' + currentChannel.name);
  let genre = '';

  try {
    try {
      genre = await fetchRandomGenre(genreUrl);
      genre = normalizeDiscordText(genre);
      if (!genre) throw new Error('Genre label empty after parse');
      appLog('info', 'Genre label OK');
    } catch (err) {
      genreBanner('Genre fetch: ' + (err && err.message ? err.message : String(err)));
      appLog(
        'error',
        'Genre fetch ' + (err && err.message ? err.message : String(err)),
      );
      showToast('Genre fetch failed — see banner', 4000);
      return;
    }

    loadingTextEl.textContent = 'Making embed…';
    const result = await api('/channels/' + currentChannel.id + '/genre-explore', {
      method: 'POST',
      body: JSON.stringify({ genre }),
    });
    appendMessage(result.message);
    genreBanner('');
    appLog(
      'info',
      result.usedGemini ? 'Genre embed posted (Gemini)' : 'Genre embed posted (fallback)',
    );
    showToast('Embed posted #' + currentChannel.name, 2800);
  } catch (e) {
    const line = summarizeSendError(e);
    genreBanner(line);
    appLog('error', 'Genre Discord ' + line);
    showToast('Discord: ' + (line.length > 80 ? line.slice(0, 77) + '…' : line), 4200);
  } finally {
    hideLoading();
    genreBtnBusy = false;
  }
}

async function api(path, opts) {
  const method = ((opts && opts.method) || 'GET').toUpperCase();
  const url = apiUrl(path);
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    ngrokBypassHeaders(url),
    TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {},
    (opts && opts.headers) || {},
  );
  let res;
  try {
    res = await fetch(url, Object.assign({}, opts, {
      mode: 'cors',
      headers,
    }));
  } catch (e) {
    appLog('error', method + ' ' + path + ' NETWORK ' + (e && e.message ? String(e.message) : ''));
    throw new Error('NETWORK');
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      if (j != null && j.error != null) detail = String(j.error);
    } catch (_) {
      detail = '';
    }
    const line = method + ' ' + path + ' HTTP ' + res.status + (detail ? ' — ' + detail : '');
    appLog('error', line + ' @ ' + url);
    throw Object.assign(new Error('HTTP_' + res.status + (detail ? ': ' + detail : '')), { detail });
  }
  try {
    return await res.json();
  } catch (err) {
    appLog('error', method + ' ' + path + ' not JSON — often ngrok interstitial @ ' + url);
    throw new Error('NETWORK');
  }
}

function renderGuildList() {
  guildListEl.innerHTML = guilds
    .map((g, i) => {
      const icon = g.iconURL
        ? `<img class="guild-icon" src="${escapeHtml(g.iconURL)}" loading="lazy" alt="">`
        : `<div class="guild-icon-placeholder">${escapeHtml(g.name[0].toUpperCase())}</div>`;
      return `<div class="guild-item${i === selectedIdx ? ' selected' : ''}" data-idx="${i}">${icon}<div class="guild-name">${escapeHtml(g.name)}</div></div>`;
    })
    .join('');
  const sel = guildListEl.querySelector('.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function renderChannelList() {
  let html = '';
  let lastCat = null;
  channels.forEach((ch, i) => {
    if (ch.category !== lastCat) {
      html += '<div class="category-header">' + escapeHtml(ch.category) + '</div>';
      lastCat = ch.category;
    }
    html +=
      '<div class="channel-item' +
      (i === selectedIdx ? ' selected' : '') +
      '" data-idx="' +
      i +
      '">' +
      escapeHtml(ch.name) +
      '</div>';
  });
  channelListEl.innerHTML = html;
  const sel = channelListEl.querySelector('.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function renderMemberPickerList() {
  if (!memberPickerListEl) return;
  if (mentionMembers.length === 0) {
    memberPickerListEl.innerHTML = '';
    return;
  }
  memberPickerListEl.innerHTML = mentionMembers
    .map((m, i) => {
      const uname = m.username || '';
      const dname = m.displayName || uname || 'User';
      const initial = (dname[0] || '?').toUpperCase();
      const av = m.avatarURL
        ? '<img class="mp-av" src="' +
          escapeHtml(m.avatarURL) +
          '" loading="lazy" alt="">'
        : '<div class="mp-av" style="display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;background:var(--accent)">' +
          escapeHtml(initial) +
          '</div>';
      return (
        '<div class="member-picker-item' +
        (i === mentionSelectedIdx ? ' selected' : '') +
        '" data-mid="' +
        escapeHtml(m.id) +
        '">' +
        av +
        '<div class="mp-meta"><div class="mp-name">' +
        escapeHtml(dname) +
        '</div><div class="mp-sub">@' +
        escapeHtml(uname) +
        '</div></div></div>'
      );
    })
    .join('');
  const sel = memberPickerListEl.querySelector('.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function insertMentionAtCursor(userId) {
  const mention = '<@' + userId + '> ';
  const ta = composeTA;
  const start = typeof ta.selectionStart === 'number' ? ta.selectionStart : ta.value.length;
  const end = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : start;
  ta.value = ta.value.slice(0, start) + mention + ta.value.slice(end);
  const pos = start + mention.length;
  try {
    ta.selectionStart = ta.selectionEnd = pos;
  } catch (_) {}
}

function confirmMentionPick() {
  const m = mentionMembers[mentionSelectedIdx];
  if (!m) return;
  insertMentionAtCursor(m.id);
  clearTimeout(mentionSearchTimer);
  showScreen('compose');
  setTimeout(() => composeTA.focus(), 50);
}

async function runMemberSearch() {
  if (!currentGuild) return;
  const q = memberSearchInput ? memberSearchInput.value.trim() : '';
  if (q.length < 1) {
    mentionMembers = [];
    mentionSelectedIdx = 0;
    renderMemberPickerList();
    return;
  }
  try {
    mentionMembers = await api(
      '/guilds/' + currentGuild.id + '/members-search?q=' + encodeURIComponent(q),
    );
    if (!Array.isArray(mentionMembers)) mentionMembers = [];
    mentionSelectedIdx = 0;
    renderMemberPickerList();
    if (mentionMembers.length === 0) showToast('No prefix match', 2000);
  } catch (e) {
    mentionMembers = [];
    renderMemberPickerList();
    appLog('error', 'members-search ' + (e.message || String(e)));
    showToast(formatApiFailure(e) || 'Search failed', 2600);
  }
}

function scheduleMemberSearch() {
  clearTimeout(mentionSearchTimer);
  mentionSearchTimer = setTimeout(runMemberSearch, 300);
}

function openMentionPicker() {
  if (!currentGuild) {
    showToast('Open a channel first');
    appLog('warn', 'Mention picker: no guild');
    return;
  }
  mentionMembers = [];
  mentionSelectedIdx = 0;
  if (memberSearchInput) memberSearchInput.value = '';
  renderMemberPickerList();
  showScreen('mention');
}

function bubbleHtml(m) {
  const voiceUrl = m.voiceUrl ? String(m.voiceUrl) : '';
  const rawContent = String(m.content || '').replace(/\u200b/g, '').trim();
  const textBody = voiceUrl
    ? rawContent
      ? escapeHtml(rawContent)
      : ''
    : m.hasAudio
      ? '🎤 Voice message'
      : escapeHtml(m.content || '');
  const hasImgs = (m.images || []).length > 0;
  const imgs = (m.images || [])
    .map(
      (url) =>
        `<img src="${escapeHtml(url)}" style="max-width:100%;border-radius:5px;margin-top:3px;display:block;" loading="lazy" alt="">`
    )
    .join('');
  const audioEl = voiceUrl
    ? `<div class="msg-audio"><audio controls preload="metadata" src="${escapeHtml(voiceUrl)}" style="width:100%;max-height:36px;"></audio></div>`
    : '';
  const voiceLabel =
    voiceUrl && !textBody ? `<div class="voice-label">Voice</div>` : '';
  return (
    `<div class="message-bubble${m.isOwn ? ' own' : ''}${hasImgs ? ' has-photo' : ''}" data-message-id="${escapeHtml(m.id)}">` +
    (m.isOwn ? '' : `<div class="message-author">${escapeHtml(m.author)}</div>`) +
    voiceLabel +
    (textBody ? `<div>${textBody}</div>` : '') +
    audioEl +
    imgs +
    `<div class="message-time">${relativeTime(m.timestamp)}</div></div>`
  );
}

function renderMessages() {
  messageListEl.innerHTML = messages.map(bubbleHtml).join('');
  scrollToBottom();
}

function appendMessage(msg) {
  if (messageListEl.querySelector('[data-message-id="' + msg.id + '"]')) return;
  const near = isNearBottom();
  const wrap = document.createElement('div');
  wrap.innerHTML = bubbleHtml(msg);
  messageListEl.appendChild(wrap.firstElementChild);
  if (near) scrollToBottom();
}

function isNearBottom() {
  return (
    messageListEl.scrollHeight - messageListEl.scrollTop - messageListEl.clientHeight < 60
  );
}

function scrollToBottom() {
  messageListEl.scrollTop = messageListEl.scrollHeight;
}

async function loadGuilds() {
  showLoading('Loading servers…');
  try {
    if (isNetlifyHost() && !useNetlifyDiscordProxy && BACKEND === stripUrl(location.origin)) {
      showToast('Netlify needs R1_DISCORD_BACKEND_URL or last ?backend=');
      throw new Error('missing-backend');
    }
    guilds = await api('/guilds');
    selectedIdx = 0;
    try {
      localStorage.setItem('r1_discord_backend', BACKEND);
    } catch (_) {}
    renderGuildList();
    appLog('info', 'Servers loaded (' + guilds.length + ')');
    if (guilds.length === 0) {
      showToast('No servers — check GUILD_IDS & bot invite');
      appLog('warn', 'No servers visible to bot');
    }
    if (guilds.length === 1) {
      await openGuild(guilds[0]);
      return;
    }
    showScreen('guilds');
  } catch (e) {
    const msg = formatApiFailure(e);
    if (String(e.message || '') === 'missing-backend')
      appLog('warn', 'Backend URL missing (?backend= / auto-backend.json)');
    else if (
      e.message &&
      !String(e.message).startsWith('HTTP_') &&
      e.message !== 'NETWORK'
    )
      appLog('error', 'loadGuilds: ' + (msg || String(e.message)));
    if (msg) showToast(msg);
    showScreen('guilds');
  } finally {
    hideLoading();
  }
}

async function openGuild(g) {
  currentGuild = g;
  $('server-name').textContent = g.name;
  showLoading('Loading channels…');
  try {
    channels = await api('/channels?guild=' + g.id);
    selectedIdx = 0;
    renderChannelList();
    appLog('info', 'Channels ' + channels.length + ' • ' + g.name);
    showScreen('channels');
  } catch (e) {
    showToast('Failed to load channels');
  } finally {
    hideLoading();
  }
}

async function openChannel(ch) {
  currentChannel = ch;
  $('channel-title').textContent = '#' + ch.name;
  $('compose-channel-name').textContent = '#' + ch.name;
  showScreen('messages');
  showLoading('Loading…');
  try {
    messages = await api('/channels/' + ch.id + '/messages?limit=30');
    renderMessages();
    appLog('info', '#' + ch.name + ' messages ' + messages.length);
  } catch (e) {
    showToast('Failed to load messages');
  } finally {
    hideLoading();
  }
}

async function sendMessage() {
  const content = composeTA.value.trim();
  if (!content || !currentChannel) return;
  const sendBtn = $('send-btn');
  sendBtn.disabled = true;
  try {
    const result = await api('/channels/' + currentChannel.id + '/send', {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    composeTA.value = '';
    showScreen('messages');
    appendMessage(result.message);
    appLog('info', 'Message posted');
  } catch (e) {
    showToast('Send failed');
  } finally {
    sendBtn.disabled = false;
  }
}

function supportsMediaRecorderPtt() {
  return !!(
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  );
}

function cleanupVoiceMicStream() {
  if (!voiceMicStream) return;
  voiceMicStream.getTracks().forEach(function (t) {
    try {
      t.stop();
    } catch (_) {}
  });
  voiceMicStream = null;
}

async function uploadVoiceBlob(blob) {
  if (!currentChannel || !blob || blob.size < 96) {
    showToast('Recording too short');
    return;
  }
  showLoading('Sending voice…');
  try {
    const url = apiUrl('/channels/' + currentChannel.id + '/voice');
    const headers = Object.assign({}, ngrokBypassHeaders(url));
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;

    const fd = new FormData();
    const t = String(blob.type || '');
    let fname = 'clip.webm';
    if (t.includes('ogg')) fname = 'clip.oga';
    else if (t.includes('mp4') || t.includes('mpeg4')) fname = 'clip.m4a';
    else if (t.includes('wav')) fname = 'clip.wav';

    fd.append('audio', blob, fname);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        body: fd,
        headers,
        mode: 'cors',
        credentials: 'omit',
      });
    } catch (e) {
      appLog('error', 'POST voice NETWORK ' + (e && e.message ? e.message : ''));
      throw new Error('NETWORK');
    }
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        if (j && j.error != null) detail = String(j.error);
      } catch (_) {}
      appLog('error', 'POST voice HTTP ' + res.status + (detail ? ' — ' + detail : '') + ' @ ' + url);
      throw Object.assign(new Error('HTTP_' + res.status + (detail ? ': ' + detail : '')), {
        detail,
      });
    }
    const j = await res.json();
    if (j && j.message) appendMessage(j.message);
    showScreen('messages');
    appLog('info', 'Voice sent (' + (j.format === 'mp3' ? 'mp3' : 'orig') + ')');
  } catch (e) {
    showToast(summarizeSendError(e));
  } finally {
    hideLoading();
  }
}

async function startCaptureWithMediaRecorder() {
  cleanupVoiceMicStream();
  recordedChunks = [];
  voiceMicStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  let mime = '';
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))
    mime = 'audio/webm;codecs=opus';
  else if (MediaRecorder.isTypeSupported('audio/webm'))
    mime = 'audio/webm';
  else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus'))
    mime = 'audio/ogg;codecs=opus';
  mediaRecorder = new MediaRecorder(
    voiceMicStream,
    mime ? { mimeType: mime } : undefined,
  );
  mediaRecorder.ondataavailable = function (e) {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onerror = function () {
    appLog('warn', 'MediaRecorder reported an error');
  };
  recIndicator.innerHTML = '&#9679; REC';
  recIndicator.classList.add('active');
  mediaRecorder.start(200);
}

async function finalizeMediaRecorderUpload() {
  const mr = mediaRecorder;
  mediaRecorder = null;
  if (!mr) {
    cleanupVoiceMicStream();
    recordedChunks = [];
    return;
  }
  await new Promise(function (resolve) {
    const done = function () {
      mr.removeEventListener('stop', done);
      resolve();
    };
    mr.addEventListener('stop', done);
    try {
      if (mr.state === 'recording') mr.stop();
      else done();
    } catch (_) {
      done();
    }
  });
  cleanupVoiceMicStream();
  const blob = new Blob(recordedChunks, { type: mr.mimeType || 'audio/webm' });
  recordedChunks = [];
  await uploadVoiceBlob(blob);
}

function connectWS() {
  const bare = stripUrl(BACKEND);
  const proto = bare.startsWith('https') ? 'wss' : 'ws';
  const host = bare.replace(/^https?:\/\//, '');
  const url =
    proto +
    '://' +
    host +
    '/ws' +
    (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : '');
  ws = new WebSocket(url);
  ws.onopen = function () {
    wsReconnectDelay = 1000;
    appLog('info', 'WebSocket OK');
  };
  ws.onmessage = function (e) {
    try {
      const data = JSON.parse(e.data);
      if (
        data.type === 'new_message' &&
        currentChannel &&
        data.channelId === currentChannel.id
      ) {
        appendMessage(data.message);
      }
    } catch (err) {}
  };
  ws.onclose = function () {
    appLog('warn', 'WebSocket closed (retry in ' + wsReconnectDelay + 'ms)');
    setTimeout(connectWS, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
  };
  ws.onerror = function () {
    appLog('warn', 'WebSocket error');
    ws.close();
  };
}

function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.continuous = true;
  r.interimResults = false;
  r.lang = 'en-US';
  let pending = '';
  r._clearPending = function () {
    pending = '';
  };
  r.onresult = function (e) {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) pending += e.results[i][0].transcript;
    }
  };
  r.onerror = function (e) {
    if (e.error !== 'no-speech') {
      void stopVoicePtt();
      showToast('Voice error');
    }
  };
  r.onend = function () {
    if (recordingMode === 'stt' && isRecording) {
      try {
        r.start();
      } catch (err) {}
    }
  };
  r._getPending = function () {
    return pending;
  };
  return r;
}

async function startVoicePtt() {
  if (!currentChannel || isRecording) return;

  if (supportsMediaRecorderPtt()) {
    try {
      await startCaptureWithMediaRecorder();
      recordingMode = 'media';
      isRecording = true;
      return;
    } catch (e) {
      appLog('warn', 'MediaRecorder: ' + (e.message || String(e)));
      if (mediaRecorder) {
        try {
          mediaRecorder.stop();
        } catch (_) {}
        mediaRecorder = null;
      }
      cleanupVoiceMicStream();
      recordedChunks = [];
    }
  }

  if (typeof CreationVoiceHandler !== 'undefined') {
    recordingMode = 'creation';
    isRecording = true;
    recIndicator.innerHTML = '&#9679; MIC';
    recIndicator.classList.add('active');
    CreationVoiceHandler.postMessage('start');
    return;
  }

  if (!recognition) recognition = initRecognition();
  if (!recognition) {
    showToast('Voice not supported');
    return;
  }
  recognition._clearPending();
  recordingMode = 'stt';
  try {
    recognition.start();
    isRecording = true;
    recIndicator.innerHTML = '&#9679; STT';
    recIndicator.classList.add('active');
  } catch (e) {
    recordingMode = null;
    showToast('Mic unavailable');
  }
}

async function stopVoicePtt() {
  if (recordingMode === 'media' || (mediaRecorder && mediaRecorder.state !== 'inactive')) {
    isRecording = false;
    recordingMode = null;
    recIndicator.classList.remove('active');
    setDefaultRecordingLabel();
    await finalizeMediaRecorderUpload();
    return;
  }

  if (recordingMode === 'creation') {
    CreationVoiceHandler.postMessage('stop');
    return;
  }

  if (!isRecording) return;

  const wasStt = recordingMode === 'stt';
  recordingMode = null;
  isRecording = false;
  recIndicator.classList.remove('active');
  setDefaultRecordingLabel();

  if (wasStt) {
    const text = recognition ? recognition._getPending().trim() : '';
    try {
      if (recognition) recognition.stop();
    } catch (e) {}
    if (recognition) recognition._clearPending();
    if (text) {
      composeTA.value = text;
      showScreen('compose');
      appLog('info', 'STT → compose');
    } else {
      showToast('No speech detected');
    }
  }
}

window.addEventListener('scrollUp', function () {
  if (currentScreen === 'compose') return;
  if (currentScreen === 'log') {
    if (logListEl) logListEl.scrollBy(0, -60);
    return;
  }
  if (currentScreen === 'guilds') {
    if (selectedIdx > 0) {
      selectedIdx--;
      renderGuildList();
    }
  } else if (currentScreen === 'channels') {
    if (selectedIdx > 0) {
      selectedIdx--;
      renderChannelList();
    }
  } else if (currentScreen === 'mention') {
    if (mentionSelectedIdx > 0) {
      mentionSelectedIdx--;
      renderMemberPickerList();
    }
  } else if (currentScreen === 'messages') {
    messageListEl.scrollBy(0, -60);
  }
});

window.addEventListener('scrollDown', function () {
  if (currentScreen === 'compose') return;
  if (currentScreen === 'log') {
    if (logListEl) logListEl.scrollBy(0, 60);
    return;
  }
  if (currentScreen === 'guilds') {
    if (selectedIdx < guilds.length - 1) {
      selectedIdx++;
      renderGuildList();
    }
  } else if (currentScreen === 'channels') {
    if (selectedIdx < channels.length - 1) {
      selectedIdx++;
      renderChannelList();
    }
  } else if (currentScreen === 'mention') {
    if (mentionSelectedIdx < mentionMembers.length - 1) {
      mentionSelectedIdx++;
      renderMemberPickerList();
    }
  } else if (currentScreen === 'messages') {
    messageListEl.scrollBy(0, 60);
  }
});

window.addEventListener('longPressStart', function () {
  if (currentScreen === 'compose' || currentScreen === 'log') return;
  if (currentScreen === 'guilds' && guilds[selectedIdx]) {
    openGuild(guilds[selectedIdx]);
  } else if (currentScreen === 'channels' && channels[selectedIdx]) {
    openChannel(channels[selectedIdx]);
  } else if (currentScreen === 'mention' && mentionMembers[mentionSelectedIdx]) {
    confirmMentionPick();
  } else if (currentScreen === 'messages') {
    void startVoicePtt();
  }
});

window.addEventListener('longPressEnd', function () {
  if (currentScreen === 'messages' && isRecording) void stopVoicePtt();
});

document.addEventListener('keydown', function (e) {
  if (
    currentScreen === 'compose' ||
    currentScreen === 'log' ||
    currentScreen === 'mention'
  )
    return;
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    window.dispatchEvent(new Event('longPressStart'));
  }
});

document.addEventListener('keyup', function (e) {
  if (
    currentScreen === 'compose' ||
    currentScreen === 'log' ||
    currentScreen === 'mention'
  )
    return;
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    window.dispatchEvent(new Event('longPressEnd'));
  }
});

composeTA.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

$('channels-back-btn').addEventListener('click', function () {
  showScreen('guilds');
});
$('back-btn').addEventListener('click', function () {
  showScreen('channels');
});
$('open-compose-btn').addEventListener('click', function () {
  if (!currentChannel) return;
  showScreen('compose');
});
$('cancel-btn').addEventListener('click', function () {
  composeTA.value = '';
  showScreen('messages');
});
$('send-btn').addEventListener('click', function () {
  sendMessage();
});

$('tag-user-btn').addEventListener('click', function () {
  openMentionPicker();
});
$('mention-back-btn').addEventListener('click', function () {
  clearTimeout(mentionSearchTimer);
  showScreen('compose');
});
if (memberSearchInput) {
  memberSearchInput.addEventListener('input', scheduleMemberSearch);
}
if (memberPickerListEl) {
  memberPickerListEl.addEventListener('click', function (e) {
    const row = e.target.closest('.member-picker-item');
    if (!row || !row.dataset.mid) return;
    insertMentionAtCursor(row.dataset.mid);
    clearTimeout(mentionSearchTimer);
    showScreen('compose');
    setTimeout(() => composeTA.focus(), 50);
  });
}

$('genre-explore-btn').addEventListener('click', function () {
  onGenreExploreClick();
});

$('guilds-log-btn').addEventListener('click', function () {
  openLogScreen();
});
$('channels-log-btn').addEventListener('click', function () {
  openLogScreen();
});
$('messages-log-btn').addEventListener('click', function () {
  openLogScreen();
});
$('log-back-btn').addEventListener('click', function () {
  showScreen(logReturnScreen);
});
$('log-clear-btn').addEventListener('click', function () {
  if (logListEl) logListEl.innerHTML = '';
});

guildListEl.addEventListener('click', function (e) {
  const item = e.target.closest('.guild-item');
  if (!item) return;
  const idx = parseInt(item.dataset.idx, 10);
  if (!isNaN(idx) && guilds[idx]) {
    selectedIdx = idx;
    openGuild(guilds[idx]);
  }
});

channelListEl.addEventListener('click', function (e) {
  const item = e.target.closest('.channel-item');
  if (!item) return;
  const idx = parseInt(item.dataset.idx, 10);
  if (!isNaN(idx) && channels[idx]) {
    selectedIdx = idx;
    openChannel(channels[idx]);
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await r1.initialize();
  } catch (_) {}
  await bootstrapNetworking();
  resolvedGenreApiUrl =
    stripUrl(urlParams.get('genreApi')) || stripUrl(HTTP_API_BASE) + defaultGenrePath;
  appLog('info', 'r1-discord ready');
  appLog('info', 'HTTP ' + HTTP_API_BASE + (useNetlifyDiscordProxy ? ' (Netlify→tunnel)' : ''));
  appLog('info', 'WS ' + BACKEND);
  appLog('info', 'Genre ' + resolvedGenreApiUrl);
  await loadGuilds();
  connectWS();
});
