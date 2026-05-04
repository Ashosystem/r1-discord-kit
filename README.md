# r1-discord-kit

A Discord client built for the **Rabbit R1** screen (240×282px). Self-hosted Node.js backend with a Discord bot + R1-optimised web UI.

Browse channels, read messages, send text, and use push-to-talk voice input — all from the R1's tiny screen.

---

## Important limitation

> **Your bot can only be added to Discord servers where you have the "Manage Server" permission (i.e. you are an owner or administrator).**
>
> Discord does not allow bots to join servers without an admin of that server explicitly authorising them. If you want to use this with a public server you don't control, you will need to ask the server's moderators or administrators to add your bot for you.

---

## How it works

```
R1 device  ──(HTTPS/WSS)──▶  your server  ──(Discord Bot API)──▶  Discord
```

A small Express server runs on your machine (or a VPS). A Discord bot attached to it reads and writes to your chosen servers. The R1 accesses the backend through a Cloudflare tunnel.

---

## Prerequisites

- Node.js 18+ (check with `node --version`)
- A Discord account
- A server where you have "Manage Server" permission

---

## Step 1 — Create a Discord application and bot

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications) and click **New Application**.
2. Give it a name (e.g. `R1 Bot`) and click **Create**.
3. In the left sidebar, click **Bot**.
4. Click **Add Bot** → **Yes, do it!**
5. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** ← this is required; the bot cannot read message text without it
6. Click **Save Changes**.
7. Click **Reset Token** → copy the token. **Keep this secret — treat it like a password.**

---

## Step 2 — Invite the bot to your server

> You must be an **owner or administrator** of the target server.

1. In the Developer Portal, go to **OAuth2 → URL Generator**.
2. Under **Scopes**, tick `bot`.
3. Under **Bot Permissions**, tick:
   - Read Messages/View Channels
   - Send Messages
   - Read Message History
4. Copy the generated URL, open it in a browser, and select your server from the dropdown. Click **Authorise**.

Repeat for each server you want the bot in.

---

## Step 3 — Get your server ID(s)

1. In Discord, open **Settings → Advanced** and enable **Developer Mode**.
2. Right-click the server icon in the left sidebar and choose **Copy Server ID**.
3. Note down the ID(s) for every server you want to appear in the app.

---

## Step 4 — Install and configure

```bash
git clone https://github.com/Ashosystem/r1-discord-kit.git
cd r1-discord-kit
npm install
npm run setup
```

`setup.js` will ask for your bot token, server ID(s), and an optional auth token, then write a `.env` file.

Or copy `.env.example` to `.env` and fill it in manually.

---

## Step 5 — Run the server

```bash
npm start
```

You should see:

```
Bot ready: YourBot#1234
r1-discord on port 3002
```

Test it at [http://localhost:3002](http://localhost:3002).

---

## Step 6 — Expose publicly (required for the R1 device)

The R1 needs a public HTTPS URL to reach your backend.

> **Important — use a stable URL.** The R1 creation URL is registered once on the device. If your backend URL changes (e.g. after a server restart), the R1 app will stop working and you'll have to re-register a new creation. Use one of the stable options below to avoid this.

---

### Option A — ngrok (easiest, no domain needed)

1. Sign up free at [ngrok.com](https://ngrok.com)
2. `npm install -g ngrok`
3. `ngrok config add-authtoken YOUR_TOKEN`
4. `ngrok http 3002`

ngrok assigns you a permanent subdomain (`https://yourname.ngrok.app`) that never changes between restarts.

---

### Option B — Cloudflare named tunnel (best if you have a domain)

1. Create a free [Cloudflare account](https://cloudflare.com) and add your domain
2. [Install cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
3. `cloudflared login`
4. `cloudflared tunnel create r1-discord`
5. `cloudflared tunnel route dns r1-discord r1-discord.yourdomain.com`
6. Create `~/.cloudflared/config.yml`:

```yaml
tunnel: r1-discord
credentials-file: /root/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: r1-discord.yourdomain.com
    service: http://localhost:3002
  - service: http_status:404
```

7. `cloudflared tunnel run r1-discord`
8. To auto-start on boot: `cloudflared service install`

---

### Option C — VPS with Caddy (if you're already self-hosting)

If you're on a VPS with a domain pointed at it, skip tunnels entirely:

1. [Install Caddy](https://caddyserver.com/docs/install)
2. Create `/etc/caddy/Caddyfile`:

```
r1-discord.yourdomain.com {
    reverse_proxy localhost:3002
}
```

3. `sudo systemctl enable --now caddy`

Caddy provisions a Let's Encrypt cert automatically. URL is permanent from day one.

---

### Option D — Quick test only (URL changes on restart)

If you just want to try the app before committing to a stable setup:

```bash
npx cloudflared tunnel --url http://localhost:3002
```

Cloudflare prints a random URL like `https://some-random-words.trycloudflare.com`. This works but changes every restart — don't use it as a permanent creation URL on the R1.

---

## R1 creation URL

Once you have a stable URL, open this in a browser or paste it into the R1 creation field:

```
https://YOUR-STABLE-URL/?backend=https://YOUR-STABLE-URL&token=YOUR_AUTH_TOKEN
```

(Omit `&token=...` if you left `R1_AUTH_TOKEN` blank.)

Register this once. As long as your backend URL stays the same, you never need to re-register the creation.

---

## Multiple servers

List multiple Guild IDs comma-separated in `.env`:

```
GUILD_IDS=123456789012345678,987654321098765432
```

The app opens to a server picker. If only one server is configured, the picker is skipped.

---

## Running persistently (optional)

To keep the server running after you close the terminal:

```bash
npm install -g pm2
pm2 start server.js --name r1-discord
pm2 save
pm2 startup   # follow the printed command to enable autostart
```

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Discord bot token |
| `GUILD_IDS` | Yes | Comma-separated server IDs |
| `PORT` | No | Port to listen on (default: 3002) |
| `R1_AUTH_TOKEN` | No | Shared secret for UI/WS auth |

---

## R1 controls

| Action | Result |
|--------|--------|
| Scroll up/down | Navigate list |
| Long press | Open selected item |
| Long press (in channel) | Hold to record voice (PTT) |
| Release | Send transcribed text to compose |
| Back button | Go back one screen |

---

## Related

- [r1-telegram-kit](https://github.com/Ashosystem/r1-telegram-kit) — same idea for Telegram
