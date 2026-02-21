# Plan: Push ESP32-Voice Extension to Your Fork

## Context

- Upstream repo: `https://github.com/openclaw/openclaw` (origin)
- Your fork: `https://github.com/Abilashs003/openclaw` (remote alias: `fork`)
- Your GitHub username: `Abilashs003`
- Branch to create: `feat/esp32-voice-plugin`
- Node version required: `v22+` (use `~/.nvm/versions/node/v22.22.0/bin/node`)

The pre-commit hook runs `oxlint` + `oxfmt` on staged files. oxlint is available at
`node_modules/.pnpm/oxlint@.../node_modules/oxlint/bin/oxlint` but `pnpm exec` can't find it
because pnpm itself is running under Node 18 (your shell default). All pnpm/node commands
below must be run with Node 22.

---

## Step 1 — Fix your shell to use Node 22

```bash
nvm use 22
node --version   # must print v22.x.x
```

If `nvm use 22` doesn't work, prefix every `node`/`pnpm` command with the full path:
```bash
~/.nvm/versions/node/v22.22.0/bin/node
~/.nvm/versions/node/v22.22.0/bin/npm
~/.nvm/versions/node/v22.22.0/bin/pnpm
```

---

## Step 2 — Verify git state

```bash
git status
git branch
git remote -v
```

Expected:
- Branch: `feat/esp32-voice-plugin` (already created)
- Staged files: `extensions/esp32-voice/**` + `pnpm-lock.yaml`
- Remotes: `origin` → openclaw/openclaw, `fork` → Abilashs003/openclaw

If branch is not yet created:
```bash
git checkout -b feat/esp32-voice-plugin
```

---

## Step 3 — Stage only the extension files

```bash
git add extensions/esp32-voice/
git add pnpm-lock.yaml
```

Do NOT add:
- `AGENTS.md` (stray file in repo root, not ours)
- Any files outside `extensions/esp32-voice/`

Verify what will be committed:
```bash
git diff --cached --name-only
```

Should list only `extensions/esp32-voice/*` and `pnpm-lock.yaml`.

---

## Step 4 — Run the linter manually before committing (avoids hook failure)

The pre-commit hook runs oxlint. Run it yourself first so you can fix issues before committing:

```bash
# List all .ts files we're staging
git diff --cached --name-only | grep "\.ts$"

# Run oxlint on them (use node 22)
nvm use 22
pnpm exec oxlint --type-aware $(git diff --cached --name-only | grep "\.ts$" | tr '\n' ' ')
```

If oxlint reports errors, fix them before moving to Step 5.

If oxlint is not found via pnpm exec, run it directly:
```bash
node_modules/.pnpm/oxlint@1.48.0_oxlint-tsgolint@0.14.1/node_modules/oxlint/bin/oxlint \
  $(git diff --cached --name-only | grep "\.ts$" | tr '\n' ' ')
```

---

## Step 5 — Commit

```bash
git commit -m "feat(esp32-voice): add ESP32 voice channel plugin (initial prototype)

Full voice pipeline for XiaoZhi ESP32 devices:
- Opus audio → Deepgram STT → OpenClaw LLM → ElevenLabs TTS → Opus output
- Standalone WebSocket server on port 8765 (no core Gateway changes)
- Pluggable STT/TTS provider registry (Deepgram + ElevenLabs)
- Ed25519 device identity auth entirely in extension
- OTP-based device pairing for secure onboarding
- Real-time Opus frame pacing with serialized audio chain
- opusscript (pure WASM) — no native binaries, works on all platforms
- OTA mock server for XiaoZhi firmware auto-configuration
- TODO.md with remaining work for contributors

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

If the commit fails due to the pre-commit hook (oxlint errors), the error output will tell you
which file and line to fix. Fix it, `git add` that file again, and retry the commit.

---

## Step 6 — Push to your fork

```bash
git push fork feat/esp32-voice-plugin
```

If your fork's default branch is behind upstream and push is rejected:
```bash
git push fork feat/esp32-voice-plugin --force-with-lease
```

> `--force-with-lease` is safe — it only force-pushes if nobody else has pushed to the same
> branch in the meantime. Since this is a new branch on your fork, it will succeed.

---

## Step 7 — Verify on GitHub

Open in browser:
```
https://github.com/Abilashs003/openclaw/tree/feat/esp32-voice-plugin
```

Check:
- `extensions/esp32-voice/` folder is present
- `TODO.md` is present
- `src/voice/voice-session.ts` is present
- No `node_modules/` folder was pushed (should be gitignored)

---

## Step 8 — (Optional) Open a PR against your own fork's main

If you want a PR on your fork for documentation/review purposes:

```bash
gh pr create \
  --repo Abilashs003/openclaw \
  --base main \
  --head feat/esp32-voice-plugin \
  --title "feat(esp32-voice): add ESP32 voice channel plugin" \
  --body "Initial prototype of the ESP32 voice channel extension.

## What this adds
- Full voice pipeline: Opus → STT → LLM → TTS → Opus
- XiaoZhi ESP32 firmware support (XiaoZhi/Jiuchuan S3 board)
- Pluggable STT (Deepgram) and TTS (ElevenLabs) providers
- OTA server for automatic ESP32 configuration
- See \`extensions/esp32-voice/TODO.md\` for remaining work before npm publish"
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `pnpm exec oxlint not found` | Use Node 22: `nvm use 22` then retry |
| `oxlint: lint errors` | Read the error output, fix the flagged line, `git add` the file, retry commit |
| `push rejected` | Use `--force-with-lease` flag |
| `remote fork does not exist` | Run `git remote add fork https://github.com/Abilashs003/openclaw.git` |
| `node_modules/ pushed` | Check `.gitignore` — `node_modules` should be listed |
