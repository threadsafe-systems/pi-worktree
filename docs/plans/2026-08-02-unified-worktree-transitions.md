# Unified Worktree Transitions

**Date:** 2026-08-02  
**Status:** Draft advisory plan  
**Recommended track:** Irreversible — this changes the model-callable tool's behavioural contract and session lifecycle  
**Next phase:** Specification

## Summary

Unify worktree create, enter, and dispose behaviour across Pi startup flags, slash commands, and the model-callable `worktree_session` tool.

Today, startup and slash-command flows relaunch Pi with the worktree as its real process working directory, while the model tool only records an alternate target and instructs the agent to use absolute paths. The shared action names hide incompatible postconditions and produce a split between `processWorktree` and `selectedWorktree`.

The intended experience is: **enter means work there**. When the runtime can carry the session automatically, Pi should re-camp and resume in the target worktree. When it cannot, the result must identify the fallback explicitly rather than imply that the process moved.

## Objectives

### O1. One behavioural contract

Give create, enter, and dispose one meaning independent of whether the request originated from a CLI flag, slash command, or model tool.

### O2. Real re-camp for interactive agents

When Pi runs in TUI mode under a supported cmux, herdr, or tmux transport, `worktree_session create|enter` should schedule a session-preserving relaunch with the target worktree as the replacement process CWD.

### O3. Safe active-turn handoff

Ensure a model-triggered transition records completed tool results, settles the current agent run, exits cleanly, and resumes with the existing interrupted-task verification guidance.

### O4. Truthful fallbacks

Retain path-targeting for environments that cannot automatically re-camp, but expose it as an explicit outcome with the unchanged process CWD and absolute-path requirement.

### O5. Coherent disposal

Make model-triggered disposal handle both a session physically running in a worktree and a main-checkout session using a path-target fallback, without weakening current dirty-worktree, session-file, live-CWD, soft-delete, or teardown-order safeguards.

### O6. Maintainable lifecycle orchestration

Concentrate transition policy and ordering behind one deep module so transport and caller adapters cannot drift independently again.

## Rationale

Pi tools bind to the startup CWD. Selecting another directory in extension-local state does not move the session and leaves correctness dependent on the model remembering to rewrite every path and shell command.

The installed Pi 0.83.0 lifecycle already supplies the primitives needed for a safe improvement:

- tool-triggered `ctx.shutdown()` is deferred until `agent_settled`;
- tool batches finish and record their results before settlement;
- custom tools may request sequential execution;
- terminating tool results can suppress a redundant follow-up model call;
- the existing detached relaunch waiter waits for the originating Pi PID to exit before starting the replacement.

These are verified in Pi's interactive/RPC mode implementations, the `pi-agent-core` tool-batch loop, and the official `structured-output.ts` and `shutdown-command.ts` extension examples. The implementation must declare Pi 0.83.0 as its minimum compatible version or feature-detect equivalent guarantees before enabling automatic model re-camp.

The missing piece is therefore orchestration and interface coherence, not a new Pi core restart primitive.

## Design direction

### Establish a Worktree Transition module

Introduce one deep module whose interface accepts a worktree intent plus an execution preference and returns a discriminated outcome.

The module should own:

- canonical branch and target resolution;
- exact existing-worktree validation;
- create and post-create ordering;
- current-checkout detection;
- runtime capability selection;
- handoff and continuation construction;
- pending-transition state;
- graceful shutdown requests;
- live-current versus remote-selected disposal;
- truthful postcondition reporting.

CLI flags, slash commands, and `worktree_session` become thin inbound adapters. cmux, herdr, tmux, and manual/path behavior become outbound relaunch adapters.

### Preserve the existing public tool and actions

Keep `worktree_session` and its current `status`, `create`, `enter`, and `dispose` actions for compatibility. Add an execution preference:

- `auto` — re-camp when supported; otherwise select an explicit safe fallback;
- `recamp` — require a real session move and report when unavailable;
- `paths` — deliberately retain the current absolute-path behaviour.

The model tool should default to `auto`. Slash commands should request `recamp` semantics. The existing `pi --worktree <name>` contract remains an internal `ensure` intent: create and provision when absent, or enter an exact matching registered checkout when present. It must not be reinterpreted as strict create.

### Use explicit transition outcomes

At minimum, distinguish:

- `already-active` — the current process is already in the target worktree;
- `relaunch-scheduled` — a replacement session has been scheduled, but is not yet claimed active;
- `path-target` — the process remains in its current CWD and absolute paths are required;
- `manual-restart` — the target is ready, but the caller must restart Pi using the supplied command;
- `disposed` — remote clean disposal completed;
- `refused` or `failed` — include a stable reason and any partial effects.

Only the replacement session may claim that a transitioned worktree is active.

### Make model-triggered re-camp terminal and sequential

The model tool should execute sequentially. Once a re-camp is accepted:

1. Resolve or provision the target.
2. Build the handoff and interrupted-turn continuation.
3. Schedule the relaunch waiter.
4. Mark the transition pending.
5. Request graceful shutdown.
6. Return `relaunch-scheduled` with a terminating tool result.
7. Refuse every later tool call while the transition is pending, except `worktree_session status`, and return an explicit `transition-pending` error for each refusal.
8. Let Pi settle and exit; let the waiter launch the successor after process exit.

The tool prompt should tell the model to call a re-camping worktree operation as the only tool in that response.

### Keep fallback state explicit

Retain extension-local target state only for `path-target` mode. Rename it conceptually from a selected worktree to a path execution target and expose the state clearly:

- `sessionMode`: `process`, `relaunch-pending`, or `path-target`;
- `processCwd` and `processBranch`;
- optional `targetCwd` and `targetBranch`;
- whether absolute paths are required.

### Unify disposal without flattening its safety cases

When Pi is physically inside the worktree, model disposal should follow the live dispose lifecycle: require a clean worktree, schedule return to main, perform teardown only after process exit, and resume in main. The successor must re-read `git worktree list`, the old path, and the branch ref. If the worktree remains because `preRemove` or removal failed, it reports `dispose-partial` with manual recovery instructions instead of implying success. A surviving branch after successful worktree removal is an expected soft-delete outcome when the branch is unmerged.

When Pi remains in the main checkout with a path target, disposal may remain an immediate remote cleanup, subject to the existing strict checks for dirty and ignored files, live CWD, and session-file containment.

Interactive slash disposal may retain explicit confirmation for destructive loss. The model tool should fail closed rather than authorize loss automatically.

## Scope

### In scope

- Shared transition planning and execution.
- Runtime capability detection using `ctx.mode` plus validated transport availability.
- Preflight of the selected transport executable and required identifiers before shutdown; automatic model re-camp is permitted only in TUI mode.
- A copyable manual recovery command in every `relaunch-scheduled` and `manual-restart` outcome.
- Model-tool re-camp under cmux, herdr, and tmux.
- Explicit no-transport and headless fallbacks.
- A small extension-owned provisioning receipt in the repository's common Git administrative directory, recording `provisioning`, `ready`, or `failed` without dirtying a checkout.
- Successor-side verification of both worktree entry and live-dispose teardown outcomes.
- Typed transition outcomes and clearer status output.
- Sequential and terminal model-tool behaviour.
- Pending-transition protection against subsequent tool calls.
- Shared create and enter semantics.
- Live-current and path-target disposal semantics.
- Documentation and provenance updates.
- Planner, executor, adapter-parity, temporary-Git, and relaunch-order tests.
- Package publication changes if transition code is extracted into additional files under `extensions/`.

### Out of scope

- Changing Pi core.
- Copying uncommitted source-checkout changes into a new worktree.
- Replacing full-session `pi --fork` with digest-based resume.
- Weakening branch, path, shell-quoting, main-checkout, dirty-file, or teardown protections.
- Guaranteeing mux command delivery after an acknowledged waiter spawn.
- Adding a durable external transition broker or persistent operation database.
- Redesigning worktree naming or project hook configuration.
- Adopting `pi-sdlc` in this repository.

## Behavioural decisions

1. **Process CWD is authoritative.** A target may be active, pending, or a path fallback; it is never silently treated as active when the process remains elsewhere.
2. **Enter means work there.** Automatic re-camp is the preferred outcome under a capable interactive runtime.
3. **Fallback is explicit.** Absolute-path targeting remains supported but is never described as a successful process migration.
4. **Caller adapters do not own lifecycle policy.** They translate requests and render outcomes only.
5. **No queued slash-command bridge.** The model tool calls the shared transition module directly so active-turn continuation and state remain local to one implementation.
6. **No durable broker in the first implementation.** Pi's deferred shutdown and the existing PID waiter are sufficient unless testing reveals a real loss mode. A small provisioning receipt in common Git metadata is lifecycle evidence, not an external broker.
7. **Provisioning state is durable.** Write a `provisioning` receipt before `git worktree add`, update it to `ready` only after every post-create step succeeds, and retain `failed` with the failed stage. Existing worktrees with no receipt are `unmanaged`, not failed; enter may preserve historical/manual-checkout compatibility but must not claim their hooks were verified. Dispose/destroy removes the receipt.
8. **Transport support is preflighted.** TUI mode, executable availability, required pane/workspace identifiers, target directory, and session-resume inputs are checked before requesting shutdown. Scheduling still remains weaker than launch acknowledgement.
9. **Destroy remains separate.** Hard branch deletion is not folded into normal session transition or disposal.

## Delivery sequence

### Stage 1 — Establish the transition seam

Extract shared request, runtime capability, plan, and outcome concepts. Route current behaviour through the module without changing observable semantics. Preserve the existing proven branch, path, quoting, and teardown helpers.

### Stage 2 — Converge create and enter

Route startup flags, slash commands, and the model tool through the same target resolution and provisioning path. Remove independent decisions about whether an exact existing checkout is accepted or refused.

Strict `create` must not silently bless an existing or partially provisioned checkout. `enter` must require an exact registered target and refuse a receipt marked `provisioning` or `failed` unless a future explicit repair flow is used. An existing checkout with no receipt is treated as `unmanaged` and may be entered for backward compatibility, with an outcome that does not claim project hooks ran. The startup flag uses internal `ensure` semantics so `pi --worktree <existing-name>` remains compatible. A future public convenience `use` action may expose ensure directly, but is not required for this change.

### Stage 3 — Enable model-triggered re-camp

Add runtime capability selection, Pi 0.83.0 compatibility enforcement, transport preflight, sequential tool execution, terminating relaunch results, pending-transition protection, graceful shutdown, supported-mux relaunch, and manual recovery copy through the shared module.

### Stage 4 — Unify fallback, status, and disposal

Make path-target and manual-restart outcomes explicit. Replace split-brain status vocabulary. Route model disposal through live-current or remote-selected behaviour based on authoritative process state.

### Stage 5 — Complete documentation and verification

Update README, provenance, tool prompt guidance, package publication rules, and tests. Perform focused live verification under herdr after deterministic tests pass.

## Definition of done

1. Under herdr, an agent calling `worktree_session enter` for an existing linked worktree causes Pi to settle, open/focus the branch-labelled destination, fork the session from the target CWD, and continue the interrupted task.
2. `worktree_session create` provides the same end-to-end behaviour after successful provisioning.
3. CLI flags, slash commands, and model-tool requests use the same transition planner and executor rather than independent lifecycle branches.
4. No origin-side response claims that a target is active before the successor verifies its CWD and branch.
5. Unsupported runtimes return an explicit `path-target` or `manual-restart` outcome and report the unchanged process CWD.
6. A forced `recamp` request never silently degrades to path targeting.
7. A normal single model-tool re-camp does not consume an unnecessary follow-up model turn.
8. Multi-tool responses cannot run any later tool after a transition becomes pending; earlier sequential siblings finish and are recorded before shutdown, and refused calls receive an explicit `transition-pending` result.
9. Tool-triggered disposal from inside a clean worktree returns the session to main and performs teardown only after the originating process exits.
10. The successor verifies live-dispose postconditions and reports `dispose-partial` when the old worktree remains; an intentionally retained unmerged branch is reported separately from teardown failure.
11. Path-target disposal remains strict and never removes a live CWD, a worktree containing the active session file, or a dirty/ignored worktree.
12. A failed or interrupted post-create operation leaves a durable non-ready receipt; later create, enter, and startup-ensure requests cannot silently report that managed checkout as provisioned.
13. Existing manually created or pre-feature worktrees remain enterable as `unmanaged`, without a false claim that project hooks completed.
14. `pi --worktree <existing-name>` retains its documented exact-match reuse-and-enter behaviour.
15. Automatic model re-camp requires TUI mode and a successful transport preflight, and every scheduled transition includes a manual recovery command.
16. Existing branch validation, shell quoting, main-checkout refusal, sibling-layout, hook ordering, and soft-versus-hard delete tests remain green.
17. Tests cover the runtime capability matrix, adapter parity, transition ordering, pending-transition protection, same-session and restarted-session create-hook failure, no-mux fallback, successor verification, pre-remove/removal failure, and both disposal modes.
18. Published package contents include every imported transition module.
19. README and tool guidance no longer imply that path selection and process migration are the same state.
20. The package declares or verifies Pi 0.83.0-compatible lifecycle semantics.
21. `npm run check` passes, followed by a live herdr create, enter, continuation, clean-dispose, and failed-dispose recovery exercise.

## Risks and mitigations

### Parallel tool batches

A transition tool may appear alongside other calls. Use sequential execution for the whole batch, mark the transition pending before later calls are prepared, block later tools, and use a terminating result. Test source-order variations.

### Relaunch scheduling is not launch acknowledgement

The current transport can prove only that a detached waiter was spawned. Before shutdown, require TUI mode, `command -v` success for the chosen transport, required ownership identifiers, and valid target/session inputs. Name the state `relaunch-scheduled`, include a copyable manual recovery command, verify CWD and branch at successor startup, and retain recovery instructions. Do not claim stronger delivery guarantees.

### Partial provisioning

Git worktree creation occurs before post-create hooks. Write a receipt in extension-owned common Git metadata before creation begins, update it to `ready` only after every provisioning step, and retain a `failed` state with the failed stage. If a hook fails, return a partial-effect failure and do not schedule re-camp. Later create, enter, and startup-ensure requests must refuse managed `provisioning`/`failed` targets until an explicit repair flow exists. Worktrees with no receipt are classified as historical/manual `unmanaged` targets.

### Backward compatibility

Some autonomous workflows may rely on path targeting. Preserve it through `execution: "paths"`, use it as the capability-driven headless fallback, and document the behavioural change for interactive `auto` calls.

### Packaging an extracted module

The package currently publishes `extensions/worktree.ts` explicitly. If code is split, publish `extensions/` or list every imported file, and verify with `npm pack --dry-run`.

### Transport-specific regressions

Keep mux syntax and presentation inside adapters. Preserve cmux-before-herdr-before-tmux precedence and test leaked outer `$TMUX`, missing herdr workspace metadata, target paths with spaces, and origin-pane fallback.

## Validation approach

### Deterministic tests

- Pure transition decision table across action, process location, runtime mode, transport, active-turn state, and requested execution preference.
- Recording-fake executor tests proving effect order and no shutdown after scheduling failure.
- Adapter-parity tests mapping equivalent CLI, slash, and model requests to equivalent plans.
- Model tool tests for sequential mode, terminating result, pending-transition guard, and structured details.
- Temporary Git repository tests for create, exact enter, same-session and restarted-session hook failure receipts, unmanaged historical worktrees, dirty state, and remote disposal.
- Existing security and quoting regression suite.

### Process-level tests

- Detached waiter does not invoke its transport until the parent PID exits.
- Forked successor receives the complete tool result and handoff context.
- Successor startup verifies target CWD and branch before reporting active.
- Live-dispose successor verification distinguishes complete removal, expected retained unmerged branch, failed `preRemove`, and surviving worktree path.
- Pi 0.83.0 contract tests prove tool results are persisted before deferred shutdown, terminating results suppress the normal extra turn, sequential siblings obey source order, and the fork sees the flushed session.

### Manual herdr verification

- Enter an existing worktree during an agent task.
- Create and enter a new worktree during an agent task.
- Confirm the branch-labelled tab, origin-pane closure, full session history, continuation, and correct CWD.
- Dispose a clean worktree back to main.
- Exercise a failed `preRemove` and confirm the successor reports `dispose-partial` with the old checkout intact.
- Exercise a transport preflight failure or unavailable-herdr fallback without losing the originating session.

## Rollback strategy

Keep `execution: "paths"` functional throughout the change. If automatic model re-camp proves unreliable, change the model adapter's `auto` policy back to path targeting without reverting the shared transition module, typed outcomes, status cleanup, or adapter convergence.

Avoid user-facing schema migrations or an external state store. Provisioning receipts live only in extension-owned common Git metadata, are backward-compatible with receipt-less worktrees, and are removed with disposal/destroy, so rollback remains a code/config change plus optional metadata cleanup.

## Assumptions

- Pi 0.83.0 is the compatibility baseline for deferred shutdown, agent settlement, sequential tool execution, and terminating tool results; older versions must be rejected or safely degraded to path targeting.
- Interactive herdr/cmux/tmux processes expose their ownership identifiers to Pi as they do today, but identifiers alone are insufficient without executable and mode preflight.
- The package continues to target local Git worktrees and a single active Pi process per session.
- Existing safety behaviour takes precedence over preserving ambiguous convenience behaviour.
- The first implementation may report a scheduled rather than acknowledged transition.

## Parked for Specification

- Exact request field name and defaulting rules for `execution`.
- Exact discriminated outcome and stable error-code vocabulary.
- Whether `auto` should choose `path-target` or `manual-restart` for a model tool in TUI mode without a mux.
- Exact representation of successor entry verification and live-dispose postcondition results in the handoff payload and status.
- Whether a convenience `use` action belongs in this release or a follow-up.
- The explicit repair command/action for a managed receipt marked `provisioning` or `failed`.
- The exact common-Git-metadata path, receipt key, atomic-write format, and cleanup policy.
- Whether transport preflight should test a harmless transport query in addition to `command -v` and identifier validation.

## Context for the next agent

Read these first:

- `extensions/worktree.ts`
  - model tool registration and `agentWorktree` state;
  - `session_start` CLI flow;
  - `handleWorktreeSessionTool`;
  - `handleEnter`, `handleCreate`, and both disposal paths;
  - `buildContinuationMessage`, `scheduleRelaunch`, and `relaunchInPlace`.
- `test/handoff.test.ts` and `test/decision.test.ts`.
- `README.md` sections on optional discipline, autonomous/headless usage, and relaunch strategy.
- `PROVENANCE.md` session-fork, safety-hardening, and known-limitation sections.
- Installed Pi 0.83.0 extension documentation and implementation: `docs/extensions.md`, `examples/extensions/structured-output.ts`, `examples/extensions/shutdown-command.ts`, `pi-agent-core/dist/agent-loop.js`, and interactive/RPC mode shutdown handling.

The next phase should produce a falsifiable specification for the transition request, outcome algebra, runtime capability matrix, effect ordering, pending-transition behaviour, and disposal state machine. It should explicitly preserve every existing security and data-loss invariant before implementation is decomposed into build tasks.
