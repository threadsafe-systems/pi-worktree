# @threadsafe-systems/pi-worktree

[![CI](https://github.com/threadsafe-systems/pi-worktree/actions/workflows/ci.yml/badge.svg)](https://github.com/threadsafe-systems/pi-worktree/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/threadsafe-systems/pi-worktree)](https://github.com/threadsafe-systems/pi-worktree/releases)

Git worktree management for [Pi Coding Agent](https://github.com/badlogic/pi-mono). Create isolated dev environments with one command — each with its own branch, database, dependencies, and ports — and carry your live agent session across the hop.

A Threadsafe Systems project. It originated from [`xiaoyu2er/pi-worktree`](https://github.com/xiaoyu2er/pi-worktree) and has since been substantially rewritten; see [`PROVENANCE.md`](./PROVENANCE.md). Inspired by `claude --worktree` from Claude Code.

## Why?

When working on multiple features in parallel (or running multiple AI coding agents), you need full isolation — not just a git branch, but separate `node_modules`, databases, env files, and dev server ports. Git worktrees provide the branch isolation; **pi-worktree** automates everything else via project-level hooks.

**One command** gets you:

- A fresh git worktree on its own branch
- A dedicated database (via `createdb` or any command you configure)
- A generated `.env.local` with worktree-specific config
- Installed dependencies (`npm install` / `bun install`)
- Applied migrations or schema pushes
- Pi running in the worktree directory, ready to code

## Install

Not published to npm. Install it as a git-backed Pi package so `pi update --extensions`
can pull updates:

```bash
# Track the default branch
pi install git:github.com/threadsafe-systems/pi-worktree

# Or pin a published release (recommended)
pi install git:github.com/threadsafe-systems/pi-worktree@v1.0.0
```

The two forms behave differently on `pi update --extensions`:

- **With a ref** (`@v1.0.0`) pi pins you. Update reconciles the clone to that
  exact ref and never moves it forward; re-run `pi install` with a new tag to
  take a new release.
- **Without a ref** pi tracks the default branch, hard-resetting the clone to
  `origin/main` on every update. You get unreleased commits as they land.

Pin unless you are developing the extension itself. Release notes are on the
[releases page](https://github.com/threadsafe-systems/pi-worktree/releases).

Then `/reload` if Pi is already running. This package includes both worktree
management and the optional worktree-discipline guard; if you previously
installed `pi-worktree-discipline`, remove it to avoid duplicate commands.

## Usage

```bash
# Create a worktree and start Pi in it (conventional-commit branch)
pi --worktree feat/my-feature

# Bare name → defaults to feat/ (e.g. feat/my-feature)
pi --worktree my-feature

# Auto-generated name (e.g. feat/calm-fox)
pi --worktree

# Override the base dir, exact branch, or base ref
pi --worktree my-feature --worktree-base develop
/worktree feat/my-feature --dir ~/wts --base origin/main
/worktree create hotfix --branch release/2.0.1

# From within a Pi session
/worktree feat/my-feature
/worktree fix login-bug      # → fix/login-bug
/worktree enter fix/login-bug # re-camp into an existing linked worktree
/worktree dispose            # leave + remove this worktree, reopen Pi in the main repo
/worktree destroy fix/login-bug
/worktree list

# Optional: enforce worktree-only write/edit operations for this repo
/worktree enforce in
/worktree enforce status
```

**Create overrides** (both `/worktree ...` and the `--worktree-*` CLI flags):

| Override | Flag (CLI) | Effect |
|---|---|---|
| `--dir <path>` | `--worktree-dir` | Worktree base directory for this invocation |
| `--branch <name>` | `--worktree-branch` | Exact branch, bypassing conventional resolution (still validated for ref/shell safety) |
| `--base <ref>` | `--worktree-base` | Branch the worktree from `<ref>` instead of `HEAD` |

Worktrees are created in a **sibling** directory next to the repo
(`<repoRoot>.worktrees/<branch-slug>`, where `/` in the branch collapses to `-`).
For example `feat/my-feature` lives at `../my-repo.worktrees/feat-my-feature`.
Because it sits outside the repo tree, there is nothing to add to `.gitignore`.

When cmux, [herdr](https://herdr.dev), or tmux is detected, Pi relaunches itself in the worktree directory within the same terminal. Without a multiplexer, it prints the path for manual `cd && pi`. If a worktree already exists because it was created manually or by another session, use `/worktree enter <type/name>` to relaunch Pi inside that existing linked checkout.

## Project configuration

Create `.pi/worktree.json` in your repo root (commit it so all contributors share the same setup). Run `/skill:worktree-setup` for interactive setup, or create it manually:

```json
{
  "linkEnvFiles": true,
  "defaultType": "feat",
  "postCreate": [
    "npm install",
    "npx prisma db push"
  ],
  "preRemove": [
    "dropdb --if-exists myapp_$(basename $PWD) 2>/dev/null || true"
  ]
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `dir` | `<repoRoot>.worktrees` | Worktree base dir. Omit for the sibling default; set to resolve relative to the repo root |
| `defaultType` | `feat` | Conventional-commit type used when the input has no `type/` prefix |
| `types` | all conventional types | Override the accepted `<type>` set |
| `linkEnvFiles` | `true` | Symlink gitignored `.env*` files (except `.env.local`) from main repo |
| `postCreate` | `[]` | Shell commands run after creation (cwd = worktree) |
| `preRemove` | `[]` | Shell commands run before removal (cwd = worktree) |

Branches follow conventional commits: `<type>/<identifier>`, e.g.
`feat/use-conventional-commits`. Valid types: `feat`, `fix`, `chore`, `docs`,
`refactor`, `test`, `perf`, `build`, `ci`, `style`, `revert`.

## Optional worktree discipline

`pi-worktree` can also guard opted-in repos against accidental edits in the main
checkout. When `.pi/worktree-discipline.json` contains `{ "enforce": true }`,
the extension refuses Pi's structured `write` and `edit` tools in the primary
checkout. Linked worktrees are always allowed. While a session is still in an enforced main checkout, the extension injects a short per-turn prompt note with the resolved default worktree location and reminds the agent to use `/worktree <type/name>` or `/worktree enter <type/name>` rather than hand-rolling a checkout and continuing from the main cwd. Agents also get a model-callable `worktree_session` tool for headless/autonomous runs: it can create or enter a linked worktree, returns the exact `worktreePath` to target, and can dispose the worktree after the agent commits.

```bash
/worktree enforce in       # write and stage .pi/worktree-discipline.json
/worktree enforce status   # show effective policy and checkout type
/worktree enforce doctor   # also verify pi-worktree is wired into Pi settings
/worktree enforce out      # local override if the policy is committed, else remove it
```

The legacy alias `/worktree-enforce in|out|status|doctor` is also registered.
The marker supports `allowPaths`, for example:

```json
{ "enforce": true, "allowPaths": ["docs/", "CHANGELOG.md"] }
```

This is a guardrail, not a sandbox: shell commands (`bash`, redirects, `sed -i`)
are not blocked. Commit `.pi/worktree-discipline.json` to share the policy; the
local override `.pi/worktree-discipline.local.json` is gitignored by the helper.
Manual `git worktree add` creates a checkout but does **not** move the active Pi
session; use `/worktree enter <type/name>` or restart Pi from the linked worktree
so relative paths and the worktree status prompt are correct. In autonomous/headless
agent turns, prefer the `worktree_session` tool; after `create`/`enter`, the agent
should use absolute paths under the returned `worktreePath` and prefix shell commands
with `cd <worktreePath> &&` until it calls `worktree_session` `dispose`.

## How it works

**Create** (`pi --worktree feat/my-feature` or `/worktree feat/my-feature`):

1. `git worktree add -b feat/my-feature <repoRoot>.worktrees/feat-my-feature HEAD`
2. Symlinks gitignored `.env*` files (except `.env.local`) from the main repo
3. Runs each `postCreate` command in order
4. Relaunches Pi in the worktree directory (forking the session so history follows)

**Enter** (`/worktree enter feat/my-feature`, from any checkout):

1. Finds an existing linked worktree by exact branch (`feat/my-feature`) or the conventional shorthand (`my-feature` → `feat/my-feature`)
2. Relaunches Pi in that worktree directory, forking the session so history follows
3. Refuses to "enter" the main working tree; create a linked worktree first

**Dispose** (`/worktree dispose`, from inside a worktree):

1. Exits Pi and, once it has stopped, `cd`s back to the main repo
2. Runs each `preRemove` command, then `git worktree remove --force` + `git branch -d` (soft; the branch is kept if it still has unmerged commits)
3. Relaunches Pi in the main repo, forking the worktree session so history follows the hop back

**Destroy** (`/worktree destroy feat/my-feature`, from the main checkout):

1. Runs each `preRemove` command
2. `git worktree remove --force <repoRoot>.worktrees/feat-my-feature`
3. `git branch -D feat/my-feature`

**Relaunch strategy:** Pi's tools (bash, read, edit, etc.) bind to the working directory at startup via closure — there is no way to change it mid-session. When a worktree is created from the main repo, Pi shuts down and injects `cd <worktree> && pi` into the terminal via `cmux send`, `herdr pane send-text`, or `tmux send-keys`, so Pi restarts with the correct cwd. Detection prefers cmux, then herdr, then tmux — cmux and herdr stamp a per-pane id on the processes they spawn, whereas `$TMUX` can leak into herdr panes from an outer session.

## Examples

### Node.js + PostgreSQL + Prisma

Each worktree gets its own database and `.env.local`:

```json
{
  "postCreate": [
    "printf 'DATABASE_URL=postgres://localhost:5432/myapp_%s\\n' $(basename $PWD) > .env.local",
    "createdb myapp_$(basename $PWD) 2>/dev/null || true",
    "npm install",
    "npx prisma db push"
  ],
  "preRemove": [
    "dropdb --if-exists myapp_$(basename $PWD) 2>/dev/null || true"
  ]
}
```

### Bun monorepo with per-worktree staging

For monorepos where each worktree needs a unique stage name (for isolated dev server ports), database, and environment:

```json
{
  "postCreate": [
    "WT=$(basename $PWD); DB=myapp_$(echo $WT | tr '-' '_'); printf 'STAGE=%s\\nDATABASE_URL=postgres://localhost:5432/%s\\n' \"$WT\" \"$DB\" > .env.local",
    "DB=$(grep DATABASE_URL .env.local | sed 's|.*/||'); createdb \"$DB\" 2>/dev/null || true",
    "bun install",
    "bun run prisma:generate",
    "bun run prisma:push"
  ],
  "preRemove": [
    "DB=$(grep DATABASE_URL .env.local 2>/dev/null | sed 's|.*/||'); [ -n \"$DB\" ] && dropdb --if-exists \"$DB\" 2>/dev/null || true"
  ]
}
```

This pattern works well for projects that derive dev server ports from the stage name, giving each worktree fully isolated services.

## Develop / verify

```bash
npm install
npm run check     # typecheck + biome lint + pure tests
npm run typecheck # tsc --noEmit only
npm run lint      # biome check (format + lint, read-only)
npm run format    # biome check --write (apply fixes)
npm test          # pure decision/handoff tests
```

Formatting and linting are pinned via [biome](https://biomejs.dev) in
`biome.json` (tab indent, `lineWidth` 80, double quotes). The one-time
reformat commit is listed in `.git-blame-ignore-revs`; enable it locally with
`git config blame.ignoreRevsFile .git-blame-ignore-revs`.

### Releasing

Releases are cut by [semantic-release](https://semantic-release.gitbook.io) from
CI (`.github/workflows/ci.yml`, config in `.releaserc.json`). Every push to
`main` that passes `npm run check` is analysed, and if it contains a releasable
commit, CI tags it and publishes a GitHub Release whose notes are the changelog.
Nothing is published to npm.

The release job deliberately makes **no commit back to `main`**. `main` is a
protected branch requiring the `check` contexts, and a required status check
rejects any direct push — including one carrying a bumped `package.json` or
`CHANGELOG.md`, and including one authenticated with a PAT. Pi identifies a
git-installed package by commit SHA and never reads its `package.json` version,
so the bump bought nothing anyway. Tags and Releases are unaffected by branch
protection.

Version bumps are derived from commit messages, so
[Conventional Commits](https://www.conventionalcommits.org) are mandatory:

| Commit                           | Bump  |
| -------------------------------- | ----- |
| `fix: ...`                       | patch |
| `feat: ...`                      | minor |
| `BREAKING CHANGE:` body footer   | major |
| `chore:`, `docs:`, `ci:`, ...    | none  |

Signal a breaking change with the `BREAKING CHANGE:` footer, never the `feat!:`
shorthand — the default angular preset does not parse `!`, so a `feat!:` squash
silently produces no release instead of a major bump.

Dry-run the decision locally before merging:

```bash
GITHUB_TOKEN=$(gh auth token) npx semantic-release --dry-run --no-ci
```

## Update

Pin the release you want and let Pi reconcile the clone:

```bash
pi install git:github.com/threadsafe-systems/pi-worktree@v1.2.3
```

## License

MIT — see [`LICENSE`](./LICENSE). Copyright (c) Threadsafe Systems and the
original pi-worktree contributors.
