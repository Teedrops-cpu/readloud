// Readloud TTS proxy — the ONLY place the OpenAI API key ever lives.
// The app never talks to OpenAI directly; it talks to this Worker,
// which talks to OpenAI on its behalf and streams the audio back.

const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const MAX_CHARS_PER_REQUEST = 4000; // OpenAI's own input cap for /v1/audio/speech

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Key',
    'Vary': 'Origin',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// Rough, non-strict daily budget tracker using KV. This is a safety net
// against runaway cost (a leaked key, a bug, a bad actor) — not a precise
// per-user metering system. KV writes aren't perfectly atomic under heavy
// concurrency, so treat DAILY_CHAR_LIMIT as "roughly this much," not exact.
async function checkAndReserveBudget(env, chars) {
  const dateKey = `usage:${new Date().toISOString().slice(0, 10)}`;
  const limit = Number(env.DAILY_CHAR_LIMIT || 0);
  const usedStr = await env.TTS_USAGE.get(dateKey);
  const used = usedStr ? parseInt(usedStr, 10) : 0;
  if (limit && used + chars > limit) return { ok: false, used, limit };
  await env.TTS_USAGE.put(dateKey, String(used + chars), { expirationTtl: 60 * 60 * 48 });
  return { ok: true, used: used + chars, limit };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405, cors);
    }

    // Casual deterrent only — see the note in the project README about
    // why a client-side app can never truly hide this key.
    const appKey = request.headers.get('X-App-Key');
    if (!env.APP_SHARED_KEY || appKey !== env.APP_SHARED_KEY) {
      return json({ error: 'unauthorized' }, 401, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'invalid JSON body' }, 400, cors);
    }

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const voice = VOICES.includes(body.voice) ? body.voice : 'alloy';

    if (!text) return json({ error: 'text is required' }, 400, cors);
    if (text.length > MAX_CHARS_PER_REQUEST) {
      return json({ error: `text exceeds ${MAX_CHARS_PER_REQUEST} character limit per request` }, 400, cors);
    }

    const budget = await checkAndReserveBudget(env, text.length);
    if (!budget.ok) {
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

    return new Response(openaiRes.body, {
      status: 200,
      headers: { ...cors, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  },
};
