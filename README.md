# r1-discord-kit

A Discord client built for the **Rabbit R1** screen (240×282px). Self-hosted Node.js backend with a Discord bot + R1-optimised web UI.

Browse channels, read messages, send text and images, explore a genre-aware LLM helper, and use **push-to-talk**: in the browser, hold PTT (or Space) on the messages screen to record and send a **voice attachment** — the server transcodes when possible (**MP3** via ffmpeg) — and playback appears **inline** in the thread. On-device **Creation** voice APIs can still behave like STT and open compose when no MediaRecorder path is available.

**Rabbit shop** (optional): a shared **rabbit heads** economy and slash-command marketplace UI + **`/rabbit-shop`** Discord slash, backed by a **Netlify serverless hub** (`netlify/functions/rabbit-shop.mjs`). Your bot tunnels REST through Netlify to the same Express host you use for Discord; the hub URL is separate (see [Rabbit shop](#rabbit-shop-rabbit-heads-hub)).

### Repository layout vs older forks

Older snapshots kept a single root **`index.html`**. This branch serves the UI from **`web/`** ( **`web/index.html`** + bundled **`web/app.js`**). **`npm start`** runs **`npm run build:web`** first so the bundle is always current.

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

A small Express server runs on your machine (or a VPS). A Discord bot attached to it reads and writes to your chosen servers. The R1 accesses the backend through a **public tunnel** (e.g. **[ngrok](https://ngrok.com/)** or **[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)**).

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
   - **Message Content Intent** ← required; the bot cannot read message text without it
   - **Server Members Intent** ← required for mention search / picking users in the app
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
   - **Attach Files** (required so the bot can post voice-message attachments)
   - **Embed Links** (voice clips are sent with an embed helper)
   - **Connect** and **Speak** (so the bot can join Discord **voice channels** when you tap 🎙 in the app — your microphone is streamed to the bot over the **`/ws` WebSocket** and played into Discord)
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

`setup.js` will ask for your bot token, server ID(s), optional **Rabbit shop** Netlify hostname and hub secret (see [below](#rabbit-shop-rabbit-heads-hub)), and an optional auth token, then write a `.env` file.

Or copy `.env.example` to `.env` and fill it in manually (see **`.env.example`** for `RABBIT_SHOP_*` shortcuts and **`BACKEND_PUBLIC_URL`** notes).

---

## Step 5 — Run the server

```bash
npm start
```

Before first start or after editing **`web/app.entry.js`**, you can regenerate the UI bundle explicitly:

```bash
npm run build:web
```

You should see:

```
Bot ready: YourBot#1234
r1-discord on port 3002
```

Test it at [http://localhost:3002](http://localhost:3002).

---

## Step 6 — Expose publicly (required for the R1 device)

The R1 needs a **public HTTPS URL** to your **`server.js`** (same host for `/ws`).

### Option A — ngrok (recommended free tier for many people)

1. [Install ngrok](https://ngrok.com/download) and register a free account.
2. Run once: **`ngrok config add-authtoken <your token>`** ([dashboard](https://dashboard.ngrok.com/get-started/your-authtoken)).
3. In a separate terminal:

   ```bash
   cd r1-discord-kit-main
   ./scripts/run-ngrok-tunnel.sh
   ```

   Or directly: **`ngrok http http://localhost:3002`** and copy the **HTTPS** forwarding URL printed in the dashboard (typically `*.ngrok-free.app`).

   **Reserved ngrok hostname (stable URL):** add to **`.env`**:

   ```
   NGROK_DOMAIN=your-name.ngrok-free.dev
   ```

   The script runs **`ngrok http … --url https://$NGROK_DOMAIN`** and treats **`https://$NGROK_DOMAIN`** as your public API base (also written to **`BACKEND_PUBLIC_URL`** / **`.tunnel-url`**).

   Add **`NGROK_AUTHTOKEN`** to **`.env`** (from the [ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken)) if you have not run **`ngrok config add-authtoken`** on that machine—required for **`systemd`**.

4. Put that **`https://…`** into your Netlify **`R1_DISCORD_BACKEND_URL`**, **`?backend=`**, or paste into **`.env`** as **`BACKEND_PUBLIC_URL`** (same as what the script writes alongside **`.tunnel-url`**).

See **`scripts/run-ngrok-tunnel.sh`** — it listens on **`127.0.0.1:4040`** to discover the HTTPS URL after start (or derives it from **`NGROK_DOMAIN`**) and syncs **`.tunnel-url`** + **`BACKEND_PUBLIC_URL`**.

### Option B — Cloudflare Quick Try tunnel (no account)

```bash
cloudflared tunnel --url http://localhost:3002
```

(or `npx cloudflared tunnel --url http://localhost:3002`)

You get **`https://…trycloudflare.com`**. URLs **rotate when cloudflared restarts** unless you configure a Cloudflare Zero Trust named tunnel on your domain.

---

### Keep the tunnel running (persist after reboot)

**ngrok (user systemd):**

1. Install **`ngrok`**, run **`ngrok config add-authtoken …`** once.
2. Ensure **`r1-discord-kit.service`** is enabled (see [Running persistently](#running-persistently-optional)).
3. Enable user **linger** if you want services at boot without login (see [COMMANDS.md](COMMANDS.md)).
4. Install the tunnel unit:

   ```bash
   cp systemd/r1-discord-ngrok.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now r1-discord-ngrok.service
   ```

5. Read the current public URL from **`.tunnel-url`**, **`GET /health`** (`tunnelUrl`), or ngrok’s local UI at **http://127.0.0.1:4040**.

6. Align port: `systemctl --user edit r1-discord-ngrok` → `Environment=NGROK_LOCAL_PORT=3002` (match **`PORT`** in `.env`). For a reserved hostname, set **`NGROK_DOMAIN=…`** in **`.env`** (the tunnel script reads it) or uncomment **`Environment=NGROK_DOMAIN=…`** in a systemd drop-in. Add **`NGROK_AUTHTOKEN`** to **`.env`** if **~/.config/ngrok/ngrok.yml** is not set up on that machine.

**Cloudflare Try tunnel (alternative):** use **`systemd/r1-discord-cloudflared.service`** and **`scripts/run-cloudflared-quick-tunnel.sh`**. Enable **only one** of **`r1-discord-ngrok`** and **`r1-discord-cloudflared`** for the same **`PORT`**.

For a **stable hostname** on your own domain, use **ngrok’s reserved domains** (paid) or a **Cloudflare named tunnel** with a free Cloudflare account — see [ngrok docs](https://ngrok.com/docs) and [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

---

## R1 creation URL

Open this URL in a browser or paste it into the R1 creation field:

```
http://localhost:3002/?backend=https://YOUR-NGROK-OR-TUNNEL-URL&token=YOUR_AUTH_TOKEN
```

(Omit `&token=...` if you left `R1_AUTH_TOKEN` blank.)

### How the UI finds your Discord API (`backend`)

Resolution order (first match wins):

1. **`?backend=`** in the page URL (explicit override).
2. **`auto-backend.json`** — on **Netlify**, this is generated at build time from **`R1_DISCORD_BACKEND_URL`**. On your **Node/tunnel** host, **`GET /auto-backend.json`** is served live from **`.tunnel-url`** / **`BACKEND_PUBLIC_URL`** in `.env` (no redeploy).
3. **`localStorage` `r1_discord_backend`** — saved after a successful load; reuse on the R1 without repeating `?backend=` until the tunnel hostname changes.
4. **Same origin** — if you open the app on **localhost** or on the **tunnel hostname** that already points at this server, the API is inferred from `location.origin`.

**Two different URLs when you deploy the UI on Netlify**

| Variable | Meaning |
|---------|---------|
| **`R1_DISCORD_BACKEND_URL`** (Netlify build env) | Public **`https://…`** where **this repo’s Express bot** listens (ngrok/cloudflared, etc.). Build writes **`web/_redirects`** so same-origin **`/guilds`**, **`/channels`**, **`/shop/catalog`**, **`/shop/action`**, **`/shop/status`**, **`/ws`**, … proxy to that host. **Update and redeploy** when your tunnel hostname changes. |
| **Rabbit shop hub** (**`RABBIT_SHOP_*` / `SHOP_*` on the bot** in **`.env`**) | The **`https://<site>.netlify.app/.netlify/functions/rabbit-shop`** (or full URL) **plus** a shared **`RABBIT_SHOP_HUB_SECRET`** matching the Netlify site env. This is the **shared marketplace + balances** API, not the Discord bot host. |

The in-app status line **“Hub OK (bot → Netlify)”** only means the **bot process** can POST to the hub; if listings still fail, check **`R1_DISCORD_BACKEND_URL`** matches your running tunnel and **redeploy** Netlify so **`_redirects`** stay current.

**Netlify:** set **`R1_DISCORD_BACKEND_URL`** to your current **`https://…ngrok-free.app`** (or other tunnel) and **redeploy** when the free URL changes (or open once with **`?backend=`** so the device stores it in `localStorage`).

---

## Rabbit shop (Rabbit Heads hub)

Optional cross-fork economy: **rabbit heads** accrue when the R1 UI sends actions with your Discord user id; you can **list / buy / offer / accept / withdraw** on slash-command SKUs and **remove** your own active listing from the shop screen.

- **Hub deploy:** Netlify function **`rabbit-shop`** + site env **`RABBIT_SHOP_HUB_SECRET`**. Details and security notes: **[`shop/README.md`](shop/README.md)**.
- **Bot host (`.env`):** either **`RABBIT_SHOP_HUB_URL`** (full function HTTPS URL) **or** **`RABBIT_SHOP_NETLIFY_HOST`** / aliases (`RABBIT_SHOP_SITE_HOST`, **`SHOP_NETLIFY_HOST`**) so the backend builds `/.netlify/functions/rabbit-shop` on that hostname; plus **`RABBIT_SHOP_HUB_SECRET`** or **`SHOP_HUB_SECRET`** identical to Netlify.
- **REST (proxied via your bot):** **`GET /shop/catalog`**, **`GET /shop/status`** (diagnostics / reachability probe), **`POST /shop/action`** (mutations inject `secret` server-side). Discord slash **`/rabbit-shop`** posts a shop preview embed.
- **Web UI:** Menu → **Rabbit shop**; SKU suggestions come from **`GET /guilds/:guildId/slash-commands`** (this bot’s **global + guild** slash commands, including nested `/group sub`-style names where applicable).

After changing **`web/`** sources, run **`npm run build:web`** and redeploy Netlify **or** rely on **`prestart`** + **`npm start`** for localhost.

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
| `GEMINI_API_KEY` | No | Google AI (Gemini) — genre-explore helper; see `.env.example` |
| `GEMINI_MODEL` | No | Gemini model override (default in `.env.example`) |
| `OPENAI_API_KEY` | No | **[Meme mode]** OpenAI API key ([platform.openai.com](https://platform.openai.com/api-keys)); required to post AI memes |
| `OPENAI_IMAGE_MODEL` | No | **`gpt-image-2`** default — see [GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2); override if your tier uses another snapshot |
| `RABBIT_SHOP_HUB_URL` | No\* | Full HTTPS URL of **`rabbit-shop`** Netlify Function (alternative to building from host below) |
| `RABBIT_SHOP_NETLIFY_HOST` | No\* | Hub site hostname (`mysite.netlify.app` or slug `mysite`); backend appends `/.netlify/functions/rabbit-shop` |
| `RABBIT_SHOP_SITE_HOST`, `SHOP_NETLIFY_HOST` | No | Aliases for the same hostname intent as `RABBIT_SHOP_NETLIFY_HOST` |
| `RABBIT_SHOP_HUB_SECRET`, `SHOP_HUB_SECRET` | No\* | Same value as **`RABBIT_SHOP_HUB_SECRET`** on Netlify; bot adds it only on mutating hub calls |

\*Required together for earns, buys, offers, listings, remove-listing (`POST /shop/action`). Reads use the hub URL only; balances in catalog still benefit from secrets on earns.

See **`.env.example`** for **`NGROK_*`**, **`BACKEND_PUBLIC_URL`** (local hint for **`scripts/build-web.mjs`** `_redirects` generation), and tunnel-related **`scripts/`** / **`systemd/`** usage.

**Netlify build (Creations-hosted UI):** set **`R1_DISCORD_BACKEND_URL`** or **`NETLIFY_DISCORD_PROXY_URL`** to your tunnel; **`npm run build:web`** bakes **`web/auto-backend.json`** and **`web/_redirects`** (optional; see **`scripts/build-web.mjs`**).

---

## Discord voice (bot joins VC, PTT as the bot)

- **Channels** lists text (`#name`) and voice (**🎙 name**). **Tap or long‑press** a 🎙 row → **`POST /voice/join`**; the bot joins using **`@discordjs/voice`**. A teal banner appears on **messages** when VC is attached.
- On **messages**, with **`/ws`** connected and mic allowed, **hold PTT**: audio is chunked as **`vc_*`** frames on the WebSocket, **FFmpeg** resamples mono PCM → **48 kHz stereo**, and the bot **plays** into the channel (others hear your **bot** speaking).
- **Menu → Leave Discord voice** (**`POST /voice/leave`**). Choosing another **server** also disconnects.
- Discord VC PTT prefers **`AudioContext#createScriptProcessor`**. Narrow WebViews may fall back to text/STT only.

---

## Voice messages (PTT → Discord attachment)

- On the **messages** screen (desktop/browser): **hold** PTT (or **Space**) → **release** to stop → the client uploads audio to **`POST /channels/:id/voice`**; the server attaches the file (prefers **`voice.mp3`** when **`ffmpeg-static`** + **`fluent-ffmpeg`** can transcode).

- Playback: messages that include audio show an **`<audio>`** control when the API includes a **`voiceUrl`** (CDN link from Discord).

- If transcoding fails, the bot still uploads the recorder’s original container (e.g. WebM/Opus); Discord must accept that MIME type.

- **Microphone permission** applies in the browser / R1 WebView. On **R1** with **Creation** voice handling, release may still route **STT** into compose when the MediaRecorder path is unavailable.

---

## Meme mode (OpenAI GPT Image)

1. Tap **Menu** on the channel messages header (**Genre**, **leave voice**, meme layout rows).
2. Return to messages; a violet banner confirms meme layout when active.
3. **Hold PTT** (or Space on desktop): in **normal** mode, browsers still send voice files when supported; **in meme modes** the app forces **speech-to-text** (`Creation`/`STT` path on R1 **or** Web Speech elsewhere).
4. Your transcript is sent to **`POST /channels/:id/meme-generate`**; the backend calls OpenAI **`v1/images/generations`** (**`OPENAI_IMAGE_MODEL`**, default **`gpt-image-2`**), then Discord receives **embed + `meme.png`** (captions are part of the image, not Discord body text).

The server-side prompt nudges **pop‑culture meme energy** with an **extra absurdist “unhinged” punch** while remaining **safe-for-work / policy-aware** via the provider.

Configure **`OPENAI_API_KEY`** and (optionally **`OPENAI_IMAGE_MODEL`**) in **`.env`**. Billing / access follows your OpenAI tier — see **[GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2)** and the **[Images API](https://platform.openai.com/docs/api-reference/images/create)**.

---

## R1 controls

| Action | Result |
|--------|--------|
| Scroll up/down | Navigate list |
| Browse channels list | **`#`** = text, **🎙** = tap / long‑press to join Discord voice |
| Long press | Open selected item |
| **Menu** (messages header) | Genre, meme layout, Rabbit shop, leave voice |
| Long press (on messages) | Hold PTT: Discord VC when joined (**🎙**); else meme/text/voice flow |
| Release (after PTT) | Stop recording and send / finish STT |
| Back button | Go back one screen |

---

## Related

- [r1-telegram-kit](https://github.com/Ashosystem/r1-telegram-kit) — same idea for Telegram

---

## Syncing with [github.com/Ashosystem/r1-discord-kit](https://github.com/Ashosystem/r1-discord-kit)

This tree is newer than snapshots that shipped a root **`index.html`** only (UI now lives under **`web/`**, with **`npm run build:web`** and **`web/app.entry.js`**). To **publish these changes**:

1. In this folder, ensure **`.git`** exists (`git init` if you unpacked a ZIP).
2. `git remote add origin https://github.com/Ashosystem/r1-discord-kit.git` (skip if already set).
3. `git add -A && git commit -m "Voice PTT uploads, MP3 transcode, web bundle layout"` — then **`git pull origin main --rebase`** if the remote already has history, resolve any conflicts, and **`git push origin main`**.
4. If the remote `main` is an unrelated old layout and you intend to replace it: coordinate a **force push** with repo owners (`git push --force-with-lease`) so outsiders are not silently broken — or open a **`v2`** branch first.

_CI / Netlify_: `package.json` includes **`prestart`** (**`npm run build:web`** before **`npm start`**). Typical Netlify **`netlify.toml`** publishes **`web/`** and **`npm run build:web`**; serverless **`rabbit-shop`** lives under **`netlify/functions/`** (configure **`RABBIT_SHOP_HUB_SECRET`** in the Netlify UI).
