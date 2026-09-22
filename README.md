# Readloud

Your PDFs, read aloud — runs entirely in the browser, free, installable as a PWA.

## What it is
- Drop in a PDF, it's read aloud using your browser's built-in text-to-speech
- Sentence/clause-aware chunking so speech keeps natural pauses and intonation
- Follow-along highlighter, 5s/10s seek, chapter menu (from PDF outline or manual markers)
- Resumes where you left off (stored locally via IndexedDB — nothing uploaded)
- Sleep timer
- Installable as a Progressive Web App with offline app-shell caching

## Local development
No build step — it's a static site. To test the service worker and install
behavior (these require a real HTTP origin, not `file://`):

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000

## Deployment
Auto-deploys to Cloudflare Pages via GitHub Actions on every push to `main`.
See `.github/workflows/deploy.yml`. Requires two repo secrets:
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Stack
Static HTML/CSS/JS, [pdf.js](https://mozilla.github.io/pdf.js/) for text
extraction, the Web Speech API for narration. No backend, no server costs.
