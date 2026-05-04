import { createInterface } from 'readline';
import { writeFileSync, existsSync } from 'fs';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, res));

console.log('\n=== r1-discord-kit setup ===\n');

if (existsSync('.env')) {
  const overwrite = await ask('.env already exists. Overwrite? (y/N) ');
  if (overwrite.toLowerCase() !== 'y') { console.log('Aborted.'); rl.close(); process.exit(0); }
}

const token    = await ask('Bot token (from Discord Developer Portal → Bot): ');
const guildIds = await ask('Guild ID(s), comma-separated: ');
const port     = await ask('Port [3002]: ') || '3002';
const authTok  = await ask('Auth token (leave blank to skip): ');
const shopHost = await ask(
  'Rabbit shop Netlify hostname (mysite.netlify.app or slug mysite, blank = skip): ',
);
const shopSec  = await ask('Rabbit shop hub secret — must match Netlify (blank = skip): ');

function normalizeShopHostname(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\//i, '');
  const i = s.indexOf('/');
  if (i !== -1) s = s.slice(0, i);
  return s.trim();
}

const lines = [
  `BOT_TOKEN=${token.trim()}`,
  `GUILD_IDS=${guildIds.trim()}`,
  `PORT=${port.trim()}`,
  authTok.trim() ? `R1_AUTH_TOKEN=${authTok.trim()}` : `R1_AUTH_TOKEN=`,
];
const nh = normalizeShopHostname(shopHost);
if (nh) lines.push(`RABBIT_SHOP_NETLIFY_HOST=${nh}`);
if (shopSec.trim()) lines.push(`SHOP_HUB_SECRET=${shopSec.trim()}`);

const env = lines.join('\n') + '\n';

writeFileSync('.env', env);
console.log('\n.env written. Run `npm start` to launch the server.');
rl.close();
