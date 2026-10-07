# Security Policy

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** — this repository's *Security* tab →
*Report a vulnerability*. Do not open a public issue for exploitable problems.

Please include:

- what you found and where (endpoint / file / flow),
- a minimal reproduction if possible,
- your impact assessment (e.g. can it read the deployed model API keys? bypass `CHAT_PASSWORD`?
  reach the desktop shell's local file / command capabilities?).

We'll acknowledge within a few days and keep you posted while it's being fixed. Please give us a
chance to ship a fix before publishing details.

## Scope notes

- OwnChat is **self-hosted**: your Worker, your KV, your API keys. The main attack surface is the
  Worker (`src/`) and, for the desktop/mobile app, the IPC grants in `src-tauri/capabilities/`.
- The desktop shell grants local capabilities (file access under a user-chosen directory, command
  execution behind a native confirmation dialog) **to the origin configured in `tauri.conf.json`**.
  Only point it at deployments you trust — that origin effectively holds the same trust as a local app.
- Deployments without `CHAT_PASSWORD` are open to anyone who has the URL (including your model
  quota). That's documented behavior, not a vulnerability — but it's worth setting the password.

## Supported versions

The deployed `main` branch is what we support. Please reproduce issues on the latest `main` or the
latest release before reporting.
