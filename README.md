# OwnChat

**English** | [中文](README.zh-CN.md)

A self-hosted AI creation platform for roleplay, long-form writing, coding and image/voice work — deploy it to your own Cloudflare account and keep your data and API keys to yourself.

![OwnChat · agent mode (glass theme)](docs/screenshots/chat-agent.en.png)

## Screenshots

| Agent mode — tool calls, approvals, image replies (glass) | Multi-agent group chat (candle) | Settings |
|---|---|---|
| ![agent](docs/screenshots/chat-agent.en.png) | ![group](docs/screenshots/chat-group.en.png) | ![settings](docs/screenshots/settings.en.png) |

## Features

- **Roleplay & multi-branch conversation** — character cards (SillyTavern V1/V2/V3 and PNG cards import/export), lorebooks, affinity tracking, group chat, multi-agent orchestration.
- **Agent mode you can watch** — a tool-calling loop with a collapsible run panel in the chat (every tool, argument and result) plus a live console in the right sidebar; destructive actions ask for approval first, and the agent sends images into the conversation on its own.
- **Multi-agent orchestration** — pull characters from different worlds into one group chat, hold a private meeting where characters answer off the record, or put a character on stage to reply directly in the timeline (as a sub-agent, the main agent can also delegate work under minimal permissions).
- **WeChat-style photo messages** — the model can *send* photos mid-chat: selfies are re-rendered from the character's reference image so the face stays consistent, scenes are generated fresh. Replies can also arrive as multiple short bubbles, WeChat-style.
- **Long-form writing & code collaboration** — a prompt-editor for reusable instruction modules, skills, and per-scene presets.
- **Image & voice** — image generation/editing through your own provider; read any reply aloud with local TTS (GPT-SoVITS) in the desktop app.
- **Ambient audio** — two independent decks (environment × music) with 30 bundled CC0 tracks; the model can direct them from roleplay context via hidden tags.
- **Themes** — minimal / glass / candle, per-device.
- **Self-hosted by design** — no vendor backend, no telemetry; your Worker, your KV, your keys.

## Self-hosting (Cloudflare Workers)

**Fastest path — the one-click deploy button.** It clones this repo into your own GitHub, provisions the KV namespace for you, and asks for the secrets while it sets the Worker up:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MaxChen12114/OwnChat)

The values it asks for are described in `.dev.vars.example` (at minimum one model key; an access password is strongly recommended). Prefer the terminal, or already have a Workers setup? Then:

Requirements: a Cloudflare account (free tier is fine) and Node.js 18+.

```bash
git clone https://github.com/<you>/OwnChat && cd OwnChat
npm i -g wrangler && wrangler login

# 1) create the KV namespace used for optional sync, then paste the printed id
#    into wrangler.toml -> [[kv_namespaces]] id
wrangler kv namespace create TAVERN_SYNC

# 2) server-side model keys (never committed; only the ones you use are required)
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put NVIDIA_API_KEY

# 3) deploy (the build step regenerates prompt registries + runs a syntax gate)
wrangler deploy
```

`wrangler deploy` prints your Worker URL. A custom domain is optional (Workers → your Worker → Settings → Domains & Routes).

Local development: `wrangler dev`, with secrets in `.dev.vars` (git-ignored).

## Desktop & Android builds

The Tauri 2 shell lives in `src-tauri/`. CI (`.github/workflows/tauri-build.yml`) builds the Windows installer and the Android APK on a version tag or manual dispatch (tags containing `-test` produce draft releases for testing).

**The shell is domain-neutral.** On first run it shows a local setup page where you enter your deployment URL — with a built-in 3-step deploy guide for newcomers. No rebuild is needed to point it at your own Worker; the app grants its local capabilities (file access under a chosen directory, command execution behind a native confirmation) to exactly the origin you configure, and only that one.

Before publishing your *own* builds, or if you want a build that skips the setup page:

1. **(Optional) hard-code a default address.** In `src-tauri/tauri.conf.json`, set `app.windows[0].url` to `https://your-domain/?shell=android` (`shell=android` enables the mobile layout). Leave it out to use the setup page instead.
2. **Generate your own signing key** for auto-updates:
   ```bash
   npx tauri signer generate -w ownchat.key
   ```
   Put the private key into repository secrets `TAURI_SIGNING_PRIVATE_KEY` (+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) and the public key into `tauri.conf.json` → `plugins.updater.pubkey`; set `plugins.updater.endpoints` to your own releases feed.
3. **Change the bundle identifier** (`identifier` in `tauri.conf.json`) if you want your builds to be a distinct app. Note it becomes the Android `applicationId`, so changing it later means a reinstall.

## Adding your own base prompts

A **base prompt** is the first block of the system prompt — it shapes how the model behaves across the whole app. This repository ships exactly **one** general-purpose base (`src/prompts/bases/基础.md`).

To add your own:

1. Put any `.md` / `.txt` file — or a folder of them (= one multi-file base) — into `src/prompts/bases/`.
2. Deploy (the build step scans that directory; the file/folder name becomes the id shown in **Settings → 对话 → 基座**).
3. With **two or more** bases deployed, the top-bar persona button switches between them with a single click (with one base, the button just shows this guide).

> **What this repository does *not* provide.** Only the one general-purpose base above is included. The project does not ship, review, or vouch for any other base text: people add their own, at their own responsibility, and are responsible for complying with the laws that apply to them and with the terms of whichever model provider they use.

Base files are payloads, not documents — their bytes go straight into model requests (keep them LF; `.gitattributes` enforces it).

Prompt libraries that ship with the repo are credited in `src/prompts/CREDITS.md`; bundled ambient audio in `public/assets/ambient/CREDITS.txt`.

## Community resources

Third-party projects that pair well with OwnChat. **Not affiliated with, not reviewed by, and not endorsed by this project** — and nothing below is copied into this repository:

- **[Spiritual-Spell-Red-Teaming](https://github.com/Goochbeater/Spiritual-Spell-Red-Teaming)** — a large community collection of red-teaming / jailbreak prompts for many LLMs (mostly Claude). **Read the warnings before you click:** it ships **no license**, it contains adult / NSFW-capable jailbreak prompts and collected vendor system prompts, and **its README embeds hidden prompt-injection text aimed at AI tools** — do not paste that README into an AI assistant or agent, read it with your own eyes only. If you use anything from it in your own deployment, that is your own responsibility: comply with the laws that apply to you and with each model provider's terms. (Consistent with this repository's policy, no-license third-party text is never copied into `src/prompts/` — link only.)

Dropped one into your own deployment and want the top-bar button to switch between bases? Add it under `src/prompts/bases/`, deploy, and the button picks it up.

## Privacy & License

- Privacy policy: [PRIVACY.md](PRIVACY.md) — data stays on your machine / in your own Cloudflare account; no telemetry.
- License: [MIT](LICENSE).

## Conventions

See [AGENTS.md](AGENTS.md) for architecture notes and development conventions. Two house rules worth knowing before you send a PR:

- **Commit messages and GitHub metadata (repo description, release notes, PR titles) are written in English.**
- The prompt files under `src/prompts/bases/` are payloads, not documents — byte-exact text matters.

Third-party credits: prompt libraries (`src/prompts/CREDITS.md`), ambient audio (`public/assets/ambient/CREDITS.txt`), and the wallpaper used in the screenshots (see README of `docs/`).
