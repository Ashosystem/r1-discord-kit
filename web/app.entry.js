/**
 * Discord UI for Rabbit R1 (bundled via esbuild for Netlify / Express).
 */
import { r1 } from 'r1-create';

const urlParams = new URLSearchParams(location.search);
const TOKEN = urlParams.get('token') || '';

const LS_SHOP_DISCORD_UID = 'r1_shop_discord_user_id';

function getShopDiscordUserId() {
  try {
    return String(localStorage.getItem(LS_SHOP_DISCORD_UID) || '');
  } catch (_) {
    return '';
  }
}

function persistShopDiscordUserId(raw) {
  const v = String(raw ?? '').trim();
  try {
    if (/^\d{17,21}$/.test(v)) localStorage.setItem(LS_SHOP_DISCORD_UID, v);
    else localStorage.removeItem(LS_SHOP_DISCORD_UID);
  } catch (_) {}
}

/** Bundled into Discord sends so the tunnel can mint Rabbit Heads for this Discord account. */
function shopDiscordUserPayload() {
  const u = getShopDiscordUserId().trim();
  if (!/^\d{17,21}$/.test(u)) return {};
  return { shopDiscordUser: u };
}

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
/** Netlify REST is same-origin via _redirects; Rabbit WebViews often block WS to tunnel — try /ws proxy first. */
let wsFallbackToTunnelWs = false;
let wsHandshakeEverSucceeded = false;
let recognition = null;
let recordingMode = null;
let voiceMicStream = null;
let mediaRecorder = null;
let recordedChunks = [];

let isRecording = false;
let genreBtnBusy = false;
/** 0 = normal voice (record/STT → compose or voice note). 1 or 2 = meme panel layout for next PTT dictation. */
let memePanelLayout = 0;
let memeJobBusy = false;

/** Bot joined Discord voice channel (client mirrors /voice/status). */
let joinedDiscordVoiceId = '';
let joinedDiscordVoiceName = '';
/** Remote VC participants: userId → display label (from pcm / vc_speak). */
let vcRemoteSpeakerNames = new Map();
/** User IDs currently marked speaking by server (Discord RTP / SpeakingMap). */
let vcRemoteSpeakingIds = new Set();
/** Synthetic: R1 talks through the bot, so Discord never reports your Discord user ID as inbound speaking. */
const VC_LOCAL_MIC_LABEL = 'You';
let discordVcTransmitting = false;
let vcDiscordMicStream = null;
let vcDiscordAudioCtx = null;
let vcDiscordSource = null;
let vcDiscordProcessor = null;
let vcDiscordMuteGain = null;
/** Pulls transmit graph without piping to speakers (gain 0 to destination can stall worklets). */
let vcDiscordSilentSinkDest = null;
/** Deferred graph teardown after `vc_end` so FFmpeg stdin can flush. */
let vcDiscordTeardownTimer = null;
let vcDiscordWorkletNode = null;
let vcDiscordWorkletBlobUrl = '';

/** Incoming Discord VC — mixed in an AudioWorklet (avoids thousands of zipper-prone AudioBufferSource starts). */
const VC_LISTEN_WORKLET_SRC = `class R1VcListenMixer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = Object.create(null);
    this.keys = [];
    this.port.onmessage = (ev) => this._push(ev.data);
  }
  _push(m) {
    if (!m || m.t !== 'p' || !m.u) return;
    const ab = m.a;
    if (!(ab instanceof ArrayBuffer) || ab.byteLength < 4) return;
    const buf = new Float32Array(ab);
    let list = this.q[m.u];
    if (!list) {
      list = [];
      this.q[m.u] = list;
    }
    let total = buf.length;
    for (let i = 0; i < list.length; i++)
      total += list[i].b.length - list[i].i;
    const cap = 57600;
    while (total > cap && list.length > 0) {
      const h = list[0];
      total -= h.b.length - h.i;
      list.shift();
    }
    list.push({ b: buf, i: 0 });
    this.keys = Object.keys(this.q);
  }
  _pull(list) {
    while (list && list.length) {
      const e = list[0];
      if (e.i >= e.b.length) {
        list.shift();
        continue;
      }
      return e.b[e.i++];
    }
    return 0;
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    const L = out.length;
    const keys = this.keys;
    const q = this.q;
    for (let j = 0; j < L; j++) {
      let s = 0;
      for (let k = 0; k < keys.length; k++) s += this._pull(q[keys[k]]);
      out[j] = Math.tanh(Math.max(-6, Math.min(6, s * 0.46)));
    }
    return true;
  }
}
registerProcessor('r1_vc_listen', R1VcListenMixer);
`;

let vcInboundCtx = null;
let vcInboundMasterGain = null;
let vcListenWorkletBlobUrl = '';
let vcListenWorkletNode = null;
let vcListenMixerPromise = null;
/** AudioBufferSource fallback only (legacy WebViews without multi-output worklet route). */
let vcInboundNextPlay = {};

function teardownVcInboundPlayback() {
  vcInboundNextPlay = {};
  vcListenMixerPromise = null;
  if (vcListenWorkletBlobUrl) {
    try {
      URL.revokeObjectURL(vcListenWorkletBlobUrl);
    } catch (_) {}
    vcListenWorkletBlobUrl = '';
  }
  if (vcListenWorkletNode) {
    try {
      vcListenWorkletNode.disconnect();
      vcListenWorkletNode.port.onmessage = null;
    } catch (_) {}
    vcListenWorkletNode = null;
  }
  if (vcInboundMasterGain) {
    try {
      vcInboundMasterGain.disconnect();
    } catch (_) {}
    vcInboundMasterGain = null;
  }
  if (vcInboundCtx) {
    try {
      vcInboundCtx.close();
    } catch (_) {}
    vcInboundCtx = null;
  }
}

function decodeBase64ToUint8(b64) {
  const bin = atob(String(b64));
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

function ensureVcInboundContext() {
  if (vcInboundCtx && vcInboundCtx.state !== 'closed') return;
  const A = window.AudioContext || window.webkitAudioContext;
  if (!A) return;
  try {
    vcInboundCtx = new A({ latencyHint: 'playback' });
    vcInboundMasterGain = vcInboundCtx.createGain();
    vcInboundMasterGain.gain.value = 0.52;
    vcInboundMasterGain.connect(vcInboundCtx.destination);
    void vcInboundCtx.resume();
  } catch (_) {
    vcInboundCtx = null;
    vcInboundMasterGain = null;
  }
}

async function ensureVcListenMixer() {
  ensureVcInboundContext();
  if (!vcInboundCtx || !vcInboundMasterGain) return false;
  if (vcListenWorkletNode) return true;
  const aw = vcInboundCtx.audioWorklet;
  if (!aw || typeof aw.addModule !== 'function') return false;
  if (vcListenMixerPromise) return vcListenMixerPromise;
  vcListenMixerPromise = (async () => {
    try {
      await vcInboundCtx.resume();
      if (!vcListenWorkletBlobUrl) {
        vcListenWorkletBlobUrl = URL.createObjectURL(
          new Blob([VC_LISTEN_WORKLET_SRC], { type: 'application/javascript' }),
        );
      }
      await vcInboundCtx.audioWorklet.addModule(vcListenWorkletBlobUrl);
      vcListenWorkletNode = new AudioWorkletNode(vcInboundCtx, 'r1_vc_listen', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      vcListenWorkletNode.connect(vcInboundMasterGain);
      return true;
    } catch (e) {
      vcListenMixerPromise = null;
      vcListenWorkletNode = null;
      appLog('warn', 'VC listen mixer: ' + (e.message || String(e)));
      return false;
    }
  })();
  return vcListenMixerPromise;
}

function playVcListenBufferFallback(uid, pcmU8, sampleRateHint) {
  if (!joinedDiscordVoiceId || !pcmU8 || pcmU8.byteLength < 2) return;
  ensureVcInboundContext();
  if (!vcInboundCtx || !vcInboundMasterGain) return;
  void vcInboundCtx.resume();

  const sr = Number(sampleRateHint) || 48000;
  const n = pcmU8.byteLength >> 1;
  const buf = vcInboundCtx.createBuffer(1, n, sr);
  const dv = new DataView(pcmU8.buffer, pcmU8.byteOffset, pcmU8.byteLength);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++)
    ch[i] = Math.max(-1, Math.min(1, dv.getInt16(i * 2, true) * (0.92 / 32768)));

  const key = String(uid || 'x');
  const now = vcInboundCtx.currentTime;
  let t = vcInboundNextPlay[key];
  if (!(t >= now)) t = now + 0.06;
  if (t - now > 1.25) t = now + 0.1;

  const src = vcInboundCtx.createBufferSource();
  src.buffer = buf;
  src.connect(vcInboundMasterGain);
  try {
    src.start(t);
  } catch (_) {
    try {
      src.start(now + 0.02);
      t = now + 0.02;
    } catch (e2) {
      appLog('warn', 'listen fallback ' + (e2.message || ''));
      return;
    }
  }

  vcInboundNextPlay[key] = t + buf.duration;
  src.onended = function () {
    try {
      src.disconnect();
    } catch (_) {}
  };
}

function dispatchVcListenWsMessage(data) {
  if (
    !joinedDiscordVoiceId ||
    !data ||
    data.type !== 'vc_listen_pcm' ||
    !data.d ||
    !discordVoiceWsReady()
  )
    return;
  const uidListen = String(data.u || '');
  const nmListen = String(data.nm || '').trim();
  if (uidListen && nmListen) vcRemoteSpeakerNames.set(uidListen, nmListen);
  const raw = decodeBase64ToUint8(data.d);
  if (raw.byteLength < 2) return;
  const n = raw.byteLength >> 1;
  const f32 = new Float32Array(n);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0; i < n; i++)
    f32[i] = dv.getInt16(i * 2, true) * (0.92 / 32768);
  const key = String(data.u || '');
  const sr = Number(data.sr) || 48000;
  void (async () => {
    const ok = await ensureVcListenMixer();
    if (ok && vcListenWorkletNode) {
      try {
        vcListenWorkletNode.port.postMessage(
          { t: 'p', u: key, a: f32.buffer },
          [f32.buffer],
        );
      } catch (_) {
        playVcListenBufferFallback(key, raw, sr);
      }
      return;
    }
    playVcListenBufferFallback(key, raw, sr);
  })();
}

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
  if (!recIndicator) return;
  recIndicator.innerHTML = '&#9679; RECORDING';
}

const memeModeBannerEl = $('meme-mode-banner');
const memeOptNormal = $('meme-opt-normal');
const memeOpt1 = $('meme-opt-1');
const memeOpt2 = $('meme-opt-2');

function syncMemeMenuButtons() {
  [memeOptNormal, memeOpt1, memeOpt2].forEach(function (el) {
    if (!el) return;
    el.classList.remove('selected');
  });
  const map = { 0: memeOptNormal, 1: memeOpt1, 2: memeOpt2 };
  const sel = map[memePanelLayout];
  if (sel) sel.classList.add('selected');
}

function updateMemeModeBanner() {
  if (!memeModeBannerEl) return;
  if (memePanelLayout === 0) {
    memeModeBannerEl.textContent = '';
    memeModeBannerEl.style.display = 'none';
    return;
  }
  memeModeBannerEl.textContent =
    'Meme · ' +
    (memePanelLayout === 2 ? '2 panels' : '1 panel') +
    ' — hold PTT, speak idea';
  memeModeBannerEl.style.display = 'block';
}

async function sendMemeFromPrompt(raw) {
  const text = normalizeDiscordText(raw);
  if (!text || !currentChannel) {
    showToast('No speech for meme');
    return;
  }
  if (memeJobBusy) return;
  memeJobBusy = true;
  showLoading('Generating meme…');
  try {
    const result = await api('/channels/' + currentChannel.id + '/meme-generate', {
      method: 'POST',
      body: JSON.stringify(
        Object.assign(
          {
            prompt: text,
            panels: memePanelLayout,
          },
          shopDiscordUserPayload(),
        ),
      ),
    });
    if (result.message) appendMessage(result.message);
    showScreen('messages');
    appLog('info', 'Meme posted panels=' + memePanelLayout);
  } catch (e) {
    showToast(summarizeSendError(e));
  } finally {
    hideLoading();
    memeJobBusy = false;
  }
}

/** ScriptProcessor buffer (power-of-two). ~21 ms @ 48 kHz — steadier for Opus than 512; still far below old 4096. */
const VC_SCRIPTPROC_BUFFER = 1024;

function discordVoiceWsReady() {
  return ws && ws.readyState === 1;
}

function supportsAnyDiscordVcMicCapture() {
  try {
    if (
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    )
      return false;
    const A = window.AudioContext || window.webkitAudioContext;
    return !!(
      A && typeof A.prototype.createMediaStreamSource === 'function'
    );
  } catch (_) {
    return false;
  }
}

function pcmFloatMonoToVcBase64(input) {
  const n = input.length;
  const u8 = new Uint8Array(n * 2);
  const dv = new DataView(u8.buffer);
  /** Leave ~1–2 dBFS headroom before int16 quantization — avoids hard clipping bursts that Opus smears into “robot” tails. */
  const headroom = 0.92;
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, input[i] * headroom));
    const q = x < 0 ? x * 0x8000 : Math.min(32767, x * 32767);
    dv.setInt16(i * 2, q | 0, true);
  }
  try {
    return btoa(String.fromCharCode.apply(null, u8));
  } catch (_) {
    return '';
  }
}

function sendVcPcmBlobFromFloat32Mono(f32) {
  if (!discordVcTransmitting || recordingMode !== 'discord_vc' || !joinedDiscordVoiceId)
    return;
  if (!discordVoiceWsReady()) return;
  const chunk = pcmFloatMonoToVcBase64(f32);
  if (!chunk) return;
  try {
    ws.send(JSON.stringify({ type: 'vc_pcm', d: chunk }));
  } catch (_) {}
}

function ensureVcDiscordWorkletBlobUrl() {
  const src =
    'class R1VcPcm extends AudioWorkletProcessor{' +
    'process(inputs,outputs){' +
    'var i0=inputs[0];var o0=outputs[0];' +
    'if(!i0||!o0)return true;var ch=i0[0];var och=o0[0];' +
    'if(!ch||!och||ch.length!==och.length)return true;' +
    'och.set(ch);' +
    'var buf=new Float32Array(ch.length);buf.set(ch);' +
    'this.port.postMessage(buf.buffer,[buf.buffer]);' +
    'return true}' +
    '}registerProcessor("r1_vc_pcm",R1VcPcm);';
  if (!vcDiscordWorkletBlobUrl) {
    vcDiscordWorkletBlobUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
  }
  return vcDiscordWorkletBlobUrl;
}

function resetDiscordVcRecordingUi() {
  discordVcTransmitting = false;
  isRecording = false;
  recordingMode = null;
  recIndicator.classList.remove('active');
  setDefaultRecordingLabel();
  renderDiscordVoiceSpeakingStrip();
}

function toggleMenuLeaveVoiceButton() {
  const el = $('menu-leave-voice-btn');
  if (!el) return;
  el.classList.toggle('meme-opt-hidden', !joinedDiscordVoiceId);
}

function clearVcSpeakingUi() {
  vcRemoteSpeakerNames.clear();
  vcRemoteSpeakingIds.clear();
  const strip = $('discord-voice-speaking');
  if (strip) {
    strip.textContent = '';
    strip.classList.remove('discord-voice-line--speakers-on');
  }
}

function renderDiscordVoiceSpeakingStrip() {
  const strip = $('discord-voice-speaking');
  if (!strip || !joinedDiscordVoiceId) return;
  const localMic =
    discordVcTransmitting && recordingMode === 'discord_vc';
  const hasRemote = vcRemoteSpeakingIds.size > 0;
  if (!localMic && !hasRemote) {
    strip.textContent = '';
    strip.classList.remove('discord-voice-line--speakers-on');
    return;
  }
  strip.classList.add('discord-voice-line--speakers-on');
  strip.textContent = '';
  strip.appendChild(document.createTextNode('Speaking: '));
  let first = true;
  if (localMic) {
    const dot = document.createElement('span');
    dot.className = 'vc-speak-dot';
    dot.setAttribute('aria-hidden', 'true');
    strip.appendChild(dot);
    strip.appendChild(document.createTextNode(VC_LOCAL_MIC_LABEL));
    first = false;
  }
  vcRemoteSpeakingIds.forEach(function (uid) {
    if (!first) strip.appendChild(document.createTextNode(', '));
    first = false;
    const dot = document.createElement('span');
    dot.className = 'vc-speak-dot';
    dot.setAttribute('aria-hidden', 'true');
    strip.appendChild(dot);
    const lab = vcRemoteSpeakerNames.get(uid) || uid.slice(0, 8);
    strip.appendChild(document.createTextNode(lab));
  });
}

function dispatchVcSpeakWsMessage(data) {
  if (!joinedDiscordVoiceId || !data || data.type !== 'vc_speak') return;
  const uid = String(data.u || '');
  if (!uid) return;
  if (data.on) {
    const nm = String(data.nm || '').trim();
    if (nm) vcRemoteSpeakerNames.set(uid, nm);
    vcRemoteSpeakingIds.add(uid);
  } else {
    vcRemoteSpeakingIds.delete(uid);
  }
  renderDiscordVoiceSpeakingStrip();
}

function updateDiscordVoiceBanner() {
  const wrap = $('discord-voice-wrap');
  const el = $('discord-voice-banner');
  if (!wrap || !el) return;
  if (!joinedDiscordVoiceId) {
    wrap.classList.remove('discord-voice-wrap--visible');
    el.textContent = '';
    clearVcSpeakingUi();
    return;
  }
  wrap.classList.add('discord-voice-wrap--visible');
  el.textContent =
    'Discord voice: 🎙 ' +
    joinedDiscordVoiceName +
    ' · hold PTT to talk · speakers on';
  renderDiscordVoiceSpeakingStrip();
}

function teardownDiscordVcHard() {
  if (vcDiscordTeardownTimer != null) {
    try {
      window.clearTimeout(vcDiscordTeardownTimer);
    } catch (_) {}
    vcDiscordTeardownTimer = null;
  }
  try {
    vcDiscordWorkletNode?.disconnect();
    vcDiscordProcessor?.disconnect();
    vcDiscordSource?.disconnect();
    vcDiscordMuteGain?.disconnect();
    vcDiscordSilentSinkDest?.disconnect();
  } catch (_) {}
  vcDiscordWorkletNode = null;
  vcDiscordProcessor = null;
  vcDiscordSource = null;
  vcDiscordMuteGain = null;
  vcDiscordSilentSinkDest = null;
  try {
    if (vcDiscordWorkletBlobUrl) {
      URL.revokeObjectURL(vcDiscordWorkletBlobUrl);
    }
  } catch (_) {}
  vcDiscordWorkletBlobUrl = '';
  try {
    if (vcDiscordAudioCtx) vcDiscordAudioCtx.close().catch(function () {});
  } catch (_) {}
  vcDiscordAudioCtx = null;
}

function stopVcDiscordMicTracks() {
  if (!vcDiscordMicStream) return;
  vcDiscordMicStream.getTracks().forEach(function (t) {
    try {
      t.stop();
    } catch (_) {}
  });
  vcDiscordMicStream = null;
}

async function silentDiscordVoiceDisconnect() {
  discordVcTransmitting = false;
  teardownDiscordVcHard();
  stopVcDiscordMicTracks();
  try {
    await api('/voice/leave', { method: 'POST' });
  } catch (_) {}
  joinedDiscordVoiceId = '';
  joinedDiscordVoiceName = '';
  teardownVcInboundPlayback();
  updateDiscordVoiceBanner();
  toggleMenuLeaveVoiceButton();
}

async function refreshVoiceJoinState() {
  try {
    const st = await api('/voice/status');
    if (st && st.joined && st.channelId) {
      joinedDiscordVoiceId = String(st.channelId);
      joinedDiscordVoiceName = String(st.channelName || '');
    } else {
      joinedDiscordVoiceId = '';
      joinedDiscordVoiceName = '';
      teardownVcInboundPlayback();
    }
  } catch (_) {
    joinedDiscordVoiceId = '';
    joinedDiscordVoiceName = '';
    teardownVcInboundPlayback();
  }
  updateDiscordVoiceBanner();
  toggleMenuLeaveVoiceButton();
}

async function joinDiscordVoiceFromClient(ch) {
  if (!ch || ch.kind !== 'voice') return;
  showLoading('Voice…');
  try {
    const r = await api('/voice/join', {
      method: 'POST',
      body: JSON.stringify({ channelId: ch.id }),
    });
    joinedDiscordVoiceId = r.channelId ? String(r.channelId) : String(ch.id);
    joinedDiscordVoiceName = r.name || ch.name || joinedDiscordVoiceId;
    updateDiscordVoiceBanner();
    toggleMenuLeaveVoiceButton();
    try {
      ensureVcInboundContext();
      void ensureVcListenMixer();
    } catch (_) {}
    showToast('Joined 🎙 ' + joinedDiscordVoiceName, 2800);
    showScreen('messages');
    if (!currentChannel) {
      $('channel-title').textContent = '🎙 ' + joinedDiscordVoiceName + ' · pick #text';
    }
    appLog('info', 'Discord VC joined ' + joinedDiscordVoiceId);
  } catch (e) {
    showToast(summarizeSendError(e));
  } finally {
    hideLoading();
  }
}

async function leaveDiscordVoiceClient() {
  showLoading('Leaving…');
  try {
    await silentDiscordVoiceDisconnect();
    showToast('Left voice');
  } finally {
    hideLoading();
  }
}

function sendDiscordVcEndPacket() {
  if (!discordVoiceWsReady()) return;
  try {
    ws.send(JSON.stringify({ type: 'vc_end' }));
  } catch (_) {}
}

function startDiscordVcPcmPush() {
  if (!joinedDiscordVoiceId || !discordVoiceWsReady()) {
    showToast('Voice: wait for WebSocket');
    appLog('warn', 'VC PTT: WS not open');
    return;
  }
  if (!supportsAnyDiscordVcMicCapture()) {
    showToast('Voice needs mic permission + Web Audio');
    appLog('warn', 'VC PTT: getUserMedia/AudioContext missing');
    return;
  }

  discordVcTransmitting = true;
  isRecording = true;
  recordingMode = 'discord_vc';
  recIndicator.innerHTML = '&#9679; VC';
  recIndicator.classList.add('active');

  if (vcDiscordTeardownTimer != null) {
    try {
      window.clearTimeout(vcDiscordTeardownTimer);
    } catch (_) {}
    vcDiscordTeardownTimer = null;
  }

  teardownDiscordVcHard();

  try {
    vcDiscordAudioCtx = new (window.AudioContext ||
      window.webkitAudioContext)({ latencyHint: 'interactive' });
    void vcDiscordAudioCtx.resume();
  } catch (e) {
    appLog('warn', 'AudioContext ' + (e.message || String(e)));
    showToast('Audio not supported');
    resetDiscordVcRecordingUi();
    return;
  }

  navigator.mediaDevices
    .getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
      },
    })
    .then(function (stream) {
      if (!discordVcTransmitting || recordingMode !== 'discord_vc') {
        stream.getTracks().forEach(function (t) {
          try {
            t.stop();
          } catch (_) {}
        });
        return;
      }
      void runDiscordVcAudioGraph(stream);
    })
    .catch(function (e) {
      appLog('warn', 'Discord VC mic ' + (e.message || String(e)));
      showToast('Mic permission denied');
      resetDiscordVcRecordingUi();
      teardownDiscordVcHard();
      stopVcDiscordMicTracks();
    });
}

async function runDiscordVcAudioGraph(stream) {
  if (!discordVcTransmitting || recordingMode !== 'discord_vc') {
    stream.getTracks().forEach(function (t) {
      try {
        t.stop();
      } catch (_) {}
    });
    return;
  }
  vcDiscordMicStream = stream;
  try {
    if (!vcDiscordAudioCtx) {
      vcDiscordAudioCtx = new (window.AudioContext ||
        window.webkitAudioContext)({ latencyHint: 'interactive' });
    }
    await vcDiscordAudioCtx.resume();

    try {
      ws.send(
        JSON.stringify({
          type: 'vc_start',
          channelId: joinedDiscordVoiceId,
          sr: vcDiscordAudioCtx.sampleRate,
        }),
      );
      appLog(
        'info',
        'VC stream start sr=' + vcDiscordAudioCtx.sampleRate + ' (before graph)',
      );
    } catch (e2) {
      appLog('warn', 'vc_start ' + (e2 && e2.message));
    }

    vcDiscordSource = vcDiscordAudioCtx.createMediaStreamSource(stream);
    vcDiscordMuteGain = vcDiscordAudioCtx.createGain();
    vcDiscordMuteGain.gain.value = 1;
    vcDiscordSilentSinkDest = vcDiscordAudioCtx.createMediaStreamDestination();

    let usedWorklet = false;
    const aw = vcDiscordAudioCtx.audioWorklet;
    if (aw && typeof aw.addModule === 'function') {
      try {
        await vcDiscordAudioCtx.audioWorklet.addModule(
          ensureVcDiscordWorkletBlobUrl(),
        );
        vcDiscordWorkletNode = new AudioWorkletNode(
          vcDiscordAudioCtx,
          'r1_vc_pcm',
          { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] },
        );
        vcDiscordWorkletNode.port.onmessage = function (ev) {
          const payload = ev.data;
          if (!payload) return;
          if (payload instanceof ArrayBuffer && payload.byteLength) {
            sendVcPcmBlobFromFloat32Mono(new Float32Array(payload));
            return;
          }
          if (
            ArrayBuffer.isView(payload) &&
            payload.BYTES_PER_ELEMENT === 4 &&
            payload.byteLength > 0
          ) {
            sendVcPcmBlobFromFloat32Mono(
              new Float32Array(
                payload.buffer,
                payload.byteOffset,
                payload.byteLength / 4,
              ),
            );
          }
        };
        vcDiscordSource.connect(vcDiscordWorkletNode);
        vcDiscordWorkletNode.connect(vcDiscordMuteGain);
        usedWorklet = true;
      } catch (we) {
        appLog(
          'warn',
          'AudioWorklet VC path failed: ' + (we.message || String(we)),
        );
      }
    }

    if (!usedWorklet) {
      if (typeof vcDiscordAudioCtx.createScriptProcessor !== 'function') {
        showToast('Mic streaming not supported here');
        resetDiscordVcRecordingUi();
        teardownDiscordVcHard();
        stopVcDiscordMicTracks();
        sendDiscordVcEndPacket();
        return;
      }
      vcDiscordProcessor = vcDiscordAudioCtx.createScriptProcessor(
        VC_SCRIPTPROC_BUFFER,
        1,
        1,
      );
      vcDiscordProcessor.onaudioprocess = function (ev) {
        sendVcPcmBlobFromFloat32Mono(ev.inputBuffer.getChannelData(0));
      };
      vcDiscordSource.connect(vcDiscordProcessor);
      vcDiscordProcessor.connect(vcDiscordMuteGain);
    }

    vcDiscordMuteGain.connect(vcDiscordSilentSinkDest);
    renderDiscordVoiceSpeakingStrip();
  } catch (e) {
    appLog('warn', 'Discord VC graph ' + (e.message || String(e)));
    showToast('Audio graph failed');
    resetDiscordVcRecordingUi();
    teardownDiscordVcHard();
    stopVcDiscordMicTracks();
    sendDiscordVcEndPacket();
  }
}

function finishDiscordVcPcmPush() {
  if (!discordVcTransmitting && recordingMode !== 'discord_vc') return;

  discordVcTransmitting = false;
  isRecording = false;
  recordingMode = null;

  sendDiscordVcEndPacket();

  renderDiscordVoiceSpeakingStrip();

  if (vcDiscordTeardownTimer != null) {
    try {
      window.clearTimeout(vcDiscordTeardownTimer);
    } catch (_) {}
    vcDiscordTeardownTimer = null;
  }

  vcDiscordTeardownTimer = window.setTimeout(function () {
    vcDiscordTeardownTimer = null;
    teardownDiscordVcHard();
    stopVcDiscordMicTracks();
    recIndicator.classList.remove('active');
    setDefaultRecordingLabel();
    appLog('info', 'Discord VC transmit end');
  }, 160);
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

/** Avoid throwing if Rabbit WebView caches an older index.html missing newer chrome (e.g. shop screen). */
function setScreenActive(screenId, on) {
  const el = document.getElementById(screenId);
  if (!el) return;
  el.classList.toggle('active', Boolean(on));
}

function showScreen(name) {
  currentScreen = name;
  setScreenActive('screen-guilds', name === 'guilds');
  setScreenActive('screen-channels', name === 'channels');
  setScreenActive('screen-messages', name === 'messages');
  setScreenActive('screen-compose', name === 'compose');
  setScreenActive('screen-mention', name === 'mention');
  setScreenActive('screen-log', name === 'log');
  setScreenActive('screen-meme-menu', name === 'memeMenu');
  setScreenActive('screen-shop', name === 'shop');
  if (name === 'compose' && composeTA) setTimeout(() => composeTA.focus(), 50);
  if (name === 'mention' && memberSearchInput)
    setTimeout(() => memberSearchInput.focus(), 60);
  if (name === 'log') {
    requestAnimationFrame(() => {
      if (logListEl) logListEl.scrollTop = logListEl.scrollHeight;
    });
  }
  if (name === 'messages') {
    updateMemeModeBanner();
    updateDiscordVoiceBanner();
  }
  if (name === 'shop') void refreshRabbitShopUI();
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
      if (joinedDiscordVoiceId) {
        composeTA.value = text;
        showScreen('compose');
        appLog('info', 'STT → compose (joined VC)');
      } else if (memePanelLayout > 0) {
        void sendMemeFromPrompt(text);
        appLog('info', 'STT → meme (Creation)');
      } else {
        composeTA.value = text;
        showScreen('compose');
        appLog('info', 'STT transcript OK');
      }
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

/**
 * Minimal Discord-style inline markdown for bot embed excerpts.
 * Bold/italic/underline/strike/code render as black-ish via CSS; base text inherits embed-accent.
 */
function discordEmbedMarkdownToHtml(raw) {
  const codes = [];
  let s = String(raw ?? '').replace(/\r\n/g, '\n');

  s = s.replace(/`([^`]{0,400})`/g, function (_m, c) {
    codes.push(c);
    return '\x01C' + (codes.length - 1) + '\x02';
  });

  s = escapeHtml(s);

  function codeTokenToHtml(tok) {
    const m = String(tok).match(/^\x01C(\d+)\x02$/);
    if (!m) return tok;
    const inner = escapeHtml(codes[parseInt(m[1], 10)] ?? '');
    return '<code>' + inner + '</code>';
  }

  s = s.replace(/\x01C\d+\x02/g, codeTokenToHtml);

  s = s.replace(/\*\*([^*\n]{1,2000}?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~\n]{1,800}?)~~/g, '<s>$1</s>');
  s = s.replace(/__([^_\n]{1,800}?)__/g, '<u>$1</u>');
  s = s.replace(/\*([^*\n]{1,400}?)\*/g, '<em>$1</em>');

  return s.replace(/\n/g, '<br>');
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
    const lowRest = rest.toLowerCase();
    if (codePart === '401' && lowRest.includes('unauthorized'))
      return 'Shop secret rejected — bot RABBIT_SHOP_HUB_SECRET must equal Netlify RABBIT_SHOP_HUB_SECRET.';
    if (
      codePart === '503' &&
      (/hub_secret|disabled/i.test(lowRest) || /rabbit_shop/.test(lowRest))
    )
      return 'Shop hub unavailable (missing secret or disabled) — set RABBIT_SHOP_HUB_SECRET on Netlify + bot .env.';
    return rest ? codePart + ': ' + rest : codePart || m;
  }
  return m;
}

async function onGenreExploreClick() {
  genreBanner('');
  if (genreBtnBusy) return;

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
      body: JSON.stringify(Object.assign({ genre }, shopDiscordUserPayload())),
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

async function onMenuServerDashboardClick() {
  showScreen('messages');

  if (!currentChannel || currentChannel.kind !== 'text') {
    showToast('Open a #text channel first');
    appLog('warn', 'Dashboard skipped (no text channel)');
    return;
  }

  showLoading('Dashboard…');
  try {
    await api('/channels/' + currentChannel.id + '/server-dashboard', {
      method: 'POST',
      body: '{}',
    });
    showToast('Dashboard posted #' + currentChannel.name, 3200);
    appLog('info', 'Server dashboard embed posted');
  } catch (e) {
    showToast(summarizeSendError(e));
    appLog('error', 'Dashboard ' + summarizeSendError(e));
  } finally {
    hideLoading();
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

async function rabbitShopMutate(payload) {
  return api('/shop/action', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

let shopUiBusy = false;

/** @param {{ ok?:boolean, rabbitShopConfigured?:boolean, rabbitShopHubReachable?:boolean|null, hubReachNote?:string, hubHost?:string|null, hints?:string[] } | null | undefined} j */
function applyShopHubStatusFromJson(j) {
  const el = $('shop-hub-status-line');
  if (!el) return;
  if (!j || j.ok !== true) {
    el.textContent =
      'Could not load hub status — check tunnel / Netlify `_redirects` includes `/shop/status`.';
    el.className = 'shop-hint shop-hub-status shop-hub-status--warn';
    return;
  }
  const cfg = Boolean(j.rabbitShopConfigured);
  const reach = j.rabbitShopHubReachable;

  if (cfg && reach === true) {
    el.textContent = j.hubHost
      ? '🐰 Hub OK (bot → Netlify) · ' + j.hubHost
      : '🐰 Hub OK (bot → Netlify).';
    el.className = 'shop-hint shop-hub-status shop-hub-status--ok';
    return;
  }
  if (cfg && reach === false) {
    const tail = j.hubReachNote ? ' ' + String(j.hubReachNote).slice(0, 116) + (String(j.hubReachNote).length > 116 ? '…' : '') : '';
    el.textContent =
      '🐰 .env looks configured, but this bot failed to reach the Netlify hub.' + tail;
    el.className = 'shop-hint shop-hub-status shop-hub-status--warn';
    return;
  }
  if (!cfg) {
    const h = Array.isArray(j.hints) && j.hints[0] ? String(j.hints[0]) : '';
    el.textContent =
      (h.length > 170 ? h.slice(0, 167) + '…' : h) ||
      'Bot host: set `RABBIT_SHOP_NETLIFY_HOST` (or full `RABBIT_SHOP_HUB_URL`) plus `SHOP_HUB_SECRET`.';
    el.className = 'shop-hint shop-hub-status shop-hub-status--warn';
    return;
  }
  /** Configured but reach not probed (no GUILD_IDS on bot). */
  el.textContent = j.hubHost
    ? '🐰 Credentials on bot · ' + j.hubHost + ' · reachability unknown (add GUILD_IDS to probe)'
    : '🐰 Credentials on bot · reachability unknown (add GUILD_IDS to probe)';
  el.className = 'shop-hint shop-hub-status shop-hub-status--ok';
}

async function pingShopHubBanner() {
  applyShopHubStatusFromJson(await api('/shop/status').catch(() => null));
}

/** Explain catalog failure separately from banner (Creations travels Netlify→tunnel→bot→hub). */
function rabbitShopCatalogFailLine(statusPack, pack) {
  if (pack && pack.error) return String(pack.error);
  if (
    statusPack &&
    statusPack.ok === true &&
    statusPack.rabbitShopHubReachable === true &&
    (pack == null || typeof pack.ok === 'undefined')
  ) {
    return (
      '/shop/catalog failed in the Netlify proxy path while the hub answers the bot.' +
      ' Set Netlify `R1_DISCORD_BACKEND_URL` to this bot\'s HTTPS URL (matches `BACKEND_PUBLIC_URL`/tunnel)' +
      ' and redeploy so `_redirects` includes `/shop/catalog`.'
    );
  }
  return 'Shop hub unreachable — configure rabbit shop on the bot host, restart it, redeploy Netlify.';
}

async function populateShopSlashPicklist() {
  const dl = $('shop-slash-datalist');
  if (!dl) return;
  const gid = currentGuild && currentGuild.id;
  if (!gid) {
    dl.innerHTML = '';
    return;
  }
  try {
    const j = await api(
      '/guilds/' + encodeURIComponent(gid) + '/slash-commands',
    ).catch(() => null);
    if (!j || !j.ok || !Array.isArray(j.commands)) {
      dl.innerHTML = '';
      return;
    }
    dl.innerHTML = j.commands
      .map(function (c) {
        return '<option value="' + escapeHtml(c.name) + '">';
      })
      .join('');
  } catch (_) {
    dl.innerHTML = '';
  }
}

async function refreshRabbitShopUI() {
  const balEl = $('shop-balance-line');
  const mount = $('shop-list-mount');
  if (!mount || !balEl) return;
  mount.innerHTML = '';

  const gid = currentGuild?.id || '';
  if (!gid || !currentGuild) {
    balEl.textContent = 'Pick a Discord server tab first.';
    void pingShopHubBanner();
    return;
  }

  let url = `/shop/catalog?guild=${encodeURIComponent(gid)}`;
  const uid = getShopDiscordUserId().trim();
  if (/^\d{17,21}$/.test(uid)) url += '&user=' + encodeURIComponent(uid);
  shopUiBusy = true;
  try {
    const [statusPack, , pack] = await Promise.all([
      api('/shop/status').catch(() => null),
      populateShopSlashPicklist(),
      api(url).catch(() => null),
    ]);
    applyShopHubStatusFromJson(statusPack);

    if (!pack || !pack.ok) {
      balEl.textContent = rabbitShopCatalogFailLine(statusPack, pack);
      mount.innerHTML = '<div class="shop-hint">See shop/README.md in the repo.</div>';
      return;
    }

    balEl.textContent = /^\d{17,21}$/.test(uid)
      ? '🐰 Balance: **' + String(pack.balance != null ? pack.balance : '…') + '** rabbit heads (shared)'
      : 'Save your Discord user ID below to view balance + unlock buys/offers.';
    renderRabbitShopListings(mount, pack.listings || [], pack.offers || []);
  } finally {
    shopUiBusy = false;
  }
}

function renderRabbitShopListings(mount, listings, offers) {
  const uid = getShopDiscordUserId().trim();
  const meOk = /^\d{17,21}$/.test(uid);
  const sellersByListing = {};
  listings.forEach(function (Lx) {
    sellersByListing[Lx.id] = Lx.sellerId;
  });

  let html = '<div class="shop-hint"><strong>Listings</strong> · ' + listings.length + '</div>';
  if (!listings.length) html += '<div class="shop-hint">No active listings.</div>';

  listings.forEach(function (L) {
    html += '<div class="shop-card">';
    html += '<div class="shop-card-title">' + escapeHtml(String(L.title || L.commandKey)) + '</div>';
    html +=
      '<div class="shop-card-meta"><code>' +
      escapeHtml(String(L.commandKey || '')) +
      '</code> · seller …' +
      escapeHtml(String(L.sellerId || '').slice(-6)) +
      (L.price != null ? ' · <strong>' + escapeHtml(String(L.price)) + '</strong> 🐰' : '') +
      '</div>';
    if (L.description) {
      html += '<div class="shop-card-meta">' + escapeHtml(String(L.description).slice(0, 420)) + '</div>';
    }
    if (meOk && L.id) {
      if (uid === String(L.sellerId || '')) {
        html +=
          '<button type="button" class="shop-mini-btn" data-delete-listing="' +
          escapeHtml(String(L.id)) +
          '">Remove</button>';
      } else {
        html +=
          '<button type="button" class="shop-mini-btn" data-buy-listing="' +
          escapeHtml(String(L.id)) +
          '">Buy</button>';
      }
    }
    html += '</div>';
  });

  html += '<div class="shop-hint"><strong>Open offers</strong> · ' + offers.length + '</div>';
  if (!offers.length) html += '<div class="shop-hint">Nobody is bidding.</div>';

  offers.forEach(function (o) {
    const sellerId = sellersByListing[o.listingId];
    const isBuyer = meOk && uid === o.fromUserId;
    const isSeller = meOk && sellerId && sellerId === uid;
    html += '<div class="shop-card">';
    html +=
      '<div class="shop-card-meta">Bid <strong>' +
      escapeHtml(String(o.bidPrice)) +
      '</strong> 🐰 · listing ' +
      escapeHtml(String(o.listingId || '').slice(0, 8)) +
      '…</div>';
    if (isBuyer) {
      html +=
        '<button type="button" class="shop-mini-btn" data-offer-withdraw="' +
        escapeHtml(String(o.id || '')) +
        '">Withdraw</button>';
    }
    if (isSeller && sellerId) {
      html +=
        '<button type="button" class="shop-mini-btn" data-offer-accept="' +
        escapeHtml(String(o.id || '')) +
        '" data-offer-seller="' +
        escapeHtml(String(sellerId)) +
        '">Accept bid</button>';
    }
    html += '</div>';
  });

  mount.innerHTML = html;
}

function installShopDelegates() {
  const mount = $('shop-list-mount');
  if (!mount || mount.dataset.delegBound === '1') return;
  mount.dataset.delegBound = '1';

  mount.addEventListener(
    'click',
    async function (ev) {
      const btn = ev.target && ev.target.closest && ev.target.closest('button.shop-mini-btn');
      if (!btn || shopUiBusy) return;

      ev.preventDefault();
      const buyerId = getShopDiscordUserId().trim();
      if (!/^\d{17,21}$/.test(buyerId)) {
        showToast('Set & save Discord user ID above');
        return;
      }

      try {
        if (btn.dataset.buyListing) {
          await rabbitShopMutate({
            action: 'buy_listing',
            listingId: btn.dataset.buyListing,
            buyerId,
          });
          showToast('Purchased ✅');
        } else if (btn.dataset.deleteListing) {
          await rabbitShopMutate({
            action: 'delete_listing',
            listingId: btn.dataset.deleteListing,
            sellerId: buyerId,
          });
          showToast('Listing removed');
        } else if (btn.dataset.offerWithdraw) {
          await rabbitShopMutate({
            action: 'withdraw_offer',
            offerId: btn.dataset.offerWithdraw,
            fromUserId: buyerId,
          });
          showToast('Withdrawn bid');
        } else if (btn.dataset.offerAccept) {
          const sellerId =
            btn.dataset.offerSeller ||
            buyerId ||
            '';

          await rabbitShopMutate({
            action: 'accept_offer',
            offerId: btn.dataset.offerAccept,
            sellerId,
          });
          showToast('Offer accepted ✅');
        }
      } catch (err) {
        showToast(summarizeSendError(err));
      }
      await refreshRabbitShopUI();
    },
    false,
  );
}

async function rabbitShopPublishListing() {
  const gid = currentGuild?.id;
  if (!gid) {
    showToast('Open a guild first');
    return;
  }
  const sellerId = getShopDiscordUserId().trim();
  if (!/^\d{17,21}$/.test(sellerId)) {
    showToast('Save your Discord ID first');
    return;
  }
  const commandKey = String($('shop-li-cmd').value || '')
    .trim()
    .replace(/^\/+/, '')
    .toLowerCase();

  const slug = commandKey.trim();
  if (
    slug.length > 96 ||
    !/^[\w-]+(?: [\w-]+)*$/.test(slug)
  ) {
    showToast('Command SKU: word segments (a-z 0-9 _ -) separated by spaces, ≤96 chars');
    return;
  }
  const title = String($('shop-li-title').value || '').trim();
  let price = Math.floor(Number(String($('shop-li-price').value || '').trim()));
  const ends = String($('shop-li-ends').value || '').trim();
  const description = String($('shop-li-desc').value || '').trim();

  if (!title || !(price >= 1)) {
    showToast('title & price ≥1 required');
    return;
  }

  const body = {
    action: 'create_listing',
    guildId: gid,
    sellerId,
    commandKey,
    title,
    price,
    description: description || '',
  };

  const t = ends ? Date.parse(ends) : NaN;
  if (Number.isFinite(t)) body.listingEndsAt = new Date(t).toISOString();

  await rabbitShopMutate(body);
}

async function rabbitShopSubmitOfferFromForm() {
  const listingId = String($('shop-off-list-id').value || '').trim();
  let bidPrice = Math.floor(Number(String($('shop-off-price').value || '').trim()));
  const expires = String($('shop-off-ends').value || '').trim();
  const note = String($('shop-off-note').value || '').trim();
  const fromUserId = getShopDiscordUserId().trim();

  if (!/^\d{17,21}$/.test(fromUserId)) {
    showToast('Save Discord ID first');
    return;
  }
  if (!listingId || !(bidPrice >= 1) || !expires) {
    showToast('listing UUID, bid price & expiry required');
    return;
  }

  const texp = Date.parse(expires);
  if (!Number.isFinite(texp) || new Date(texp).getTime() <= Date.now()) {
    showToast('Offer must end in the future');
    return;
  }

  await rabbitShopMutate({
    action: 'make_offer',
    listingId,
    fromUserId,
    bidPrice,
    note: note || '',
    offerEndsAt: new Date(texp).toISOString(),
  });
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
    const labelText = ch.kind === 'voice' ? '🎙 ' + ch.name : '#' + ch.name;
    html +=
      '<div class="channel-item' +
      (i === selectedIdx ? ' selected' : '') +
      '" data-idx="' +
      i +
      '">' +
      escapeHtml(labelText) +
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
  const embedCard = Boolean(m.embedCard);
  const rawContent = String(m.content || '').replace(/\u200b/g, '').trim();
  let textBodyInner = '';
  if (voiceUrl) {
    textBodyInner = rawContent ? (embedCard ? discordEmbedMarkdownToHtml(rawContent) : escapeHtml(rawContent)) : '';
  } else if (m.hasAudio) {
    textBodyInner = '🎤 Voice message';
  } else {
    const body = rawContent || String(m.content || '');
    textBodyInner = embedCard ? discordEmbedMarkdownToHtml(body) : escapeHtml(body);
  }

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
    voiceUrl && !textBodyInner ? `<div class="voice-label">Voice</div>` : '';
  const bubbleKind = `${m.isOwn ? ' own' : ''}${embedCard ? ' embed-card' : ''}${hasImgs ? ' has-photo' : ''}`;
  return (
    `<div class="message-bubble${bubbleKind}" data-message-id="${escapeHtml(m.id)}">` +
    (m.isOwn ? '' : `<div class="message-author">${escapeHtml(m.author)}</div>`) +
    voiceLabel +
    (textBodyInner ? `<div class="message-body">${textBodyInner}</div>` : '') +
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
  await silentDiscordVoiceDisconnect();
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
  if (!ch || ch.kind === 'voice') return;
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
      body: JSON.stringify(Object.assign({ content }, shopDiscordUserPayload())),
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
    const shopId = getShopDiscordUserId().trim();
    if (/^\d{17,21}$/.test(shopId)) fd.append('shopDiscordUser', shopId);

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

function buildWebSocketUrl() {
  const q = TOKEN ? '?token=' + encodeURIComponent(TOKEN) : '';
  if (
    useNetlifyDiscordProxy &&
    isNetlifyHost() &&
    !wsFallbackToTunnelWs
  ) {
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    return wsProto + '://' + location.host + '/ws' + q;
  }
  const bare = stripUrl(BACKEND);
  const proto = bare.startsWith('https') ? 'wss' : 'ws';
  const host = bare.replace(/^https?:\/\//, '');
  return `${proto}://${host}/ws${q}`;
}

function connectWS() {
  const url = buildWebSocketUrl();
  if (useNetlifyDiscordProxy && isNetlifyHost() && !wsFallbackToTunnelWs) {
    appLog('info', 'WebSocket connecting wss via site /ws rewrite');
  } else {
    appLog(
      'info',
      'WebSocket connecting tunnel ' +
        stripUrl(BACKEND).replace(/^https?:\/\//, '') +
        '/ws',
    );
  }
  ws = new WebSocket(url);
  ws.onopen = function () {
    wsHandshakeEverSucceeded = true;
    wsReconnectDelay = 1000;
    appLog('info', 'WebSocket OK');
    vcRemoteSpeakingIds.clear();
    void refreshVoiceJoinState();
  };
  ws.onmessage = function (e) {
    try {
      const data = JSON.parse(e.data);
      dispatchVcSpeakWsMessage(data);
      dispatchVcListenWsMessage(data);
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
    if (
      useNetlifyDiscordProxy &&
      isNetlifyHost() &&
      !wsFallbackToTunnelWs &&
      !wsHandshakeEverSucceeded
    ) {
      wsFallbackToTunnelWs = true;
      appLog('warn', 'WebSocket same-origin handshake failed → tunnel WS');
      wsReconnectDelay = 1000;
      setTimeout(connectWS, 300);
      return;
    }
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
  if (isRecording) return;

  /** When bot is in a voice channel, side button PTT sends mic PCM over WS to the bot. */
  const wantsDiscordVc = Boolean(joinedDiscordVoiceId);

  if (wantsDiscordVc) {
    if (!discordVoiceWsReady()) {
      showToast('Voice: wait for WS — check Log (WebSocket OK)');
      appLog(
        'warn',
        'VC PTT blocked: WS not open (rs=' +
          (ws ? String(ws.readyState) : 'no') +
          ')',
      );
      return;
    }
    if (!supportsAnyDiscordVcMicCapture()) {
      showToast('Voice: mic/Web Audio unavailable');
      return;
    }
    startDiscordVcPcmPush();
    return;
  }

  if (!currentChannel) return;

  const memeSpeechMode =
    memePanelLayout > 0 &&
    currentScreen === 'messages' &&
    !joinedDiscordVoiceId;

  if (!memeSpeechMode && supportsMediaRecorderPtt()) {
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
  if (recordingMode === 'discord_vc') {
    finishDiscordVcPcmPush();
    return;
  }

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
      if (joinedDiscordVoiceId) {
        composeTA.value = text;
        showScreen('compose');
        appLog('info', 'STT → compose (joined VC)');
      } else if (memePanelLayout > 0) {
        void sendMemeFromPrompt(text);
      } else {
        composeTA.value = text;
        showScreen('compose');
        appLog('info', 'STT → compose');
      }
    } else {
      showToast('No speech detected');
    }
  }
}

window.addEventListener('scrollUp', function () {
  if (currentScreen === 'compose' || currentScreen === 'memeMenu') return;
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
  if (currentScreen === 'compose' || currentScreen === 'memeMenu') return;
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
  if (
    currentScreen === 'compose' ||
    currentScreen === 'log' ||
    currentScreen === 'memeMenu'
  )
    return;
  if (currentScreen === 'guilds' && guilds[selectedIdx]) {
    openGuild(guilds[selectedIdx]);
  } else if (currentScreen === 'channels' && channels[selectedIdx]) {
    const chx = channels[selectedIdx];
    if (chx.kind === 'voice') void joinDiscordVoiceFromClient(chx);
    else openChannel(chx);
  } else if (currentScreen === 'mention' && mentionMembers[mentionSelectedIdx]) {
    confirmMentionPick();
  } else if (currentScreen === 'messages') {
    void startVoicePtt();
  }
});

window.addEventListener('longPressEnd', function () {
  if (
    isRecording &&
    (recordingMode === 'discord_vc' || currentScreen === 'messages')
  )
    void stopVoicePtt();
});

document.addEventListener('keydown', function (e) {
  if (
    currentScreen === 'compose' ||
    currentScreen === 'log' ||
    currentScreen === 'mention' ||
    currentScreen === 'memeMenu'
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

$('meme-menu-btn').addEventListener('click', function () {
  if (!currentGuild) {
    showToast('Pick a server first');
    return;
  }
  syncMemeMenuButtons();
  toggleMenuLeaveVoiceButton();
  showScreen('memeMenu');
});

$('menu-genre-btn').addEventListener('click', function () {
  showScreen('messages');
  void onGenreExploreClick();
});

const menuServerDashboardBtn = $('menu-server-dashboard-btn');
if (menuServerDashboardBtn) {
  menuServerDashboardBtn.addEventListener('click', function () {
    void onMenuServerDashboardClick();
  });
}

const menuRabbitShopBtn = $('menu-rabbit-shop-btn');
if (menuRabbitShopBtn) {
  menuRabbitShopBtn.addEventListener('click', function () {
    if (!currentGuild) {
      showToast('Pick a server first');
      return;
    }
    const si = $('shop-discord-input');
    if (si) si.value = getShopDiscordUserId();
    showScreen('shop');
  });
}

const shopBackBtn = $('shop-back-btn');
if (shopBackBtn)
  shopBackBtn.addEventListener('click', function () {
    showScreen('memeMenu');
    syncMemeMenuButtons();
    toggleMenuLeaveVoiceButton();
  });

const shopRefreshBtn = $('shop-refresh-btn');
if (shopRefreshBtn) shopRefreshBtn.addEventListener('click', () => void refreshRabbitShopUI());

const shopDiscordInputEl = $('shop-discord-input');
if (shopDiscordInputEl)
  shopDiscordInputEl.addEventListener('blur', function () {
    persistShopDiscordUserId(shopDiscordInputEl.value || '');
    void refreshRabbitShopUI();
  });

const shopPublishBtn = $('shop-publish-btn');
if (shopPublishBtn)
  shopPublishBtn.addEventListener('click', function () {
    void (async function () {
      showLoading('Listing…');
      try {
        await rabbitShopPublishListing();
        showToast('Listing live ✅');
        await refreshRabbitShopUI();
      } catch (e) {
        showToast(summarizeSendError(e));
      } finally {
        hideLoading();
      }
    })();
  });

const shopOfferBtn = $('shop-off-submit-btn');
if (shopOfferBtn)
  shopOfferBtn.addEventListener('click', function () {
    void (async function () {
      showLoading('Submitting bid…');
      try {
        await rabbitShopSubmitOfferFromForm();
        showToast('Offer recorded ✅');
        await refreshRabbitShopUI();
      } catch (e) {
        showToast(summarizeSendError(e));
      } finally {
        hideLoading();
      }
    })();
  });

$('menu-leave-voice-btn').addEventListener('click', function () {
  void leaveDiscordVoiceClient();
});

$('meme-menu-back').addEventListener('click', function () {
  showScreen('messages');
});

function setMemeLayout(n) {
  memePanelLayout = n;
  syncMemeMenuButtons();
  updateMemeModeBanner();
  showScreen('messages');
}

if (memeOptNormal)
  memeOptNormal.addEventListener('click', function () {
    setMemeLayout(0);
  });
if (memeOpt1)
  memeOpt1.addEventListener('click', function () {
    setMemeLayout(1);
  });
if (memeOpt2)
  memeOpt2.addEventListener('click', function () {
    setMemeLayout(2);
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
    renderChannelList();
    const chi = channels[idx];
    if (chi.kind === 'voice') void joinDiscordVoiceFromClient(chi);
    else openChannel(chi);
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
  appLog(
    'info',
    useNetlifyDiscordProxy && isNetlifyHost()
      ? 'WS: tries site /ws proxy → fallback tunnel (' +
          stripUrl(BACKEND).replace(/^https?:\/\//, '') +
          ')'
      : 'WS: tunnel ' + stripUrl(BACKEND),
  );
  appLog('info', 'Genre ' + resolvedGenreApiUrl);
  await loadGuilds();
  connectWS();
  installShopDelegates();
  syncMemeMenuButtons();
  updateMemeModeBanner();
  await refreshVoiceJoinState();
});
