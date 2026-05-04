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
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from 'ffmpeg-static';
import { Client, GatewayIntentBits, ChannelType, EmbedBuilder } from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

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
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';

// Support GUILD_IDS (comma-separated) or legacy GUILD_ID
const GUILD_IDS = (process.env.GUILD_IDS || process.env.GUILD_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean);

/** Left-bar color for every message this bot posts (#e82734). */
const BOT_EMBED_COLOR = 0xe82734;

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
  ],
});

// channelCache: guildId → channels[]
const channelCache = new Map();
const wsClients    = new Set();

client.once('ready', () => {
  console.log(`Bot ready: ${client.user.tag}`);
  for (const guildId of GUILD_IDS) refreshGuildCache(guildId);
});

function refreshGuildCache(guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) { console.error(`Guild ${guildId} not found`); return; }

  const categories = new Map();
  guild.channels.cache.forEach(ch => {
    if (ch.type === ChannelType.GuildCategory) categories.set(ch.id, ch.name);
  });

  const channels = [...guild.channels.cache
    .filter(ch => ch.type === ChannelType.GuildText && ch.viewable)
    .sort((a, b) => {
      const cA = a.parent?.position ?? 0, cB = b.parent?.position ?? 0;
      return cA !== cB ? cA - cB : a.position - b.position;
    })
    .map(ch => ({ id: ch.id, name: ch.name, category: categories.get(ch.parentId) || 'Uncategorized', position: ch.position }))
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

  let content = msg.content || '';
  if (!content.trim() && msg.embeds?.length) {
    const e = msg.embeds[0];
    const title = String(e.title || '');
    const description = String(e.description || '');
    content =
      ([title.trim(), description.trim()].filter(Boolean).join('\n\n') || '').trim() || '📎 Embed';
  }

  return {
    id:        msg.id,
    author:    msg.author.username,
    authorId:  msg.author.id,
    content:   content.trim(),
    timestamp: msg.createdTimestamp,
    isOwn:     msg.author.id === client.user.id,
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

function buildGenreExploreEmbed(genreLabel, description) {
  const genre = safeGenreInput(genreLabel);
  const prefix = '🎲 ';
  let title = prefix + genre;
  if (title.length > 256) title = title.slice(0, 253) + '…';

  let desc = normalizeGeminiReply(description);
  if (desc.length > 4096) desc = desc.slice(0, 4093) + '…';

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc || '\u200b')
    .setColor(BOT_EMBED_COLOR)
    .setFooter({ text: `Binary Jazz Genrenator · ${GEMINI_MODEL} · r1-discord` })
    .setTimestamp(new Date());
}

client.on('messageCreate', (message) => {
  if (!GUILD_IDS.includes(message.guildId)) return;
  const payload = JSON.stringify({ type: 'new_message', guildId: message.guildId, channelId: message.channelId, message: formatMessage(message) });
  wsClients.forEach(ws => { if (ws.readyState === 1) ws.send(payload); });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

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

app.post('/channels/:id/voice', authMiddleware, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file' });
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
      const mp3Buf = await transcodeVoiceBufferToMp3(req.file.buffer, req.file.mimetype);
      attachment = { attachment: mp3Buf, name: 'voice.mp3' };
      usedMp3 = true;
    } catch (e) {
      console.warn('[voice] MP3 transcoding unavailable:', e.message || e);
      const fallbackExt = inferVoiceInputExtFromMime(req.file.mimetype);
      attachment = {
        attachment: req.file.buffer,
        name: `voice.${fallbackExt}`,
      };
    }

    const sent = await channel.send({
      embeds: [voiceEmbed],
      files: [attachment],
    });

    const msg = formatMessage(sent);
    res.json({
      ok: true,
      message: msg,
      format: usedMp3 ? 'mp3' : inferVoiceInputExtFromMime(req.file.mimetype),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/channels/:id/send', authMiddleware, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content required' });
  if (content.length > 2000) return res.status(400).json({ error: 'Too long' });
  try {
    const channel = await client.channels.fetch(req.params.id);
    if (!channel || !GUILD_IDS.includes(channel.guildId)) return res.status(404).json({ error: 'Not found' });
    const sent = await channel.send({ embeds: [buildBotPlainEmbed(content)] });
    res.json({ ok: true, message: formatMessage(sent) });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    res.json({
      ok: true,
      message: formatMessage(sent),
      usedGemini: Boolean(reasonText.trim()),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(join(__dirname, 'web')));
app.use((req, res) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(404).type('text').send('Not found');
    return;
  }
  const p = req.path;
  if (p.startsWith('/channels') || p.startsWith('/guilds') || p.startsWith('/api')) {
    res.status(404).json({
      error: 'route not found on this backend — update server',
      path: req.originalUrl,
      method: req.method,
      hint:
        req.method === 'POST' &&
        String(p).includes('genre-explore')
          ? 'POST /channels/:id/genre-explore missing — pull latest r1-discord-kit and restart (systemctl --user restart r1-discord-kit.service).'
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
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

client.login(BOT_TOKEN).then(() => {
  server.listen(PORT, () => console.log(`r1-discord on port ${PORT}`));
}).catch(err => { console.error('Discord login failed:', err); process.exit(1); });
