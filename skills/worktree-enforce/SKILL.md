---
name: worktree-enforce
description: Opt the current repo in or out of pi-worktree discipline enforcement, show its status, or run a doctor health check. `worktree-enforce in` requires all edits here to go through a git worktree (the main checkout becomes read-only for the write/edit tools); `worktree-enforce out` stops enforcing (local override if the marker is committed, else removes it); `worktree-enforce status` shows whether enforcement is active, from which marker, and the checkout type; `worktree-enforce doctor` also audits whether the pi-worktree extension is wired into ~/.pi/agent/settings.json. Manages the .pi/worktree-discipline.json marker the pi-worktree extension reads.
disable-model-invocation: true
---

# worktree-enforce

Per-repo control over pi worktree discipline. It manages the two markers the
`pi-worktree` extension reads in the repo containing your current
directory:

- `.pi/worktree-discipline.json` — committed, shared policy (`{"enforce": true, "allowPaths": [...]}`)
- `.pi/worktree-discipline.local.json` — gitignored, per-checkout override that **wins** over the committed marker

This skill does not install the extension. That is a one-time install
(add the `pi-worktree` package to `~/.pi/agent/settings.json` or install this package with `pi install`).
Without the extension loaded, the markers exist but nothing enforces them;
`doctor` tells you whether the wiring is present.

## Run it

Pass the subcommand (`in`, `out`, `status`, or `doctor`; default `status`):

```bash
bash "$(dirname "$0")/scripts/worktree-enforce.sh" <in|out|status|doctor>
```

Or, inside a pi session with the extension loaded, use either slash command:

```
/worktree enforce in
/worktree enforce status
/worktree-enforce in
/worktree-enforce status
```

## What each arg does

- **`in`** — opt this repo **in**. Writes the committed marker `{"enforce": true}`
  (preserving any existing `allowPaths`) and clears a local override that would
  disable it. The marker is **staged**, not committed; commit it to share the
  policy with the repo.
- **`out`** — opt **out**, smartly:
  - if the marker is **committed** (in `HEAD`), write the gitignored local override
    `{"enforce": false}` so the shared policy is left intact (and add the override
    to `.gitignore`);
  - otherwise (marker uncommitted or absent) remove the local and staged markers so
    the repo falls back to the default, which is off.
- **`status`** — print, for the current repo: the effective enforcement (ON/OFF)
  and which marker it came from, whether you are in a main checkout or a linked
  worktree, and the repo root.
- **`doctor`** — everything `status` shows, plus a PASS/FAIL line on whether the
  `pi-worktree` extension is referenced in `~/.pi/agent/settings.json`.

## What enforcement actually does

When a repo is opted in and you are in its **main** checkout, the extension
refuses the `write` and `edit` tools with a message telling you to work from a
worktree. Linked worktrees are always allowed. Paths under `allowPaths` stay
editable in the main checkout. The marker files are **not** exempt from the gate:
toggle enforcement with `/worktree-enforce` or the script (which write the marker
via the shell, not the gated `write`/`edit` tools), so an agent cannot
self-authorise by rewriting the policy through the write tool.

`bash` is **not** gated. A determined `sed -i` or shell redirect can still write
in the main checkout. This is a guardrail against accidental main-checkout edits,
not a sandbox. The Claude Code equivalent has the same Write/Edit-only limit.

## Notes

- Run it from anywhere inside the target repo; it resolves the repo root itself.
- After `in`, commit `.pi/worktree-discipline.json` so the policy travels with the repo.
- Toggling enforcement is never blocked, because `/worktree-enforce` and the
  script write the marker through the shell (`pi.exec`), not the gated `write`/`edit`
  tools.
