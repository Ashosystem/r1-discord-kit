# Useful commands — r1-discord-kit

Quick reference. For full context see [README.md](README.md).

## Prerequisites

```bash
node --version    # expect v18+
```

## Install dependencies

```bash
cd /path/to/r1-discord-kit-main
npm install
```

Repair a broken install:

```bash
rm -rf node_modules package-lock.json
npm install
```

## Configure `.env`

Interactive wizard:

```bash
npm run setup
```

Or copy the template and edit by hand:

```bash
cp .env.example .env
```

Required variables: `BOT_TOKEN`, `GUILD_IDS`. Optional: `PORT` (default `3002`), `R1_AUTH_TOKEN`.

## Build the bundled web UI (Netlify / `npm start`)

Source: `web/index.html`, `web/app.entry.js`. Built script: **`web/app.js`** (bundles `r1-create`).

```bash
npm run build:web
```

`npm start` runs `build:web` first (`prestart`) so `/` always serves fresh assets from **`web/`**.

## Run the server (foreground)

```bash
npm start
```

Expect logs like `Bot ready: YourBot#1234` and `r1-discord on port 3002`.

## Quick checks

```bash
curl -s http://localhost:3002/health
```

If `R1_AUTH_TOKEN` is set:

```bash
curl -s -H "Authorization: Bearer YOUR_R1_AUTH_TOKEN" http://localhost:3002/health
```

Open the UI: [http://localhost:3002](http://localhost:3002)

## Expose for the R1 (HTTPS tunnel)

### ngrok (see [README](README.md) Step 6)

```bash
ngrok config add-authtoken YOUR_TOKEN   # once, from https://dashboard.ngrok.com
# Optional in .env — reserved ngrok hostname stays stable:
# NGROK_DOMAIN=juicy-vicissitudinous-lachlan.ngrok-free.dev
./scripts/run-ngrok-tunnel.sh
```

Or: **`ngrok http http://localhost:3002`** and copy the HTTPS URL from the dashboard / **http://127.0.0.1:4040**.

Use that `https://…` as the **backend** for the R1 creation screen (or Netlify **`R1_DISCORD_BACKEND_URL`**).

R1 creation URL pattern (adjust tunnel and token):

```
http://localhost:3002/?backend=https://YOUR-SUBDOMAIN.ngrok-free.app&token=YOUR_AUTH_TOKEN
```

Omit `&token=…` if `R1_AUTH_TOKEN` is empty.

Netlify UI + tunnel API:

```
https://YOUR_APP.netlify.app/?backend=https://YOUR-SUBDOMAIN.ngrok-free.app&token=YOUR_AUTH_TOKEN
```

The **Genre** button fetches a genre (Binary Jazz proxy), then **`POST /channels/:id/genre-explore`** runs **Gemini** on the server and posts a **Discord embed**.

### Cloudflare Quick Try (alternative)

```bash
npx cloudflared tunnel --url http://localhost:3002
```

## Deploy frontend on Netlify

Connect the repo; Netlify picks up **`netlify.toml`** (`publish = "web"`, build `npm run build:web`). The Node server in this repo is **not** run on Netlify—only static `web/` is published.

## ngrok tunnel (persistent systemd)

Matches [README](README.md) Step 6 / `systemd/r1-discord-ngrok.service`:

1. Install **`ngrok`**, run **`ngrok config add-authtoken …`** once.
2. After **`r1-discord-kit.service`** works:

```bash
cp systemd/r1-discord-ngrok.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now r1-discord-ngrok.service
```

Current public URL: **`cat .tunnel-url`**, **`curl -s http://localhost:3002/health`**, or **http://127.0.0.1:4040**.

Free ngrok URLs **change when ngrok restarts** unless you pay for a fixed domain; **`run-ngrok-tunnel.sh`** updates **`.tunnel-url`** and **`BACKEND_PUBLIC_URL`** when it can read the agent API.

Align port: `systemctl --user edit r1-discord-ngrok` → `Environment=NGROK_LOCAL_PORT=3002`.

Enable **either** **`r1-discord-ngrok`** **or** **`r1-discord-cloudflared`**, not both targeting the same `PORT`.

## Cloudflare Try tunnel (alternative, no CF account)

1. Install **`cloudflared`** (e.g. `brew install cloudflare/cloudflare/cloudflared`).
2. After **`r1-discord-kit.service`** works, install the tunnel unit:

```bash
cp systemd/r1-discord-cloudflared.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now r1-discord-cloudflared.service
```

See your current `*.trycloudflare.com` URL:

```bash
journalctl --user -u r1-discord-cloudflared.service --no-pager | grep trycloudflare | tail -5
```

The tunnel helper also refreshes **`BACKEND_PUBLIC_URL`** in `.env` and **`.tunnel-url`** in the repo root; **`curl -s http://localhost:3002/health`** includes **`tunnelUrl`**.

Quick URLs **change when the tunnel process restarts**; use a **named tunnel** in Cloudflare Zero Trust for a stable hostname.

Align port with `.env` (`PORT=…`) via `systemctl --user edit r1-discord-cloudflared` → `Environment=CLOUDFLARED_LOCAL_PORT=3002`.

## Systemd user service (start on login / boot)

Install unit from this repo (adjust `WorkingDirectory=` inside the file if your clone path differs):

```bash
mkdir -p ~/.config/systemd/user
cp systemd/r1-discord-kit.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now r1-discord-kit.service
```

**Boot without logging in** (user services at system boot):

```bash
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

Daily control:

```bash
systemctl --user start r1-discord-kit.service
systemctl --user stop r1-discord-kit.service
systemctl --user restart r1-discord-kit.service
systemctl --user status r1-discord-kit.service
```

Logs:

```bash
journalctl --user -u r1-discord-kit.service -f
journalctl --user -u r1-discord-kit.service -n 50 --no-pager
```

After changing the unit file or moving the project:

```bash
systemctl --user daemon-reload
systemctl --user restart r1-discord-kit.service
```

Disable autostart:

```bash
systemctl --user disable --now r1-discord-kit.service
```

## Optional: PM2 (instead of systemd)

```bash
npm install -g pm2
pm2 start server.js --name r1-discord
pm2 save
pm2 startup
```

Follow the command `pm2 startup` prints to enable autostart.

## Discord Developer Portal (links)

- Applications: [discord.com/developers/applications](https://discord.com/developers/applications)
- Bot needs **Message Content Intent** and **Server Members Intent** (Privileged Gateway Intents).
