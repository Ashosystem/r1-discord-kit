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

const env = [
  `BOT_TOKEN=${token.trim()}`,
  `GUILD_IDS=${guildIds.trim()}`,
  `PORT=${port.trim()}`,
  authTok.trim() ? `R1_AUTH_TOKEN=${authTok.trim()}` : `R1_AUTH_TOKEN=`,
].join('\n') + '\n';

writeFileSync('.env', env);
console.log('\n.env written. Run `npm start` to launch the server.');
rl.close();
