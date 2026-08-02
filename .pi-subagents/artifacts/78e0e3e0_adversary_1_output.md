# Adversarial Review: feat/unified-worktree-transitions

**Head SHA:** 505444e48492acd4c9d8ed0a4662031f062942d1  
**Branch:** feat/unified-worktree-transitions  
**Reviewer:** qwen-3.8-max-preview (adversarial)  
**Date:** 2026-08-02

## Findings

### Remote dispose runs hooks without subshells — `exit` in a hook terminates the script
- severity: high
- file: extensions/worktree.ts
- line: 895–900 (buildTeardownScript)
- problem: `buildTeardownScript` (used by both `buildDisposeScript` and `buildDestroyScript`) runs preRemove hooks directly in the script body with `set -e`, not in subshells. The build plan's own defect log (#2) identified this exact pattern in `buildVerifiedTeardownScript` and fixed it by wrapping hooks in `( ... )`. The fix was applied only to the live-dispose script; the remote and slash-command scripts retain the original vulnerability.
- repro_or_impact: A `.pi/worktree.json` containing `"preRemove": ["exit 7"]` causes `buildDisposeScript` (model remote dispose) and `buildDestroyScript` (slash destroy) to terminate the bash process at the hook step. The subsequent `git worktree remove` and `git branch -d` never run. For remote dispose the handler sees `dispose.code !== 0` and reports `dispose-partial` without a report. The live-dispose path was fixed; these two were not.

### Remote dispose has no post-hook cleanliness recheck — `--force` destroys files created after the dirty check
- severity: high
- file: extensions/worktree.ts
- line: 2444–2454 (handleModelDispose remote path) and 880–914 (buildTeardownScript)
- problem: `buildVerifiedTeardownScript` (live dispose) rechecks `git status --porcelain --ignored` after preRemove hooks and immediately before `git worktree remove --force`, aborting if a hook or concurrent write dirtied the target. `buildTeardownScript` (used for remote dispose and destroy) performs no such recheck. The initial dirty check in `handleModelDispose` happens before the bash script runs; anything written between that check and `--force` is silently destroyed.
- repro_or_impact: Write a file into the worktree between the model's dirty check and the `git worktree remove --force` inside the bash script (e.g., a concurrent process or a preRemove hook that creates a file). The file is force-deleted without the agent or user being told. The spec (S-DSP-15) explicitly requires this recheck; it is only implemented for the live path.

### Remote dispose does not acquire a lifecycle claim on the target
- severity: medium
- file: extensions/worktree.ts
- line: 2444–2500 (handleModelDispose remote path)
- problem: The spec (§12.2) requires "a mutating disposal acquires its lifecycle claim before reading dirty state." Live disposal (`disposeLiveWorktree`) correctly calls `acquireClaim`. Remote disposal does not: it goes straight from the dirty check to `pi.exec("bash", ["-c", buildDisposeScript(...)])`. Two concurrent processes can both pass the dirty check and both execute teardown on the same target.
- repro_or_impact: Two pi sessions concurrently calling `worktree_session dispose` on the same remote worktree both succeed past the dirty check and both run the teardown bash script. The second `git worktree remove` fails (already removed), but `git branch -d` may race with the first session's verification read. The outcome is reported based on post-hoc checks, but the interleaving is uncontrolled.

### `listWorktrees` and `resolveGitCommonDir` throw on git failure — model sees an unstructured error string
- severity: medium
- file: extensions/worktree.ts
- line: 1755 (listWorktrees), 1722 (resolveGitCommonDir)
- problem: Both functions throw `new Error(...)` when git fails. `handleWorktreeSessionTool` does not wrap their callers in try/catch, so exceptions propagate to Pi's tool error handler. The spec (§5) says "throws are reserved for programmer errors" and requires operational failures to be returned as structured results with `outcome`, `code`, `process`, and `recovery` fields.
- repro_or_impact: A corrupted `.git`, a git binary upgrade mid-session, or a timeout on `git worktree list --porcelain` causes the model tool to return a raw error string instead of a structured `TransitionDetails` with `code: "git-failed"`. The model loses the `process`, `sessionMode`, and `recovery` fields it needs to reason about recovery.

### `buildDisposeScript` never writes a teardown report — remote dispose outcomes are unverifiable by v2 successors
- severity: medium
- file: extensions/worktree.ts
- line: 1063–1073 (buildDisposeScript calls buildTeardownScript)
- problem: `buildVerifiedTeardownScript` atomically writes a `TeardownReportV1` which the successor reads via `readTeardownReport` and which `verifyDispose` uses to set `reportPresent`. `buildDisposeScript` (remote/slash paths) writes no report. The spec (§12.4) says "a missing or malformed report is partial, never implicit success."
- repro_or_impact: If a v2 dispose handoff is constructed for a remote disposal (or the slash path is later wired to produce v2 handoffs), the successor finds `reportPresent: false` and always classifies the transition as `partial`, even when removal actually succeeded. Currently mitigated because remote dispose uses the legacy handoff path, but the asymmetry means the shared verifier cannot work for remote paths without the shared report writer.

### Pending-transition guard is unit-tested but never integration-tested against Pi 0.83's batch loop
- severity: medium
- file: test/transition-planner.test.ts
- line: 355–390
- problem: The build plan (T5) specified `test/pending-transition.test.ts` as a dedicated test file. It does not exist. The guard logic is unit-tested in `transition-planner.test.ts` and has a trivial wiring test in `worktree-adapters.test.ts`, but no test proves that Pi 0.83's `tool_call` handler with `{block: true}` actually prevents a queued sibling tool from executing in a sequential batch after the transition tool sets `pendingTransition`.
- repro_or_impact: If Pi 0.83's tool-batch loop does not consult the `tool_call` handler for tools already queued in a sequential batch, every tool issued alongside a re-camp would execute after the transition, acting on the wrong working directory. The current tests test the guard function in isolation, not the Pi runtime integration.

### Teardown script grep claim matching uses regex mode for operationId, not fixed-string
- severity: low
- file: extensions/worktree.ts
- line: 970 (buildVerifiedTeardownScript)
- problem: The claim check uses `grep -q "\"operationId\":\"$op\""` without `-F`. The PID line is safe (numeric). The operationId line is interpreted as a regex: if `$op` contained `.`, `*`, `[`, or other regex metacharacters, it could false-match unrelated content in the owner file. Currently mitigated because `newOperationId()` produces only alphanumeric+hyphen IDs via `toString(36)`.
- repro_or_impact: No current code path produces an operationId with regex metacharacters. The risk is defensive: a future change providing an operationId containing `.` could cause the grep to match a different field's value, allowing the teardown script to proceed when it should refuse. Adding `-F` to all three grep calls is a one-character fix that eliminates the class.

## Verified Correct

The following areas were traced adversarially and found sound:

- **Live disposal (`disposeLiveWorktree`):** Claim acquisition, transfer to waiter PID, waiter abort on transfer failure, verified teardown script with subshell hooks, destination branch preflight, double cleanliness recheck, atomic report write, claim cleanup. The owner-tuple disarm is correctly tested by S-DSP-17 tests.
- **`buildVerifiedTeardownScript` bash logic:** `set -u` is safe because `abort` is always initialized. `$$` correctly resolves to the waiter bash PID. The `record` function accumulates stages correctly. The report `printf` format string cannot be confused by path contents because only `%s` directives are used. The `rm -rf` on the claim directory is the only recursive delete.
- **Successor verification:** `verifyEnter` correctly compares handoff target against observed state. `verifyDispose` correctly distinguishes verified, partial, and mismatch. A ready receipt that was replaced or removed is never silently downgraded to unmanaged.
- **Transport probes:** `selectTransport` never falls through on a failed higher-precedence probe. Waiter scheduling resolves only on the OS `spawn` event. The acknowledgement timer is deliberately referenced (defect #1 from the build plan's log).
- **Lifecycle claims:** `mkdir` as atomic test-and-set is correct. Dead-PID reclaim fails closed on EPERM (ambiguous PID reuse). `transferClaim` verifies both the source and destination tuples.
- **Shell quoting:** `shQuote` is applied consistently to all dynamic values in all generated scripts. The waiter script passes dynamic values as positional arguments to `bash -c`, never interpolated into the script body.
- **Handoff encoding:** v2 round-trips correctly. v1 decodes as legacy. Contradictory payloads (ready without hash, unmanaged with hash) are rejected by `isValidV2`.