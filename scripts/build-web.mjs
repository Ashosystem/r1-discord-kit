import * as esbuild from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const proj = dirname(dirname(fileURLToPath(import.meta.url)));

function readPublicBackendFromDotenv() {
  const envPath = join(proj, '.env');
  if (!existsSync(envPath)) return '';
  try {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed) continue;
      const m = trimmed.match(/^BACKEND_PUBLIC_URL\s*=\s*(.*)$/);
      if (!m) continue;
      return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* ignore */
  }
  return '';
}

const backendUrl = (
  process.env.R1_DISCORD_BACKEND_URL ||
  process.env.NETLIFY_DISCORD_PROXY_URL ||
  readPublicBackendFromDotenv()
).trim();

const discordNetlifyProxy = Boolean(backendUrl);

writeFileSync(
  join(proj, 'web', 'auto-backend.json'),
  JSON.stringify({
    backend: backendUrl,
    discordNetlifyProxy,
  }) + '\n',
);

/* Netlify: same-origin Discord REST + /ws avoids cross-origin/tunnel quirks in Rabbit WebViews. Falls back client-side if /ws handshake fails. */
const redirectsLines = [
  '# Genre (same-origin on Netlify)',
  '/api/genrenator-genre https://binaryjazz.us/wp-json/genrenator/v1/genre/ 200',
];
if (backendUrl) {
  const b = backendUrl.replace(/\/$/, '');
  redirectsLines.push(
    '',
    `# Discord REST → tunnel (${b}). Source: env R1_DISCORD_BACKEND_URL / NETLIFY_DISCORD_PROXY_URL or .env BACKEND_PUBLIC_URL`,
    `/guilds ${b}/guilds 200`,
    `/guilds/* ${b}/guilds/:splat 200`,
    `/channels ${b}/channels 200`,
    `/channels/* ${b}/channels/:splat 200`,
    `/health ${b}/health 200`,
    `# Rabbit Heads shop endpoints (Creations REST → tunnel, same-origin as guilds/channels).`,
    `/shop/catalog ${b}/shop/catalog 200`,
    `/shop/action ${b}/shop/action 200`,
    `/shop/status ${b}/shop/status 200`,
    `# WebSocket to bot (embedded WebViews often block cross-origin wss → tunnel).`,
    `/ws ${b}/ws 200`,
  );
}
writeFileSync(join(proj, 'web', '_redirects'), redirectsLines.join('\n') + '\n');

await esbuild.build({
  absWorkingDir: proj,
  entryPoints: ['web/app.entry.js'],
  outfile: 'web/app.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
  legalComments: 'none',
  logLevel: 'info',
});
