import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const PORT       = process.env.PORT       || 3002;
const BOT_TOKEN  = process.env.BOT_TOKEN;
const AUTH_TOKEN = process.env.R1_AUTH_TOKEN || null;

// Support GUILD_IDS (comma-separated) or legacy GUILD_ID
const GUILD_IDS = (process.env.GUILD_IDS || process.env.GUILD_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
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

function formatMessage(msg) {
  const attachments = [...msg.attachments.values()];
  const images = attachments
    .filter(a => a.contentType?.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp)$/i.test(a.name || ''))
    .map(a => a.url);
  return {
    id:        msg.id,
    author:    msg.author.username,
    authorId:  msg.author.id,
    content:   msg.content,
    timestamp: msg.createdTimestamp,
    isOwn:     msg.author.id === client.user.id,
    hasAudio:  attachments.some(a => a.contentType?.startsWith('audio/')),
    images,
  };
}

client.on('messageCreate', (message) => {
  if (!GUILD_IDS.includes(message.guildId)) return;
  const payload = JSON.stringify({ type: 'new_message', guildId: message.guildId, channelId: message.channelId, message: formatMessage(message) });
  wsClients.forEach(ws => { if (ws.readyState === 1) ws.send(payload); });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', bot: client.user?.tag, guilds: GUILD_IDS }));
app.get('/', (req, res) => res.sendFile(join(__dirname, 'index.html')));

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
    const ext  = req.file.mimetype.includes('ogg') ? 'ogg' : 'webm';
    const sent = await channel.send({ files: [{ attachment: req.file.buffer, name: `voice.${ext}` }] });
    res.json({ ok: true, message: formatMessage(sent) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/channels/:id/send', authMiddleware, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content required' });
  if (content.length > 2000) return res.status(400).json({ error: 'Too long' });
  try {
    const channel = await client.channels.fetch(req.params.id);
    if (!channel || !GUILD_IDS.includes(channel.guildId)) return res.status(404).json({ error: 'Not found' });
    const sent = await channel.send(content.trim());
    res.json({ ok: true, message: formatMessage(sent) });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
