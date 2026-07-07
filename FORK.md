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
3. **Sibling worktree location.** Worktrees live at
   `<repoRoot>.worktrees/<branch-slug>` (a sibling of the repo, never nested), so
   there is no `.gitignore` entry to maintain. The branch slug collapses `/` to
   `-`, so `feat/foo` → `.../repo.worktrees/feat-foo` (a single directory).
4. **Conventional-commit branches.** Branch names are `<type>/<identifier>`
   (`feat`, `fix`, `chore`, `docs`, ...). Input is normalised by `resolveBranch`:
   `feat/foo`, `feat foo`, bare `foo` (→ `feat/foo`), or empty (→ `feat/<name>`).
   `branchPrefix` is gone. The command guidance asks the agent to infer the type
   from the conversation, defaulting to `feat`.
5. **`/worktree dispose`.** From inside a worktree: exit pi, and once it has
   stopped, `cd` back to the main repo, run `preRemove`, `git worktree remove
   --force` + `git branch -d` (soft; an unmerged branch is kept), then relaunch
   pi in the main repo forking the worktree session (a `kind: "dispose"` handoff
   explains the move back and any lost WIP). Teardown runs in the detached waiter
   after pi exits, so the worktree is never removed from under a live cwd.
6. Pure helpers `buildRelaunchCommand`, `buildCreateScript`, `buildDisposeScript`,
   `buildDestroyScript`, `resolveBranch`, `getWorktreeDir`, `branchToDirName`,
   `isPathInside`, `encodeHandoff`/`decodeHandoff`, `handoffCaveat` are exported
   and unit-tested in `test/handoff.test.ts`.
7. **Adversarial-review hardening pass** (gpt-5.5 + glm-5.2):
   - `resolveBranch` now charset-validates the branch **type**, not just the
     identifier, so a committed `.pi/worktree.json` with a `types`/`defaultType`
     containing shell metacharacters (`feat$(…)`) can no longer reach a `bash -c`
     sink. This was a real RCE via a shared config file.
   - Every git script (`buildCreateScript`/`buildDestroyScript`/`buildDisposeScript`
     and the link-env / postCreate steps) `shQuote`s all interpolated paths and
     the branch, so an injection-y repo path cannot execute either.
   - Create no longer force-deletes a colliding branch (the old `git branch -D`
     is gone); `git worktree add -b` fails loudly instead, and `handleCreate`
     refuses when the worktree already exists. A real feature branch or an
     existing checkout can never be clobbered.
   - `handleDestroy` refuses to run from **inside** the target worktree (it does
     not relaunch, so that would strand the session on a dead cwd) and verifies
     removal actually happened rather than assuming success.
   - Dispose counts **gitignored** files too (`git status --porcelain --ignored`)
     so the per-worktree `.env.local` / local DBs are surfaced in the confirm
     prompt and the handoff caveat before `rm -rf`; the caveat no longer asserts
     removal as fact but tells the agent to verify with `git worktree list` /
     `git branch`. Dispose also refuses when the fork session file lives inside
     the worktree (removal would delete it before `pi --fork` reads it).
8. **Second (verification) review pass** closed the residuals the panel raised:
   - `handleDestroy` resolves its target from `git worktree list --porcelain`
     (via the pure `parseWorktreeList`) and matches on the **exact** branch,
     rather than reconstructing the directory from the slug. Two custom types
     that differ only by a hyphen (`feat/fix-foo` vs `feat-fix/foo`) slug to the
     same directory; looking up by branch means destroy can never act on the
     wrong checkout. It then verifies BOTH the directory and the branch are gone
     and reports the actual state.
   - `isPathInside` now canonicalises with `realpathSync` (falling back to
     lexical `resolve` for non-existent paths), so a symlinked cwd/session path
     cannot bypass the destroy/dispose containment guards.
   - The dispose caveat labels lost files as "uncommitted/untracked" (untracked
     files are counted too), not "uncommitted tracked".
9. **Regression caught by the second review pass and fixed.** Resolving destroy
   by branch (item 8) could match the **main working tree** (which also uses a
   `<type>/<identifier>` branch), and `git worktree remove` refusing the main
   tree fell through to `rm -rf <repoRoot>` — deleting the source repo. The pure
   `resolveDestroyTarget` now refuses any branch whose checkout is the main
   working tree (`entry.path === repoRoot`). `canonicalPath` was also hardened to
   resolve intermediate symlinks even when the leaf does not yet exist, so
   `isPathInside` is robust for any future caller.
10. **Third review pass** hardened teardown further:
    - `buildTeardownScript` no longer has an `rm -rf` fallback. If
      `git worktree remove` refuses (e.g. a stale worktree path that has since
      been reused by unrelated content), it prunes the metadata instead of
      blindly deleting the directory; `handleDestroy` already reports any path
      that lingers.
    - `createWorktree` now checks each `postCreate` hook's exit code and aborts
      (instead of silently reporting a half-provisioned worktree as ready).
11. **Fourth review pass** closed the last items:
    - Branch **types** must now be hyphen-free (`isValidType`). This makes
      `branchToDirName` provably injective, eliminating the slug-collision class
      at the root (so neither destroy nor the `--worktree` attach path can ever
      resolve to the wrong branch's checkout under custom types).
    - `preRemove` hooks are fail-fast (`set -e`): a failing cleanup/backup hook
      aborts before the irreversible worktree/branch removal.
    - `resolveDestroyTarget`'s main-checkout guard uses `canonicalPath` for
      consistency with `isPathInside` (git's own refusal remains the backstop).

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
