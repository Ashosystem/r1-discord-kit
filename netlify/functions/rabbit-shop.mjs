/**
 * Rabbit Heads command marketplace — shared Netlify Function backend (JSON blob + optional dev file).
 *
 * Deploy with env: RABBIT_SHOP_HUB_SECRET (required for mutations).
 * Optional: RABBIT_HEADS_PER_ENGAGEMENT (default 100)
 *
 * Netlify persists via @netlify/blobs. Fallback file: repo `shop/` locally; on Lambda `/tmp` only
 * — bundled functions can strip `import.meta.url`, yielding a non-string `path` → TypeError gateway 502.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDeployStore } from '@netlify/blobs';

const BLOB_KEY = 'rabbit-shop-db-v1.json';
const ENGAGEMENT_AMOUNT = Number(
  process.env.RABBIT_HEADS_PER_ENGAGEMENT || process.env.RABBIT_ENGAGEMENT_AMOUNT || 100,
);

const SECRET =
  typeof process.env.RABBIT_SHOP_HUB_SECRET === 'string'
    ? process.env.RABBIT_SHOP_HUB_SECRET.trim()
    : '';

/** Netlify runs on AWS Lambda — only `/tmp` is writable; avoids broken path when bundler mangles `import.meta.url`. */
const ON_REMOTE_FUNCTION = Boolean(
  process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.AWS_EXECUTION_ENV,
);

function fallbackDbFilePath() {
  if (ON_REMOTE_FUNCTION) return '/tmp/rabbit-shop-live-state.json';
  try {
    const url = import.meta.url;
    if (typeof url !== 'string' || !url) return join(process.cwd(), 'shop', 'live-state.json');
    const filePath = fileURLToPath(url);
    if (typeof filePath !== 'string' || !filePath)
      return join(process.cwd(), 'shop', 'live-state.json');
    const base = dirname(filePath);
    if (typeof base !== 'string' || !base) return join(process.cwd(), 'shop', 'live-state.json');
    return join(base, '..', '..', 'shop', 'live-state.json');
  } catch (_) {
    return join(process.cwd(), 'shop', 'live-state.json');
  }
}

const FALLBACK_FILE = fallbackDbFilePath();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, ngrok-skip-browser-warning',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DEFAULT_DB = Object.freeze({
  schemaVersion: 1,
  balances: Object.create(null),
  listings: [],
  offers: [],
  dedupe: Object.create(null),
});

function corsJson(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  };
}

async function fallbackRead() {
  try {
    const raw = await readFile(FALLBACK_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') return mergeDb(j);
  } catch (_) {}
  return structuredClone(DEFAULT_DB);
}

async function fallbackWrite(db) {
  await mkdir(dirname(FALLBACK_FILE), { recursive: true });
  await writeFile(FALLBACK_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function mergeDb(raw) {
  const d = structuredClone(DEFAULT_DB);
  d.balances = Object.assign(Object.create(null), raw.balances || {});
  d.listings = Array.isArray(raw.listings) ? raw.listings : [];
  d.offers = Array.isArray(raw.offers) ? raw.offers : [];
  d.dedupe = Object.assign(Object.create(null), raw.dedupe || {});
  return d;
}

let _store;
function blobStore() {
  if (_store) return _store;
  try {
    /** Omit `consistency: 'strong'` — can fail where Blobs disallows strong mode → Netlify gateway 502. */
    _store = getDeployStore({ name: 'rabbit-command-shop' });
  } catch {
    _store = null;
  }
  return _store;
}

async function loadDb() {
  const bs = blobStore();
  if (bs) {
    try {
      const json = await bs.get(BLOB_KEY, { type: 'json' });
      if (json && typeof json === 'object') return mergeDb(json);
    } catch (_) {}
    return structuredClone(DEFAULT_DB);
  }
  return fallbackRead();
}

async function saveDb(db) {
  const bs = blobStore();
  if (bs) {
    try {
      await bs.setJSON(BLOB_KEY, db);
      return;
    } catch (e) {
      console.warn('[rabbit-shop] blob setJSON:', e?.message || e);
    }
  }
  try {
    await fallbackWrite(db);
  } catch (e) {
    console.warn('[rabbit-shop] fallbackWrite:', e?.message || e);
  }
}

function sanitizeSnowflake(id) {
  const s = String(id ?? '').trim();
  if (!/^\d{17,21}$/.test(s)) throw new Error('invalid_discord_snowflake');
  return s;
}

function pruneDedupe(db) {
  const d = db.dedupe;
  const keys = Object.keys(d);
  const cap = 12_000;
  if (keys.length <= cap) return;
  keys.sort((a, b) => (Number(d[a]) || 0) - (Number(d[b]) || 0));
  const drop = keys.length - cap;
  for (let i = 0; i < drop; i++) delete d[keys[i]];
}

function pruneExpiredLists(db, nowIso) {
  for (const L of db.listings) {
    if (L.status !== 'active') continue;
    if (L.listingEndsAt && L.listingEndsAt < nowIso) L.status = 'expired';
  }
}

function pruneExpiredOffers(db, nowIso) {
  for (const o of db.offers) {
    if (o.status !== 'open') continue;
    if (o.offerEndsAt < nowIso) o.status = 'expired';
  }
}

function getBalance(db, uid) {
  const n = db.balances[uid];
  return typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 0;
}

function adjustBalance(db, uid, delta) {
  const next = getBalance(db, uid) + Math.floor(delta);
  if (next < 0) throw new Error('insufficient_rabbit_heads');
  db.balances[uid] = next;
  return next;
}

function listingById(db, id) {
  return db.listings.find((l) => l.id === id) || null;
}

function dispatch(db, payload) {
  const action = String(payload.action || '').trim();
  switch (action) {
    case 'listings_for_guild': {
      const guildId = sanitizeSnowflake(payload.guildId);
      const rows = db.listings
        .filter((l) => l.guildId === guildId && l.status === 'active')
        .slice(0, 50);
      return { ok: true, listings: rows };
    }
    case 'offers_for_guild': {
      const guildId = sanitizeSnowflake(payload.guildId);
      const activeIds = new Set(
        db.listings
          .filter((l) => l.guildId === guildId && l.status === 'active')
          .map((l) => l.id),
      );
      const offers = db.offers.filter(
        (o) => activeIds.has(o.listingId) && o.status === 'open',
      );
      return { ok: true, offers };
    }
    case 'balance_for_user': {
      const userId = sanitizeSnowflake(payload.userId);
      return { ok: true, balance: getBalance(db, userId), userId };
    }

    case 'earn_engagement': {
      requireSecret(payload);
      const userId = sanitizeSnowflake(payload.userId);
      const engagementKey = String(payload.engagementKey || '').trim().slice(0, 240);
      if (!engagementKey) throw new Error('engagementKey_required');

      pruneDedupe(db);
      if (db.dedupe[engagementKey])
        return { ok: true, duplicate: true, balance: getBalance(db, userId) };

      db.dedupe[engagementKey] = Date.now();
      adjustBalance(db, userId, ENGAGEMENT_AMOUNT);
      return {
        ok: true,
        earned: ENGAGEMENT_AMOUNT,
        balance: getBalance(db, userId),
      };
    }

    case 'create_listing': {
      requireSecret(payload);
      const guildId = sanitizeSnowflake(payload.guildId);
      const sellerId = sanitizeSnowflake(payload.sellerId);
      const commandKey = String(payload.commandKey ?? '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 96);
      const title = String(payload.title ?? '')
        .trim()
        .slice(0, 120);
      if (!commandKey) throw new Error('command_key_required');
      if (!title) throw new Error('title_required');
      let price = Math.floor(Number(payload.price));
      if (!(price >= 1) || price > 1_000_000_000) throw new Error('invalid_price');

      let listingEndsAt = '';
      const le = payload.listingEndsAt;
      if (le != null && String(le).trim()) {
        const t = Date.parse(String(le));
        if (!Number.isFinite(t)) throw new Error('invalid_listingEndsAt');
        listingEndsAt = new Date(t).toISOString();
      }
      const description = String(payload.description ?? '')
        .trim()
        .slice(0, 500);

      const row = {
        id: randomUUID(),
        guildId,
        sellerId,
        commandKey,
        title,
        description,
        price,
        listingEndsAt,
        createdAt: new Date().toISOString(),
        status: 'active',
      };
      db.listings.push(row);
      return { ok: true, listing: row };
    }

    case 'make_offer': {
      requireSecret(payload);
      const listingId = String(payload.listingId ?? '').trim();
      const listing = listingById(db, listingId);
      if (!listing || listing.status !== 'active')
        throw new Error('listing_unavailable');

      const fromUserId = sanitizeSnowflake(payload.fromUserId);
      if (fromUserId === listing.sellerId)
        throw new Error('cannot_offer_own_listing');

      let bidPrice = Math.floor(Number(payload.bidPrice));
      if (!(bidPrice >= 1)) throw new Error('invalid_offer_price');

      const offerEndsRaw = payload.offerEndsAt;
      if (!offerEndsRaw) throw new Error('offer_ends_required');
      const offerT = Date.parse(String(offerEndsRaw));
      if (!Number.isFinite(offerT)) throw new Error('invalid_offer_ends');

      const offerEndsAt = new Date(offerT).toISOString();
      if (offerEndsAt <= new Date().toISOString())
        throw new Error('offer_must_end_in_future');

      const note = String(payload.note ?? '').trim().slice(0, 400);
      const o = {
        id: randomUUID(),
        listingId: listing.id,
        guildId: listing.guildId,
        fromUserId,
        bidPrice,
        note,
        status: 'open',
        createdAt: new Date().toISOString(),
        offerEndsAt,
      };
      db.offers.push(o);
      return { ok: true, offer: o };
    }

    case 'buy_listing': {
      requireSecret(payload);
      const buyerId = sanitizeSnowflake(payload.buyerId);
      const listingId = String(payload.listingId ?? '').trim();
      const listing = listingById(db, listingId);
      if (!listing || listing.status !== 'active')
        throw new Error('listing_unavailable');

      if (listing.sellerId === buyerId) throw new Error('cannot_buy_own_listing');
      pruneExpiredLists(db, new Date().toISOString());
      if (listing.status !== 'active') throw new Error('listing_unavailable');

      const price = listing.price;
      adjustBalance(db, buyerId, -price);
      adjustBalance(db, listing.sellerId, price);
      listing.status = 'sold';
      listing.soldAt = new Date().toISOString();
      listing.buyerId = buyerId;
      return {
        ok: true,
        price,
        balance: getBalance(db, buyerId),
        listing,
      };
    }

    case 'withdraw_offer': {
      requireSecret(payload);
      const offerId = String(payload.offerId ?? '').trim();
      const uid = sanitizeSnowflake(payload.fromUserId);
      const o = db.offers.find((x) => x.id === offerId && x.fromUserId === uid);
      if (!o || o.status !== 'open') throw new Error('offer_not_found');
      o.status = 'withdrawn';
      return { ok: true, offer: o };
    }

    case 'accept_offer': {
      requireSecret(payload);
      const sellerId = sanitizeSnowflake(payload.sellerId);
      const offerId = String(payload.offerId ?? '').trim();
      const o = db.offers.find((x) => x.id === offerId);
      if (!o || o.status !== 'open')
        throw new Error('offer_unavailable');

      const listing = listingById(db, o.listingId);
      if (!listing || listing.sellerId !== sellerId || listing.status !== 'active')
        throw new Error('offer_not_yours_or_listing_bad');

      const nowIso = new Date().toISOString();
      pruneExpiredOffers(db, nowIso);
      if (o.status !== 'open' || o.offerEndsAt <= nowIso)
        throw new Error('offer_expired');

      adjustBalance(db, o.fromUserId, -o.bidPrice);
      adjustBalance(db, sellerId, o.bidPrice);
      listing.status = 'sold_via_offer';
      listing.soldAt = nowIso;
      listing.buyerId = o.fromUserId;
      o.status = 'accepted';

      return {
        ok: true,
        balanceSeller: getBalance(db, sellerId),
        buyerRenders: getBalance(db, o.fromUserId),
        listing,
      };
    }

    case 'delete_listing': {
      requireSecret(payload);
      const listingId = String(payload.listingId ?? '').trim();
      const sellerId = sanitizeSnowflake(payload.sellerId);
      const listing = listingById(db, listingId);
      if (!listing || listing.status !== 'active')
        throw new Error('listing_unavailable');
      if (listing.sellerId !== sellerId) throw new Error('listing_delete_forbidden');

      const nowIso = new Date().toISOString();
      for (const o of db.offers) {
        if (o.listingId === listing.id && o.status === 'open') {
          o.status = 'withdrawn';
          o.cancelledListingAt = nowIso;
        }
      }

      listing.status = 'cancelled';
      listing.cancelledAt = nowIso;
      return { ok: true, listing };
    }

    default:
      throw new Error(`unknown_action:${action}`);
  }
}

function requireSecret(payload) {
  if (!SECRET) throw new Error('hub_secret_not_configured');
  if (payload.secret !== SECRET) throw new Error('unauthorized');
}

/** Never throw to Netlify bare — bare throws become HTTP 502 on the gateway. */
async function handleShopEvent(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST')
    return corsJson(405, { ok: false, error: 'use_post_json' });

  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
    if (!body || typeof body !== 'object') body = {};
  } catch {
    return corsJson(400, { ok: false, error: 'invalid_json' });
  }

  const nowIso = new Date().toISOString();

  try {
    const db = await loadDb();
    pruneExpiredLists(db, nowIso);
    pruneExpiredOffers(db, nowIso);

    const out = dispatch(db, body);
    await saveDb(db);
    return corsJson(200, out);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'hub_error';
    const code =
      msg === 'unauthorized' ? 401
      : msg === 'hub_secret_not_configured' ? 503
      : /^invalid_|missing|must_end|listing_|offer_|insufficient|cannot_buy|cannot_offer/.test(msg) ? 400
      : 500;

    return corsJson(code, { ok: false, error: msg });
  }
}

export const handler = async (event) => {
  try {
    return await handleShopEvent(event);
  } catch (fatal) {
    console.error('[rabbit-shop] fatal', fatal?.stack || fatal);
    const msg =
      fatal && fatal.message
        ? String(fatal.message).slice(0, 220)
        : 'rabbit_shop_fatal';
    return corsJson(500, { ok: false, error: msg });
  }
};
