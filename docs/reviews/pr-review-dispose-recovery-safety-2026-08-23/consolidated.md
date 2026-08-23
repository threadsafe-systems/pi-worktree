# Removal recovery safety — consolidated PR review

- **Date:** 2026-08-23
- **Track:** Reversible
- **Branch:** `feat/dispose-recovery-safety`
- **Governing documents:** `docs/plans/2026-08-23-dispose-recovery-safety.md`, `docs/plans/2026-08-23-dispose-recovery-safety-build.md`
- **Reviewers:** Bedrock EU Claude Opus 5, DeepSeek V4 Pro
- **Orchestrator/adjudicator:** `openai/gpt-5.6-sol`

## Consolidated findings

| ID | Severity | Finding | Agreement | Disposition |
| --- | --- | --- | --- | --- |
| F1 | High | Destroy counted the branch it would hard-delete as a durable ref, hiding commits that the operation would orphan. | Opus | Incorporated in `01210df`; both reviewers verified **RESOLVED**. |
| F2 | Medium | A valid but already-pruned administrative OID made ref-containment fail and permanently blocked removal. | Opus | Incorporated in `01210df`; only an object strictly proven missing is ignored. Both reviewers verified **RESOLVED**. |
| F3 | Medium | Stale/prunable registrations could not be cleaned through the extension. | Opus; DeepSeek disagreed on severity | Automatic prune remains deliberately forbidden because the surviving administrative reflog can be the only recovery pointer. `6a110c3` added actionable preservation-before-prune guidance. Final verdict: Opus **DEFERRED-OK**, DeepSeek **RESOLVED**; no surviving medium. |
| F4 | Medium | Detached teardown used ambient `node` instead of Pi's interpreter. | Opus | Incorporated in `01210df` using shell-quoted `process.execPath`; both reviewers verified **RESOLVED**. |
| F5 | Low | Pre-mutation refusal was reported as branch deletion failure. | Opus | Incorporated in `01210df` with `not-attempted`; **RESOLVED**. |
| F6 | Low | Exact inventory rendering can create a very large confirmation/model result. | Opus | **DEFERRED-OK** by both reviewers. Exact entries are required by D1/D2/D11; subprocess output is bounded at 16 MiB and overflow fails closed rather than truncating approved evidence. |
| F7 | Low | Failing hook output was persisted in the detached report. | DeepSeek | Incorporated in `01210df`; structural failure evidence remains but hook output is omitted from the report. Both reviewers verified **RESOLVED**. |
| F8 | Low | An already-absent branch used failure prose in an otherwise complete in-process disposal. | Opus | Incorporated in `6a110c3` through `teardownBranchNote`; direct test added. The model-facing remote-dispose success message still normalizes the rare `absent` state to end-state wording `deleted`; recorded as a non-blocking residual. |

## Adjudication

### F3 — stale/prunable registration

The original convenience regression is accepted as an intentional safety boundary, not an authorization to restore automatic prune. A missing checkout has no inspectable inventory, while its per-worktree administrative reflog may still be the only pointer to recoverable commits. Repository-wide prune also exceeds the selected target's mutation boundary.

The first refusal was nevertheless inadequate because a raw ENOENT encouraged unsafe manual cleanup. The incorporated fix names the missing registered path, explains that local and administrative recovery cannot be inspected, directs the user to inspect the surviving branch and per-worktree reflog, requires preserving needed commits with a branch or tag, and only then suggests manual `git worktree prune`. Both reviewers reproduced the state and accepted the resulting fail-closed behavior for the final gate.

### Low residuals

The following do not block the PR:

- **Remote-dispose absent-branch wording:** reachable only if the named ref disappears after identity revalidation; the final state is absent and no safety decision depends on the prose. Retain as a future consistency cleanup.
- **Hook stderr in an in-process session message:** `preRemove` hooks are user-authored local commands, and their failure output is useful immediate evidence. The detached machine report no longer persists it. Treat secrets printed by hook commands as a hook-configuration concern.
- **Present non-commit administrative OID:** unusual/corrupt administrative input still refuses rather than guessing. The Git error is less actionable than the missing-object path but preserves the approved fail-closed boundary.

No high or medium finding was dismissed silently. F3's disagreement was resolved by incorporating the refusal-quality concern while retaining the approved no-prune boundary.

## Fix evidence

### `01210df` — wave one

- Exclude destroy's hard-deleted target branch from durable-ref classification at approval and revalidation.
- Distinguish a strictly missing administrative object from other ref-containment failures.
- Invoke detached teardown through Pi's `process.execPath`.
- Preserve `not-attempted` as a truthful branch disposition.
- Omit failing-hook output from the persisted detached report.
- Add real-Git, executor, shell-quoting, container, and secret non-persistence regressions.

### `6a110c3` — wave two

- Replace raw missing-path ENOENT with actionable fail-closed recovery guidance.
- Record destroy-time ref exclusion in both governing documents.
- Render an already-absent branch as nothing to delete and add a direct regression test.

## Validation

Parent validation on the reviewed implementation:

- `npm run check` — 16 test files passed.
- `npm run test:container-enter` — passed.
- `npm pack --dry-run --json` — passed; safety and teardown entrypoint shipped.
- `git diff --check` — passed.
- Primary LSP diagnostics — zero findings.

Reviewers additionally ran targeted real-Git probes for branch reachability, reflog-only commits, pruned objects, stale registrations, non-commit objects, detached branch disposition, shell execution, and package behavior.

## Final gate

**PASS — no high or medium finding survives adjudication.**
