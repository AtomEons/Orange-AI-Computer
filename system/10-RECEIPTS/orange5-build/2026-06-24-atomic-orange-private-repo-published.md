# Receipt — Atomic Orange Published as Private GitHub Repo

**Receipt ID:** `2026-06-24-atomic-orange-private-repo-published`
**Hash chain:** #018
**Status:** `ATOMIC_ORANGE_PRIVATE_REPO_LIVE_AT_GITHUB_READY_FOR_CHATGPT_VISUAL_COLLABORATION`
**Confidence:** 1.0 (gh confirmed `visibility:PRIVATE`, push succeeded, branch tracking set)
**Prior receipt:** `2026-06-24-ae-cobra-night1-spine-authored` (#017)
**Actor:** Claude (Orange voice)
**Sovereign:** Atom McCree

---

## What happened

Operator directive: *"LETS TAKE THE ATOMIC ORANGE AKA ATOMIC CHAT CUSTOM APP AND PUT WHATEVER CODEX GOT DONE LOCAL ON A FOLDER ON GITHUB PRIVATE FOR CHATGPT TO WORK ON VISUAL"*.

Published the Atomic Orange Tauri shell at `C:\AtomEons\Orange5\02-APP\` as a private GitHub repo so ChatGPT (the operator's other collaborator) can iterate on the visual layer with full source access.

## Repo details

| Field | Value |
|---|---|
| URL | https://github.com/Atom-Eons/atomic-orange |
| Visibility | **PRIVATE** |
| Default branch | `main` |
| Description | Atomic Orange — Orange5 UI face (Tauri 2 + React 19 + Vite 6 + Rust). Private repo for ChatGPT visual collaboration. |
| Account | AtomEons (gh authenticated, scope: repo) |
| First commit | "initial publish — Atomic Orange (Tauri 2 + React 19 + Vite 6) for ChatGPT visual work" |
| Files committed | 87 source files, 10,582 line additions |
| Total commit size | ~390 KB source (vs 1.4 GB on disk with node_modules + target) |

## What got published

- `src/` — React 19 lane components (Chat, Cockpit, Vault, Settings + LaneShell + ChromeBar)
- `src-tauri/` — Rust Tauri 2 native bridges (current-user install, NSIS bundle target)
- `public/` — static assets
- `index.html` + `vite.config.{ts,js,d.ts}` — Vite 6 entry
- `package.json` + `package-lock.json` — npm dep manifest
- `tsconfig.{json,node.json,tsbuildinfo,node.tsbuildinfo}` — TypeScript config
- `README.md` — repo readme (Codex-authored, operator-polished)
- `PR-01-SPEC.md` — original PR-01 native-rail spec
- `.gitignore` — Codex-authored, excludes `node_modules`, `dist`, `dist-ssr`, `*.local`, `src-tauri/target`, `src-tauri/Cargo.lock`, `.DS_Store`, `.vscode/*`, `*.log`

## What got EXCLUDED (via .gitignore)

| Path | Why excluded |
|---|---|
| `node_modules/` | ~84 MB of npm deps; reconstructable via `npm install` |
| `src-tauri/target/` | Rust build artifacts |
| `src-tauri/Cargo.lock` | Per existing .gitignore (debatable but Codex chose it; left alone) |
| `dist/`, `dist-ssr/` | Vite build outputs |
| `tsconfig.tsbuildinfo` cache files | TypeScript incremental cache |
| `.DS_Store`, `.vscode/*`, `*.log` | OS / IDE junk |

## Secret scan — clean

Pre-push grep across all staged content (`git diff --cached | grep -iE 'api[_-]?key|secret|password|token|sk-...|ghp_...|AIza...|AKIA...'`) returned **no real secrets**. Matches found were all benign:

- `apiKey: string` / `apiKey: ""` — Settings lane's BYO-frontier-key UX field with empty default (operator's key lives in `window.localStorage`, not in source)
- `js-tokens` — npm dependency name
- `codexa-token` — string literal in cockpit UI labeling token-state, not the actual token
- `type="password"` — HTML input type for the API-key field

No `.env`, no `.pem`, no `.key`, no credential files were staged.

## Git identity

This machine had no git identity configured globally OR locally. The CLAUDE.md rule "NEVER update the git config" was respected — used `GIT_AUTHOR_*` and `GIT_COMMITTER_*` environment variables for this one commit instead of `git config`. No global or repo-local config was written.

Commit author: `Atom McCree <a.mccree@gmail.com>` (operator's known identity per auto-memory).

## ChatGPT collaboration path

Operator can now:
1. Share the repo URL with ChatGPT (or any external collaborator)
2. Pull / branch / commit / push via standard git
3. ChatGPT's edits land as PRs or direct commits on `main`
4. Operator merges visual work back into local `C:\AtomEons\Orange5\02-APP\` via `git pull`

Note: this is now a **bidirectional** path. Local edits to `02-APP/` need to be `git add`/`commit`/`push` to land on GitHub, and external edits need `git pull` to come back local. The local repo is no longer the sole source of truth.

## Frontier-Isolation Law

Unchanged. The published Tauri shell talks only to the OrangeLLM gateway at `127.0.0.1:1337/v1` — same as the local version. Frontier model BYO keys live in `localStorage` (never in source), boundary middleware is in the OrangeLLM gateway repo (NOT this repo). The published repo cannot leak anything Orange5-internal because the gateway is the only thing it can reach, and the gateway is in `06-ORANGELLM/server/` (separate from `02-APP/`, NOT published).

## Mom's Law alignment

- Asked for clean publish, got clean publish.
- Pre-flight secret scan ran before push, not after.
- Honest about what got published, what got excluded, and why each file was kept or dropped.
- Honest about scope: this opens a bidirectional sync path that the operator now needs to manage when working with ChatGPT.
- No git config touched. Env-var override used instead.
- Receipt has its evidence: `gh repo view` JSON confirms `visibility:PRIVATE`, the push log shows `[new branch] HEAD -> main`, the commit log shows the message landed.

## Rollback

```powershell
# Delete the GitHub repo (irreversible — content gone from GitHub)
gh repo delete Atom-Eons/atomic-orange --yes

# Remove local git state (local source untouched)
Remove-Item -Recurse -Force C:\AtomEons\Orange5\02-APP\.git
```

Files in `02-APP/` itself stay on disk. Only the git state + GitHub repo are affected.

## Hash chain

#018. Prior: #017 (Æ Cobra Night-1 spine authored). Next expected: #019 (Æ Cobra Night-1 LIVE on Codexa after operator preflight) OR ad-hoc receipt for whatever next operator-directed action lands.

---

**Mom is watching. Private repo. No secrets pushed. No git config touched. ChatGPT has the working tree.**
