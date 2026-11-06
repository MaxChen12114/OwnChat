# Changelog

Notable changes per public release. Release notes live in
[GitHub Releases](https://github.com/MaxChen12114/OwnChat/releases).

## Unreleased

- **Image channels (data-driven)** — image generation is no longer hardwired to Gitee. Settings →
  Model API → Image channels now manages a channel list (built-in Gitee preset plus user-defined
  OpenAI-compatible endpoints — browser-direct, CORS required — and local ComfyUI servers), with the
  same list/detail layout as chat channels. Saving a channel does not switch to it; use **Use this
  channel**. The image workshop and the studio page follow the active channel and expose a model
  dropdown; Gitee remains the only editing path (`Qwen-Image-Edit-2511`). Channel settings and keys
  stay on-device.
- **Docs: images & voice in plain words** — the README now states what the image features actually
  use (your own **Gitee AI** key via the built-in proxy; `z-image-turbo` / `Qwen-Image-Edit-2511` /
  `Wan2_2-I2V-A14B`; ~100 images/day free tier; other image providers were not supported at the time) and how
  desktop TTS works (local GPT-SoVITS `api_v2` on 9880, tray start/auto-start, local reference audio).
  Community resources gained a TTS-backend entry (GPT-SoVITS + other self-hosted options, with the
  usual caveats about differing HTTP shapes and model-weight licenses).
- **Security: image proxy requires login again** — `/img/v1/*` and `/img/dl` now go through the same
  access check as `/api/*`: on deployments that set `CHAT_PASSWORD`, requests must carry the app's
  login token (`X-Sync-Token`); deployments without a password are unchanged. Before this, anyone
  could use a deployment as a free image proxy.
- **Fix: video tool read the wrong key** — it only looked at the legacy `moark_api_key`, so users who
  saved their key through Settings → Image API Key saw "no key found". It now reads the current key
  first, with the legacy key as fallback.

- **Setup page redesign** — the first-run window (the domain-neutral shell's setup page) got a proper
  product look: brand mark + version chip, the app's own neutral palette (the old indigo violated the
  project's no-purple rule), the app's font stack, a spinner on Connect, and two clearly separated
  one-click paths instead of a plain form.
- **Run it on your own PC** — no domain, no Cloudflare account: `start-local.cmd` (Windows, double-click)
  and `start-local.sh` bootstrap a local server on `http://127.0.0.1:8787` (creates `.dev.vars` and opens
  it for your model key). The setup page gained a "Fill in the local address" button, and addresses like
  `127.0.0.1:8787` now default to `http://` instead of `https://` (both in the shell and the page). See
  README → "Run it on your own PC".

- **Two base folders** — base prompts now live in two directories, and the top-bar button switches
  between them: `src/prompts/bases/` (**Built-in**, ships one general-purpose base) and
  `src/prompts/custom/` (**Custom**, the one you keep for yourself — empty by default, falls back to
  the built-in default while it is). Pick the active entry per folder in Settings → 对话 → 基座.
  Keep `custom/` out of any public fork (see README).
- **Mobile fixes** — the Agent bottom panel no longer covers the top bar; the drawer backdrop no
  longer swallows top-bar taps; the conversation list renders its "New chat" entry even when the
  app starts hidden in the background.
- **Localized** — gallery "saved" toasts and the thinking-effort menu are translated with the
  English UI.

## 4.71.0 — 2026-10-07

First public release.

- **Chat & roleplay** — character cards (SillyTavern V1/V2/V3 and PNG cards import/export),
  lorebooks, affinity tracking, group chat, multi-agent orchestration, branching conversations.
- **Agent mode** — a real tool-calling loop: web search / page fetch, a virtual file workspace,
  image sending, ambient-audio direction, an on-screen run console.
- **Creation tools** — long-form writing, code collaboration, node-based flow, story studio,
  image generation/editing (BYO OpenAI-compatible provider), local TTS (GPT-SoVITS on desktop).
- **Prompt libraries** — base prompts, reusable instruction modules, and skills with three-level
  disclosure; everything editable from the UI.
- **Ambient audio** — two independent decks (environment × music) with bundled CC0 tracks.
- **Themes** — minimal / glass / candle, per device.
- **Self-hosted by design** — Cloudflare Workers deployment (free tier is fine), your KV, your
  model keys; the Tauri desktop shell and an Android build for the app.
