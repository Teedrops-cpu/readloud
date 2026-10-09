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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-Chars-Remaining',
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

// Returns the account's remaining characters without generating audio.
// Doesn't bind a device (only real use does), but won't reveal a balance to
// a device other than the bound one.
async function handleBalance(request, env, cors) {
  let body;
  try { body = await request.json(); } catch (e) {
    return json({ error: 'invalid JSON body' }, 400, cors);
  }
  const licenseKey = typeof body.licenseKey === 'string' ? body.licenseKey.trim() : '';
  const deviceId = cleanDeviceId(body.deviceId);
  if (!licenseKey || !deviceId) return json({ error: 'licenseKey and deviceId are required' }, 400, cors);

  const account = await getBalance(env, licenseKey);
  if (!account) {
    // Bought but never used yet: confirm it's real, report the full pack.
    const check = await verifyGumroadLicense(env.GUMROAD_BASE_PRODUCT_ID, licenseKey);
    if (!check.valid) return json({ error: 'invalid or inactive license key' }, 401, cors);
    return json({ charsRemaining: Number(env.BASE_PACK_CHARS || 0) }, 200, cors);
  }
  if (!(await ensureStillValid(env, licenseKey, account))) return revokedResponse(cors);
  if (account.deviceId && account.deviceId !== deviceId) return deviceMismatch(cors);
  return json({ charsRemaining: account.charsRemaining }, 200, cors);
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

// ---------------------------------------------------------------------------
// Pricing survey (premium on hold). Answers are stored as survey:{deviceId},
// one per device (a new answer replaces the old one). Country comes from
// Cloudflare; the IP is never stored, only a hash used for a daily rate limit.
// ---------------------------------------------------------------------------
const SURVEY_OPTIONS = {
  price:   ['free', 'lt3', '3to6', '6to10', '10to15', 'gt15'],
  reading: ['light', 'book', 'heavy'],
  model:   ['pack', 'monthly', 'either'],
};
const SURVEY_LABELS = {
  price: { free: 'Nothing (free voice is enough)', lt3: 'Under $3', '3to6': '$3 to $6', '6to10': '$6 to $10', '10to15': '$10 to $15', gt15: 'Over $15' },
  reading: { light: 'A few pages a week', book: 'About a book a month', heavy: 'Several books a month' },
  model: { pack: 'Pay once for a pack', monthly: 'Monthly plan, more pages', either: 'No preference' },
};
const SURVEY_MAX_PER_IP_PER_DAY = 5;

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handleSurvey(request, env, cors) {
  let body;
  try { body = await request.json(); } catch (e) {
    return json({ error: 'invalid JSON body' }, 400, cors);
  }
  const deviceId = cleanDeviceId(body.deviceId);
  if (!deviceId) return json({ error: 'deviceId is required — please refresh the app' }, 400, cors);

  const pick = (field) => (SURVEY_OPTIONS[field].includes(body[field]) ? body[field] : null);
  const price = pick('price'), reading = pick('reading'), model = pick('model');
  if (!price || !reading || !model) return json({ error: 'Please answer the three questions.' }, 400, cors);

  let email = typeof body.email === 'string' ? body.email.trim() : '';
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return json({ error: 'That email address doesn\'t look right. Leave it empty if you prefer.' }, 400, cors);
  }
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';
  const currency = body.currency === 'NGN' ? 'NGN' : 'USD'; // which prices they were shown

  // One set of answers per device: no changing them afterwards.
  if (await env.LICENSES.get(`survey:${deviceId}`)) {
    return json({ error: 'Your answers are already recorded. Thank you.' }, 409, cors);
  }

  // Daily rate limit per IP (hashed, expires after two days).
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const rlKey = `survey-ip:${(await sha256Hex(ip + '|' + day)).slice(0, 32)}`;
  const count = parseInt((await env.TTS_USAGE.get(rlKey)) || '0', 10);
  if (count >= SURVEY_MAX_PER_IP_PER_DAY) {
    return json({ error: 'Thanks, we already have your answers for today.' }, 429, cors);
  }
  await env.TTS_USAGE.put(rlKey, String(count + 1), { expirationTtl: 60 * 60 * 48 });

  const country = (request.cf && request.cf.country) || 'XX';
  await env.LICENSES.put(`survey:${deviceId}`, JSON.stringify({
    price, reading, model, email, comment, country, currency, at: new Date().toISOString(),
  }));
  return json({ ok: true }, 200, cors);
}

// Tells the app the visitor's country and the naira rate used for survey
// prices. Change NGN_PER_USD in wrangler.toml and redeploy when the rate moves.
function handleGeo(request, env, cors) {
  const country = (request.cf && request.cf.country) || 'XX';
  const ngnPerUsd = Number(env.NGN_PER_USD || 1400);
  return json({ country, ngnPerUsd }, 200, { ...cors, 'Cache-Control': 'no-store' });
}

// One fixed sample per voice, generated once, then served from storage.
const SAMPLE_TEXT = 'The train pulled out of the station just after six. Ada opened the report she had been avoiding all week, pressed play, and leaned back. For the first time in days, the pages moved without her having to push them along.';
async function handleSample(request, env) {
  const url = new URL(request.url);
  const voice = VOICES.includes(url.searchParams.get('voice')) ? url.searchParams.get('voice') : 'alloy';
  const key = `sample:v1:${voice}`;
  const headers = { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' };

  const cached = await env.LICENSES.get(key, { type: 'arrayBuffer' });
  if (cached) return new Response(cached, { status: 200, headers });

  if (!(await checkAndReserveDailyBudget(env, SAMPLE_TEXT.length))) {
    return new Response('sample unavailable right now', { status: 429, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  const openaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1', voice, input: SAMPLE_TEXT, response_format: 'mp3' }),
  });
  if (!openaiRes.ok) {
    return new Response('sample unavailable right now', { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  const audio = await openaiRes.arrayBuffer();
  await env.LICENSES.put(key, audio);
  return new Response(audio, { status: 200, headers });
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function csvCell(v) {
  let t = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // stop spreadsheet formula injection
  return '"' + t.replace(/"/g, '""') + '"';
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function loadSurveyAnswers(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.LICENSES.list({ prefix: 'survey:', cursor });
    keys.push(...page.keys.map(k => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const out = [];
  for (let i = 0; i < keys.length; i += 50) {
    const vals = await Promise.all(keys.slice(i, i + 50).map(k => env.LICENSES.get(k)));
    vals.forEach(v => { try { if (v) out.push(JSON.parse(v)); } catch (e) {} });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

async function handleSurveyResults(request, env) {
  const url = new URL(request.url);
  const privateHeaders = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' };
  if (!env.SURVEY_RESULTS_KEY) {
    return new Response('Results are not set up yet: run  wrangler secret put SURVEY_RESULTS_KEY', { status: 503, headers: privateHeaders });
  }
  if (!timingSafeEqual(url.searchParams.get('key') || '', env.SURVEY_RESULTS_KEY)) {
    return new Response('Not found', { status: 404, headers: privateHeaders });
  }
  const answers = await loadSurveyAnswers(env);

  if (url.searchParams.get('format') === 'csv') {
    const rows = [['date', 'country', 'shown_prices_in', 'would_pay', 'reads', 'prefers', 'email', 'comment']]
      .concat(answers.map(a => [a.at, a.country, a.currency || 'USD', SURVEY_LABELS.price[a.price], SURVEY_LABELS.reading[a.reading], SURVEY_LABELS.model[a.model], a.email, a.comment]));
    return new Response(rows.map(r => r.map(csvCell).join(',')).join('\n'), {
      status: 200, headers: { ...privateHeaders, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="readloud-survey.csv"' },
    });
  }

  const count = (list, field) => {
    const c = Object.fromEntries(SURVEY_OPTIONS[field].map(o => [o, 0]));
    list.forEach(a => { if (a[field] in c) c[a[field]]++; });
    return c;
  };
  const bars = (list, field) => {
    const c = count(list, field), n = list.length || 1;
    return '<table>' + SURVEY_OPTIONS[field].map(o => {
      const pct = Math.round((c[o] / n) * 100);
      return `<tr><td>${escapeHtml(SURVEY_LABELS[field][o])}</td><td class="bar"><span style="width:${pct}%"></span></td><td class="num">${c[o]} <small>(${pct}%)</small></td></tr>`;
    }).join('') + '</table>';
  };
  const ng = answers.filter(a => a.country === 'NG'), rest = answers.filter(a => a.country !== 'NG');
  const byCountry = {};
  answers.forEach(a => { byCountry[a.country] = (byCountry[a.country] || 0) + 1; });
  const countryRows = Object.entries(byCountry).sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `<tr><td>${escapeHtml(c)}</td><td class="num">${n}</td></tr>`).join('');
  const readingSplit = SURVEY_OPTIONS.reading.map(r => {
    const group = answers.filter(a => a.reading === r);
    return `<h3>${escapeHtml(SURVEY_LABELS.reading[r])} <small>(${group.length})</small></h3>${group.length ? bars(group, 'price') : '<p class="muted">No answers yet.</p>'}`;
  }).join('');
  const people = answers.filter(a => a.email || a.comment).map(a =>
    `<tr><td>${escapeHtml(a.at.slice(0, 10))}</td><td>${escapeHtml(a.country)}</td><td>${escapeHtml(SURVEY_LABELS.price[a.price])}</td><td>${escapeHtml(a.email)}</td><td>${escapeHtml(a.comment)}</td></tr>`).join('');
  const inNaira = answers.filter(a => a.currency === 'NGN').length;
  const csvHref = `?key=${encodeURIComponent(url.searchParams.get('key'))}&format=csv`;

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Readloud survey results</title>
<style>
:root{--ink:#ece7dd;--bg:#17181a;--card:#1f201d;--rule:#38372f;--muted:#a39c8c;--accent:#5aab92}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
h1{font-family:Georgia,serif;font-size:1.7rem;margin:0 0 4px}h2{font-size:1.1rem;margin:32px 0 10px}h3{font-size:0.95rem;margin:18px 0 6px}
.card{background:var(--card);border:1px solid var(--rule);border-radius:8px;padding:14px 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:top}
td.num{text-align:right;white-space:nowrap}td.bar{width:40%}td.bar span{display:block;height:10px;border-radius:5px;background:var(--accent);min-width:2px}
.muted,small{color:var(--muted)}a{color:var(--accent)}.wide{overflow-x:auto}
</style></head><body><main>
<h1>Readloud pricing survey</h1>
<p class="muted">${answers.length} response${answers.length === 1 ? '' : 's'}${answers.length < 30 ? '. Wait for about 30 before trusting the pattern.' : '.'} ${inNaira} answered with naira prices (same brackets, converted at ₦${Number(env.NGN_PER_USD || 1400).toLocaleString('en')} per dollar). <a href="${csvHref}">Download CSV</a></p>
<h2>What people would pay once, for about 100 pages</h2><div class="card">${bars(answers, 'price')}</div>
<h2>Nigeria vs everywhere else</h2><div class="grid">
<div class="card"><h3>Nigeria <small>(${ng.length})</small></h3>${ng.length ? bars(ng, 'price') : '<p class="muted">No answers yet.</p>'}</div>
<div class="card"><h3>Everywhere else <small>(${rest.length})</small></h3>${rest.length ? bars(rest, 'price') : '<p class="muted">No answers yet.</p>'}</div></div>
<h2>By how much people read</h2><div class="card">${readingSplit}</div>
<div class="grid"><div><h2>Pack or monthly plan?</h2><div class="card">${bars(answers, 'model')}</div></div>
<div><h2>Countries</h2><div class="card"><table>${countryRows || '<tr><td class="muted">None yet</td></tr>'}</table></div></div></div>
<h2>Launch list and comments</h2><div class="card wide"><table><tr><th>Date</th><th>Country</th><th>Would pay</th><th>Email</th><th>Comment</th></tr>${people || '<tr><td colspan="5" class="muted">None yet</td></tr>'}</table></div>
</main></body></html>`;
  return new Response(html, { status: 200, headers: { ...privateHeaders, 'Content-Type': 'text/html; charset=utf-8' } });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (request.method === 'GET') {
      if (url.pathname === '/sample') return handleSample(request, env);
      if (url.pathname === '/geo') return handleGeo(request, env, cors);
      if (url.pathname === '/survey-results') return handleSurveyResults(request, env);
    }
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors);
    if (url.pathname === '/survey') return handleSurvey(request, env, cors);
    if (url.pathname === '/redeem-topup') return handleRedeemTopup(request, env, cors);
    if (url.pathname === '/transfer-device') return handleTransferDevice(request, env, cors);
    if (url.pathname === '/balance') return handleBalance(request, env, cors);
    return handleSpeak(request, env, cors); // default route: /speak (and /)
  },
};
