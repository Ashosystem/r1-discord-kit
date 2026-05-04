# Rabbit Heads command marketplace

Shared fake economy (**rabbit heads**) and user-priced **command listings** backed by Netlify Functions + `@netlify/blobs` JSON storage (fallback: `live-state.json` when blobs are unavailable / local dev).

## Central hub (recommended)

1. Deploy this repo’s site on Netlify (or only the **`netlify/functions`** function + env).
2. Set **`RABBIT_SHOP_HUB_SECRET`** in the Netlify site (long random string).
3. Optionally set **`RABBIT_HEADS_PER_ENGAGEMENT`** (default **100**) for each credited app engagement.

Your public URL ends up like:

`https://<site>.netlify.app/.netlify/functions/rabbit-shop`

Every Discord bot fork points at **the same hub** so balances, listings, and offers are shared:

```
RABBIT_SHOP_HUB_URL=https://<site>.netlify.app/.netlify/functions/rabbit-shop
RABBIT_SHOP_HUB_SECRET=<same secret as Netlify>
```

## What “sell a command” means

- Listings **`commandKey`** are **stored in the shared hub**. They do **not** scan your repo on disk — they’re whatever SKU string you advertise (economy/metadata only). **Buying a listing does not add or enable real Discord slash permissions** unless you bolt on your own entitlement system.
- The Creation **Rabbit shop** command field autocomplete comes from **`GET /guilds/:guildId/slash-commands`** on your bot: Discord’s guild command registry for **this deployed bot** (same names shown when you `/` in Discord: `rabbit-shop`, `server-dashboard`, …). That’s why you weren’t seeing “repo commands” before — nothing was querying Discord/Git for you.

## End-to-end flows

| Who | Flow |
|-----|------|
| **Economy** | `server.js` calls the hub **`earn_engagement`** after Discord actions from the R1 web UI when **`shopDiscordUser`** (Discord snowflake) is supplied in bodies (send / genre / meme / voice). |
| **Listings / offers / buys** | R1 **`web`** screen “Rabbit shop” calls **`GET /shop/catalog`** then **`POST /shop/action`** via your authenticated Express backend; the backend injects **`secret`** → Netlify hub. |
| **Discord browse** | Slash **`/rabbit-shop show`** posts an embed in-channel; **`balance`** is ephemeral for the invoker. |

## Security notes (MVP)

- Treat **`RABBIT_SHOP_HUB_SECRET`** like a symmetric API key. Only your bot backend should inject it (`POST /shop/action`).
- The browser never receives the hub secret when using `R1_AUTH_TOKEN` on your tunnel.
- **Anyone who knows someone’s Discord snowflake could still attempt buys** unless you add OAuth/session binding later; Creations UX should stash *your own* ID via “My Discord ID” in the shop screen.
