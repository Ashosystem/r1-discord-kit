import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { existsSync, readFileSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from 'ffmpeg-static';
import {
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
  StreamType,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  ApplicationCommandOptionType,
} from 'discord.js';

const require = createRequire(import.meta.url);
/** Opus PCM decode only (no npm @discordjs/opus bindings). Used for Discord → browser listen path. */
const OpusScript = require('opusscript');

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

/** Installed bundle version from package.json (compare to upstream). */
let LOCAL_KIT_VERSION = '1.0.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
  LOCAL_KIT_VERSION = String(pkg.version || LOCAL_KIT_VERSION).trim();
} catch (_) {}

if (ffmpegInstaller) {
  ffmpeg.setFfmpegPath(ffmpegInstaller);
}

function inferVoiceInputExtFromMime(mimetype) {
  const m = String(mimetype || '').toLowerCase();
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mp4') || m.includes('mpeg4')) return 'm4a';
  if (m.includes('webm')) return 'webm';
  return 'webm';
}

async function transcodeVoiceBufferToMp3(buffer, mimetype) {
  const ext = inferVoiceInputExtFromMime(mimetype);
  const dir = await mkdtemp(join(tmpdir(), 'r1d-voice-'));
  const inPath = join(dir, `upload.${ext}`);
  const outPath = join(dir, 'voice.mp3');
  await writeFile(inPath, buffer);
  await new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .outputOptions('-vn')
      .audioCodec('libmp3lame')
      .audioBitrate(128)
      .format('mp3')
      .on('end', resolve)
      .on('error', reject)
      .save(outPath);
  });
  const mp3Buf = await readFile(outPath);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  return mp3Buf;
}

const PORT       = process.env.PORT       || 3002;
const BOT_TOKEN  = process.env.BOT_TOKEN;
const AUTH_TOKEN = process.env.R1_AUTH_TOKEN || null;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || '';
/** Gemini model ID (Genre button copy + `/server-dashboard` changelog). Default: preview flash. */
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
/** Compare against this upstream repo for changelog summaries. Override with owner/repo slug. */
const KIT_REPO = (process.env.KIT_REPO || 'Ashosystem/r1-discord-kit').trim();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';

// Support GUILD_IDS (comma-separated) or legacy GUILD_ID
const GUILD_IDS = (process.env.GUILD_IDS || process.env.GUILD_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean);

/** Left-bar color for every message this bot posts (#e82734). */
const BOT_EMBED_COLOR = 0xe82734;

/**
 * Prefer full `RABBIT_SHOP_HUB_URL`; else derive from Netlify-ish host vars (no trailing path needed).
 * Accepts `mysite.netlify.app`, `https://mysite.netlify.app`, or short slug `mysite` → `mysite.netlify.app`.
 */
function resolveRabbitShopHubUrlFromEnv() {
  const explicit = String(process.env.RABBIT_SHOP_HUB_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (explicit && /^https:\/\//i.test(explicit)) return explicit;

  const hostRaw = String(
    process.env.RABBIT_SHOP_NETLIFY_HOST ||
      process.env.RABBIT_SHOP_SITE_HOST ||
      process.env.SHOP_NETLIFY_HOST ||
      '',
  ).trim();

  let host = hostRaw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\/+$/, '').toLowerCase();
  if (!host) return '';

  /** Single-label slug → default Netlify site hostname */
  if (!host.includes('.') && /^[\w-]{2,63}$/.test(host)) host = `${host}.netlify.app`;

  if (!/^[\w.-]+\.[a-z]{2,}$/i.test(host)) return '';

  return `https://${host}/.netlify/functions/rabbit-shop`;
}

/** Shared hub auth for mutations (`earn`, listings, buys). */
function resolveRabbitShopHubSecretFromEnv() {
  const a = String(process.env.RABBIT_SHOP_HUB_SECRET ?? '').trim();
  const b = String(process.env.SHOP_HUB_SECRET ?? '').trim();
  return a || b || '';
}

const RABBIT_SHOP_HUB_URL = resolveRabbitShopHubUrlFromEnv();
const RABBIT_SHOP_HUB_SECRET = resolveRabbitShopHubSecretFromEnv();

function isDiscordSnowflake(s) {
  return /^\d{17,21}$/.test(String(s ?? '').trim());
}

async function rabbitShopInvoke(payload) {
  if (!RABBIT_SHOP_HUB_URL || !/^https:\/\//i.test(RABBIT_SHOP_HUB_URL))
    throw new Error('rabbit_shop_hub_unconfigured');

  const res = await fetch(RABBIT_SHOP_HUB_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const rawBody = await res.text();
  let j = {};
  try {
    j = JSON.parse(rawBody || '{}');
  } catch (_) {
    j = {};
  }
  if (!res.ok || j.ok === false) {
    const apiErr =
      typeof j.error === 'string' && j.error.trim()
        ? j.error.trim()
        : `shop_http_${res.status}`;
    const hint =
      res.status >= 500 &&
      !(typeof j.error === 'string' && j.error.trim()) &&
      rawBody
        ? String(rawBody.replace(/\s+/g, ' ').trim()).slice(0, 140)
        : '';
    throw Object.assign(new Error(apiErr + (hint ? ` · ${hint}` : '')), {
      detail: j,
      status: res.status,
    });
  }
  return j;
}

async function rabbitShopPublic(payload) {
  return rabbitShopInvoke(payload);
}

async function rabbitShopPrivate(payloadWithoutSecret) {
  if (!RABBIT_SHOP_HUB_SECRET) throw new Error('rabbit_shop_hub_unconfigured');
  return rabbitShopInvoke({
    secret: RABBIT_SHOP_HUB_SECRET,
    ...payloadWithoutSecret,
  });
}

async function rabbitShopEarnEngagement(guildId, channelId, messageId, discordUserRaw, kind) {
  try {
    if (
      !guildId ||
      !channelId ||
      !messageId ||
      !RABBIT_SHOP_HUB_URL ||
      !RABBIT_SHOP_HUB_SECRET
    )
      return;
    const userId = String(discordUserRaw ?? '').trim();
    if (!isDiscordSnowflake(userId)) return;
    await rabbitShopPrivate({
      action: 'earn_engagement',
      userId,
      engagementKey: `${kind}:${guildId}:${channelId}:${messageId}`,
    }).catch(() => {});
  } catch (_) {}
}

function truncateShopField(text, max) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * SKU strings for Rabbit shop picker: root slash + `/group sub`-style nested commands when present.
 * @param {unknown} raw Discord API command payload
 */
function discordSlashLeavesForSku(raw) {
  if (!raw || typeof raw !== 'object') return [];
  if (Number(/** @type {{type?: number}} */ (raw).type ?? 1) !== 1) return [];
  const root = String(
    /** @type {{name?: string}} */ (raw).name ?? '',
  )
    .trim()
    .toLowerCase()
    .replace(/^\/+/, '');
  if (!/^[\w-]{1,32}$/.test(root)) return [];
  const desc = String(/** @type {{description?: string}} */ (raw).description ?? '')
    .trim()
    .slice(0, 200);
  const opts = Array.isArray(/** @type {{options?: unknown[]}} */ (raw).options)
    ? /** @type {{options: unknown[]}} */ (raw).options
    : [];
  const structural = opts.filter(o => {
    const t =
      typeof o === 'object' &&
      o &&
      /** @type {{type:number}} */ (/** @type {object} */ (o)).type;
    const n = Number(t);
    return (
      n === ApplicationCommandOptionType.Subcommand ||
      n === ApplicationCommandOptionType.SubcommandGroup
    );
  });
  if (!structural.length) return [{ name: root, description: desc }];

  /** @type {{ name:string, description:string }[]} */
  const out = [];

  /** @param {string} prefix @param {unknown[]} inner */
  function walk(prefix, inner) {
    for (const rawOpt of inner || []) {
      if (!rawOpt || typeof rawOpt !== 'object') continue;
      const opt = /** @type {{type:number,name?:string,options?:unknown[]}} */ (rawOpt);
      const seg = String(opt.name ?? '')
        .trim()
        .toLowerCase()
        .replace(/^\/+/, '');
      if (!/^[\w-]{1,32}$/.test(seg)) continue;
      if (opt.type === ApplicationCommandOptionType.SubcommandGroup) {
        walk(prefix + ' ' + seg, Array.isArray(opt.options) ? opt.options : []);
      } else if (opt.type === ApplicationCommandOptionType.Subcommand) {
        const path = (prefix + ' ' + seg).trim();
        const child = Array.isArray(opt.options) ? opt.options : [];
        const deep = child.filter(oObj => {
          if (!oObj || typeof oObj !== 'object') return false;
          const tn = Number(/** @type {{type:number}} */ (/** @type {object} */ (oObj)).type);
          return (
            tn === ApplicationCommandOptionType.Subcommand ||
            tn === ApplicationCommandOptionType.SubcommandGroup
          );
        });
        if (deep.length) walk(path, child);
        else out.push({ name: path, description: desc });
      }
    }
  }

  walk(root, structural);
  const seen = new Set();
  return out.filter((r) => {
    if (!r.name || seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });
}

/** Discord slash preview of shared hub listings/offers */
function buildRabbitShopEmbed(listingsPack, offersPack, guildTitle) {
  const listings = (listingsPack && listingsPack.listings) || [];
  const offers = (offersPack && offersPack.offers) || [];

  const embed = new EmbedBuilder()
    .setTitle('🐰 Rabbit command shop · ' + truncateShopField(guildTitle || 'this server', 190))
    .setColor(BOT_EMBED_COLOR)
    .setDescription(
      truncateShopField(
        'Shared economy balances + marketplace live on Netlify Blobs (`RABBIT_SHOP_HUB_URL`). Earn rabbit heads via R1 app actions whenever your Discord user id is bundled with Discord kit REST calls.',
        360,
      ),
    )
    .setTimestamp(new Date());

  let body = '';
  if (listings.length === 0) body += '*No active listings.*\n';
  else {
    body += listings.slice(0, 8).map((L, i) => {
      let ends = '';
      if (L.listingEndsAt) {
        const u = Math.floor(new Date(L.listingEndsAt).getTime() / 1000);
        if (Number.isFinite(u)) ends = `\n└ ends <t:${u}:R>`;
      }
      return (
        `**${i + 1}.** \`${truncateShopField(L.commandKey, 40)}\` — **${L.price}** 🐰\n` +
        `└ *${truncateShopField(L.title, 160)}*` +
        ends
      );
    }).join('\n');
  }

  embed.addFields({
    name: '📦 Commands for sale',
    value: truncateShopField(body || '—', 1024),
    inline: false,
  });

  let ob = '';
  if (offers.length === 0) ob += '*No open bids.*';
  else {
    ob = offers
      .slice(0, 6)
      .map((o, i) => {
        const u = Math.floor(new Date(o.offerEndsAt).getTime() / 1000);
        const rel = Number.isFinite(u) ? ` · expires <t:${u}:R>` : '';
        return `#${i + 1}: **${o.bidPrice}** 🐰 on listing \`${String(o.listingId).slice(0, 8)}…\`${rel}`;
      })
      .join('\n');
  }
  embed.addFields({
    name: '💬 Offers in flight',
    value: truncateShopField(ob || '—', 1024),
    inline: false,
  });
  embed.setFooter({
    text: 'Use Menu → Rabbit shop in the Creation to list, bid, or buy commands.',
  });
  return embed;
}

const tunnelUrlPath = join(__dirname, '.tunnel-url');
function readTunnelUrl() {
  try {
    if (!existsSync(tunnelUrlPath)) return null;
    const u = readFileSync(tunnelUrlPath, 'utf8').trim();
    return u || null;
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// channelCache: guildId → channels[] (text + voice, `kind`: "text"|"voice")
const channelCache = new Map();
const wsClients    = new Set();

let discordVoicePlayer = null;
let botVoiceGuildId = null;
let botVoiceChannelId = null;
let botVoiceChannelName = '';
/** @type {import('child_process').ChildProcessWithoutNullStreams | null} */
let vcFFmpegProc = null;
let lastVcPcmNoEncoderLog = 0;

/** @type {Map<string, { stream: import('stream').Readable }>} */
const voiceListenStreams = new Map();
let opusListenDecoderMono = null;
let opusListenDecoderStereo = null;

function wsBroadcastJson(obj) {
  const payload = JSON.stringify(obj);
  for (const sock of wsClients) {
    if (sock.readyState === 1) sock.send(payload);
  }
}

/** Merge tiny RX chunks so browsers schedule fewer PCM blocks (~40 ms target). */
const vcListenMergeByUser = new Map();
/** userId → display hint for VC speaking UI (PCM / subscribe paths). */
const vcListenUserLabels = new Map();
/** Voice connection whose receiver.speaking we bound (remove listeners on teardown). */
let vcSpeakEventsConn = null;

function tearDownVoiceListen() {
  if (vcSpeakEventsConn?.receiver?.speaking) {
    try {
      vcSpeakEventsConn.receiver.speaking.removeAllListeners('start');
      vcSpeakEventsConn.receiver.speaking.removeAllListeners('end');
    } catch (_) {}
  }
  vcSpeakEventsConn = null;
  vcListenUserLabels.clear();
  vcListenMergeByUser.clear();
  for (const { stream } of voiceListenStreams.values()) {
    try {
      stream.removeAllListeners();
      if (!stream.destroyed) stream.destroy();
    } catch (_) {}
  }
  voiceListenStreams.clear();
  if (opusListenDecoderMono) {
    try {
      opusListenDecoderMono.delete();
    } catch (_) {}
    opusListenDecoderMono = null;
  }
  if (opusListenDecoderStereo) {
    try {
      opusListenDecoderStereo.delete();
    } catch (_) {}
    opusListenDecoderStereo = null;
  }
}

function pcmStereoToMonoS16(stereo) {
  const samples = Math.floor(stereo.length / 4);
  const mono = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const l = stereo.readInt16LE(i * 4);
    const r = stereo.readInt16LE(i * 4 + 2);
    const m = Math.max(-32768, Math.min(32767, Math.round((l + r) / 2)));
    mono.writeInt16LE(m, i * 2);
  }
  return mono;
}

function decodeDiscordOpusToMonoS16(opusBuf) {
  if (!opusListenDecoderStereo) {
    opusListenDecoderStereo = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  }
  try {
    const pcmS = opusListenDecoderStereo.decode(opusBuf);
    return pcmStereoToMonoS16(pcmS);
  } catch (_) {
    if (!opusListenDecoderMono) {
      opusListenDecoderMono = new OpusScript(48000, 1, OpusScript.Application.VOIP);
    }
    try {
      return opusListenDecoderMono.decode(opusBuf);
    } catch (_) {
      return null;
    }
  }
}

function subscribeVoiceListenUser(conn, userId, displayHint) {
  if (!conn?.receiver || !userId || userId === client.user?.id) return;
  if (voiceListenStreams.has(userId)) return;
  vcListenUserLabels.set(
    userId,
    String(displayHint || '').trim() || vcListenUserLabels.get(userId) || '',
  );
  let stream;
  try {
    stream = conn.receiver.subscribe(userId);
  } catch (e) {
    console.warn('[voice-rx] subscribe', userId, e?.message || e);
    return;
  }
  voiceListenStreams.set(userId, { stream });
  stream.on('data', (opusPacket) => {
    if (!opusPacket?.length) return;
    const monoS16 = decodeDiscordOpusToMonoS16(opusPacket);
    if (!monoS16?.length) return;
    const target = 7200;
    const prev = vcListenMergeByUser.get(userId);
    const merged = prev ? Buffer.concat([prev, monoS16]) : monoS16;
    if (merged.length >= target) {
      vcListenMergeByUser.delete(userId);
      const tag = vcListenUserLabels.get(userId) || displayHint || '';
      wsBroadcastJson({
        type: 'vc_listen_pcm',
        u: userId,
        nm: tag,
        sr: 48000,
        d: merged.toString('base64'),
      });
    } else {
      vcListenMergeByUser.set(userId, merged);
    }
  });
  stream.on('error', (err) =>
    console.warn('[voice-rx] stream error', userId, err?.message || err),
  );
  stream.once('close', () => {
    voiceListenStreams.delete(userId);
    vcListenMergeByUser.delete(userId);
    vcListenUserLabels.delete(userId);
  });
}

function primeVoiceListenUsers(conn, voiceChannel) {
  if (!conn?.receiver || !voiceChannel) return;
  for (const m of voiceChannel.members.values()) {
    const u = m.user;
    if (!u || u.bot) continue;
    const tag = m.displayName || u.globalName || u.username || u.id;
    subscribeVoiceListenUser(conn, u.id, tag);
  }
}

function bindVoiceReceiverSpeakingEvents(conn) {
  const speaking = conn?.receiver?.speaking;
  if (!speaking) return;
  if (vcSpeakEventsConn === conn) return;
  if (vcSpeakEventsConn?.receiver?.speaking) {
    try {
      vcSpeakEventsConn.receiver.speaking.removeAllListeners('start');
      vcSpeakEventsConn.receiver.speaking.removeAllListeners('end');
    } catch (_) {}
  }
  vcSpeakEventsConn = conn;
  speaking.on('start', (userId) => {
    if (!userId || userId === client.user?.id) return;
    const gid = conn.joinConfig?.guildId;
    const gm = gid ? client.guilds.cache.get(gid) : null;
    const nm =
      vcListenUserLabels.get(userId) ||
      (() => {
        try {
          const m = gm?.members?.cache?.get(userId);
          const u = m?.user;
          if (!m || !u) return '';
          return String(
            m.displayName || u.globalName || u.username || u.id || '',
          ).trim();
        } catch (_) {
          return '';
        }
      })();
    if (nm) vcListenUserLabels.set(userId, nm);
    wsBroadcastJson({
      type: 'vc_speak',
      on: true,
      u: userId,
      nm,
    });
  });
  speaking.on('end', (userId) => {
    if (!userId || userId === client.user?.id) return;
    wsBroadcastJson({ type: 'vc_speak', on: false, u: userId });
  });
}

async function armVoiceListenAfterJoin(conn, voiceChannel) {
  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 30_000);
    bindVoiceReceiverSpeakingEvents(conn);
    primeVoiceListenUsers(conn, voiceChannel);
  } catch (e) {
    console.warn('[voice-rx] connection not ready:', e?.message || e);
  }
}

function getDiscordVoicePlayer() {
  if (!discordVoicePlayer) {
    discordVoicePlayer = createAudioPlayer({
      behaviors: {
        /** Keep draining Opus/ffmpeg even while UDP is handshaking (default Pause deadlocks FFmpeg). */
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });
    discordVoicePlayer.on('error', (e) => console.warn('[voice-player]', e?.message || e));
  }
  return discordVoicePlayer;
}

function killVcEncoder() {
  if (!vcFFmpegProc) return;
  try {
    vcFFmpegProc.kill('SIGKILL');
  } catch (_) {}
  vcFFmpegProc = null;
}

function stopVcTransmission() {
  killVcEncoder();
  try {
    getDiscordVoicePlayer().stop(true);
  } catch (_) {}
}

async function discordBotJoinVoice(guildVoiceChannel) {
  if (!guildVoiceChannel?.guild) throw new Error('Invalid voice channel');

  /** @type {import('discord.js').VoiceChannel} */
  const ch = guildVoiceChannel;
  const guildId = ch.guild.id;

  if (botVoiceGuildId && botVoiceGuildId !== guildId) {
    disconnectBotFromAllVoice('switching guild voice');
  }

  stopVcTransmission();
  const conn = joinVoiceChannel({
    channelId: ch.id,
    guildId,
    adapterCreator: ch.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  conn.subscribe(getDiscordVoicePlayer());
  void armVoiceListenAfterJoin(conn, ch);

  botVoiceGuildId = guildId;
  botVoiceChannelId = ch.id;
  botVoiceChannelName = ch.name || '';
  return { guildId: ch.guild.id, channelId: ch.id, name: botVoiceChannelName };
}

function disconnectBotFromAllVoice(reason) {
  console.log('[discord-voice] disconnect:', reason || '');
  tearDownVoiceListen();
  stopVcTransmission();
  if (botVoiceGuildId) {
    try {
      getVoiceConnection(botVoiceGuildId)?.destroy();
    } catch (_) {}
  }
  botVoiceGuildId = null;
  botVoiceChannelId = null;
  botVoiceChannelName = '';
}

function handleVoiceClientMessage(rawText) {
  let msg;
  try {
    msg = JSON.parse(rawText);
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'vc_start') {
    if (!botVoiceGuildId || !botVoiceChannelId) {
      console.warn('[vc_start] Bot not in any voice channel');
      return;
    }
    const cid = msg.channelId;
    if (
      cid != null &&
      cid !== '' &&
      String(cid) !== String(botVoiceChannelId)
    ) {
      console.warn('[vc_start] channelId mismatch client=' + cid + ' bot=' + botVoiceChannelId);
      return;
    }
    const sr = Number(msg.sr);
    const sampleRate = Number.isFinite(sr) && sr >= 8000 && sr <= 96000 ? Math.floor(sr) : 48000;
    killVcEncoder();
    try {
      getDiscordVoicePlayer().stop(true);
    } catch (_) {}

    const bin = ffmpegInstaller || 'ffmpeg';
    /** Opus-in-Ogg for @discordjs/voice OggDemuxer (no native Opus npm module). Tuned for natural speech. */
    const ff = spawn(bin, [
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'warning',
      '-fflags', '+nobuffer+flush_packets',
      '-probesize', '32',
      '-analyzeduration', '0',
      '-f', 's16le',
      '-ar', String(sampleRate),
      '-ac', '1',
      '-i', 'pipe:0',
      '-af',
      'highpass=f=80,aresample=48000',
      '-c:a', 'libopus',
      '-ar', '48000',
      '-ac', '2',
      '-application', '2048',
      '-frame_duration', '20',
      '-b:a', '128k',
      '-vbr', 'on',
      '-packet_loss', '5',
      '-fec', '1',
      '-f', 'ogg',
      '-page_duration', '44000',
      'pipe:1',
    ]);

    ff.stderr?.on('data', (b) => {
      const s = String(b).trim();
      if (s) console.warn('[vc-ffmpeg]', s.slice(0, 200));
    });
    ff.on('error', (e) => console.warn('[vc-ffmpeg] spawn', e.message || e));
    ff.on('exit', (code) => {
      if (vcFFmpegProc !== ff || code === 0 || code === null) return;
      console.warn('[vc-ffmpeg] process exited:', code);
    });

    vcFFmpegProc = ff;

    try {
      const resource = createAudioResource(ff.stdout, {
        inputType: StreamType.OggOpus,
        silencePaddingFrames: 3,
      });
      getDiscordVoicePlayer().play(resource);
      console.log('[vc_start] opus encoder running sr=' + sampleRate);
    } catch (e) {
      console.warn('[vc_start] createAudioResource', e.message || e);
      killVcEncoder();
    }
    return;
  }

  if (msg.type === 'vc_pcm') {
    if (!vcFFmpegProc) {
      const now = Date.now();
      if (now - lastVcPcmNoEncoderLog > 8000) {
        lastVcPcmNoEncoderLog = now;
        console.warn('[vc_pcm] ignored: no active encoder (did vc_start succeed?)');
      }
      return;
    }
    if (!vcFFmpegProc.stdin?.writable) {
      return;
    }
    try {
      if (msg.d) {
        const buf = Buffer.from(String(msg.d), 'base64');
        vcFFmpegProc.stdin.write(buf);
      }
    } catch (e) {
      console.warn('[vc_pcm]', e.message || e);
    }
    return;
  }

  if (msg.type === 'vc_end') {
    try {
      vcFFmpegProc?.stdin?.end();
    } catch (_) {}
    return;
  }
}

client.once('ready', async () => {
  console.log(`Bot ready: ${client.user.tag}`);
  for (const guildId of GUILD_IDS) refreshGuildCache(guildId);
  await registerSlashCommands();
});

function refreshGuildCache(guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) { console.error(`Guild ${guildId} not found`); return; }

  const categories = new Map();
  guild.channels.cache.forEach(ch => {
    if (ch.type === ChannelType.GuildCategory) categories.set(ch.id, ch.name);
  });

  const channels = [...guild.channels.cache
    .filter(
      ch =>
        ch.viewable &&
        (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildVoice),
    )
    .sort((a, b) => {
      const cA = a.parent?.position ?? 0, cB = b.parent?.position ?? 0;
      return cA !== cB ? cA - cB : a.position - b.position;
    })
    .map(ch => ({
      id: ch.id,
      name: ch.name,
      category: categories.get(ch.parentId) || 'Uncategorized',
      position: ch.position,
      kind: ch.type === ChannelType.GuildVoice ? 'voice' : 'text',
    }))
    .values()];

  channelCache.set(guildId, channels);
}

function postTargetCheck(channel) {
  if (!channel) return { ok: false, code: 'no_channel' };
  const gid = channel.guildId ?? channel.guild?.id;
  if (!gid || !GUILD_IDS.includes(gid))
    return { ok: false, code: 'channel_not_allowed', guildId: gid ?? null };
  return { ok: true };
}

function formatMessage(msg) {
  const attachments = [...msg.attachments.values()];
  const audioAtt = attachments.find(a => a.contentType?.startsWith('audio/'));
  const voiceUrl = audioAtt?.url ?? '';
  const images = attachments
    .filter(a => a.contentType?.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp)$/i.test(a.name || ''))
    .map(a => a.url);

  msg.embeds.forEach((e) => {
    const img = e.image?.proxyURL ?? e.image?.url ?? e.thumbnail?.proxyURL ?? e.thumbnail?.url;
    if (img && !images.includes(img)) images.push(img);
  });

  let content = msg.content || '';
  if (!content.trim() && msg.embeds?.length) {
    /** Flatten every embed → one string for WS / R1 web (Discord clients still render embeds separately). */
    const parts = [];
    for (const e of msg.embeds) {
      const title = String(e.title || '').trim();
      let description = String(e.description || '').trim();
      if (/^\u200b\s*$/.test(description)) description = '';
      else if (description.startsWith('```ansi')) {
        description = discordEmbedAnsiDescriptionToPlain(description);
      }
      const fields = [...(e.fields?.values?.() ?? e.fields ?? [])]
        .map((f) => {
          const n = String(f?.name ?? '').trim();
          const v = String(f?.value ?? '').trim();
          if (!n && !v) return '';
          return n ? `**${n}**\n${v}` : v;
        })
        .filter(Boolean);
      const chunk = [
        ...(title ? [title] : []),
        ...(description ? [description] : []),
        ...fields,
      ].join('\n\n');
      if (chunk.trim()) parts.push(chunk.trim());
    }
    content =
      parts.join('\n\n━━━━━━━━\n\n') ||
      (images.length ? '' : '📎 Embed');
  }

  return {
    id:        msg.id,
    author:    msg.author.username,
    authorId:  msg.author.id,
    content:   content.trim(),
    timestamp: msg.createdTimestamp,
    isOwn:     msg.author.id === client.user.id,
    /** R1 UI: tint like Discord embed sidebar when our bot authored embed payloads. */
    embedCard:
      Boolean(msg.embeds?.length) && msg.author?.id === client.user?.id,
    hasAudio:  attachments.some(a => a.contentType?.startsWith('audio/')),
    voiceUrl,
    images,
  };
}

function buildBotPlainEmbed(body) {
  let desc = String(body ?? '').trim() || '\u200b';
  if (desc.length > 4096) desc = desc.slice(0, 4093) + '…';
  return new EmbedBuilder()
    .setDescription(desc)
    .setColor(BOT_EMBED_COLOR)
    .setTimestamp(new Date());
}

function safeGenreInput(genre) {
  return String(genre ?? '').trim().slice(0, 500);
}

function normalizeGeminiReply(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function fallbackGenreDescription(genre) {
  const g = safeGenreInput(genre);
  return (
    '"' +
    g.slice(0, 200) +
    '" is a crate-digger curveball label—perfect for late-night headphones, resetting a commute vibe, or a DJ set wildcard that still feels intentional.'
  );
}

async function geminiGenreReason(genre) {
  if (!GEMINI_API_KEY) return null;

  const g = safeGenreInput(genre);
  const prompt =
    'You explain fictional music micro-genres for DJs and listeners.\n' +
    'Binary Jazz Genrenator produced this label: "' +
    g.replace(/"/g, '') +
    '"\n\n' +
    'In exactly 2–3 short sentences (plain text only, no markdown, no bullets, no title line),\n' +
    'say why someone might hit play on music tagged like that — mood, moment, energy.';

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(GEMINI_MODEL) +
    ':generateContent?key=' +
    encodeURIComponent(GEMINI_API_KEY);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.72, maxOutputTokens: 512 },
    }),
  });

  const json = await res.json();

  if (!res.ok) {
    const detail = json?.error?.message || JSON.stringify(json);
    console.warn('[gemini]', detail);
    throw new Error(typeof detail === 'string' ? detail : 'Gemini request failed');
  }

  let text =
    json?.candidates?.[0]?.content?.parts
      ?.map((p) => (p.text != null ? String(p.text) : ''))
      .join('') ?? '';
  text = normalizeGeminiReply(text);
  return text.length >= 16 ? text : null;
}

function truncateDiscordField(val, max = 1024) {
  let s = String(val ?? '').replace(/\u0000/g, '').trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/** ANSI SGR for Discord ` ```ansi ` fenced blocks inside embed descriptions (sidebar color stays `setColor`). */
const DSC = Object.freeze({
  rs: '\u001b[0m',
  fg: Object.freeze({
    red: '\u001b[0;31m',
    brightRed: '\u001b[1;31m',
    green: '\u001b[0;32m',
    yellow: '\u001b[0;33m',
    blue: '\u001b[0;34m',
    magenta: '\u001b[0;35m',
    cyan: '\u001b[0;36m',
    /** Bright white — Discord ANSI reads this as section headers on tinted embed BG. */
    white: '\u001b[1;37m',
    boldBlack: '\u001b[1;30m',
  }),
});

function stripDiscordAnsiEscapeCodes(s) {
  return String(s ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}

/** Unwrap a ` ```ansi ` fenced description and strip SGR escapes for plaintext / WebSocket payloads. */
function discordEmbedAnsiDescriptionToPlain(desc) {
  const d = String(desc ?? '').trim();
  const m = d.match(/^```ansi\s*\n([\s\S]*?)\n```$/);
  if (m) return stripDiscordAnsiEscapeCodes(m[1]).trim();
  return stripDiscordAnsiEscapeCodes(d);
}

function shortenRelativeJoined(joinedUnixSec) {
  const j = Number(joinedUnixSec);
  if (!Number.isFinite(j) || j <= 0) return 'unknown';
  const sec = Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(j));
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  if (sec < 2_592_000) return `${Math.floor(sec / 604800)}w ago`;
  return `${Math.floor(sec / 2_629_744)}mo+ ago`;
}

/**
 * Color every contiguous ASCII-digit run like the embed stripe (`DSC.fg.brightRed`);
 * surrounding text stays on `baselineSgr`.
 */
function ansiTintDigits(text, baselineSgr = DSC.fg.white, digitSgr = DSC.fg.brightRed) {
  const rs = DSC.rs;
  const base = baselineSgr;
  const digit = digitSgr;
  let out = '';
  for (const part of String(text).split(/(\d+)/)) {
    if (part === '') continue;
    out += /^\d+$/.test(part) ? `${digit}${part}${rs}${base}` : `${base}${part}`;
  }
  return out + rs;
}

/**
 * ` ```ansi ` … ` ``` ` for embed descriptions. Strips nested fences; clamps total length to Discord’s cap.
 */
function discordAnsiCodeBlock(body, maxTotalLen = 4096) {
  const open = '```ansi\n';
  const close = '\n```';
  let inner = String(body ?? '')
    .replace(/\r/g, '')
    .replace(/\u0000/g, '')
    .replace(/```/g, "'''");
  const innerMax = Math.max(0, maxTotalLen - open.length - close.length);
  if (inner.length > innerMax) {
    inner =
      inner.slice(0, Math.max(0, innerMax - 4)) +
      DSC.rs +
      '\n…';
  }
  return open + inner + close;
}

/** Interpret `**segments**` as bold-black ANSI; gaps use plainEsc (e.g. brand red). */
function ansiFromMarkdownBold(plainEsc, boldEsc, text) {
  const t = String(text ?? '');
  if (!t) return '';
  let out = plainEsc;
  let i = 0;
  while (i < t.length) {
    const start = t.indexOf('**', i);
    if (start === -1) {
      out += t.slice(i);
      break;
    }
    out += t.slice(i, start);
    const end = t.indexOf('**', start + 2);
    if (end === -1) {
      out += t.slice(start);
      break;
    }
    out += boldEsc + t.slice(start + 2, end) + DSC.rs + plainEsc;
    i = end + 2;
  }
  return out + DSC.rs;
}

function buildDashboardStatsAnsiBody(stats) {
  const R = DSC.fg.brightRed;
  const B = DSC.fg.boldBlack;
  const W = DSC.fg.white;
  const rs = DSC.rs;

  const nh = stats.topHumans.length;
  const nj = stats.newestMembers.length;
  const nb = stats.topBots.length;

  const header =
    `${R}Sample${rs} ${ansiTintDigits(stats.sampleMeta, W, R)}\n` +
    `${R}Showing ${nh}${R} posters · ${nj}${R} joins · ${nb}${R} bots${rs}`;

  const sec1Title = `\n\n${W}💬 Top posters (${R}${nh}${W})${rs}\n`;
  const sec1Body = stats.topHumans.length
    ? stats.topHumans
        .map(
          (row, i) =>
            `${R}${i + 1}. ${B}${row.label}${rs}${R} ×${row.count}${rs}`,
        )
        .join('\n')
    : `${W}(no human-authored messages in sampled history)${rs}`;

  const sec2Title = `\n\n${W}🆕 Newest joins (${R}${nj}${W})${rs}\n`;
  const sec2Body = stats.newestMembers.length
    ? stats.newestMembers
        .map(
          (row, i) =>
            `${R}${i + 1}. ${B}${row.label}${rs}${R} joined ${ansiTintDigits(shortenRelativeJoined(row.joined), W, R)}`,
        )
        .join('\n')
    : `${W}(no join timestamps cached — try Server Members intent + bot role)${rs}`;

  const sec3Title = `\n\n${W}🤖 Bot podium (${R}${nb}${W})${rs}\n`;
  const sec3Body = stats.topBots.length
    ? stats.topBots
        .map(
          (row, i) =>
            `${R}${i + 1}. ${B}${row.label}${rs}${W} — msgs ${R}${row.msgs}${rs}${W}, reactionsΣ ${R}${row.reacts}${rs}${W} · score ${R}${row.score}${rs}`,
        )
        .join('\n')
    : `${W}(no bot messages matched in sampled window)${rs}`;

  return header + sec1Title + sec1Body + sec2Title + sec2Body + sec3Title + sec3Body + rs;
}

/** Gemini sometimes truncates mid-clause — trim dangling auxiliaries, fall back to last full sentence. */
function sanitizeChangelogTail(text) {
  let t = String(text ?? '').replace(/\u0000/g, '').trim();
  if (!t) return t;
  if (/[.!?…][\s)"']*$/.test(t)) return t;

  const dangling = /\b(the|a|an|for|with|that|which|recent|critical|updates?)\s+(have|has|been|were|being)\s*$/i;
  for (let i = 0; i < 5 && dangling.test(t); i++) {
    if (/\s+[A-Za-z']+\s*$/u.test(t)) t = t.replace(/\s+[A-Za-z']+\s*$/u, '').trim();
  }
  while (/\s+(have|has|been|were|being|and|the|to|from)\s*$/iu.test(t) && t.length > 40) {
    t = t.replace(/\s+(have|has|been|were|being|and|the|to|from)\s*$/iu, '').trim();
  }

  const lastDot = t.lastIndexOf('. ');
  const lastBang = Math.max(t.lastIndexOf('! '), t.lastIndexOf('? '));
  const cut = Math.max(lastDot >= 140 ? lastDot + 1 : -1, lastBang >= 140 ? lastBang + 1 : -1);
  if (cut > 0) return t.slice(0, cut).trim();

  if (!/[.!?…]$/.test(t)) return t.endsWith('…') ? t : `${t.trimEnd()}…`;
  return t;
}

function sanitizeDashboardLabel(member, userIdFallback) {
  const raw =
    member?.displayName ||
    member?.user?.username ||
    member?.user?.globalName ||
    userIdFallback ||
    '?';
  return String(raw).replace(/`/g, "'").slice(0, 36);
}

function channelSnowflakeRank(ch) {
  try {
    const id = ch?.lastMessageId;
    if (!id) return 0n;
    return BigInt(id);
  } catch (_) {
    return 0n;
  }
}

async function fetchUpstreamCommitSubjects(limit = 18) {
  const url =
    `https://api.github.com/repos/${KIT_REPO.replace(/%/g, '')}/commits?per_page=${limit}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'r1-discord-kit-server-dashboard',
    },
  }).catch(() => null);
  if (!res?.ok) return [];
  const rows = await res.json().catch(() => []);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((c) => {
      const line = String(c.commit?.message || '').split(/\r?\n/)[0]?.trim();
      const sha = String(c.sha || '').slice(0, 7);
      const iso = String(c.commit?.author?.date || '').slice(0, 10);
      if (!line) return '';
      return `${sha} ${iso}: ${truncateDiscordField(line, 190)}`;
    })
    .filter(Boolean);
}

async function geminiKitChangelogSummary(commitLines, sampleMeta) {
  if (!GEMINI_API_KEY) {
    return (
      'GEMINI_API_KEY is not set on the host: add it to `.env` for an AI changelog. ' +
      `Upstream (${KIT_REPO}): ${commitLines.length} recent commits fetched raw in fields below would be summarized here.`
    );
  }

  const commitBlock =
    commitLines.slice(0, 15).join('\n') || '(No commits fetched from GitHub API.)';
  const prompt =
    'You summarize open-source discord bot UI updates for self-hosters.\n' +
    'Repo: github.com/' +
    KIT_REPO +
    '\n' +
    'Local installed package version reported by runtime: `' +
    LOCAL_KIT_VERSION +
    '`.\n\n' +
    'Recent default-branch commit subjects:\n' +
    commitBlock +
    '\n\n' +
    'Stats context (sampler, not exhaustive): ' +
    sampleMeta +
    '\n\n' +
    'Write TWO short paragraphs (~900 unicode characters TOTAL max).\n' +
    '1) Paragraph 1: start with UPDATE CHECK for r1-discord-kit — then tight changelog for admins.\n' +
    'Paragraph 1 MUST end with a period.\n' +
    '2) Paragraph 2: EXACTLY one line in this shape (fill in blanks, end with period):\n' +
    'VERDICT: YES | MAYBE | NO — brief reason admins should rebuild or skip.\n' +
    'No markdown headings, prefer plain sentences.\n';

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(GEMINI_MODEL) +
    ':generateContent?key=' +
    encodeURIComponent(GEMINI_API_KEY);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.38, maxOutputTokens: 2048 },
    }),
  }).catch(() => null);

  const json = res ? await res.json().catch(() => ({})) : {};
  if (!res?.ok) {
    const detail = json?.error?.message || res?.statusText || 'Gemini unreachable';
    return truncateDiscordField('Changelog AI skipped: ' + detail, 4096);
  }

  let text =
    json?.candidates?.[0]?.content?.parts
      ?.map((p) => (p.text != null ? String(p.text) : ''))
      .join('') ?? '';
  text = normalizeGeminiReply(text);

  /** Model sometimes truncates exactly at MAX_TOKENS — finishReason is surfaced in REST. */
  const fr =
    typeof json?.candidates?.[0]?.finishReason === 'string'
      ? json.candidates[0].finishReason
      : '';

  text = sanitizeChangelogTail(text);
  if (!/\bVERDICT\s*:\s*(YES|MAYBE|NO)\b/im.test(text)) {
    text =
      text.trimEnd() +
      '\n\nVERDICT: MAYBE — Gemini output missing verdict line; confirm on GitHub before rebuilding.';
    text = sanitizeChangelogTail(text);
  }
  if (/MAX_TOKENS|OTHER/i.test(fr)) {
    console.warn('[dashboard changelog] Gemini finish:', fr || 'unknown');
  }
  text = sanitizeChangelogTail(text);

  const out = text.length >= 48 ? truncateDiscordField(text, 4080) : 'Changelog AI returned empty text.';
  return out;
}

async function sampleGuildForDashboard(guild) {
  const me = guild.members.me;
  if (!me) throw new Error('Bot guild member missing');

  const humanMsgCount = new Map();
  /** @type {Map<string, { msgs: number; reacts: number }>} */
  const botPulse = new Map();

  let totalMessagesSeen = 0;

  const textCandidates = [...guild.channels.cache.values()].filter(
    (ch) =>
      ch &&
      ch.type === ChannelType.GuildText &&
      ch.viewable &&
      ch.permissionsFor(me).has([
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.ReadMessageHistory,
      ]),
  );
  textCandidates.sort((a, b) =>
    channelSnowflakeRank(b) > channelSnowflakeRank(a) ? 1 : -1,
  );
  const take = textCandidates.slice(0, 14);

  for (const tc of take) {
    let before = undefined;
    for (let page = 0; page < 4; page++) {
      let batch;
      try {
        batch = await tc.messages.fetch({ limit: 100, before }).catch(() => null);
      } catch (_) {
        batch = null;
      }
      if (!batch?.size) break;
      const arr = [...batch.values()].sort((a, b) => {
        try {
          return BigInt(a.id) > BigInt(b.id) ? 1 : -1;
        } catch (_) {
          return 0;
        }
      });

      for (const m of arr) {
        if (!m.author) continue;
        totalMessagesSeen++;
        if (m.author.bot) {
          const sid = m.author.id;
          const cur =
            botPulse.get(sid) || {
              msgs: 0,
              reacts: 0,
            };
          cur.msgs += 1;
          let rsum = 0;
          try {
            for (const r of m.reactions.cache.values())
              rsum += Number(r.count) || 0;
          } catch (_) {}
          cur.reacts += rsum;
          botPulse.set(sid, cur);
        } else {
          const uid = m.author.id;
          humanMsgCount.set(uid, (humanMsgCount.get(uid) || 0) + 1);
        }
      }

      before = arr[0]?.id;
      if (!before || batch.size < 100) break;
    }
    await new Promise((r) => setTimeout(r, 220));
  }

  /** @type {Array<{ uid: string; count: number; label: string }>} */
  const topHumans = [...humanMsgCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([uid, count]) => ({
      uid,
      count,
      label: sanitizeDashboardLabel(guild.members.cache.get(uid), uid.slice(0, 8)),
    }));

  /** @type {Array<{ uid: string; score: number; msgs: number; reacts: number; label: string }>} */
  const topBots = [...botPulse.entries()]
    .map(([uid, data]) => {
      const score = data.msgs * 3 + data.reacts;
      return {
        uid,
        score,
        msgs: data.msgs,
        reacts: data.reacts,
        label: sanitizeDashboardLabel(guild.members.cache.get(uid), uid.slice(0, 8)),
      };
    })
    .filter((row) => row.msgs > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const newestMembers = [...guild.members.cache.values()]
    .filter((m) => m && !m.user?.bot && m.joinedTimestamp)
    .sort((a, b) => (b.joinedTimestamp || 0) - (a.joinedTimestamp || 0))
    .slice(0, 10)
    .map((m) => ({
      label: sanitizeDashboardLabel(m, m.id.slice(0, 8)),
      joined: Math.floor(((m.joinedTimestamp || Date.now()) / 1000)),
    }));

  const sampleMeta =
    `scanned≤${take.length} text channels · ~${totalMessagesSeen} msgs in sample`;

  return {
    topHumans,
    topBots,
    newestMembers,
    sampleMeta,
    guildName: guild.name,
  };
}

async function composeServerDashboardEmbeds(guild, commitLinesHint) {
  await guild.members.fetch().catch(() => {});

  const stats = await sampleGuildForDashboard(guild);

  const changelog = await geminiKitChangelogSummary(
    Array.isArray(commitLinesHint) && commitLinesHint.length > 0
      ? commitLinesHint
      : await fetchUpstreamCommitSubjects(),
    stats.sampleMeta,
  );

  const statsEmbed = new EmbedBuilder()
    .setTitle(
      truncateDiscordField(`📊 ${guild.name} · activity sampler`, 256),
    )
    .setColor(BOT_EMBED_COLOR)
    .setDescription(
      discordAnsiCodeBlock(buildDashboardStatsAnsiBody(stats), 4096),
    )
    .setFooter({
      text: truncateDiscordField(
        `${stats.sampleMeta} · local kit v${LOCAL_KIT_VERSION}`,
        2048,
      ),
    })
    .setTimestamp(new Date());

  const changelogAnsi = ansiFromMarkdownBold(
    DSC.fg.brightRed,
    DSC.fg.boldBlack,
    truncateDiscordField(changelog, 3800),
  );

  const changelogEmbed = new EmbedBuilder()
    .setTitle('📋 r1-discord-kit · Gemini update check')
    .setColor(BOT_EMBED_COLOR)
    .setDescription(
      changelogAnsi.trim()
        ? discordAnsiCodeBlock(changelogAnsi, 4096)
        : truncateDiscordField(changelog, 4096),
    )
    .setFooter({
      text: truncateDiscordField(
        `${GEMINI_MODEL} · ${KIT_REPO}`,
        2048,
      ),
    })
    .setTimestamp(new Date());

  return [statsEmbed, changelogEmbed];
}

async function registerSlashCommands() {
  if (!BOT_TOKEN || !GUILD_IDS.length) return;
  try {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    await client.application.fetch();

    const rabbitMarket = new SlashCommandBuilder()
      .setName('rabbit-shop')
      .setDescription('Shared Rabbit Heads economy + command marketplace.')
      .addSubcommand((sc) =>
        sc
          .setName('show')
          .setDescription('Post guild listings + open bids (Netlify Rabbit shop hub)')
      )
      .addSubcommand((sc) =>
        sc.setName('balance').setDescription('See your Rabbit Heads balance')
      );

    const dashboardCmd = new SlashCommandBuilder()
      .setName('server-dashboard')
      .setDescription('Two embeds: activity sample + Gemini/GitHub changelog & verdict.');

    const cmdBodies = [rabbitMarket.toJSON(), dashboardCmd.toJSON()];

    for (const gid of GUILD_IDS) {
      await rest.put(Routes.applicationGuildCommands(client.application.id, gid), {
        body: cmdBodies,
      });
    }
    console.log(
      `[slash] Registered "/rabbit-shop" + "/server-dashboard" on ${GUILD_IDS.length} server(s)`,
    );
  } catch (e) {
    console.warn('[slash] register failed', e?.message || e);
  }
}

function sanitizeMemePromptInput(raw) {
  let s = String(raw ?? '').replace(/\u0000/g, '').trim().slice(0, 900);
  s = s.replace(/\\/g, ' ').replace(/"/g, "'");
  return s;
}

/** Full prompt passed to GPT image model — captions + layout live inside pixels. See https://developers.openai.com/api/docs/models/gpt-image-2 */
function buildOpenAiMemePrompt(userVoiceIdea, panels) {
  const idea = sanitizeMemePromptInput(userVoiceIdea);
  const base = idea || 'internet chaos mode';
  const layout =
    panels === 2
      ? (
        'VISUAL STRUCTURE: a vertical TWO-panel stacked meme comic (narrow portrait canvas). TOP panel smaller: calm setup riffing recognizable meme/pop-culture *vibes*. ' +
          'BOTTOM panel larger: escalate with chaotic UNHINGED absurdist twist—meta, feral sincerity, "nobody thinks about this angle" humor. ' +
          'Both panels MUST include LARGE contrasty meme caption typography (impact-style lettering) fused into art—top+bottom captions per panel.'
        )
      : (
        'VISUAL STRUCTURE: ONE blockbuster single-panel meme. BIG top and/or bottom impact-font style captions synthesized into scenery. '
      );
  return [
    `User spoken meme seed (interpret loosely, original composition): "${base}".`,
    'Generate ONE polished viral-style meme IMAGE: bold readable CAPTION glyphs embedded—text is inseparable artwork.',
    'Tone: knowingly absurd pop-culture meme energy with an extra unpredictable UNHINGED comedic escalation (SFW — no sexual content, hate, politicians, identifiable real people, logos, watermark text, copyrighted character likeness — use ambiguous generic stand‑ins instead).',
    layout,
    'High contrast meme macro palette (no UI chrome, pure illustration / stylized clipart hybrid). PNG-like crisp edges.',
  ].join('\n');
}

async function openAiGenerateMemePngBuffer(userVoiceIdea, panels) {
  if (!OPENAI_API_KEY.trim()) throw new Error('OPENAI_API_KEY missing on server (.env)');
  const prompt = buildOpenAiMemePrompt(userVoiceIdea, panels);
  const body = {
    model: OPENAI_IMAGE_MODEL.trim(),
    prompt,
    n: 1,
    size: panels === 2 ? '1024x1536' : '1024x1024',
  };
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msgErr = j.error?.message ? String(j.error.message) : res.statusText;
    throw new Error(`OpenAI image: ${msgErr}`);
  }
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image (expected b64_json for GPT image models)');
  return Buffer.from(b64, 'base64');
}

function buildMemeImageOnlyEmbed() {
  return new EmbedBuilder()
    .setDescription('\u200b')
    .setColor(BOT_EMBED_COLOR)
    .setImage('attachment://meme.png')
    .setTimestamp(new Date());
}

function buildGenreExploreEmbed(genreLabel, description) {
  const genre = safeGenreInput(genreLabel);
  const prefix = '🎲 ';
  let title = prefix + genre;
  if (title.length > 256) title = title.slice(0, 253) + '…';

  let desc = normalizeGeminiReply(description);
  desc = truncateDiscordField(desc, 3800);
  const genreAnsi = ansiFromMarkdownBold(
    DSC.fg.brightRed,
    DSC.fg.boldBlack,
    desc,
  );

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      desc ? discordAnsiCodeBlock(genreAnsi, 4096) : '\u200b',
    )
    .setColor(BOT_EMBED_COLOR)
    .setFooter({ text: `Binary Jazz Genrenator · ${GEMINI_MODEL} · r1-discord` })
    .setTimestamp(new Date());
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'rabbit-shop') {
    const sub = interaction.options.getSubcommand();
    if (!interaction.guildId || !GUILD_IDS.includes(interaction.guildId)) {
      if (interaction.deferred || interaction.replied) return;
      return interaction.reply({
        content: 'This Discord server is not enabled in this bot’s GUILD_IDS.',
        ephemeral: true,
      });
    }
    if (!RABBIT_SHOP_HUB_URL || !RABBIT_SHOP_HUB_SECRET) {
      if (interaction.deferred || interaction.replied) return;
      return interaction.reply({
        content:
          'Rabbit shop hub is not configured — set RABBIT_SHOP_NETLIFY_HOST (or full RABBIT_SHOP_HUB_URL) plus RABBIT_SHOP_HUB_SECRET / SHOP_HUB_SECRET on the bot host.',
        ephemeral: true,
      });
    }

    if (sub === 'balance') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const j = await rabbitShopPublic({
          action: 'balance_for_user',
          userId: interaction.user.id,
        });
        await interaction.editReply({
          content: `🐰 Rabbit heads: **${Number(j.balance ?? 0)}** (shared hub balance)`,
        });
      } catch (e) {
        await interaction.editReply({ content: `Balance failed — ${e.message || e}` });
      }
      return;
    }

    if (sub === 'show') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const guildId = interaction.guildId;
        const guildName = interaction.guild?.name || 'Server';
        const [listingPack, offersPack] = await Promise.all([
          rabbitShopPublic({ action: 'listings_for_guild', guildId }),
          rabbitShopPublic({ action: 'offers_for_guild', guildId }),
        ]);
        const embed = buildRabbitShopEmbed(listingPack, offersPack, guildName);
        if (interaction.channel?.isTextBased())
          await interaction.channel.send({ embeds: [embed] });
        await interaction.editReply({
          content:
            '✅ Posted Rabbit shop snapshot in this channel. Open **Menu → Rabbit shop** in the Creation to buy or list commands.',
        });
      } catch (e) {
        await interaction.editReply({ content: `Shop fetch failed — ${e.message || e}` });
      }
      return;
    }
    return;
  }

  if (interaction.commandName !== 'server-dashboard') return;

  if (!interaction.guildId || !GUILD_IDS.includes(interaction.guildId)) {
    if (interaction.deferred || interaction.replied) return;
    return interaction.reply({
      content: 'This Discord server is not enabled in this bot’s GUILD_IDS.',
      ephemeral: true,
    });
  }

  await interaction.deferReply().catch(() => {});

  try {
    const guild =
      interaction.guild ?? (await interaction.client.guilds.fetch(interaction.guildId));
    const commits = await fetchUpstreamCommitSubjects();
    const embeds = await composeServerDashboardEmbeds(guild, commits);
    await interaction.editReply({ embeds });
  } catch (e) {
    console.warn('[server-dashboard]', e?.message || e);
    await interaction
      .editReply({
        embeds: [buildBotPlainEmbed('Dashboard failed: ' + (e?.message || String(e)))],
      })
      .catch(() => {});
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (!botVoiceGuildId || newState.guild.id !== botVoiceGuildId) return;
  const conn = getVoiceConnection(botVoiceGuildId);
  if (!conn || conn.state.status !== VoiceConnectionStatus.Ready) return;

  if (newState.channelId === botVoiceChannelId && newState.member?.user && !newState.member.user.bot) {
    const name =
      newState.member.displayName ||
      newState.member.user.globalName ||
      newState.member.user.username ||
      newState.member.id;
    subscribeVoiceListenUser(conn, newState.member.id, String(name));
  }

  if (
    oldState.channelId === botVoiceChannelId &&
    newState.channelId !== botVoiceChannelId &&
    oldState.member?.id &&
    client.user?.id &&
    oldState.member.id !== client.user.id
  ) {
    const sid = oldState.member.id;
    const meta = voiceListenStreams.get(sid);
    if (!meta) return;
    try {
      meta.stream.removeAllListeners();
      if (!meta.stream.destroyed) meta.stream.destroy();
    } catch (_) {}
    voiceListenStreams.delete(sid);
    vcListenUserLabels.delete(sid);
    vcListenMergeByUser.delete(sid);
  }
});

client.on('messageCreate', (message) => {
  if (!GUILD_IDS.includes(message.guildId)) return;
  const payload = JSON.stringify({ type: 'new_message', guildId: message.guildId, channelId: message.channelId, message: formatMessage(message) });
  wsClients.forEach(ws => { if (ws.readyState === 1) ws.send(payload); });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const uploadVoiceMaybeMeta = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
}).fields([{ name: 'audio', maxCount: 1 }]);

const app = express();
app.use(
  cors({
    origin: true,
    methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
  }),
);
app.use(express.json());

app.get('/health', (req, res) => res.json({
  status: 'ok',
  bot: client.user?.tag,
  guilds: GUILD_IDS,
  tunnelUrl: readTunnelUrl() || process.env.BACKEND_PUBLIC_URL || null,
  rabbitShopHubUrl: Boolean(
    RABBIT_SHOP_HUB_URL?.trim() && /^https:\/\//i.test(RABBIT_SHOP_HUB_URL),
  ),
  rabbitShopHubReady: Boolean(
    RABBIT_SHOP_HUB_URL?.trim() &&
      /^https:\/\//i.test(RABBIT_SHOP_HUB_URL) &&
      RABBIT_SHOP_HUB_SECRET,
  ),
}));

/** Let the SPA discover the Discord API URL (tunnel) without ?backend=. */
app.get('/auto-backend.json', (_req, res) => {
  const backend = readTunnelUrl() || process.env.BACKEND_PUBLIC_URL || '';
  res.type('application/json')
    .set('Access-Control-Allow-Origin', '*')
    .set('Cache-Control', 'no-store')
    .send(JSON.stringify({ backend }));
});

/** Proxy Binary Jazz genre API (avoid browser CORS; works on Netlify via _redirects too). */
app.get('/api/genrenator-genre', async (_req, res) => {
  try {
    const upstream = await fetch('https://binaryjazz.us/wp-json/genrenator/v1/genre/', {
      headers: { Accept: 'application/json' },
    });
    const body = await upstream.text();
    const ct = upstream.headers.get('content-type') || 'application/json';
    res.status(upstream.status).set('Access-Control-Allow-Origin', '*').type(ct).send(body);
  } catch (err) {
    res.status(502).json({ error: 'Genre proxy failed' });
  }
});

/** No auth — safe diagnostics (never exposes secret). `rabbitShopHubReachable` = this bot reached Netlify (not the WebView tunnel path). */
app.get('/shop/status', async (_req, res) => {
  let hubHost = null;
  try {
    const u = RABBIT_SHOP_HUB_URL;
    if (u && /^https:\/\//i.test(u)) hubHost = new URL(u).hostname;
  } catch (_) {}
  const explicitUrl = String(process.env.RABBIT_SHOP_HUB_URL ?? '').trim();
  const hasSecret = Boolean(RABBIT_SHOP_HUB_SECRET);
  const urlOk = Boolean(RABBIT_SHOP_HUB_URL && /^https:\/\//i.test(RABBIT_SHOP_HUB_URL));
  const configured = urlOk && hasSecret;
  const hints = [];
  if (!explicitUrl)
    hints.push('Optional: set RABBIT_SHOP_HUB_URL to the full HTTPS function URL.');
  hints.push(
    `Or set RABBIT_SHOP_NETLIFY_HOST / RABBIT_SHOP_SITE_HOST / SHOP_NETLIFY_HOST to your site's hostname (defaults to /.netlify/functions/rabbit-shop).`,
  );
  if (!hasSecret && urlOk)
    hints.push('Set RABBIT_SHOP_HUB_SECRET (or SHOP_HUB_SECRET for brevity) to match RABBIT_SHOP_HUB_SECRET on Netlify.');
  hints.push(
    'Green “credentials OK” ≠ catalog working: Creations loads /shop/catalog through Netlify → your tunnel URL (R1_DISCORD_BACKEND_URL at Netlify build).',
  );
  if (!configured)
    hints.unshift('Earn/buy/catalog need both a valid HTTPS hub URL and a shared secret.');

  let rabbitShopHubReachable = null;
  let hubReachNote = '';
  const probeGuild = GUILD_IDS.find(isDiscordSnowflake);
  if (urlOk && probeGuild) {
    try {
      await rabbitShopPublic({
        action: 'listings_for_guild',
        guildId: probeGuild,
      });
      rabbitShopHubReachable = true;
    } catch (e) {
      rabbitShopHubReachable = false;
      hubReachNote = truncateShopField(String(e?.message || e), 180);
    }
  }

  res.json({
    ok: true,
    rabbitShopConfigured: configured,
    rabbitShopHubReachable,
    ...(hubReachNote ? { hubReachNote } : {}),
    hubHost,
    hints,
  });
});

/** Public reads + balance from shared Netlify shop hub — proxied via bot for same-origin CREATION clients. */
app.get('/shop/catalog', authMiddleware, async (req, res) => {
  const gid = String(req.query.guild ?? '').trim();
  const uidRaw = req.query.user;
  if (!isDiscordSnowflake(gid))
    return res.status(400).json({ ok: false, error: '?guild=<snowflake> required' });
  if (!RABBIT_SHOP_HUB_URL)
    return res.status(503).json({ ok: false, error: 'rabbit_shop_hub_disabled', listings: [], offers: [] });
  try {
    const listingPack = await rabbitShopPublic({ action: 'listings_for_guild', guildId: gid });
    const offersPack = await rabbitShopPublic({ action: 'offers_for_guild', guildId: gid });

    /** @type {{ ok:true, guildId:string, listings: unknown[], offers: unknown[], balance?:number }} */
    const out = {
      ok: true,
      guildId: gid,
      listings: listingPack.listings || [],
      offers: offersPack.offers || [],
    };
    if (isDiscordSnowflake(uidRaw)) {
      try {
        const b = await rabbitShopPublic({
          action: 'balance_for_user',
          userId: String(uidRaw).trim(),
        });
        out.balance = Number(b.balance ?? 0);
      } catch (_) {}
    }
    res.json(out);
  } catch (err) {
    console.warn('[shop/catalog]', err?.message || err);
    res.status(502).json({ ok: false, error: String(err.message || err) });
  }
});

/** Mutating shop actions → hub (`secret` added server-side). */
app.post('/shop/action', authMiddleware, async (req, res) => {
  if (!RABBIT_SHOP_HUB_URL || !RABBIT_SHOP_HUB_SECRET) {
    return res.status(503).json({ ok: false, error: 'rabbit_shop_hub_disabled' });
  }
  const action = String(req.body?.action || '').trim();
  const allowed = new Set([
    'create_listing',
    'make_offer',
    'buy_listing',
    'withdraw_offer',
    'accept_offer',
    'delete_listing',
  ]);
  if (!allowed.has(action))
    return res.status(400).json({ ok: false, error: 'invalid_shop_action' });

  const { action: _drop, secret: _sec, ...rest } = req.body || {};
  try {
    const out = await rabbitShopPrivate({ action, ...rest });
    res.json(out);
  } catch (err) {
    console.warn('[shop/action]', action, err?.message || err);
    const detail = /** @type {{detail?:unknown}} */ (/** @type {unknown} */ (err)).detail;
    const msg = String(err?.message || err);
    let code = 502;
    if (/^unauthorized$/i.test(msg) || /^shop_http_401$/i.test(msg)) code = 401;
    else if (/^hub_secret_not_configured$/i.test(msg) || /^shop_http_503$/i.test(msg))
      code = 503;
    else if (/^rabbit_shop_hub_unconfigured$/i.test(msg)) code = 503;
    else if (
      /^shop_http_(40[0-9]|41[0-9])(?:\b|:)|^listing_|^offer_|^cannot_|^insufficient_|^command_|^title_|invalid_|(^|[^a-z])(missing|must_end|required)(\b|$)/i.test(
        msg,
      )
    )
      code = 400;

    res.status(code).json({
      ok: false,
      error: String(err?.message || err),
      ...(detail !== undefined ? { detail } : {}),
    });
  }
});

// GET /guilds/:guildId/members-search?q=prefix — Discord matches usernames/nicks that *start with* q (enable Server Members Intent in the Developer Portal)
app.get('/guilds/:guildId/members-search', authMiddleware, async (req, res) => {
  const guildId = req.params.guildId;
  if (!GUILD_IDS.includes(guildId))
    return res.status(403).json({ error: 'Guild not configured' });
  const rawQ = String(req.query.q ?? '').trim().slice(0, 32);
  if (rawQ.length < 1)
    return res.json([]);
  const lim = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 18, 1), 25);
  try {
    const guild =
      client.guilds.cache.get(guildId) ??
      (await client.guilds.fetch(guildId));
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    const col = await guild.members.search({ query: rawQ, limit: lim });
    const out = [...col.values()].map((m) => ({
      id: m.user.id,
      username: m.user.username,
      displayName: m.displayName,
      avatarURL: m.user.displayAvatarURL({ size: 32 }) || null,
    }));
    res.json(out);
  } catch (err) {
    console.warn('[members-search]', err?.message || err);
    res.status(500).json({ error: err?.message || 'Member search failed' });
  }
});

// GET /guilds — list all configured guilds the bot can see
app.get('/guilds', authMiddleware, (req, res) => {
  const result = GUILD_IDS.map(id => {
    const guild = client.guilds.cache.get(id);
    if (!guild) return null;
    return { id, name: guild.name, iconURL: guild.iconURL({ size: 64 }) || null };
  }).filter(Boolean);
  res.json(result);
});

/**
 * Guild slash command names exposed by **this bot** — for Rabbit shop “command SKU” picker.
 * (Shop listings are ledger strings; they do not change Discord registrations.)
 */
app.get('/guilds/:guildId/slash-commands', authMiddleware, async (req, res) => {
  const guildId = req.params.guildId;
  if (!GUILD_IDS.includes(guildId))
    return res.status(403).json({ error: 'Guild not configured' });
  let application = client.application;
  try {
    if (!application?.id)
      await client.application.fetch();
    application = client.application;
  } catch (_) {
    /** ignore — checked below */
  }
  const appId = application?.id;
  if (!BOT_TOKEN || !appId)
    return res.status(503).json({ error: 'bot_not_ready' });
  try {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    const globRaw =
      /** @type {unknown[]} */ (
        await rest.get(Routes.applicationCommands(appId)).catch(() => [])
      );
    const guildRaw =
      /** @type {unknown[]} */ (
        await rest.get(Routes.applicationGuildCommands(appId, guildId)).catch(() => [])
      );
    const globRows = [];
    const guRows = [];
    for (const c of globRaw ?? []) globRows.push(...discordSlashLeavesForSku(c));
    for (const c of guildRaw ?? []) guRows.push(...discordSlashLeavesForSku(c));
    /** Guild copies win over global when the same SKU string appears. */
    const bySku = new Map();
    for (const row of globRows) bySku.set(row.name, row);
    for (const row of guRows) bySku.set(row.name, row);

    const commands = [...bySku.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    res.json({ ok: true, guildId, commands });
  } catch (err) {
    console.warn('[slash-commands]', err?.message || err);
    res.status(502).json({ ok: false, error: String(err?.message || err) });
  }
});

// GET /channels?guild=GUILD_ID
app.get('/channels', authMiddleware, (req, res) => {
  const guildId = req.query.guild;
  if (!guildId) return res.status(400).json({ error: 'guild query param required' });
  if (!GUILD_IDS.includes(guildId)) return res.status(403).json({ error: 'Guild not configured' });
  res.json(channelCache.get(guildId) || []);
});

app.get('/channels/:id/messages', authMiddleware, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 50);
  try {
    const channel = await client.channels.fetch(req.params.id);
    if (!channel || !GUILD_IDS.includes(channel.guildId)) return res.status(404).json({ error: 'Not found' });
    const fetched = await channel.messages.fetch({ limit });
    res.json([...fetched.values()].reverse().map(formatMessage));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/channels/:id/voice', authMiddleware, uploadVoiceMaybeMeta, async (req, res) => {
  const files = req.files?.audio ?? [];
  const audioFile = files[0];
  if (!audioFile) return res.status(400).json({ error: 'No audio file' });
  try {
    const channel = await client.channels.fetch(req.params.id);
    if (!channel || !GUILD_IDS.includes(channel.guildId)) return res.status(404).json({ error: 'Not found' });
    const voiceEmbed = new EmbedBuilder()
      .setDescription('\u200b')
      .setColor(BOT_EMBED_COLOR)
      .setTimestamp(new Date());

    let attachment;
    let usedMp3 = false;
    try {
      if (!ffmpegInstaller) throw new Error('ffmpeg binary missing');
      const mp3Buf = await transcodeVoiceBufferToMp3(audioFile.buffer, audioFile.mimetype);
      attachment = { attachment: mp3Buf, name: 'voice.mp3' };
      usedMp3 = true;
    } catch (e) {
      console.warn('[voice] MP3 transcoding unavailable:', e.message || e);
      const fallbackExt = inferVoiceInputExtFromMime(audioFile.mimetype);
      attachment = {
        attachment: audioFile.buffer,
        name: `voice.${fallbackExt}`,
      };
    }

    const sent = await channel.send({
      embeds: [voiceEmbed],
      files: [attachment],
    });

    void rabbitShopEarnEngagement(
      channel.guildId,
      channel.id,
      sent.id,
      req.body?.shopDiscordUser,
      'voice',
    );

    const msg = formatMessage(sent);
    res.json({
      ok: true,
      message: msg,
      format: usedMp3 ? 'mp3' : inferVoiceInputExtFromMime(audioFile.mimetype),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/channels/:id/send', authMiddleware, async (req, res) => {
  const { content, shopDiscordUser } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content required' });
  if (content.length > 2000) return res.status(400).json({ error: 'Too long' });
  try {
    const channel = await client.channels.fetch(req.params.id);
    if (!channel || !GUILD_IDS.includes(channel.guildId)) return res.status(404).json({ error: 'Not found' });
    const sent = await channel.send({ embeds: [buildBotPlainEmbed(content)] });

    void rabbitShopEarnEngagement(
      channel.guildId,
      channel.id,
      sent.id,
      shopDiscordUser,
      'post',
    );

    res.json({ ok: true, message: formatMessage(sent) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Menu + slash parity: one embed — stats sampler + Gemini changelog for r1-discord-kit. */
app.post('/channels/:id/server-dashboard', authMiddleware, async (req, res) => {
  try {
    const channel = await client.channels.fetch(req.params.id);
    if (!channel?.guildId || channel.type !== ChannelType.GuildText)
      return res.status(400).json({ error: 'A text channel id is required' });
    const check = postTargetCheck(channel);
    if (!check.ok)
      return res.status(404).json({
        error: 'channel not allowed',
        code: check.code,
      });

    const guild =
      channel.guild ?? (await client.guilds.fetch(channel.guildId));
    const commits = await fetchUpstreamCommitSubjects();
    const embeds = await composeServerDashboardEmbeds(guild, commits);
    const sent = await channel.send({ embeds });
    res.json({ ok: true, messageId: sent.id });
  } catch (err) {
    console.warn('[server-dashboard][POST]', err?.message || err);
    res.status(500).json({ error: err.message || 'Dashboard failed' });
  }
});

/** Genre button: Gemini rationale + Discord embed (API key stays on server). */
app.post('/channels/:id/genre-explore', authMiddleware, async (req, res) => {
  const genreIn = req.body?.genre;
  if (typeof genreIn !== 'string' || !genreIn.trim())
    return res.status(400).json({ error: 'genre required (string)' });

  const gRaw = genreIn.trim();
  if (gRaw.length > 500) return res.status(400).json({ error: 'genre too long' });

  try {
    let reasonText = '';
    try {
      reasonText = (await geminiGenreReason(gRaw)) || '';
    } catch (e) {
      console.warn('[genre-explore][gemini]', e?.message || e);
      reasonText = '';
    }

    const description =
      reasonText.trim() || fallbackGenreDescription(gRaw);
    const embed = buildGenreExploreEmbed(gRaw, description);

    const channel = await client.channels.fetch(req.params.id);
    const check = postTargetCheck(channel);
    if (!check.ok)
      return res.status(404).json({
        error: 'channel not allowed — wrong channel or outdated server',
        code: check.code,
        guildId: check.guildId,
      });

    const sent = await channel.send({ embeds: [embed] });
    void rabbitShopEarnEngagement(
      channel.guildId,
      channel.id,
      sent.id,
      req.body?.shopDiscordUser,
      'genre',
    );
    res.json({
      ok: true,
      message: formatMessage(sent),
      usedGemini: Boolean(reasonText.trim()),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Meme mode: OpenAI GPT-class image model → single PNG → Discord embed image only. */
app.post('/channels/:id/meme-generate', authMiddleware, async (req, res) => {
  const promptIn = req.body?.prompt;
  if (typeof promptIn !== 'string' || !sanitizeMemePromptInput(promptIn))
    return res.status(400).json({ error: 'prompt required (string, from voice transcript)' });

  let panels = parseInt(String(req.body?.panels), 10);
  if (panels !== 1 && panels !== 2) panels = 2;

  try {
    const channel = await client.channels.fetch(req.params.id);
    const check = postTargetCheck(channel);
    if (!check.ok)
      return res.status(404).json({
        error: 'channel not allowed — wrong channel or outdated server',
        code: check.code,
        guildId: check.guildId,
      });

    const pngBuffer = await openAiGenerateMemePngBuffer(promptIn, panels);
    const embed = buildMemeImageOnlyEmbed();

    const sent = await channel.send({
      embeds: [embed],
      files: [{ attachment: pngBuffer, name: 'meme.png' }],
    });

    void rabbitShopEarnEngagement(
      channel.guildId,
      channel.id,
      sent.id,
      req.body?.shopDiscordUser,
      'meme',
    );

    res.json({
      ok: true,
      message: formatMessage(sent),
      model: OPENAI_IMAGE_MODEL,
      panels,
    });
  } catch (err) {
    console.warn('[meme-generate]', err?.message || err);
    res.status(500).json({ error: err.message || 'Meme generation failed' });
  }
});

/** Bot joins Discord voice channel; browser streams PCM over WebSocket (vc_* messages). */
app.post('/voice/join', authMiddleware, async (req, res) => {
  try {
    const rawId = req.body?.channelId;
    const channelId = typeof rawId === 'string' ? rawId.trim() : '';
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch || ch.type !== ChannelType.GuildVoice)
      return res.status(400).json({ error: 'Not a Discord voice channel' });

    if (!ch.guild?.id || !GUILD_IDS.includes(ch.guild.id))
      return res.status(403).json({ error: 'Guild not configured' });

    const meMember = await ch.guild.members.fetchMe().catch(() => null);
    if (
      !meMember ||
      !ch.permissionsFor(meMember).has([
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak,
      ])
    )
      return res.status(403).json({ error: 'Bot needs View Channel, Connect, and Speak here' });

    await discordBotJoinVoice(ch);

    res.json({
      ok: true,
      channelId: botVoiceChannelId,
      guildId: botVoiceGuildId,
      name: botVoiceChannelName,
    });
  } catch (err) {
    disconnectBotFromAllVoice('join failed');
    console.warn('[voice/join]', err?.message || err);
    res.status(500).json({ error: err.message || 'Join failed' });
  }
});

app.post('/voice/leave', authMiddleware, (_req, res) => {
  disconnectBotFromAllVoice('REST leave');
  res.json({ ok: true });
});

app.get('/voice/status', authMiddleware, (_req, res) => {
  res.json({
    joined: Boolean(botVoiceChannelId),
    channelId: botVoiceChannelId || null,
    guildId: botVoiceGuildId || null,
    channelName: botVoiceChannelName || null,
  });
});

app.use(express.static(join(__dirname, 'web')));
app.use((req, res) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(404).type('text').send('Not found');
    return;
  }
  const p = req.path;
  if (p.startsWith('/channels') || p.startsWith('/guilds') || p.startsWith('/api') || p.startsWith('/voice')) {
    res.status(404).json({
      error: 'route not found on this backend — update server',
      path: req.originalUrl,
      method: req.method,
      hint:
        req.method === 'POST' &&
        String(p).includes('genre-explore')
          ? 'POST /channels/:id/genre-explore missing — pull latest r1-discord-kit and restart (systemctl --user restart r1-discord-kit.service).'
          : req.method === 'POST' && String(p).includes('meme-generate')
            ? 'POST /channels/:id/meme-generate missing — update server + set OPENAI_API_KEY.'
            : req.method === 'POST' && String(p).includes('server-dashboard')
              ? 'POST /channels/:id/server-dashboard missing — pull latest r1-discord-kit and restart.'
              : String(p).includes('/voice/')
              ? 'Voice routes (/voice/join, /voice/leave, /voice/status) missing — restart server.'
              : undefined,
    });
    return;
  }
  res.status(404).type('text').send('Not found');
});

const server = createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  if (AUTH_TOKEN) {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (token !== AUTH_TOKEN) { ws.close(4001, 'Unauthorized'); return; }
  }
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'connected' }));
  ws.on('message', (data) => {
    const txt = Buffer.isBuffer(data) ? data.toString('utf8') : typeof data === 'string' ? data : '';
    if (!txt || txt.length > 650000) return;
    if (txt.startsWith('{')) handleVoiceClientMessage(txt);
  });
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

client.login(BOT_TOKEN).then(() => {
  server.listen(PORT, () => console.log(`r1-discord on port ${PORT}`));
}).catch(err => { console.error('Discord login failed:', err); process.exit(1); });
