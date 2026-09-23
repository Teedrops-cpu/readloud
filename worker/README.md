# readloud-tts-proxy

A minimal Cloudflare Worker that proxies text-to-speech requests to OpenAI.
This exists for one reason: an API key can never live in browser code, so
this Worker holds it privately and the app talks to this instead.

## Deploy

```bash
npm install -g wrangler   # if you don't have it
wrangler login
wrangler kv namespace create TTS_USAGE
# paste the returned id into wrangler.toml under [[kv_namespaces]]

wrangler secret put OPENAI_API_KEY
wrangler secret put APP_SHARED_KEY   # make up any long random string yourself

wrangler deploy
```

Deploy prints your Worker's URL — something like
`https://readloud-tts-proxy.<your-subdomain>.workers.dev`. That's what
goes into the app's `PREMIUM_TTS_ENDPOINT` constant.

## Honest security note

`APP_SHARED_KEY` is embedded in the app's client-side JS, which means
anyone who opens dev tools can read it and call this Worker directly,
bypassing the app entirely. It stops casual abuse, not a determined
person. The real backstop is `DAILY_CHAR_LIMIT` in `wrangler.toml` —
a hard ceiling on total spend per day regardless of who's calling it.
Raise or lower it based on what you're comfortable risking before
proper per-user licensing (stage 5) replaces the shared key entirely.
