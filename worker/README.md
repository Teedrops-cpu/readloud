# readloud-tts-proxy

A Cloudflare Worker that proxies text-to-speech to OpenAI, gated by real
Gumroad license keys. Two routes:

- `POST /speak` — `{ licenseKey, text, voice }` → audio/mpeg. Verifies the
  key against your Base Pack product on first use, then tracks a character
  balance for it going forward.
- `POST /redeem-topup` — `{ baseLicenseKey, topupLicenseKey }` → adds the
  Top-up pack's page credit to an existing base account, and marks the
  top-up key as spent so it can't be redeemed twice.

## Deploy

```bash
npm install -g wrangler   # if you don't have it
wrangler login

wrangler kv namespace create TTS_USAGE
wrangler kv namespace create LICENSES
# paste both returned ids into wrangler.toml under their [[kv_namespaces]] blocks

wrangler secret put OPENAI_API_KEY

wrangler deploy
```

Deploy prints your Worker's URL — something like
`https://readloud-tts-proxy.<your-subdomain>.workers.dev`. That's what goes
into the app's `PREMIUM_TTS_BASE` constant (no trailing slash — the app
appends `/speak` and `/redeem-topup` itself).

`wrangler.toml` already has your real Gumroad product IDs and the
per-purchase character budgets (`BASE_PACK_CHARS`, `TOPUP_CHARS`) — tune
those if real pages run denser or sparser than the ~2,500 char/page
assumption they're based on.

## What changed from the earlier shared-key version

There's no more `APP_SHARED_KEY` — Gumroad's own license verification
*is* the gate now, and it's real: nobody can fabricate a license key that
matches an actual, unrefunded purchase. A leaked license only exposes
that one customer's remaining balance, not your whole app.

Gumroad's public license-verify endpoint only needs your product ID and
the customer's key — no access token required, so none is stored here.
(An access token would only matter for a future nice-to-have like
auto-revoking a license on refund — not needed for this to work.)

`DAILY_CHAR_LIMIT` from before is still here as a second, global safety
net layered on top of the real per-account balances — cheap insurance
against a bug or a single compromised license being hammered in one day.
