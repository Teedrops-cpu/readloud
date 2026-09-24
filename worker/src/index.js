// Readloud TTS proxy — holds the OpenAI key privately, verifies Gumroad
// license keys, and tracks each account's remaining character balance.
//
// Two routes:
//   POST /speak          { licenseKey, text, voice } -> audio/mpeg
//   POST /redeem-topup   { baseLicenseKey, topupLicenseKey } -> new balance
//
// A Base Pack license key IS the account: its balance lives at
// `license:{key}` in the LICENSES KV. A Top-up key isn't an account on its
// own — it's a one-time code that, once redeemed, adds credit to an
// existing base account and is then marked spent so it can't be reused.

const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const MAX_CHARS_PER_REQUEST = 4000; // OpenAI's own input cap for /v1/audio/speech

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// Rough, non-strict daily budget tracker — a safety net against a global
// runaway (a bug, an abused/stolen license), layered ON TOP of the real
// per-account balances below. Not precise under heavy concurrency; that's
// fine, it's a ceiling, not a meter.
async function checkAndReserveDailyBudget(env, chars) {
  const dateKey = `usage:${new Date().toISOString().slice(0, 10)}`;
  const limit = Number(env.DAILY_CHAR_LIMIT || 0);
  const usedStr = await env.TTS_USAGE.get(dateKey);
  const used = usedStr ? parseInt(usedStr, 10) : 0;
  if (limit && used + chars > limit) return false;
  await env.TTS_USAGE.put(dateKey, String(used + chars), { expirationTtl: 60 * 60 * 48 });
  return true;
}

// Calls Gumroad's public license verification endpoint. No access token
// needed for this — just the product ID and the key the customer got at
// checkout. increment_uses_count is off since we track usage ourselves.
async function verifyGumroadLicense(productId, licenseKey) {
  const res = await fetch('https://api.gumroad.com/v2/licenses/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      product_id: productId,
      license_key: licenseKey,
      increment_uses_count: 'false',
    }),
  });
  const data = await res.json().catch(() => null);
  if (!data || !data.success) return { valid: false };
  const p = data.purchase || {};
  if (p.refunded || p.chargebacked || p.disputed) return { valid: false };
  return { valid: true, purchase: p };
}

// Re-checks an existing account against Gumroad at most once per
// REVERIFY_HOURS. If the purchase has since been refunded, charged back,
// or its license disabled in Gumroad, the account is permanently revoked.
async function ensureStillValid(env, licenseKey, account) {
  if (account.revoked) return false;
  const maxAgeMs = Number(env.REVERIFY_HOURS || 24) * 60 * 60 * 1000;
  if (account.lastVerifiedAt && Date.now() - account.lastVerifiedAt < maxAgeMs) return true;
  const check = await verifyGumroadLicense(env.GUMROAD_BASE_PRODUCT_ID, licenseKey);
  if (!check.valid) {
    account.revoked = true;
    account.revokedAt = Date.now();
    await saveBalance(env, licenseKey, account);
    return false;
  }
  account.lastVerifiedAt = Date.now();
  await saveBalance(env, licenseKey, account);
  return true;
}
function revokedResponse(cors) {
  return json({ error: 'This license is no longer active (refunded or disabled).', code: 'revoked' }, 401, cors);
}

async function getBalance(env, licenseKey) {
  const raw = await env.LICENSES.get(`license:${licenseKey}`);
  return raw ? JSON.parse(raw) : null;
}
async function saveBalance(env, licenseKey, record) {
  await env.LICENSES.put(`license:${licenseKey}`, JSON.stringify(record));
}

// ---------- one-active-device-per-license ----------
// Each account remembers the one device (a random ID the app generates
// and keeps in the browser) it's currently bound to. Any other device is
// refused until the owner explicitly moves the license, which is rate-
// limited so a key can't be passed back and forth between people.
function deviceMismatch(cors) {
  return json({
    error: 'This license is active on another device. Use "Move license to this device" to switch.',
    code: 'device_mismatch',
  }, 403, cors);
}
// Returns true if the account is (or has just become) bound to deviceId.
function bindOrCheckDevice(account, deviceId) {
  if (!account.deviceId) { account.deviceId = deviceId; account.deviceBoundAt = Date.now(); return true; }
  return account.deviceId === deviceId;
}
function cleanDeviceId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v.trim()) ? v.trim() : '';
}

async function handleSpeak(request, env, cors) {
  let body;
  try { body = await request.json(); } catch (e) {
    return json({ error: 'invalid JSON body' }, 400, cors);
  }

  const licenseKey = typeof body.licenseKey === 'string' ? body.licenseKey.trim() : '';
  const deviceId = cleanDeviceId(body.deviceId);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const voice = VOICES.includes(body.voice) ? body.voice : 'alloy';

  if (!licenseKey) return json({ error: 'licenseKey is required' }, 400, cors);
  if (!deviceId) return json({ error: 'deviceId is required — please refresh the app' }, 400, cors);
  if (!text) return json({ error: 'text is required' }, 400, cors);
  if (text.length > MAX_CHARS_PER_REQUEST) {
    return json({ error: `text exceeds ${MAX_CHARS_PER_REQUEST} character limit per request` }, 400, cors);
  }

  // Load (or lazily create) this account's balance.
  let account = await getBalance(env, licenseKey);
  if (!account) {
    const check = await verifyGumroadLicense(env.GUMROAD_BASE_PRODUCT_ID, licenseKey);
    if (!check.valid) {
      return json({ error: 'invalid or inactive license key' }, 401, cors);
    }
    account = { charsRemaining: Number(env.BASE_PACK_CHARS || 0), createdAt: Date.now(), lastVerifiedAt: Date.now() };
    await saveBalance(env, licenseKey, account);
  } else if (!(await ensureStillValid(env, licenseKey, account))) {
    return revokedResponse(cors);
  }

  const wasUnbound = !account.deviceId;
  if (!bindOrCheckDevice(account, deviceId)) return deviceMismatch(cors);
  if (wasUnbound) await saveBalance(env, licenseKey, account);

  if (account.charsRemaining < text.length) {
    return json({ error: 'out of premium narration credit — buy a top-up pack to continue' }, 402, cors);
  }

  const withinDailyBudget = await checkAndReserveDailyBudget(env, text.length);
  if (!withinDailyBudget) {
    return json({ error: 'daily voice budget reached — try again tomorrow, or use the free voice for now' }, 429, cors);
  }

  const openaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'tts-1', voice, input: text, response_format: 'mp3' }),
  });

  if (!openaiRes.ok) {
    const detail = await openaiRes.text();
    return json({ error: 'upstream TTS request failed', detail }, 502, cors);
  }

  // Only deduct after OpenAI actually succeeded — a failed generation
  // shouldn't cost the customer their credit.
  account.charsRemaining -= text.length;
  account.lastUsed = Date.now();
  await saveBalance(env, licenseKey, account);

  return new Response(openaiRes.body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-Chars-Remaining': String(account.charsRemaining),
    },
  });
}

async function handleRedeemTopup(request, env, cors) {
  let body;
  try { body = await request.json(); } catch (e) {
    return json({ error: 'invalid JSON body' }, 400, cors);
  }
  const baseLicenseKey = typeof body.baseLicenseKey === 'string' ? body.baseLicenseKey.trim() : '';
  const topupLicenseKey = typeof body.topupLicenseKey === 'string' ? body.topupLicenseKey.trim() : '';
  const deviceId = cleanDeviceId(body.deviceId);
  if (!deviceId) return json({ error: 'deviceId is required — please refresh the app' }, 400, cors);

  if (!baseLicenseKey || !topupLicenseKey) {
    return json({ error: 'baseLicenseKey and topupLicenseKey are both required' }, 400, cors);
  }

  // The base key must be a real, active account (create it if this is
  // someone's very first redemption before ever calling /speak).
  let account = await getBalance(env, baseLicenseKey);
  if (!account) {
    const baseCheck = await verifyGumroadLicense(env.GUMROAD_BASE_PRODUCT_ID, baseLicenseKey);
    if (!baseCheck.valid) return json({ error: 'invalid or inactive base license key' }, 401, cors);
    account = { charsRemaining: Number(env.BASE_PACK_CHARS || 0), createdAt: Date.now(), lastVerifiedAt: Date.now() };
  } else if (!(await ensureStillValid(env, baseLicenseKey, account))) {
    return revokedResponse(cors);
  }
  if (!bindOrCheckDevice(account, deviceId)) return deviceMismatch(cors);

  // The top-up key must not have been redeemed before, anywhere.
  const alreadyRedeemed = await env.LICENSES.get(`redeemed:${topupLicenseKey}`);
  if (alreadyRedeemed) {
    return json({ error: 'this top-up code has already been redeemed' }, 409, cors);
  }

  const topupCheck = await verifyGumroadLicense(env.GUMROAD_TOPUP_PRODUCT_ID, topupLicenseKey);
  if (!topupCheck.valid) {
    return json({ error: 'invalid or inactive top-up license key' }, 401, cors);
  }

  account.charsRemaining += Number(env.TOPUP_CHARS || 0);
  await saveBalance(env, baseLicenseKey, account);
  await env.LICENSES.put(`redeemed:${topupLicenseKey}`, JSON.stringify({
    redeemedAt: Date.now(), appliedToBaseKey: baseLicenseKey,
  }));

  return json({ ok: true, charsRemaining: account.charsRemaining }, 200, cors);
}

// Moves a license to the calling device. Rate-limited: after a move, the
// license can't be moved again for TRANSFER_COOLDOWN_DAYS. A real owner
// switching phones or clearing their browser is unaffected; two people
// trying to share one key keep kicking each other off and then get stuck.
async function handleTransferDevice(request, env, cors) {
  let body;
  try { body = await request.json(); } catch (e) {
    return json({ error: 'invalid JSON body' }, 400, cors);
  }
  const licenseKey = typeof body.licenseKey === 'string' ? body.licenseKey.trim() : '';
  const deviceId = cleanDeviceId(body.deviceId);
  if (!licenseKey || !deviceId) return json({ error: 'licenseKey and deviceId are required' }, 400, cors);

  let account = await getBalance(env, licenseKey);
  if (!account) {
    const check = await verifyGumroadLicense(env.GUMROAD_BASE_PRODUCT_ID, licenseKey);
    if (!check.valid) return json({ error: 'invalid or inactive license key' }, 401, cors);
    account = { charsRemaining: Number(env.BASE_PACK_CHARS || 0), createdAt: Date.now() };
  } else {
    // Re-verify on every move so a refunded license can't be kept alive.
    if (account.revoked) return revokedResponse(cors);
    const check = await verifyGumroadLicense(env.GUMROAD_BASE_PRODUCT_ID, licenseKey);
    if (!check.valid) {
      account.revoked = true; account.revokedAt = Date.now();
      await saveBalance(env, licenseKey, account);
      return revokedResponse(cors);
    }
    account.lastVerifiedAt = Date.now();
  }

  if (account.deviceId === deviceId) {
    return json({ ok: true, charsRemaining: account.charsRemaining, alreadyHere: true }, 200, cors);
  }

  const cooldownMs = Number(env.TRANSFER_COOLDOWN_DAYS || 7) * 24 * 60 * 60 * 1000;
  if (account.deviceId && account.lastTransferAt && Date.now() - account.lastTransferAt < cooldownMs) {
    const nextAllowed = new Date(account.lastTransferAt + cooldownMs).toISOString().slice(0, 10);
    return json({
      error: `This license was moved recently. It can be moved again on ${nextAllowed}.`,
      code: 'transfer_cooldown',
    }, 429, cors);
  }

  if (account.deviceId) account.lastTransferAt = Date.now(); // first-ever bind isn't a "move"
  account.deviceId = deviceId;
  account.deviceBoundAt = Date.now();
  await saveBalance(env, licenseKey, account);
  return json({ ok: true, charsRemaining: account.charsRemaining }, 200, cors);
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors);

    const url = new URL(request.url);
    if (url.pathname === '/redeem-topup') return handleRedeemTopup(request, env, cors);
    if (url.pathname === '/transfer-device') return handleTransferDevice(request, env, cors);
    return handleSpeak(request, env, cors); // default route: /speak (and /)
  },
};
