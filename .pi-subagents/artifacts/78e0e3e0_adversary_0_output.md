### `$$` ownership check in the verified teardown always fails in production
- severity: high
- file: extensions/worktree.ts
- line: 970-972 (the `grep -q "\"pid\":$$,"` check in `buildVerifiedTeardownScript`)
- problem: The lifecycle claim is transferred to `handle.pid`, which is Node's `child.pid` for the spawned **outer waiter** bash (see `worktree-transport.ts` `makeHandle` → `pid: child.pid ?? -1`, and `worktree.ts:2626` `pid: handle.pid`). But `buildWaiterInvocation` runs the teardown as `bash -c "$pre"` **inside** the waiter script (e.g. `if [ -n "$pre" ]; then bash -c "$pre"; fi`). That forks a **child** bash, so `$$` inside the teardown script is a different PID than the outer waiter PID persisted in `owner.json`. The grep `"pid":$$,` therefore never matches, `abort="claim"` always fires, and the verified teardown **never removes the worktree, the registration, or the branch** on the model-driven live-dispose path.
- repro_or_impact: I reproduced the real invocation shape end to end: outer waiter `$$`=13042 (recorded in owner.json as the waiter pid); inner teardown bash `$$`=13049; the grep for `"pid":13049,` misses → `ABORT=claim`. Every `worktree_session dispose` against a live target schedules the waiter, transfers the claim, shuts the session down, relaunches in the main checkout, and then the teardown self-aborts at the ownership stage. The successor always reports `partial` ("worktree still exists") and the user is told to clean up manually. The feature is non-functional. The data is safe (fail-closed), but the headline capability does not work. Fix: pass the waiter pid positionally into the preScript (`bash -c "$pre" waiter "$$"`) and grep for `$1` instead of `$$`.

### The verified-teardown test runs the script in one bash, masking the `$$` defect
- severity: high
- file: test/disposal.test.ts
- line: 126-130 (`spawn("bash", ["-c", prelude + script, "teardown", pidFile, goFile])`)
- problem: `runTeardown` concatenates `prelude + script` into a single `bash -c` string, so `$$` in the prelude (`echo $$ > "$1"`) and `$$` inside `buildVerifiedTeardownScript` resolve to the **same** PID. The test then writes `owner.json` with that single PID, so the grep passes. In production the preScript is executed by a **separate** `bash -c "$pre"` child of the waiter, so the two `$$` values differ. `S-DSP-09`, `S-DSP-07`, `S-DSP-05`, `S-DSP-14`, `S-DSP-15`, `S-DSP-17`, `S-DSP-19` all exercise this single-bash model and therefore cannot detect the production mismatch.
- repro_or_impact: Every disposal test passes today even though the production path is broken (see finding above). The test asserts the teardown "removes path, registration, and receipt" against an invocation model that does not exist outside the test. To actually cover the claim, the test must spawn the waiter exactly as `buildWaiterInvocation` does and let it invoke the preScript via `bash -c "$pre"`.

### Teardown deletes the claim and writes its report even after failing its own ownership check
- severity: medium
- file: extensions/worktree.ts
- line: 1043-1055 (the unconditional tail: `path_present`/`registration_present` probes, `rm -f "$receipt"`, `mkdir -p … printf … mv -f`, and `rm -rf "$(dirname "$owner")"`)
- problem: The final observation/report/claim-release block sits **outside** every `if [ "$abort" = "" ]` guard. A teardown that aborted at `claim`, `destination`, `dirty`, `pre-remove`, or `dirty-after-hooks` still (a) writes a teardown report claiming to have observed the post-state and (b) runs `rm -rf "$(dirname "$owner")"`, destroying the ownership evidence a process that just failed to prove it was the owner.
- repro_or_impact: Combined with the `$$` defect this is the steady state today: every live-dispose teardown aborts at `claim` yet still removes the claim directory. In the abstract it also means any process that obtains the script text (e.g. from logs) and runs it cannot prove ownership but still erases the owner file, weakening the claim invariant. The report/claim-release should be gated on a successful ownership check (or at minimum the release should be).

### Orphan-grace reclaim can steal a claim from a slow (not crashed) origin
- severity: low
- file: extensions/worktree-receipt.ts
- line: 217-237 (`acquireClaim`: the `!held && orphanedLongerThanGrace(dir)` branch)
- problem: `mkdir` is the atomic test-and-set, but `writeClaimOwner` is a separate step. If an origin pauses longer than `ORPHAN_CLAIM_GRACE_MS` (30 s) between the `mkdirSync` and `writeClaimOwner` (SIGSTOP, heavy swapping, debugger pause), a challenger sees `readClaim → null` + `orphanedLongerThanGrace → true`, calls `writeClaimOwner(challenger)`, and returns `ok`. When the origin resumes it unconditionally calls `writeClaimOwner(origin)`, **overwriting** the challenger's owner tuple. Both then believe they own the target until the next `verifyClaim`/`writeReceipt` read.
- repro_or_impact: Not data-destructive on its own (the loser's `writeReceipt` fails with `receipt-write-failed` because `verifyClaim` no longer matches), but it can hand the target to a stalled/zombie origin over a live challenger. The grace window is a conscious tradeoff for the crash case, so this is low severity, but the origin-clobbers-challenger direction is worth noting.

### `getRepoRoot`, `listWorktrees`, `resolveGitCommonDir` throw instead of returning a structured refusal
- severity: low
- file: extensions/worktree.ts
- line: 218 (`getRepoRoot`), 1807-1813 (`listWorktrees`), 1788-1792 (`resolveGitCommonDir`)
- problem: These helpers throw raw `Error`s. They are called on the model-tool hot path (`handleWorktreeSessionTool` does `await getRepoRoot(pi)` then `createStore(await resolveGitCommonDir(repoRoot))` before any try/catch, and `resolveTransitionTarget`/`handleModelDispose` call `listWorktrees(repoRoot)` unguarded). On a transient git failure, a missing `--git-common-dir`, or a repo that stops being a repo mid-call, the tool rejects instead of returning a `TransitionDetails` with a stable `code`.
- repro_or_impact: The spec promises every outcome is a structured envelope. A flaky `git rev-parse --git-common-dir` surfaces to the model as an unhandled exception string rather than `code: "git-failed"` with a recovery path, which is exactly the regression class the structured-refusal design was meant to eliminate.

### `verifyDispose` branch disposition is a TOCTOU false positive
- severity: low
- file: extensions/worktree.ts
- line: 1731-1749 (`branchDisposition` computed via `git branch --merged HEAD` at successor-verification time)
- problem: Disposition is judged by whether the branch is merged **now**, in the successor, not at teardown time. The waiter's `git branch -d` correctly refuses an unmerged branch and keeps it ("success"). If that branch is merged into `HEAD` between teardown and the successor's `verifyTransition` call, the successor classifies it as `delete-failed` (merged but still present) and reports `partial`/`dispose-partial` for an outcome that was actually correct.
- repro_or_impact: Narrow window in practice, but it can surface a spurious "cleanup did not fully complete" caveat and nudge the agent/user toward redundant manual action on a branch that was intentionally retained.