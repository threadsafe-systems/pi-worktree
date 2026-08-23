# Worktree Removal Recovery Safety

**Date:** 2026-08-23  
**Status:** Draft advisory plan  
**Recommended track:** Reversible — this changes internal teardown policy and user-facing safety diagnostics without freezing a persisted or external interface  
**Next phase:** Build

## Summary

Harden every worktree-removal path against data that ordinary porcelain status does not reveal.

Normal disposal will remain lossless: it refuses tracked, untracked, ignored, index-flagged, initialized-submodule, or recovery-only administrative history and identifies the exact state the user must preserve or remove. Explicit destroy will remain destructive: it presents the exact inventory and recovery risks for confirmation, runs configured pre-remove hooks, then refuses if the approved state changed before mutation.

A dedicated safety module will own inspection, normalization, revalidation, and argv-only Git mutations. User-authored hooks remain shell commands because their configuration is shell text; Git mutations no longer need shell interpolation.

## Objectives

### O1. Detect status-invisible local state

Inspect `assume-unchanged` and `skip-worktree` index flags, initialized submodules, and nested submodule state in addition to tracked, untracked, and ignored files.

Sparse-checkout-managed `skip-worktree` entries are allowed only when Git's own sparse rule checker proves they are managed by the active sparse definition. Unsupported, malformed, or ambiguous inspection fails closed.

### O2. Detect recovery-only commits

Inspect the selected worktree's reflogs, per-worktree refs, relevant pseudorefs, and `FETCH_HEAD`. Report commits that are reachable through that administrative state but not through a durable local branch, tag, or remote-tracking ref.

The diagnostic includes complete object IDs so the user can preserve each commit with a branch or tag before retrying.

### O3. Preserve distinct dispose and destroy contracts

`dispose` refuses any state whose removal could lose data. `destroy` may remove approved data, but its confirmation names the exact protected, ignored, submodule, index-flag, and recovery inventory.

### O4. Revalidate after hooks

A destructive operation records the inspected snapshot, runs `preRemove`, inspects again, and mutates only if the approved snapshot is unchanged. New, removed, or altered inventory and administrative recovery state all refuse mutation; the user can inspect and retry.

### O5. Keep mutation arguments structural

Run Git removal and branch deletion with executable-plus-argv APIs. Shell execution is limited to configured hook text and waiter/process orchestration.

### O6. Keep all caller paths consistent

Apply the same inspection and revalidation semantics to:

- slash-command disposal from the live worktree;
- model-triggered live disposal through the waiter;
- model-triggered remote disposal;
- slash-command hard destroy.

## Rationale

`git status --porcelain --ignored` is not a complete removal inventory.

- `assume-unchanged` and non-sparse `skip-worktree` entries can suppress local differences.
- initialized submodules and their nested state are not safely represented by the current count.
- reflogs and per-worktree administrative refs can be the only pointers to commits that Git may later garbage-collect after worktree removal.
- a count such as "3 ignored files" does not tell a user what must be preserved.
- the initial check happens before hooks and before session movement, so relying on it creates a time-of-check/time-of-use gap.

The cited `@narumitw/pi-worktree` implementation demonstrates the required Git surfaces and fail-closed posture. This project will port the behavior into its own lifecycle, receipt, waiter, and verification architecture rather than copy its UI or package structure.

## Design direction

### Structured safety snapshot

Add a focused module, expected at `extensions/worktree-safety.ts`, with a small data contract resembling:

- canonical worktree path and administrative Git directory;
- normalized protected inventory entries;
- normalized ignored inventory entries;
- normalized recovery-only object IDs;
- enough identity evidence to ensure the same registered worktree is still being acted on.

Inventory entries carry a stable category and path/detail rather than preformatted prose. Formatting is a separate operation that strips terminal controls before presenting Git-derived content.

Snapshot equality is deterministic: sort and deduplicate every set before comparison. Revalidation compares canonical identity, complete inventory, and complete recovery-only OID sets.

### Inventory inspection

Use Git with explicit argv to collect:

1. `status --porcelain=v1 --untracked-files=all --ignored=matching --ignore-submodules=none`;
2. `ls-files -v -z` for index flags;
3. sparse-checkout configuration and `sparse-checkout check-rules` for candidate `skip-worktree` paths;
4. `submodule status --recursive` for initialized submodules;
5. recursive submodule status output for local nested state.

Any initialized submodule is protected even when clean because removing its parent worktree removes the initialized checkout. Nested dirty or ignored state is listed separately when present.

### Administrative recovery inspection

Resolve the selected worktree's absolute administrative directory through Git. Read reflog files recursively without following symbolic links, plus:

- `refs/worktree`;
- `refs/bisect`;
- `ORIG_HEAD`;
- `MERGE_HEAD`;
- `REBASE_HEAD`;
- `CHERRY_PICK_HEAD`;
- `REVERT_HEAD`;
- `BISECT_HEAD`;
- `FETCH_HEAD`.

Validate every parsed object ID. For each candidate, ask Git whether a local branch, tag, or remote-tracking ref contains it. Candidates with no durable containing ref are recovery risks.

Filesystem errors, unexpected administrative entry types, malformed files, unsupported sparse-rule verification, and Git failures refuse the operation rather than treating the corresponding inventory as empty.

### Dispose policy

Before acquiring or transferring teardown authority, inspect the selected worktree. Refuse when either protected or ignored inventory is non-empty, or when recovery-only OIDs exist. The refusal lists exact normalized entries and preservation guidance.

After `preRemove`, take a fresh snapshot and require exact equality with the approved empty/risk-free snapshot before removal. This catches status, index, submodule, and administrative-history changes made by hooks or concurrent processes.

### Destroy policy

Inspect before presenting confirmation. The confirmation lists all inventory and recovery-only OIDs, including an explicit warning that administrative pointers may disappear and commits may later be garbage-collected.

After confirmation, run `preRemove`, take a fresh snapshot, and require exact equality with the confirmed snapshot. Any change refuses before worktree or branch mutation. The user may inspect the new state and invoke destroy again.

Destroy retains hard branch deletion after successful worktree removal. Dispose retains soft branch deletion and keeps an unmerged branch.

### Shared teardown executor

Move teardown order into one executor:

1. inspect and establish the approved snapshot;
2. obtain any required human confirmation;
3. run configured hooks fail-fast;
4. revalidate worktree identity and exact snapshot;
5. run `git worktree remove --force` by argv;
6. verify path and registration state;
7. delete the branch by argv only when permitted by the operation contract;
8. remove provisioning evidence only after path and registration removal;
9. persist or return the observed result.

The waiter path must invoke the same behavior after the originating process exits. A thin Node entrypoint may host this executor for detached operation; it must use the package's supported Node floor and produce a machine-readable result consumed by successor verification. The existing shell waiter may coordinate PID exit and relaunch, but must not independently reimplement safety inspection or Git mutation.

## Scope

### In scope

- Structured worktree safety snapshots.
- Exact, sanitized inventory diagnostics.
- Index-flag inspection with sparse-checkout exceptions proven by Git.
- Initialized and nested submodule inspection.
- Administrative reflog, per-worktree ref, pseudoref, and `FETCH_HEAD` inspection.
- Durable-ref reachability checks for administrative-history OIDs.
- Fail-closed parsing and filesystem behavior.
- Exact post-hook revalidation.
- Proportional dispose refusal and destroy confirmation semantics.
- Shared teardown execution across slash, model, remote, and waiter paths.
- Argv-only Git removal and branch deletion.
- Machine-readable detached teardown results.
- Provenance credit for the behavioral prior art.
- Unit, temporary-repository, process, and disposable-container coverage.

### Out of scope

- Changing branch naming, worktree location, or provisioning configuration.
- Automatically creating rescue branches or tags.
- Deleting or expiring reflogs.
- Changing Git garbage-collection settings.
- Making the model capable of authorizing data loss.
- Replacing the session-relaunch transport tracked by #20, #22, and #26.
- Adding a generic Git forensic toolkit unrelated to removal.
- Adopting pi-sdlc in this repository.
- Mutating issue #23 or a project board during this advisory run.

## Behavioral decisions

1. **Dispose is refusal-only for loss risk.** It never asks the model or slash-command user to approve protected data loss.
2. **Destroy is the explicit destructive operation.** It may proceed only after a human confirms the exact snapshot.
3. **Initialized submodules are protected inventory.** Clean submodule content is still a checkout that removal destroys.
4. **Sparse exceptions come from Git.** A `skip-worktree` bit is allowed only when `sparse-checkout check-rules` proves the active sparse definition manages it.
5. **Ambiguity is unsafe.** Missing commands, unsupported rule checks, malformed output, symlinks in administrative traversal, and read failures refuse.
6. **Revalidation is exact.** Both additions and removals after confirmation/preflight force a retry rather than silently widening or changing approval.
7. **Recovery diagnostics use full OIDs.** Abbreviations are not sufficient preservation handles.
8. **Git mutation is argv-only.** Shell remains only where the configured interface is itself shell text or where the waiter coordinates processes.
9. **One safety implementation serves every adapter.** Callers may render results differently but cannot own independent inspection policy.
10. **Existing soft-versus-hard branch behavior remains.** Disposal keeps unmerged branches; destroy hard-deletes after successful worktree removal.

## Definition of done

1. **D1** — A worktree with ordinary tracked or untracked changes is refused by dispose with exact entries.
2. **D2** — A worktree with ignored files is refused by dispose with exact entries rather than a count.
3. **D3** — A worktree with `assume-unchanged` state is refused even when porcelain status is clean.
4. **D4** — A non-sparse-managed `skip-worktree` entry is refused even when porcelain status is clean.
5. **D5** — A `skip-worktree` entry proven by Git to be managed by active sparse checkout does not by itself block removal.
6. **D6** — Unsupported or malformed sparse-rule verification refuses instead of allowing an index flag.
7. **D7** — An initialized submodule blocks dispose even when clean; nested dirty or ignored submodule state is identified.
8. **D8** — A commit reachable only through the selected worktree's administrative history blocks dispose and is printed as a full OID.
9. **D9** — The same administrative commit does not block once a durable branch, tag, or remote-tracking ref contains it.
10. **D10** — Malformed or unreadable administrative state refuses removal.
11. **D11** — Destroy confirmation lists exact protected, ignored, submodule, index-flag, and recovery entries.
12. **D12** — If inventory or recovery history changes after confirmation or during `preRemove`, destroy refuses before worktree or branch mutation.
13. **D13** — If any safety state appears during `preRemove`, dispose refuses before worktree or branch mutation.
14. **D14** — Slash disposal, model live disposal, model remote disposal, and slash destroy share the same inspection and revalidation policy.
15. **D15** — Git worktree removal and branch deletion run through argv APIs, not interpolated shell commands.
16. **D16** — Existing lifecycle claims, receipt cleanup, switch-first disposal, waiter ownership, successor verification, and soft-versus-hard branch semantics remain green.
17. **D17** — Detached teardown emits a machine-readable result that distinguishes refused, partial, and complete outcomes without trusting process exit alone.
18. **D18** — `PROVENANCE.md` credits the `@narumitw/pi-worktree` MIT implementation as behavioral prior art.
19. **D19** — Tests include filenames with spaces, newlines, leading dashes, terminal-control bytes, and non-ASCII text without corrupting comparison or diagnostics.
20. **D20** — `npm run check` and `npm run test:container-enter` pass.

## Risks and mitigations

### Git-version differences

`sparse-checkout check-rules` is not present in older Git versions. Treat absence or failure as inability to prove safety; refuse nontrivial `skip-worktree` state and report the failed proof rather than guessing.

### Administrative parsing mistakes

Reflog and pseudoref formats are safety-sensitive. Keep parsers pure and strict, test SHA-1 and SHA-256 object widths, reject malformed records, and use Git for reachability rather than implementing graph traversal.

### Output-driven injection or terminal spoofing

Git paths and ref-derived labels are untrusted display data. Preserve raw normalized values for comparison, strip terminal controls for UI, and never place them into shell source.

### Time-of-check/time-of-use races

No userspace check can make arbitrary external Git mutation impossible. Revalidate identity and the complete snapshot immediately before argv mutation while holding the extension lifecycle claim. Git remains the authority for final removal, and observed postconditions remain mandatory.

### Waiter duplication

Do not create a second safety policy in shell. Invoke the shared Node executor and persist its machine-readable result so the successor reports what actually occurred.

### Hooks that intentionally change inventory

Exact revalidation means such a hook causes a safe refusal and requires a second invocation. This is intentional: the first approval did not cover the new snapshot.

### Large repositories

Batch durable-ref checks where possible, deduplicate OIDs before querying, bound subprocess time, and report inspection failure rather than silently truncating.

## Validation approach

### Pure tests

- Porcelain and NUL-delimited index parsing.
- Sparse-managed versus unmanaged `skip-worktree` classification.
- Administrative reflog, pseudoref, and `FETCH_HEAD` parsing.
- Snapshot normalization, equality, and safe formatting.
- Malformed input and terminal-control handling.

### Temporary Git repositories

- `assume-unchanged` and `skip-worktree` states invisible to porcelain.
- Cone and non-cone sparse-checkout behavior.
- Clean and dirty initialized submodules, including recursive submodules.
- Recovery-only reflog commits before and after adding a durable ref.
- Worktree identity and administrative-state changes between snapshots.
- Soft disposal and hard destroy branch behavior.

### Process and container tests

- Hook-created inventory refuses before removal.
- Hook-created administrative history refuses before removal.
- Destroy confirmation snapshot changes refuse.
- Detached waiter runs the same executor and persists refused/partial/complete results.
- Switch-first slash disposal still preserves the session and process cwd.

## Assumptions

- Node remains at the declared `>=22.19.0` floor, so a shipped detached executor can use current ESM and filesystem APIs.
- Git provides the authoritative repository, sparse-checkout, ref-containment, and worktree identity operations.
- The worktree's administrative directory remains available until Git removal begins.
- A remote-tracking ref counts as durable recovery for this feature, matching the cited prior art.
- Full inventory disclosure is acceptable in local Pi UI and session records because it describes files already visible to the local user.

## Context for the next agent

Read these first:

- `extensions/worktree.ts`
  - `summarizeWorktreeStatus` and `unsafeDisposeReason`;
  - `buildTeardownScript`, `buildVerifiedTeardownScript`, and `runInProcessDisposal`;
  - `handleModelDispose`, `scheduleLiveDisposal`, `handleDispose`, and `handleDestroy`.
- `extensions/worktree-receipt.ts` for claims, receipts, and teardown reports.
- `extensions/worktree-handoff.ts` and `extensions/worktree-transition.ts` for persisted disposal evidence.
- `test/handoff.test.ts`, `test/disposal.test.ts`, and `test/container/enter-switch.e2e.ts`.
- `@narumitw/pi-worktree` `src/git.ts` and `src/command.ts` at the reviewed prior-art revision.
- `PROVENANCE.md` before adding the new attribution.

Begin Build by splitting the work into independently testable slices: snapshot/parser foundation, real Git inventory, administrative reachability, policy/formatting, direct teardown executor, detached waiter integration, and adapter/container verification. Keep one authoritative snapshot and mutation path across all callers.
