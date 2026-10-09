# Changelog

Notable changes per public release. Release notes live in
[GitHub Releases](https://github.com/MaxChen12114/OwnChat/releases).

## Unreleased

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
