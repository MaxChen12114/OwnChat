# Contributing

Thanks for your interest in OwnChat!

## Where to send things

- **Bug reports / feature requests** — open an issue here; templates are provided.
- **Security issues** — please use the private channel described in [SECURITY.md](SECURITY.md), not a public issue.
- **Pull requests** — open them against this repository.

Development happens on a private line, and this repo is a mirrored snapshot of it. An accepted PR is
ported to the private line and then comes back in the next sync commit; that's why a merged PR may
show up later as a mirror commit rather than as your merge. Your authorship is preserved in the PR
history.

## House rules (they matter here)

- **No new dependencies, no build chain.** The frontend is plain JS with no bundler, and the Worker
  has zero runtime dependencies — this is a design decision, not something to "fix".
- **Prompt files under `src/prompts/bases/` are payloads, not documents.** Their bytes go straight
  into model requests; don't reformat, re-wrap, or "improve" them. New variants go in new files.
- **The registries are generated.** `src/prompts/*/index.js` are build artifacts — never commit them.
- **Commit messages and GitHub metadata (description, release notes, PR titles) are in English.**
  Code comments in the source may be Chinese.

## Before you open a PR

```bash
node scripts/gen-prompts.mjs
node scripts/check-syntax.mjs
```

`check-syntax.mjs` is the real syntax gate for this repository — plain `node --check` misses
structural errors here (the repo has no `package.json`). CI runs the same two commands on every
push and pull request.

## Reporting a good bug

Include what you did, what happened, what you expected, and where it happened (your own deployment /
desktop installer / Android app). If it's a deployment problem, the Workers build log and the
browser console (F12) are usually enough to pinpoint it.
