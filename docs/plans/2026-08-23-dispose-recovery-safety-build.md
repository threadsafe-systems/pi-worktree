# Worktree Removal Recovery Safety — Build Plan

**Date:** 2026-08-23  
**Status:** Advisory build plan  
**Track:** Reversible  
**Authoritative plan:** `docs/plans/2026-08-23-dispose-recovery-safety.md`  
**Tracker projection:** None — advisory mode forbids tracker mutation

## Objective

Implement one fail-closed safety snapshot and teardown path for every worktree removal adapter. Normal disposal refuses any data-loss risk; explicit destroy confirms the exact risk and proceeds only if the snapshot remains unchanged after hooks.

## Rationale

The current `git status --porcelain --ignored` count omits index flags, initialized submodules, and recovery-only administrative history. Checks also occur before hooks while mutations remain partly encoded as shell source. The tasks below establish strict parsers and real-Git inspection before changing mutation paths, then converge direct and detached teardown onto one executor.

## Task order

```text
T1 ─┬─> T2 ─┐
    └─> T3 ─┴─> T4 ─> T5 ─> T6 ─> T7
```

T2 and T3 may proceed independently after T1. All later tasks are sequential because each changes the safety authority used by the next.

## T1 — Snapshot model, parsers, normalization, and safe formatting

### Deliverable

Create `extensions/worktree-safety.ts` with:

- structured inventory and recovery-risk types;
- strict porcelain and NUL-delimited index-flag parsers;
- strict reflog, pseudoref, per-worktree-ref, and `FETCH_HEAD` OID parsers;
- SHA-1 and SHA-256 object-ID validation;
- deterministic sort/deduplicate normalization and snapshot equality;
- terminal-control-safe rendering that preserves raw comparison values.

No Git subprocesses or removal policy enter this task.

### Scenarios

D10, D19.

### Checks

- `npx tsx test/worktree-safety.test.ts` — tests, scope: task.
- `npm run check` — tests, scope: full.
- `npx biome check extensions/worktree-safety.ts test/worktree-safety.test.ts --error-on-warnings` — lint.
- `npx tsc --noEmit` — typecheck.

### Stop conditions

- A parser accepts malformed administrative input.
- Snapshot comparison depends on filesystem iteration order.
- Sanitization changes raw values used for equality.

## T2 — Real Git inventory, index flags, sparse checkout, and submodules

### Deliverable

Add an argv-based Git inspection adapter to the safety module and temporary-repository tests for:

- tracked, untracked, and ignored inventory;
- `assume-unchanged` and `skip-worktree` flags;
- Git-proven sparse-managed `skip-worktree` exceptions;
- refusal when sparse-rule proof is unavailable, malformed, or inconsistent;
- initialized submodules and recursive nested status.

Use stdin-capable process execution for `sparse-checkout check-rules`; do not infer sparse ownership from path patterns.

### Scenarios

D1, D2, D3, D4, D5, D6, D7, D19.

### Checks

- `npx tsx test/worktree-safety-git.test.ts` — tests, scope: task.
- `npm run check` — tests, scope: full.
- `npx biome check extensions/worktree-safety.ts test/worktree-safety-git.test.ts --error-on-warnings` — lint.
- `npx tsc --noEmit` — typecheck.

### Stop conditions

- A porcelain-clean `assume-unchanged` or unmanaged `skip-worktree` entry is omitted.
- An initialized submodule can be classified as empty protected inventory.
- A sparse exception is granted without successful Git rule verification.

## T3 — Administrative history and durable-ref reachability

### Deliverable

Inspect the selected worktree's canonical administrative directory and collect candidate OIDs from reflogs, per-worktree refs, pseudorefs, and `FETCH_HEAD`. Reject symlinked/unexpected entries and read failures. Deduplicate candidates, then use Git ref-containment queries to retain only OIDs not reachable from local branches, tags, or remote-tracking refs.

Temporary-repository tests must create a real reflog-only commit and prove that a branch or tag makes it durable.

### Scenarios

D8, D9, D10, D19.

### Checks

- `npx tsx test/worktree-recovery.test.ts` — tests, scope: task.
- `npm run check` — tests, scope: full.
- `npx biome check extensions/worktree-safety.ts test/worktree-recovery.test.ts --error-on-warnings` — lint.
- `npx tsc --noEmit` — typecheck.

### Stop conditions

- A malformed or unreadable administrative source becomes an empty risk set.
- Reachability is inferred without asking Git.
- Diagnostics abbreviate the recovery OID.

## T4 — Removal policy and exact human-facing evidence

### Deliverable

Replace count-only disposal reasoning with structured policy:

- dispose refusal lists exact protected, ignored, and recovery entries plus preservation guidance;
- destroy confirmation lists the exact destructive snapshot and recovery warning;
- every Git-derived display value is sanitized;
- snapshot mismatch diagnostics identify which inventory class changed;
- model callers can receive refusal details but cannot authorize destructive loss.

Keep formatting separate from inspection and mutation.

### Scenarios

D1, D2, D3, D4, D6, D7, D8, D9, D10, D11, D19.

### Checks

- `npx tsx test/worktree-safety.test.ts` — tests, scope: task.
- `npx tsx test/handoff.test.ts` — tests, scope: task.
- `npm run check` — tests, scope: full.
- `npx biome check extensions/worktree-safety.ts extensions/worktree.ts test/worktree-safety.test.ts test/handoff.test.ts --error-on-warnings` — lint.
- `npx tsc --noEmit` — typecheck.

### Stop conditions

- Dispose offers a confirmation path for protected loss.
- Destroy confirmation omits any snapshot category.
- A terminal-control byte can reach UI or persisted message output.

## T5 — Shared direct teardown executor and post-hook revalidation

### Deliverable

Move direct removal order into one executor used by slash destroy, slash in-process dispose, and model remote dispose:

1. accept the approved snapshot and operation policy;
2. run `preRemove` hooks fail-fast;
3. re-read identity and complete snapshot;
4. refuse on any difference;
5. call Git worktree removal and branch deletion by argv;
6. verify path, registration, and branch outcomes;
7. clean receipts only after path and registration disappear;
8. return a structured refused/partial/complete result.

Shell remains only for configured hook strings.

### Scenarios

D12, D13, D14, D15, D16.

### Checks

- `npx tsx test/worktree-teardown.test.ts` — tests, scope: task.
- `npx tsx test/disposal.test.ts` — tests, scope: task.
- `npm run check` — tests, scope: full.
- `npx biome check extensions/worktree-safety.ts extensions/worktree.ts test/worktree-teardown.test.ts test/disposal.test.ts --error-on-warnings` — lint.
- `npx tsc --noEmit` — typecheck.

### Stop conditions

- A hook-created index, submodule, status, or recovery change reaches mutation.
- Any Git mutation is interpolated into shell text.
- Claims or receipts regress on refused or partial outcomes.

## T6 — Detached waiter integration and machine-readable reports

### Deliverable

Expose the shared teardown executor through a package-shipped Node entrypoint for the live model/waiter path. The waiter remains responsible for PID exit and process relaunch only. The executor reads the approved snapshot, reruns hooks and safety inspection, performs argv-only mutations, and writes an atomic machine-readable report distinguishing refused, partial, and complete outcomes.

Successor verification consumes that report without treating process exit as proof. Package contents and the Node `>=22.19.0` floor must support the entrypoint in an installed environment.

### Scenarios

D13, D14, D15, D16, D17.

### Checks

- `npx tsx test/process-lifecycle.test.ts` — tests, scope: task.
- `npx tsx test/disposal.test.ts` — tests, scope: task.
- `npm pack --dry-run` — packaging.
- `npm run check` — tests, scope: full.
- `npx tsc --noEmit` — typecheck.

### Stop conditions

- Detached teardown carries a second safety implementation.
- A missing or malformed report can be interpreted as successful removal.
- The packed package omits the executable safety module.

## T7 — Adapter parity, provenance, container proof, and final regression

### Deliverable

Complete integration across slash dispose, slash destroy, model live dispose, and model remote dispose. Add Docker scenarios for hook-created state and detached refused/complete reports. Update README safety behavior and add the `@narumitw/pi-worktree` MIT behavioral credit to `PROVENANCE.md`.

Verify existing switch-first disposal, process cwd alignment, conversation carry, lifecycle claims, receipt cleanup, successor reporting, and soft-versus-hard branch behavior.

### Scenarios

D14, D16, D17, D18, D20.

### Checks

- `npm run test:container-enter` — tests, scope: task.
- `npm run check` — tests, scope: full.
- `npm pack --dry-run` — packaging.
- `git diff --check` — formatting hygiene.
- `npx biome check . --error-on-warnings` — lint.
- `npx tsc --noEmit` — typecheck.

### Stop conditions

- Any caller bypasses the shared safety policy.
- Existing disposal/session-switch proofs regress.
- Provenance omits the source and license basis of the ported behavior.

## Definition-of-done coverage

| DoD | Owning tasks |
| --- | --- |
| D1–D2 | T2, T4 |
| D3–D6 | T2, T4 |
| D7 | T2, T4 |
| D8–D10 | T3, T4 |
| D11 | T4 |
| D12–D13 | T5, T6 |
| D14 | T5, T6, T7 |
| D15 | T5, T6 |
| D16 | T5, T6, T7 |
| D17 | T6, T7 |
| D18 | T7 |
| D19 | T1, T2, T3, T4 |
| D20 | T7 |

Every DoD item has one owning implementation task and at least one downstream integration or regression check where the behavior crosses an adapter boundary.

## Implementation discipline

- Work one task at a time in dependency order.
- Begin each task with its failing task-scoped test.
- Do not weaken or delete a scenario to make implementation pass; return to the Plan if the design is wrong.
- Run the task check before the full check.
- Commit each completed task independently with the task and covered DoD identifiers in the commit body, never in code comments.
- Keep the branch usable after every commit.
- Do not mutate issue #23 or any project board in advisory mode.

## Assumptions appendix

- The seven-task size would normally justify tracker projection, but advisory mode explicitly forbids tracker mutation.
- `extensions/worktree-safety.ts` is the default module location; implementation may split a thin detached entrypoint when packaging requires it.
- Temporary repositories are preferred over mocks for Git semantics; pure parsers retain focused unit tests for malformed input.
- A remote-tracking ref is durable for recovery classification.
- Exact post-hook equality intentionally requires a second invocation when a hook changes the approved snapshot.
- The active branch is local and unpushed until the advisory implementation reaches PR review.
- T1 escapes control bytes in diagnostics instead of deleting them, preserving path distinctions while preventing terminal interpretation.
- T2 enumerates initialized submodule paths with Git's recursive `submodule foreach`, then inspects each checkout independently; this avoids parsing human-oriented submodule descriptions while keeping every Git call argv-based.
