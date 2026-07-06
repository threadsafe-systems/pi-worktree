# FORK.md — local fork of pi-worktree

This is a local fork of `pi-worktree` (based on upstream `1.3.3`), installed by
path in `~/.pi/agent/settings.json` instead of `npm:pi-worktree`.

## Why

Upstream relaunches into a worktree with a **fresh** pi session (`cd <wt> && pi`),
so the conversation you were having does not follow the hop. This fork carries
the session across.

## What changed (`extensions/worktree.ts`)

1. **Fork the parent session on relaunch.** The relaunch command becomes
   `cd <wt> && PI_WT_HANDOFF=<b64> pi --fork <parentSessionFile>`, using
   `ctx.sessionManager.getSessionFile()`. `pi --fork` seeds a new session in the
   worktree with the full parent history, runs in the worktree cwd, and leaves
   the parent session file untouched (all verified).
2. **One-turn orientation caveat.** The new session decodes `PI_WT_HANDOFF` and,
   on the first agent turn, injects a note stating: it was forked from the
   parent cwd/branch; repo-relative paths are unchanged while absolute and
   prior-cwd-relative paths now resolve under the worktree; and how many files
   had **uncommitted changes left behind** in the old checkout (a worktree is a
   fresh checkout, so that WIP is not present here).
3. Pure helpers `buildRelaunchCommand`, `encodeHandoff`/`decodeHandoff`,
   `handoffCaveat` are exported and unit-tested in `test/handoff.test.ts`.

Back-compatible: with no session to fork (e.g. `--no-session`), the command
falls back to the original `cd <wt> && pi`.

## Test

```bash
<loom>/node_modules/.bin/tsx test/handoff.test.ts
```

## Caveat this does NOT solve

Uncommitted work in the old checkout is not moved into the worktree; the caveat
only warns about it. Starting work in a worktree from the outset (the discipline
`pi-worktree-discipline` enforces) avoids the mid-edit-migration hazard entirely.
