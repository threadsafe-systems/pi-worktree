# Unified Worktree Transitions — Build Plan

**Date:** 2026-08-02  
**Status:** Ready for advisory implementation  
**Track:** Irreversible  
**Plan:** `docs/plans/2026-08-02-unified-worktree-transitions.md`  
**Approved advisory specification:** `docs/specs/2026-08-02-unified-worktree-transitions.md`  
**Next phase:** Implementation

## 1. Objective

Implement the approved advisory specification through nine bounded tasks. Each task owns named specification scenarios and exact validation commands. The sequence establishes the shared transition seam first, then durable lifecycle state and transports, then caller adapters, successor verification, disposal, compatibility, and end-to-end proof.

The build remains advisory because this repository has not adopted `pi-sdlc`. No tracker objects, validation manifests, panel stamps, or formal gate claims are created.

## 2. Build strategy

### 2.1 Module shape

Keep one deep caller-facing Worktree Transition module and place variable implementation behind internal seams:

```text
extensions/worktree.ts                 Pi flags, commands, events, UI adapter
extensions/worktree-transition.ts      request/outcome interface, planner, executor, state
extensions/worktree-receipt.ts         receipts, lifecycle claims, teardown reports
extensions/worktree-transport.ts       probe and waiter adapters
```

Tests use the same interfaces as callers. Pure facts are injected; deterministic tests do not require a real multiplexer or destructive repository operations.

### 2.2 Test layout

```text
test/transition-planner.test.ts
test/provisioning-receipt.test.ts
test/transport.test.ts
test/worktree-adapters.test.ts
test/pending-transition.test.ts
test/successor-verification.test.ts
test/disposal.test.ts
test/package-contract.test.ts
test/process-lifecycle.test.ts
```

T1 adds a stable `test/run-all.ts` aggregator and changes `npm test` to run it. The aggregator discovers every `test/*.test.ts` file except itself and executes them sequentially, so every later test joins the full regression net by construction. Existing `test/decision.test.ts` and `test/handoff.test.ts` remain included. T8 adds a package-contract assertion that every planned test file is discovered.

### 2.3 Test-first rule

For each task:

1. add the task-specific scenario tests;
2. run the task-specific test and observe the expected failure;
3. implement only the task scope;
4. run task-specific tests;
5. run `npm test` as the broad regression net;
6. run static and standards checks;
7. record any discretionary choice in the Assumptions appendix.

## 3. Dependency graph

```text
T1 Transition contracts and planner
 ├── T2 Receipt, claim, and report store
 └── T3 Transport probes and waiter scheduling

T1 + T2 + T3
 └── T4 Create, ensure, enter, status, and caller convergence
      └── T5 Model-tool sequencing and pending-transition guard

T1 + T2 + T4
 └── T6 Versioned handoff and successor verification

T2 + T3 + T5 + T6
 └── T7 Live/remote disposal and hard-destroy integration

T1–T7
 └── T8 Compatibility, package, and documentation
      └── T9 Process-level and live herdr verification
```

T2 and T3 may be developed independently after T1. All other work follows the dependency edges.

## 4. Shared validation conventions

Every code task includes:

| Check role | Command | Category | Scope |
| --- | --- | --- | --- |
| Task test | Task-specific `npx tsx test/<file>.test.ts` | tests + scenarios | `task` |
| Full regression | `npm test` | tests | `full` |
| Type safety | `npm run typecheck` | static | n/a |
| Lint/format policy | `npm run lint` (`biome check . --error-on-warnings` from T1 onward) | static + standards | n/a |
| Patch hygiene | `git diff --check` | standards | n/a |

A task is incomplete if its task test passes but the full regression net fails. T1 removes the existing optional-chain warning and makes the lint script use `--error-on-warnings`; every later lint/check run therefore fails on any warning.

## 5. Tasks

## T1. Establish transition contracts and the pure planner

**Purpose:** Create the deep-module seam and make request validation, adapter policy, target-selection policy, capability outcomes, and state transitions explicit before side effects move.

**Implementation scope:**

- Add `extensions/worktree-transition.ts`.
- Define `TransitionRequest`, `RuntimeFacts`, `TransitionDetails`, `StatusOutcome`, `TransitionCode`, planner states, and internal `ensure` intent.
- Implement strict request validation and `name`/`branch` candidate rules.
- Implement the pure capability/fallback decision table, including injected supported/unsupported Pi compatibility facts.
- Model transition state and independent path-target state.
- Add a dependency interface for Git, filesystem, receipts, transport, clock, ids, and shutdown without implementing those adapters yet; every Git/probe dependency requires an explicit timeout.
- Add `test/run-all.ts`, change `npm test` to use discovery, remove the existing Biome warning, and make `npm run lint` use `biome check . --error-on-warnings`.
- Set the Pi Coding Agent peer floor to `>=0.83.0`, update the lock/install to 0.83-compatible packages, and verify the installed dependency tree before lifecycle code is added.
- Keep existing exported pure branch/path/security helpers authoritative; do not duplicate them.
- Add `test/transition-planner.test.ts`.

**Owned scenarios:**

- S-REQ-02, S-REQ-03, S-REQ-07, S-REQ-08
- S-CAP-06, S-CAP-07, S-CAP-08

**Checks:**

| Check | Command | Category | Scope |
| --- | --- | --- | --- |
| Planner scenarios | `npx tsx test/transition-planner.test.ts` | tests + scenarios | `task` |
| Full regression | `npm test` | tests | `full` |
| Type safety | `npm run typecheck` | static | n/a |
| Lint | `npm run lint` | static + standards | n/a |
| Installed Pi contracts | `npm ls @earendil-works/pi-coding-agent @earendil-works/pi-ai` | static | n/a |
| Patch hygiene | `git diff --check` | standards | n/a |

**Completion evidence:**

- `npm test` discovers every present `test/*.test.ts` file and `npm run lint` fails on warnings.
- Installed Pi Coding Agent is 0.83-compatible before later tasks compile against it.
- All callers can be represented as data without caller-specific lifecycle logic.
- Planner tests prove no side-effect adapter is called for invalid/refused plans.
- A `path-target` plan cannot be mistaken for process migration.

**Stop condition:** Do not move current startup/slash/model implementations in this task.

## T2. Implement receipts, lifecycle claims, and teardown reports

**Depends on:** T1

**Purpose:** Make managed provisioning and teardown evidence durable across restarts and safe against concurrent creators.

**Implementation scope:**

- Add `extensions/worktree-receipt.ts`.
- Resolve the common Git directory with the specified old-Git fallback.
- Implement target-path receipt/claim keys and operation-id report keys.
- Implement canonical JSON hashing and the defined config digest.
- Implement atomic receipt/report writes, permissions, flushes where supported, and fail-closed parsing.
- Implement lifecycle-claim acquire, exact owner-tuple verification, transfer primitives, release, dead-PID reclamation, and PID-ambiguity refusal. T2 defines transfer storage; T7 owns live origin-to-waiter orchestration.
- Implement authoritative re-read after claim acquisition as a reusable primitive.
- Implement stale-receipt discard rules using the stale receipt's recorded branch.
- Add temporary-repository and concurrent-process tests in `test/provisioning-receipt.test.ts`.

**Owned scenarios:**

- S-PRO-11

**Supporting component coverage (owned end-to-end later):** S-PRO-01 through S-PRO-10, S-PRO-12, S-PRO-13, S-PRO-14.

**Checks:**

| Check | Command | Category | Scope |
| --- | --- | --- | --- |
| Receipt/claim scenarios | `npx tsx test/provisioning-receipt.test.ts` | tests + scenarios | `task` |
| Full regression | `npm test` | tests | `full` |
| Type safety | `npm run typecheck` | static | n/a |
| Lint | `npm run lint` | static + standards | n/a |
| Patch hygiene | `git diff --check` | standards | n/a |

**Completion evidence:**

- Two concurrent creators produce one owner and one `target-busy` refusal under both completion orderings.
- A crash-state `provisioning` receipt remains non-ready after a new process starts.
- Receipt/report files never contain hook commands, output, or environment values.

**Stop condition:** Do not run project hooks or schedule Pi relaunches in this task.

## T3. Implement transport probes and OS-acknowledged waiter scheduling

**Depends on:** T1

**Purpose:** Replace environment-only transport selection with testable ownership evidence and prevent shutdown without an OS-spawned waiter.

**Implementation scope:**

- Add `extensions/worktree-transport.ts`.
- Implement cmux, herdr, and tmux ownership candidates with existing precedence.
- Implement non-mutating probe results with expected/observed identifiers, stable failure classes, and explicit bounded subprocess timeouts.
- Refuse lower-transport fallthrough when a higher ownership marker exists but fails probe.
- Require `bash`, `pi`, transport executable, exact target, and required identifiers.
- Require explicit tmux pane and herdr workspace/pane ownership.
- Replace boolean `scheduleRelaunch` with an asynchronous OS-spawn-acknowledged scheduler returning a referenced `WaiterHandle` containing the PID plus `commitDetach()` and bounded `abortAndWait()` operations.
- Keep the child referenced after `spawn`; enforce the one-second spawn deadline and best-effort termination. Create/enter callers may commit-detach immediately after acknowledgement. Live disposal in T7 must persist and verify claim transfer through the handle before `commitDetach()`.
- Preserve literal command injection, parent-PID waiting, paths-with-spaces safety, herdr tab behaviour, and origin-pane targeting.
- Add `test/transport.test.ts` with injected process/environment/probe/spawn fakes.

**Owned scenarios:**

- S-CAP-02, S-CAP-03, S-CAP-04, S-CAP-05, S-CAP-09

S-CAP-01 receives supporting transport evidence here; T5 owns the end-to-end model outcome.

**Checks:**

| Check | Command | Category | Scope |
| --- | --- | --- | --- |
| Transport scenarios | `npx tsx test/transport.test.ts` | tests + scenarios | `task` |
| Full regression | `npm test` | tests | `full` |
| Type safety | `npm run typecheck` | static | n/a |
| Lint | `npm run lint` | static + standards | n/a |
| Patch hygiene | `git diff --check` | standards | n/a |

**Completion evidence:**

- Stale cmux/herdr ownership cannot fall through to an outer tmux pane.
- Missing herdr workspace and missing tmux pane are preflight failures.
- No caller can request shutdown before the scheduler resolves with an OS `spawn` event.
- Probe timeout and waiter timeout tests prove transport subprocesses cannot block planning indefinitely.
- A spawned waiter remains controllable until its caller explicitly commits detachment.

**Stop condition:** Do not wire `ctx.shutdown()` or modify public caller behaviour in this task.

## T4. Converge create, startup ensure, enter, status, and adapters

**Depends on:** T1, T2, T3

**Purpose:** Route target resolution and provisioning through the transition module while preserving strict-create versus startup-ensure compatibility.

**Implementation scope:**

- Move create/provision effect ordering behind `WorktreeTransitions.execute`, with explicit timeouts on every Git and hook subprocess.
- Write and update receipts around Git add, env linking, and every post-create hook.
- Ensure receipt failures report partial effects and never schedule re-camp.
- Implement strict create refusal for an existing exact checkout.
- Implement startup `ensure` reuse for ready and unmanaged exact checkouts.
- Implement enter refusal for main, missing, failed, provisioning, corrupt, or mismatched targets.
- Implement exact `StatusOutcome`, path-target terminology, and stale path-target clearing.
- Route startup and slash create/enter through the same planner/executor.
- Keep slash UI as rendering only; retain generated names and create overrides.
- Add `test/worktree-adapters.test.ts` with adapter-parity and temporary-Git tests.

**Owned scenarios:**

- S-REQ-01, S-REQ-04, S-REQ-05
- S-PRO-01, S-PRO-02, S-PRO-03, S-PRO-04, S-PRO-05, S-PRO-06, S-PRO-07, S-PRO-08, S-PRO-09, S-PRO-10, S-PRO-12, S-PRO-14
- S-TRN-08

S-REQ-06 receives supporting planner/path-target evidence here; T5 owns the public model request outcome. Existing create/enter safety behaviours represented by S-CMP-01 are supporting regression evidence; T8 owns that scenario.

**Checks:**

| Check | Command | Category | Scope |
| --- | --- | --- | --- |
| Adapter/create/enter scenarios | `npx tsx test/worktree-adapters.test.ts` | tests + scenarios | `task` |
| Full regression | `npm test` | tests | `full` |
| Type safety | `npm run typecheck` | static | n/a |
| Lint | `npm run lint` | static + standards | n/a |
| Patch hygiene | `git diff --check` | standards | n/a |

**Completion evidence:**

- Equivalent requests produce equivalent transition plans across all three inbound surfaces.
- `pi --worktree <existing>` still reuses an exact checkout.
- Model/slash strict create never silently enters or blesses an existing checkout.

**Stop condition:** Do not add model-tool shutdown/pending behaviour or successor verification in this task.

## T5. Wire the model tool, sequential execution, termination, and pending guard

**Depends on:** T4

**Purpose:** Make model-triggered re-camp safe during an active turn and prevent later sibling tools from executing after transition scheduling.

**Implementation scope:**

- Replace literal-union schemas with `StringEnum` from `@earendil-works/pi-ai`.
- Add `execution` to the model-tool request and update tool guidance.
- Register `worktree_session` with `executionMode: "sequential"`.
- Derive trustworthy Pi compatibility facts from the installed 0.83+ package/runtime surface; unsupported injected versions produce `unsupported-pi-version` and disable automatic model re-camp.
- Await transport scheduling, explicitly commit-detach create/enter waiter handles, set pending state, request graceful shutdown, and return `terminate: true` only for `relaunch-scheduled`.
- Add a global pending guard that permits only exact `worktree_session status` after pending.
- Preserve structured outcome details for operational failures/refusals.
- Handle the all-results-must-terminate rule without assuming blocked siblings terminate.
- Add Pi lifecycle contract fixtures and `test/pending-transition.test.ts`.

**Owned scenarios:**

- S-REQ-06
- S-CAP-01, S-CAP-10
- S-TRN-01, S-TRN-02, S-TRN-03, S-TRN-04, S-TRN-05
- S-CMP-02

**Checks:**

| Check | Command | Category | Scope |
| --- | --- | --- | --- |
| Pending/model-tool scenarios | `npx tsx test/pending-transition.test.ts` | tests + scenarios | `task` |
| Full regression | `npm test` | tests | `full` |
| Type safety | `npm run typecheck` | static | n/a |
| Lint | `npm run lint` | static + standards | n/a |
| Patch hygiene | `git diff --check` | standards | n/a |

**Completion evidence:**

- A lone re-camp result is recorded and terminates without an unnecessary model call.
- Earlier sibling tools finish; every later sibling is explicitly refused.
- A scheduling or compatibility failure leaves Pi alive and non-pending.

**Stop condition:** Do not implement live disposal in this task.

## T6. Version the handoff and verify successors

**Depends on:** T1, T2, T4

**Purpose:** Ensure only the successor can verify active/partial states while retaining orientation for legacy sessions.

**Implementation scope:**

- Add V2 handoff encoding/decoding with operation id, source/target, provisioning class, expected receipt hash, session carry, and dispose facts.
- Preserve decoding of the current unversioned payload as `legacy-unverified`.
- Define and return the exact `SuccessorVerification` structure.
- Verify target canonical path, registration, exact branch, provisioning class, and ready receipt hash before active status/caveat.
- Read teardown reports for dispose handoffs and independently re-read Git/path/receipt/branch reality.
- Distinguish `verified`, `mismatch`, `partial`, and `legacy-unverified`.
- Ensure continuation/caveat wording never asserts removal before verification.
- Add `test/successor-verification.test.ts`.

**Owned scenarios:**

- S-TRN-06, S-TRN-07, S-TRN-09, S-TRN-10

**Checks:**

| Check | Command | Category | Scope |
| --- | --- | --- | --- |
| Handoff/verification scenarios | `npx tsx test/successor-verification.test.ts` | tests + scenarios | `task` |
| Full regression | `npm test` | tests | `full` |
| Type safety | `npm run typecheck` | static | n/a |
| Lint | `npm run lint` | static + standards | n/a |
| Patch hygiene | `git diff --check` | standards | n/a |

**Completion evidence:**

- A changed/missing managed receipt cannot be downgraded to unmanaged.
- Wrong destination path/branch cannot be called active or verified.
- Legacy handoff behaviour remains useful but is explicitly unverified.

**Stop condition:** Do not alter worktree teardown ordering in this task.

## T7. Implement live disposal, remote disposal, and hard-destroy integration

**Depends on:** T2, T3, T5, T6

**Purpose:** Apply the shared safety and evidence model to every teardown path without giving the model hard-delete authority.

**Implementation scope:**

- Implement selector-less and explicit disposal precedence, with explicit timeouts on every Git, status, hook, teardown-report, and branch-classification subprocess.
- Acquire/revalidate lifecycle claims before mutating disposal reads.
- Keep model disposal fail-closed on tracked, untracked, or ignored files.
- Preserve slash-command destructive confirmation as caller policy.
- Implement live origin-to-waiter claim transfer and exact owner-tuple disarm.
- Preflight destination main path/branch before any live teardown and immediately before soft branch deletion.
- Recheck model target cleanliness after origin exit and after `preRemove`.
- Enforce fail-fast `preRemove`, no `rm -rf`, conditional soft branch deletion, conditional receipt cleanup, and atomic teardown report.
- Release claims after durable report; recover from transfer failure, waiter death, and successor launch failure.
- Implement synchronous remote verification with `remoteProcessLiveness: "unknown"`.
- Integrate slash-only hard destroy with the shared resolver, claim, receipt cleanup, and verifier.
- Add temporary-Git/process tests in `test/disposal.test.ts`.

**Owned scenarios:**

- S-REQ-09
- S-PRO-13
- S-DSP-01, S-DSP-02, S-DSP-03, S-DSP-04, S-DSP-05, S-DSP-06, S-DSP-07, S-DSP-08, S-DSP-09, S-DSP-10, S-DSP-11, S-DSP-12, S-DSP-13, S-DSP-14, S-DSP-15, S-DSP-16, S-DSP-17, S-DSP-18, S-DSP-19

**Checks:**

| Check | Command | Category | Scope |
| --- | --- | --- | --- |
| Disposal/destroy scenarios | `npx tsx test/disposal.test.ts` | tests + scenarios | `task` |
| Full regression | `npm test` | tests | `full` |
| Type safety | `npm run typecheck` | static | n/a |
| Lint | `npm run lint` | static + standards | n/a |
| Patch hygiene | `git diff --check` | standards | n/a |

The disposal scenario test must include a structural assertion that generated teardown scripts contain no recursive-delete fallback; it supplies the task's `bannedPatterns` evidence without a duplicate command.

**Completion evidence:**

- Destination mismatch before teardown produces no destructive effect.
- Transfer failure cannot leave an armed destructive waiter.
- Missing/malformed teardown reports are partial, never success.
- Remote disposal truthfully declares unknown independent-process liveness.

**Stop condition:** Do not add any model-callable hard-delete action.

## T8. Complete compatibility, package publication, and documentation

**Depends on:** T1–T7

**Purpose:** Make the refactor shippable and keep public guidance aligned with process/path/pending semantics.

**Implementation scope:**

- Re-verify the Pi peer floor and 0.83-compatible lock/install established in T1, and ensure all `extensions/` imports publish.
- Unit-test the aggregator's discovery function with a synthetic directory listing containing every planned filename, including the future T9 process test; T9's actual `npm test` run proves the real file is discovered without another script edit.
- Add `test/package-contract.test.ts` to inspect `npm pack --dry-run --json`, peer ranges, imports, and enum schema.
- Update README model-tool, startup, fallback, status, disposal, recovery, and compatibility guidance.
- Update PROVENANCE with the unified transition architecture and safety decisions.
- Remove guidance that says interactive model calls should continue through absolute paths by default; retain explicit `execution: paths` guidance for autonomous/headless use.
- Document the remote-process-liveness limitation and manual recovery commands.
- Preserve current command aliases and configuration format.

**Owned scenarios:**

- S-CMP-01, S-CMP-03, S-CMP-04, S-CMP-05, S-CMP-06

S-CMP-02 is re-evidenced here through package/install checks; T5 owns its runtime behaviour.

**Checks:**

| Check | Command | Category | Scope |
| --- | --- | --- | --- |
| Package contract scenarios | `npx tsx test/package-contract.test.ts` | tests + scenarios | `task` |
| Full regression | `npm test` | tests | `full` |
| Full project check | `npm run check` | tests + static + standards | `full` |
| Package contents | `npm pack --dry-run --json` | standards | n/a |
| Installed Pi contracts | `npm ls @earendil-works/pi-coding-agent @earendil-works/pi-ai` | static | n/a |
| Patch hygiene | `git diff --check` | standards | n/a |

**Completion evidence:**

- Dry pack contains every runtime-imported transition file.
- README and tool prompt distinguish process, pending, path-target, manual, partial, and verified states.
- All previous security regression tests remain green.

**Stop condition:** Do not perform live mux verification until all deterministic checks pass.

## T9. Prove Pi lifecycle and live herdr behaviour

**Depends on:** T8

**Purpose:** Validate the cross-process properties that pure tests cannot prove and produce implementation evidence for release review.

**Implementation scope:**

- Add `test/process-lifecycle.test.ts` for parent-PID waiting, OS spawn acknowledgement, persisted tool results, all-results termination semantics, waiter disarm, teardown reports, and manual successor recovery.
- Run the complete deterministic suite first.
- Perform live herdr enter of an existing worktree during an active agent task.
- Perform live herdr create/provision/re-camp during an active agent task.
- Verify destination tab label, correct CWD/branch, full forked history, interrupted-turn continuation, and origin closure.
- Perform clean live disposal back to main.
- Force `preRemove` failure live and verify no prohibited destructive effect and truthful successor status.
- Prove destination-branch mismatch with the deterministic process harness, where the timing can be controlled exactly.
- Exercise unavailable/stale transport and manual recovery without losing the origin session.
- Capture commands and observations in the implementation/PR evidence; do not commit session files or environment contents.

### T9 isolated live-herdr runbook

Run only after deterministic checks pass, from a herdr-owned terminal pane:

```bash
export IMPL_ROOT="$PWD"
export FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/pi-wt-live.XXXXXX")"
export MAIN="$FIXTURE/repo"
export WT_BASE="$FIXTURE/repo.worktrees"
export SESSION_DIR="$FIXTURE/sessions"
mkdir -p "$SESSION_DIR" "$MAIN/.pi"
git init -b main "$MAIN"
git -C "$MAIN" config user.name "Pi Worktree Test"
git -C "$MAIN" config user.email "pi-worktree-test@example.invalid"
printf '{"name":"pi-worktree-live-fixture","private":true}\n' > "$MAIN/package.json"
printf '{"postCreate":["test -f package.json"],"preRemove":[]}\n' > "$MAIN/.pi/worktree.json"
git -C "$MAIN" add package.json .pi/worktree.json
git -C "$MAIN" commit -m "test: initialise live fixture"
git -C "$MAIN" worktree add -b feat/existing "$WT_BASE/feat-existing" HEAD
pi --version
herdr --version
git --version
```

Launch the implementation under test:

```bash
cd "$MAIN"
pi --no-extensions -e "$IMPL_ROOT/extensions/worktree.ts" \
  --session-dir "$SESSION_DIR" --approve
```

Inside Pi, perform these exact operations one at a time and record `worktree_session status`, `pwd`, `git branch --show-current`, and `git worktree list --porcelain` after each successor starts:

1. Ask: `Call worktree_session enter with branch feat/existing as the only tool call. After the successor starts, verify pwd, branch, git status, and the carried tool result before continuing.` Expected: herdr-focused successor at `$WT_BASE/feat-existing`, branch `feat/existing`, verified handoff, origin pane closed. Evidence: S-CAP-01, S-CAP-10, S-TRN-01, S-TRN-06.
2. Ask the worktree successor: `Call worktree_session dispose as the only tool call.` Expected: verified clean return to `$MAIN`; worktree registration/path absent; branch deleted or truthfully retained unmerged. Evidence: S-DSP-02, S-DSP-09.
3. Ask the main successor: `Call worktree_session create with branch feat/live-create as the only tool call.` Expected: ready receipt followed by verified successor at `$WT_BASE/feat-live-create`. Evidence: S-TRN-01, S-TRN-06, S-TRN-09.
4. Dispose `feat/live-create` as in step 2.

For fail-fast `preRemove`, return to main and create a new committed fixture configuration before creating the target:

```bash
printf '{"postCreate":["test -f package.json"],"preRemove":["test ! -e %s/fail-pre-remove"]}\n' "$FIXTURE" > "$MAIN/.pi/worktree.json"
git -C "$MAIN" add .pi/worktree.json
git -C "$MAIN" commit -m "test: add controlled pre-remove failure"
```

Create `feat/pre-remove-failure` through the model tool, then from another shell run `touch "$FIXTURE/fail-pre-remove"` before requesting model disposal. Expected: successor reports `dispose-partial`; target path/registration/branch/receipt remain and no hard-delete occurs. Remove the marker and invoke clean remote disposal from main for recovery. Evidence: S-DSP-05 and S-DSP-18.

Run branch-mismatch, stale-transport, waiter-disarm, waiter-death, and launch-failure cases through the deterministic process harness so timing is controlled:

```bash
npx tsx test/process-lifecycle.test.ts
```

That command must print scenario-labelled PASS evidence for S-CAP-02, S-CAP-03, S-CAP-09, S-TRN-03, S-TRN-07, S-DSP-14, S-DSP-17, S-DSP-18, and S-DSP-19.

Cleanup only after `git worktree list --porcelain` shows no fixture worktree needed for failure evidence:

```bash
git -C "$MAIN" worktree list --porcelain
git -C "$MAIN" worktree prune
case "$FIXTURE" in
  "${TMPDIR:-/tmp}"/pi-wt-live.*) rm -rf "$FIXTURE" ;;
  *) printf 'Refusing unexpected cleanup path: %s\n' "$FIXTURE" >&2; exit 1 ;;
esac
```

**Re-evidenced scenarios:**

- S-CAP-01, S-CAP-02, S-CAP-03, S-CAP-09, S-CAP-10
- S-TRN-01, S-TRN-03, S-TRN-06, S-TRN-07, S-TRN-09
- S-DSP-02, S-DSP-05, S-DSP-09, S-DSP-14, S-DSP-17, S-DSP-18, S-DSP-19

**Checks:**

| Check | Command | Category | Scope |
| --- | --- | --- | --- |
| Process lifecycle | `npx tsx test/process-lifecycle.test.ts` | tests + scenarios | `task` |
| Full regression | `npm test` | tests | `full` |
| Full project check | `npm run check` | tests + static + standards | `full` |
| Package contents | `npm pack --dry-run --json` | standards | n/a |
| Patch hygiene | `git diff --check` | standards | n/a |
| Live herdr matrix | Manual procedures listed above | scenarios | n/a |

**Completion evidence:**

- Command logs show each deterministic check passing.
- Live observations distinguish origin scheduling from successor verification.
- Failure exercises leave recoverable state and no false success claim.

**Stop condition:** Do not call implementation complete if any live failure path is unverified or any deterministic check is nonzero.

## 6. Scenario ownership audit

| Scenario family | Count | Owning task |
| --- | ---: | --- |
| S-REQ | 9 | T1, T4, T5, and T7 |
| S-CAP | 10 | T1, T3, and T5 |
| S-PRO | 14 | T2, T4, and T7 |
| S-TRN | 10 | T4, T5, and T6 |
| S-DSP | 19 | T7 |
| S-CMP | 6 | T5 and T8 |
| **Total** | **68** | All owned |

T9 intentionally re-evidences cross-process scenarios; it does not create new scenario ids.

## 7. Implementation completion criteria

Implementation is ready for PR review only when:

1. T1–T9 are complete in dependency order.
2. All 68 specification scenarios have executable or explicitly manual evidence.
3. `npm run check` exits zero.
4. `npm pack --dry-run --json` proves all runtime imports are shipped.
5. `npm run lint` runs Biome with `--error-on-warnings` and exits zero.
6. No test, receipt, report, or documentation output contains secrets or environment values.
7. Live herdr create, enter, clean dispose, partial dispose, and recovery are evidenced; deterministic process tests evidence destination mismatch, waiter disarm, launch failure, and waiter death.
8. Git status contains only intended implementation, test, and documentation changes.
9. The PR declares the change as irreversible/breaking where release policy requires it.

## 8. Assumptions

- The implementation will use one writer in one feature worktree; advisory reviewers remain read-only.
- T2 and T3 are logically parallel but may be implemented sequentially to preserve single-writer discipline.
- New tests may split differently if their scenario ownership and exact task commands are updated in this build plan before implementation continues.
- The existing shell-based hook trust model remains unchanged.
- No persistent external broker, process-occupancy registry, or Pi core change is introduced.
- Remote disposal retains `remoteProcessLiveness: "unknown"` exactly as specified.
- Discretionary implementation choices discovered during T1–T9 are appended below rather than silently changing scenario contracts.

### Implementation-time assumptions log

**Status:** T1–T5 and T8 complete on `feat/unified-worktree-transitions`. T6, T7, and T9 outstanding.

| Task | State | Commit |
| --- | --- | --- |
| T1 contracts and planner | Complete | `257c585` |
| T2 receipts, claims, reports | Complete | `915c949` |
| T3 transport probes and waiter | Complete | `c28051d` |
| T4 create/ensure/enter convergence | Complete | `de9b59f` |
| T5 model tool, sequencing, pending guard | Complete | `de9b59f` |
| T6 versioned handoff and successor verification | Outstanding | — |
| T7 live disposal and hard-destroy integration | Partial: model remote disposal verified and claim-aware; live teardown still uses the existing interactive flow | `de9b59f` |
| T8 compatibility, package, documentation | Complete | `f76f9ae` |
| T9 process-level and live herdr verification | Outstanding | — |

Discretionary calls made during implementation:

1. **`files` widened to `extensions/` in T1, not T8.** The moment T1 split a module out of `extensions/worktree.ts`, the single-file publish allow-list would have shipped a broken package. Deferring that to T8 would have left every intermediate commit unpublishable.
2. **Branch resolution is injected into the planner rather than imported.** `worktree.ts` imports the planner, so importing its helpers back would create a module cycle. The planner takes a `BranchResolver`, which also lets the candidate-ordering rule be tested without config plumbing.
3. **Transport ownership probes degrade rather than fail closed on an unknown CLI.** A vendor query that cannot run at all (older CLI, no such subcommand) leaves the identifier evidence standing and records that ownership is unverified. Failing closed there would break herdr and cmux setups that work today, for no safety gain; a query that *does* run and disagrees still fails closed.
4. **`piSupportsRecamp` uses `ctx.mode` as the observable proof of the 0.83 contracts.** Older contexts did not expose `mode` at all, so its presence is a usable runtime signal without parsing a version string the extension cannot trust.
5. **Live model disposal returns `manual-restart` pointing at `/worktree dispose`.** Waiter-owned teardown with claim transfer is T7; until it lands, the model is told plainly that it cannot remove the directory it is standing in, rather than being given a partial mechanism.
6. **The acknowledgement timer is deliberately referenced.** An unreferenced timer cannot fire when nothing else holds the event loop, which would hang the caller instead of failing it — found by the transport tests.
7. **`runProvisioningSteps` reports each stage before running it**, so a process that dies inside a step leaves a receipt naming the step that was in flight.
