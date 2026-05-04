# R1 Discord kit: Netlify UI + ngrok backend + Gemini “Genre” (for normal humans)

This guide explains—without assuming you’re a developer—how the **Genre** feature uses **Google Gemini** on your own computer, how the **web app** on **Netlify** talks to your **Discord bot** through a **public HTTPS tunnel** (we use **[ngrok](https://ngrok.com/)** here; **Cloudflare Try** works too), and how to put the **Netlify link** into **[Boondit’s R1 Generator](https://boondit.site/r1-generator)** so you can **scan a QR code** with **Rabbit’s Creations** app and open the UI on your R1.

---

## The simple picture

| Piece | What it is | Where it lives |
|--------|------------|----------------|
| **The screen you tap** | The Discord UI (small phone-style pages) | **Netlify** (just files + your built `app.js`) |
| **The brain that talks to Discord** | Your Node server + Discord bot | **Your PC / home server** |
| **The bridge** | A public `https://…` address that forwards to your PC | **ngrok** (typical hostname: `*.ngrok-free.app`) |
| **Genre + AI text** | Random genre from Binary Jazz, then Gemini writes “why you’d play it,” then Discord gets a **rich embed** | **On your Node server** (API key never goes in the phone browser) |

Netlify does **not** run your Discord bot. It only **hosts the website**. The R1 loads that website, and the website **calls your tunnel URL** for every Discord action—including **Genre**.

---

## How the Gemini + API “Genre” feature works (in this project)

1. You tap **Genre** in a channel.
2. The **browser** (on the R1 or anywhere) fetches a random label from the **Binary Jazz Genrenator**, using the existing genre proxy path on your backend or Netlify redirects.
3. The browser then sends **one request** to **your backend**:
   - **Method:** `POST`
   - **Path:** `/channels/<channel-id>/genre-explore`
   - **Body (JSON):** `{ "genre": "<the random label text>" }`
4. **Your server** (not the R1, not Netlify):
   - Calls **Google AI Studio / Gemini** with that label and a short prompt asking for 2–3 plain sentences.
   - If Gemini fails or you didn’t set a key, it falls back to a canned description.
   - Builds a **Discord embed** (title + description + footer) and posts it to that channel via **discord.js**.

So: **Gemini runs only on the machine running `server.js`.** Netlify never sees your `GEMINI_API_KEY`.

Related server code (names may shift slightly—search the repo):

- **`geminiGenreReason()`** — HTTP call to Gemini’s REST API (`generateContent`).
- **`buildGenreExploreEmbed()`** — turns label + AI text into a Discord embed.
- **`POST /channels/:id/genre-explore`** — auth + validation + sends the embed.

### How the web app wires it (conceptually)

Rough flow in **`web/app.entry.js`**:

1. **`fetchRandomGenre()`** — pulls the label (same cooperative parsing as today).
2. **`api(...)`** — shared helper used everywhere for authenticated JSON calls (`Authorization: Bearer …` when you set **`R1_AUTH_TOKEN`**).
3. **Genre tap handler** calls:
   ```text
   api('/channels/' + currentChannel.id + '/genre-explore', {
     method: 'POST',
     body: JSON.stringify({ genre }),
   })
   ```
4. **`resolveBackendUrl()`** / **`apiUrl()`** — figure out **which `https://` host** is your real API (tunnel). That’s how Netlify + R1 find your PC.

---

## What you need installed / created (checklist)

- [ ] **Discord bot** + token, bot invited to your server, **`GUILD_IDS`** in `.env`
- [ ] **Node app** runs locally: **`npm install`**, **`npm start`** (or your systemd unit)
- [ ] **`GEMINI_API_KEY`** from [Google AI Studio](https://aistudio.google.com/apikey), optional **`GEMINI_MODEL`** (default in this repo is **`gemini-3-flash-preview`**)
- [ ] **`R1_AUTH_TOKEN`** (optional but recommended): same random secret in `.env` and in the Creation URL as **`?token=...`**
- [ ] **ngrok** account + **`ngrok config add-authtoken …`** once; tunnel pointing at **`http://localhost:3002`** (or whichever port you use)
- [ ] **Netlify** site publishing the **`web`** folder **after build**
- [ ] **Creations** on the R1 (Rabbit’s app for loading custom creations from a QR/install link)

---

## Part A — Run the Discord API at home (behind ngrok)

1. On the machine that runs the bot:
   ```bash
   cd r1-discord-kit-main
   npm install
   cp .env.example .env   # if you don’t already have .env
   # Edit .env: BOT_TOKEN, GUILD_IDS, GEMINI_API_KEY, R1_AUTH_TOKEN (optional), PORT default 3002
   npm start
   ```
2. In another terminal (after one-time **`ngrok config add-authtoken <token>`** from the [ngrok dashboard](https://dashboard.ngrok.com)):
   ```bash
   ./scripts/run-ngrok-tunnel.sh
   ```
   For a **reserved ngrok hostname** that does not change each restart, put **`NGROK_DOMAIN=…`** in **`.env`** (the script uses **`ngrok http … --url https://…`**). Example: **`juicy-vicissitudinous-lachlan.ngrok-free.dev`** → public base **`https://juicy-vicissitudinous-lachlan.ngrok-free.dev`**.

   Or without the script: **`ngrok http http://localhost:3002 --url https://your-name.ngrok-free.dev`**.

   Set **`NGROK_AUTHTOKEN`** in **`.env`** (dashboard authtoken) for **`systemd`**, unless you already ran **`ngrok config add-authtoken`** on that PC.

3. That URL is your **`BACKEND`** / **`R1_DISCORD_BACKEND_URL`** for the rest of this guide. The script can also refresh **`.tunnel-url`** and **`BACKEND_PUBLIC_URL`** in `.env` when the agent API on **http://127.0.0.1:4040** is available.

   **Important:** On **free random** ngrok URLs, the hostname often **changes** when ngrok restarts. A **reserved hostname** (`NGROK_DOMAIN`) stays stable. If Genre returns **404**, your Netlify deploy or **`?backend=`** may still point at an **old** URL — update **`R1_DISCORD_BACKEND_URL`** / **`?backend=`** accordingly.

### Optional: Cloudflare Try instead of ngrok

```bash
npx cloudflared tunnel --url http://localhost:3002
```

Use the printed `https://…trycloudflare.com` everywhere this doc says “ngrok URL.” Same stale-URL caveat when the tunnel process restarts.

---

## Part B — Build the UI for Netlify

Netlify builds with **`npm run build:web`** (see **`netlify.toml`**). That:

- bundles **`web/app.entry.js`** → **`web/app.js`**
- writes **`web/auto-backend.json`** from the Netlify env var **`R1_DISCORD_BACKEND_URL`** (see **`scripts/build-web.mjs`**)

So you can bake your **current tunnel** into the deploy:

1. In Netlify: **Site settings → Environment variables**
2. Add **`R1_DISCORD_BACKEND_URL`** = `https://your-subdomain.ngrok-free.app` (**no trailing slash**)
3. Trigger a **new deploy**

After deploy, opening your Netlify site should resolve the API to that tunnel **without** putting `?backend=` in the URL (you can still override with `?backend=` when the tunnel rotates).

Genre API path on the backend stays under the same origin as the tunnel, e.g.  
`POST https://your-subdomain.ngrok-free.app/channels/<id>/genre-explore`.

---

## Part C — Boondit QR + Rabbit Creations (the human-friendly flow)

Goal: Put your **Netlify UI URL** (plus optional **`?backend=`** and **`?token=`**) into a **creation QR** so the R1 opens your Discord app easily.

### 1. Fill in Boondit’s generator

Open **[Boondit — R1 Component Generator](https://boondit.site/r1-generator)**.

Treat it like a form for “what shows up when someone installs this creation”:

- **Plugin name** — e.g. `R1 Discord`
- **Theme color** — any brand color you like
- **Website URL** — **`https://your-site.netlify.app/`**  
  Add query params if Netlify wasn’t built with the tunnel baked in:

  ```text
  https://your-site.netlify.app/?backend=https://YOUR-SUBDOMAIN.ngrok-free.app&token=YOUR_SECRET
  ```

  - **`backend=`** → must match **today’s** tunnel (or omit if **`R1_DISCORD_BACKEND_URL`** was correct at deploy time).
  - **`token=`** → only if **`R1_AUTH_TOKEN`** is set server-side **and** matches this value.

Boondit generates **metadata JSON** + a **QR image** meant for Rabbit’s installer flow—use their **Copy JSON** / **Save Image** buttons as documented on that page.

### 2. Scan with Rabbit’s **Creations** app

On the R1, use the **Creations** app made by Rabbit (the one meant for discovering/loading creations). Scan the QR from Boondit (or load the packaged creation if you publish through a store workflow—this doc stays at “QR + Website URL level”).

**In plain English:** Creations reads “go open this HTTPS page full-screen”; that page **is** your Netlify-hosted UI; the UI then talks **through the tunnel** back to **`server.js`**, where **Gemini** and **Discord** actually run.

---

## Troubleshooting (symptoms → what to fix)

| Symptom | Likely cause |
|---------|----------------|
| **HTTP 404** on Genre | Old tunnel hostname, stale **`localStorage`**, or **`R1_DISCORD_BACKEND_URL`** wrong on last Netlify build; or PC not running latest **`server.js`**. Retry **`?backend=`** with fresh tunnel URL; restart your Node service after `git pull`. |
| Embed posts but text is boring | Gemini key missing → server uses **fallback** copy; add **`GEMINI_API_KEY`** to `.env`. |
| 401 Unauthorized | **`?token=`** doesn’t match **`R1_AUTH_TOKEN`**, or header not sent—fix URL or `.env`. |
| Netlify shows UI but nothing loads | Tunnel down, **`BACKEND`** empty, or wrong site—check browser / **Log** screen in-app if enabled. |

---

## Security in one paragraph

Treat **`GEMINI_API_KEY`** and **`BOT_TOKEN`** like passwords (`**.env`** only). The **Netlify bundle** never contains Gemini keys—only optionally the **public tunnel URL**. **`R1_AUTH_TOKEN`** stops random strangers from POSTing through your tunnel if someone guesses URL; rotate it if leaked.

---

## Quick reference — env vars (server / Netlify split)

**On your PC (`server.js` / `.env`):**

- **`BOT_TOKEN`**, **`GUILD_IDS`**, **`GEMINI_API_KEY`**, **`GEMINI_MODEL`** (optional), **`R1_AUTH_TOKEN`** (optional)

**Netlify build env:**

- **`R1_DISCORD_BACKEND_URL`** = `https://…ngrok-free.app` (or your fixed domain — **no slash at the end**)

---

© You & your repo contributors; Boondit & Rabbit are credited as linked products—not affiliated with this file unless stated elsewhere.
