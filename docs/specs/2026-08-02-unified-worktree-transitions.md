# Unified Worktree Transitions Specification

**Date:** 2026-08-02  
**Status:** Approved advisory specification (human, 2026-08-02)  
**Track:** Irreversible  
**Upstream plan:** `docs/plans/2026-08-02-unified-worktree-transitions.md`  
**Repository lifecycle:** Advisory only; this repository has not adopted `pi-sdlc`

## 1. Purpose and authority

This specification fixes the public contracts, transition state machines, safety invariants, and falsifiable scenarios for unifying worktree create, enter, and dispose behaviour across:

- the `pi --worktree` startup flags;
- `/worktree` slash commands and their aliases; and
- the model-callable `worktree_session` tool.

The plan is the authority for objectives and scope. This document is the authority for observable behaviour. Implementation details may vary only when every interface, invariant, ordering rule, and scenario in this document remains true.

The existing implementation is concentrated in `extensions/worktree.ts`. In particular, the current model tool selects an absolute-path target (`extensions/worktree.ts:1258-1373`, `1575-1748`), while startup and slash-command paths schedule a process relaunch (`extensions/worktree.ts:1400-1505`, `1844-2057`). This specification removes that behavioural split without weakening the existing branch, path, quoting, dirty-file, live-CWD, or teardown protections.

## 2. Terms

- **Process checkout**: the checkout containing `ctx.cwd`. It is the only checkout that may be called active.
- **Target checkout**: the exact registered linked worktree selected by a transition.
- **Path target**: a target checkout used through absolute paths while the process remains elsewhere.
- **Re-camp**: exit the originating Pi process and start its successor with the target checkout as its process CWD.
- **Origin**: `model`, `slash`, or `startup`.
- **Intent**: `status`, strict `create`, `enter`, startup-only `ensure`, or `dispose`.
- **Provisioning receipt**: extension-owned lifecycle evidence stored in the repository's common Git administrative directory.
- **Pending transition**: a waiter has been acknowledged, graceful shutdown has been requested, and the successor has not yet verified the transition.
- **Successor verification**: the replacement Pi process independently checks the postconditions carried in its handoff before claiming success.
- **Live disposal**: disposal of the worktree containing the originating Pi process.
- **Remote disposal**: disposal of another worktree while Pi's process CWD remains safe.

## 3. Non-negotiable invariants

### I1. Process truth

`ctx.cwd` plus Git detection is authoritative. Extension-local selection never changes the process checkout and must never be rendered as though it did.

### I2. Exact Git identity

Create, enter, ensure, dispose, and successor verification resolve worktrees from `git worktree list --porcelain` and compare canonical paths and exact branch names. A path collision or shorthand collision never authorizes a transition.

### I3. Main-checkout protection

No remove, dispose, or destroy path may target the main working tree. Canonical-path containment checks remain mandatory.

### I4. Originating live-CWD protection

A worktree containing the originating Pi process is removed only by a detached waiter after that process exits. Remote disposal cannot prove that an independently launched process is not using the target; section 12.2 defines this retained limitation explicitly rather than claiming cross-process liveness safety.

### I5. Session-file protection

A worktree containing the session file used by `pi --fork` is never removed. The operation is refused before scheduling.

### I6. Dirty-worktree protection

The model tool never authorizes loss of tracked, untracked, or ignored files. Interactive slash disposal may retain its explicit destructive confirmation, but absence of confirmation must remain non-destructive.

### I7. Shell safety

Every dynamic path, branch, ref, handoff, continuation, and recovery command remains literal shell data through the existing quoting discipline. Project hooks remain trusted project code and are not interpolated into generated shell syntax.

### I8. Provisioning truth

A managed checkout is `ready` only after Git creation, environment linking, and all configured `postCreate` hooks complete. Failed, interrupted, corrupt, or unknown managed state is never silently upgraded to ready.

### I9. Scheduled is not active

The origin may report only `relaunch-scheduled`. Only the successor may report a verified active checkout.

### I10. Teardown is verified

A detached teardown script requesting removal is not proof of removal. Success is based on successor-side Git, path, branch, and receipt checks.

## 4. Public surface

### 4.1 `worktree_session` request

The tool keeps its name and four public actions. It adds one optional execution field.

```ts
type WorktreeSessionRequest = {
  action: "status" | "create" | "enter" | "dispose";
  execution?: "auto" | "recamp" | "paths";
  name?: string;
  branch?: string;
  base?: string;
};
```

The TypeBox schema must use `StringEnum` imported from `@earendil-works/pi-ai`, rather than a union of literals, because Pi documents that helper as the Google-compatible enum shape.

Validation rules:

| Action | Allowed fields | Required selector | Rules |
| --- | --- | --- | --- |
| `status` | `action` | none | Any selector, base, or execution field is `invalid-request`. |
| `create` | `action`, `execution`, `name`, `branch`, `base` | none | Empty selector retains generated-name behaviour. `name` and `branch` are mutually exclusive. |
| `enter` | `action`, `execution`, `name`, `branch` | `name` or `branch` | `base` is invalid. `name` and `branch` are mutually exclusive. |
| `dispose` | `action`, `execution`, `name`, `branch` | optional | Without a selector: process linked worktree, else current path target. With a selector: resolve only that exact named target. `name` and `branch` are mutually exclusive; `base` is invalid. |

`execution` defaults to `auto` for model requests. It means:

- `auto`: automatically re-camp when the full safe capability is present; choose a truthful fallback otherwise;
- `recamp`: never degrade to path targeting; return `manual-restart` if automatic re-camp is unavailable;
- `paths`: deliberately keep Pi in its current process CWD and select an absolute-path target. It is valid only for `create`, `enter`, and remote `dispose`.

### 4.2 Inbound adapter mapping

All adapters construct the same internal request and call the same transition module.

| Inbound surface | Internal intent | Execution | Additional policy |
| --- | --- | --- | --- |
| Model `status` | `status` | n/a | Structured outcome. |
| Model `create` | `create` | supplied or `auto` | Strict create. |
| Model `enter` | `enter` | supplied or `auto` | Exact existing target. |
| Model `dispose` | `dispose` | supplied or `auto` | Never confirms destructive loss. |
| `/worktree create` and aliases | `create` | `recamp` | Interactive UI rendering. |
| `/worktree enter` and aliases | `enter` | `recamp` | Interactive UI rendering. |
| `/worktree dispose` and aliases | `dispose` | `recamp` | May obtain explicit destructive confirmation. |
| `pi --worktree` | `ensure` | `recamp` | Create if absent; reuse only an exact registered checkout if present. |

`ensure` is not added to the public model-tool action enum in this release. No public `use`, `repair`, or `accept` action is added.

For target lookup, `branch` is always one exact branch. On read paths, `name` produces an ordered, deduplicated candidate list: its trimmed literal first, followed by conventional resolution when that differs and is valid. Create resolves `name` directly through the existing conventional branch resolver.

### 4.3 Deep-module seam

The lifecycle implementation lives behind one Worktree Transition module. Its caller-facing interface is conceptually:

```ts
interface WorktreeTransitions {
  execute(request: TransitionRequest, runtime: RuntimeFacts): Promise<TransitionOutcome>;
  inspect(runtime: RuntimeFacts): Promise<StatusOutcome>;
  guardToolCall(call: ToolCallFacts): PendingDecision;
  verifySuccessor(handoff: TransitionHandoff, runtime: RuntimeFacts): Promise<VerificationOutcome>;
}
```

`extensions/worktree.ts` remains the Pi adapter: it translates Pi flags, commands, tool calls, events, and UI rendering. It does not independently decide target identity, capability, effect order, fallback, receipt state, or disposal mode.

The Worktree Transition module owns the planner and executor. Transport and provisioning seams are internal to it. Tests may exercise internal pure planners through named exports, but inbound adapters must not bypass `execute`, `inspect`, `guardToolCall`, or `verifySuccessor`.

## 5. Outcome contract

Every operational tool result returns `details` with this common envelope. Expected operational refusal/failure is represented here rather than thrown, preserving structured evidence. Throws are reserved for programmer errors or impossible internal failures.

```ts
interface TransitionDetails {
  schemaVersion: 1;
  operationId?: string;
  action: "status" | "create" | "enter" | "dispose";
  requestedExecution?: "auto" | "recamp" | "paths";
  outcome:
    | "status"
    | "already-active"
    | "relaunch-scheduled"
    | "path-target"
    | "manual-restart"
    | "disposed"
    | "dispose-partial"
    | "refused"
    | "failed";
  code?: TransitionCode;
  process: CheckoutState;
  target?: CheckoutState;
  sessionMode: "process" | "relaunch-pending" | "path-target";
  requiresAbsolutePaths: boolean;
  provisioning?: "ready" | "unmanaged" | "provisioning" | "failed";
  transport: "cmux" | "herdr" | "tmux" | "none";
  sessionCarry?: "fork" | "fresh" | "none";
  remoteProcessLiveness: "not-applicable" | "unknown";
  partialEffects?: string[];
  recovery?: {
    command?: string;
    instructions: string[];
  };
  verification?: SuccessorVerification;
}
```

`CheckoutState` includes the canonical absolute path, exact branch or `null`, and `kind: "main" | "linked"`.

Outcome semantics:

- `status`: inspection only.
- `already-active`: process CWD and exact branch already equal the target.
- `relaunch-scheduled`: waiter spawn was acknowledged, transition is pending, shutdown was requested, and a recovery command is present. This result sets `terminate: true`.
- `path-target`: process CWD is unchanged, target is recorded, and `requiresAbsolutePaths` is true.
- `manual-restart`: no shutdown or target selection occurred; instructions and a copyable command are present.
- `disposed`: remote removal and postconditions were verified synchronously.
- `dispose-partial`: the successor or remote executor found residual state after teardown.
- `refused`: validation or a safety precondition prevented side effects.
- `failed`: execution began and did not complete; `partialEffects` and recovery are mandatory.

Stable `TransitionCode` values for this release are:

```text
invalid-request
target-not-found
target-exists
target-conflict
target-main-checkout
target-not-ready
target-busy
receipt-corrupt
receipt-write-failed
branch-conflict
dirty-worktree
live-cwd-unsafe
session-file-contained
unsupported-pi-version
transport-unavailable
transport-preflight-failed
session-unavailable
schedule-failed
git-failed
hook-failed
transition-pending
dispose-partial
```

Human-readable `content` is rendered from `details`; it is not a separate source of truth. Consumers must switch on `outcome` and `sessionMode`; there is deliberately no boolean that could collapse scheduled, path-targeted, manual, and verified states into a misleading generic success. `remoteProcessLiveness` is `unknown` only for remote disposal and `not-applicable` for every other finalized outcome.

## 6. Status contract

`worktree_session status` returns the common envelope with `outcome: "status"` plus:

```ts
interface StatusOutcome extends TransitionDetails {
  outcome: "status";
  pathTarget?: CheckoutState;
  pending?: {
    operationId: string;
    action: "create" | "enter" | "dispose";
    target: CheckoutState;
    transport: "cmux" | "herdr" | "tmux";
    scheduledAt: string;
    recoveryCommand: string;
  };
  targetProvisioning?: "ready" | "unmanaged" | "provisioning" | "failed";
  lastVerification?: SuccessorVerification;
  discipline: "on" | "off";
  defaultWorktreeBase: string;
}
```

Status always reports the process checkout and whether absolute paths are required. It never calls a path target `selectedWorktree` or `active`. A new successor starts with no inherited path target. A pending operation exists only in the originating process; its durable facts are carried in the handoff and session transcript.

## 7. Capability and fallback matrix

### 7.1 Pi compatibility

Automatic model re-camp requires Pi Coding Agent 0.83.0-compatible semantics:

- `ctx.mode` includes `tui`, `rpc`, `json`, and `print`;
- a tool-level `executionMode: "sequential"` makes its whole sibling batch sequential;
- `ctx.shutdown()` is deferred until Pi becomes idle;
- tool results are recorded before settlement; and
- `terminate: true` suppresses the follow-up model call only when every finalized result in the batch is terminating.

The package declares `@earendil-works/pi-coding-agent >=0.83.0` as a peer requirement. If equivalent semantics cannot be established at runtime, automatic model re-camp is disabled with `unsupported-pi-version`; `paths` remains available.

### 7.2 Transport ownership and probe

Transport ownership precedence remains cmux, then herdr, then tmux. Ownership is not accepted from environment variables alone.

A transport is capable only if:

1. `ctx.mode === "tui"`;
2. `bash`, `pi`, and the selected transport executable resolve;
3. the target directory exists and is the exact expected Git checkout;
4. the transport's non-mutating probe confirms the originating surface/pane;
5. herdr also confirms a non-empty workspace id and that the pane belongs to it;
6. tmux has a non-empty originating pane id;
7. a readable session file exists when an active model turn must be carried; and
8. the detached waiter emits an OS process spawn acknowledgement before shutdown is requested.

A transport probe returns its kind, expected owner identifiers, observed identifiers where available, and one of `available`, `not-owned`, `missing-executable`, `owner-mismatch`, or `probe-failed`. Finalized outcomes always set `transport`: `none` means no adapter was selected, while a named transport means its probe passed.

The spawn acknowledgement is Node's child-process `spawn` event, not a message from the waiter and not transport-delivery acknowledgement. Scheduling keeps the child referenced until either `spawn` or `error`; a one-second deadline without `spawn` is `schedule-failed`, with best-effort child termination. Only after `spawn` may the child be detached/unreferenced and shutdown requested.

If a higher-precedence ownership marker exists but its probe fails, selection does not fall through to a lower transport: lower variables may belong to an outer or stale multiplexer.

### 7.3 Create and enter fallback selection

| Execution | Runtime capability | Outcome |
| --- | --- | --- |
| any | already exact active target | `already-active` |
| `paths` | target valid | `path-target` |
| `auto` or `recamp` | full automatic capability | `relaunch-scheduled` |
| `auto` or `recamp` | TUI but transport/session preflight unavailable | `manual-restart` |
| `auto` | RPC, JSON, or print | `path-target` |
| `recamp` | RPC, JSON, or print | `manual-restart` |

An active model turn without a readable session file never automatically re-camps into a fresh session. It returns `manual-restart`. An idle slash/startup request may automatically launch a fresh session and must declare `sessionCarry: "fresh"`.

### 7.4 Recovery command

`relaunch-scheduled` and `manual-restart` always include a shell-quoted recovery command. For enter/create it starts Pi at the target and includes `--fork`, handoff, and continuation only when those inputs are valid. For live disposal it preserves soft-delete semantics: after the user exits the live Pi process, it runs the same fail-fast teardown request and launches Pi in the main checkout with the dispose handoff.

The origin never claims that the recovery command or detached transport command was delivered.

## 8. Transition state and effect ordering

The originating process has one in-memory transition state:

```text
idle -> preparing -> relaunch-pending
          |                |
          +-> idle on refusal/failure/path-target/manual-restart
```

The independent path-target state is either unset or one exact checkout. A `path-target` outcome sets/replaces it; `already-active`, successful remote disposal of that target, and successor startup clear it. Only one operation may be `preparing` or `relaunch-pending` at a time.

For automatic create/enter re-camp, effects occur in this order:

1. validate request and resolve exact target identity;
2. create/provision when the intent requires it;
3. verify target registration, branch, path, and receipt state;
4. capture the current session file and handoff facts;
5. preflight Pi, target, session, waiter, and transport capability;
6. build the relaunch and recovery commands;
7. spawn the detached waiter and await spawn acknowledgement;
8. set `relaunch-pending` with operation id and recovery data;
9. call `ctx.shutdown()`;
10. return `relaunch-scheduled` with `terminate: true`.

No shutdown occurs if steps 1–7 fail.

The tool definition has `executionMode: "sequential"`. Therefore tool calls earlier in assistant source order finish first. Once step 8 occurs, `guardToolCall` refuses every later tool call, including read-only and third-party tools, except exactly `worktree_session { action: "status" }`. Each refused call receives `transition-pending`. A batch containing any earlier or refused non-terminating result may still cause one follow-up model call under Pi's all-results-must-terminate rule; the guard continues to prohibit tool side effects until shutdown.

The prompt guidance requires a potentially re-camping `worktree_session` call to be the only tool call in its assistant response.

## 9. Provisioning receipt contract

### 9.1 Location and key

Resolve the common Git directory using `git rev-parse --path-format=absolute --git-common-dir`. When Git does not support `--path-format`, fall back to `git rev-parse --git-common-dir` from the main repository root and resolve its output there.

Receipts and lifecycle claims live under:

```text
<git-common-dir>/pi-worktree/provisioning/v1/<sha256(canonical-target-path)>.json
<git-common-dir>/pi-worktree/provisioning/v1/<sha256(canonical-target-path)>.claim/
```

The directory is extension-owned and does not dirty any checkout. The canonical absolute target path is also stored in the receipt and must match the requested target before the receipt is trusted.

### 9.2 Shape

```ts
interface ProvisioningReceiptV1 {
  schemaVersion: 1;
  operationId: string;
  branch: string;
  worktreePath: string;
  base: string;
  state: "provisioning" | "ready" | "failed";
  stage: "git-worktree-add" | "link-env" | "post-create" | "complete";
  postCreateIndex?: number; // zero-based current/failed hook
  configDigest: string;
  startedAt: string;
  updatedAt: string;
  failure?: {
    code: "git-failed" | "hook-failed" | "receipt-write-failed";
    exitCode?: number;
  };
}
```

The receipt never stores command output, environment values, or hook command text. `configDigest` is the SHA-256 of canonical JSON containing the effective `linkEnvFiles` boolean and ordered `postCreate` array. It is audit evidence; a later configuration change does not invalidate a previously ready checkout.

### 9.3 Ownership, atomicity, and permissions

An operation may perform preliminary selector normalization and derive the candidate canonical path solely to locate the claim. It then atomically creates that target's `.claim/` directory and writes owner metadata containing `operationId`, PID, owner role (`origin` or `waiter`), and creation time. While holding the claim it must authoritatively re-read the receipt, target path, worktree registration, and branch and reject any difference from the preliminary identity before mutation. A live claim causes `refused/target-busy`. A dead-PID claim may be reclaimed atomically; PID ambiguity fails closed and requires manual cleanup.

The claim is held through the mutating operation's final durable receipt or teardown-report write. Every receipt update verifies the complete claim owner tuple (`operationId`, PID, and role); a loser can never overwrite another operation's receipt. Live disposal keeps the child referenced while transferring claim ownership to the OS-acknowledged waiter PID. The waiter must verify `operationId`, its own PID, and role `waiter` before any teardown effect. If transfer persistence fails, the origin cancels shutdown and terminates the child best-effort; even if termination fails, the untransferred waiter is disarmed by the owner-tuple check. Only after transfer succeeds may the child be detached/unreferenced.

Each receipt write must:

1. ensure the extension-owned directory is private to the current user where the platform permits;
2. write complete JSON to a uniquely named temporary file in the same directory;
3. flush and close the temporary file;
4. re-verify claim ownership;
5. atomically rename it over the receipt; and
6. flush the containing directory where the platform permits.

A missing receipt means `unmanaged`. Invalid JSON, an unknown schema, mismatched branch/path, or impossible field combination means `receipt-corrupt` and fails closed for managed operations.

### 9.4 Lifecycle

- Derive the claim key from normalized request identity, acquire the lifecycle claim, then authoritatively re-read and validate receipt, path, registration, and branch before mutation.
- Write `provisioning` before invoking `git worktree add`.
- Update `stage` before each environment-link or post-create effect.
- Write `ready` with stage `complete` only after every effect succeeds.
- On a detected failure after partial effects, write `failed` with the stage and index.
- If any receipt write fails, return `receipt-write-failed`; report Git/path effects already completed and never continue to re-camp. Failure to persist the `failed` state itself is included in recovery text.
- If the process dies, `provisioning` remains non-ready across restart.
- Dispose/destroy removes the receipt only after the worktree path and registration are gone.
- A stale receipt may be discarded automatically only when the target path is absent, no worktree registration references it, and the stale receipt's recorded branch does not exist. Otherwise recovery is manual.
- Release the lifecycle claim only after final state or a teardown report has been atomically persisted. Release does not freeze the target until successor startup; the successor always re-reads reality and reports any subsequent recreation/mutation as partial or mismatch.

No hook is automatically retried and no checkout is manually “accepted” in this release because project hooks need not be idempotent. The supported recovery is inspect, preserve any valuable data, then remotely dispose or interactively destroy the partial checkout and create again. `dispose` and `destroy` may target `provisioning` or `failed` receipts; they do not call the checkout ready, they still enforce dirty/live-CWD/session-file rules, and they clear the receipt only after verified removal. Failure outcomes provide non-destructive instructions when cleanup cannot complete.

## 10. Create, ensure, and enter semantics

### 10.1 Strict create

Strict `create` requires the target path, exact branch, and worktree registration to be absent. If an exact checkout already exists, return `refused/target-exists`; do not reinterpret create as enter and do not create or overwrite a receipt.

After successful provisioning:

- `paths` returns `path-target` with provisioning `ready`;
- capable `auto`/`recamp` schedules re-camp;
- incapable interactive re-camp returns `manual-restart`; and
- incapable headless `auto` returns `path-target`.

### 10.2 Startup ensure

Startup-only `ensure` creates and provisions an absent target. If the exact target already exists:

- `ready` receipt: enter it;
- no receipt: enter it as `unmanaged` and state that hooks were not verified;
- `provisioning`, `failed`, or corrupt receipt: refuse;
- mismatched branch, path, or registration: refuse `target-conflict`.

This preserves `pi --worktree <existing-name>` reuse behaviour.

### 10.3 Enter

`enter` requires an exact registered linked worktree and refuses the main checkout. A ready receipt yields provisioning `ready`; no receipt yields `unmanaged`. `provisioning`, `failed`, and corrupt receipts are refused. Enter never writes a ready receipt and never claims project hooks ran for an unmanaged checkout.

If the process is already in the exact target checkout and branch, return `already-active` and clear any stale path target.

## 11. Handoff and successor verification

### 11.1 Handoff version

The handoff becomes a versioned payload. The decoder remains able to read the current unversioned enter/dispose payload as legacy version 1.

Version 2 contains:

```ts
interface TransitionHandoffV2 {
  schemaVersion: 2;
  operationId: string;
  kind: "enter" | "dispose";
  source: CheckoutState;
  target: CheckoutState;
  targetProvisioning: "ready" | "unmanaged";
  expectedReceiptHash?: string;
  sessionCarry: "fork" | "fresh";
  uncommitted: number;
  ignored?: number;
  dispose?: {
    removedPath: string;
    branch: string;
    receiptPath?: string;
  };
}
```

`expectedReceiptHash` is required when `targetProvisioning` is `ready` and absent when it is `unmanaged`. It is the SHA-256 of the receipt's canonical JSON representation, so whitespace or object-key serialization differences cannot change identity.

```ts
interface SuccessorVerification {
  kind: "enter" | "dispose";
  status: "verified" | "partial" | "mismatch" | "legacy-unverified";
  operationId?: string;
  checkedAt: string;
  expected?: CheckoutState;
  actual: CheckoutState;
  expectedProvisioning?: "ready" | "unmanaged";
  actualProvisioning?: "ready" | "unmanaged" | "provisioning" | "failed" | "corrupt";
  branchDisposition?: "deleted" | "kept-unmerged" | "delete-failed" | "unknown";
  pathDisposition?: "removed" | "present";
  registrationDisposition?: "removed" | "present";
  receiptDisposition?: "removed" | "present" | "mismatched";
  issues: TransitionCode[];
}
```

A legacy handoff yields `legacy-unverified`: it retains the existing orientation caveat but cannot prove an expected destination that was never encoded. Git may still identify the process checkout normally, but status must not call the legacy transition verified. `corrupt` is an observed provisioning classification used only by verification/refusal; it is not a persisted receipt state.

### 11.2 Enter verification

Before naming the session, setting active-worktree status, or injecting a success caveat for a V2 transition, the successor verifies:

- canonical `ctx.cwd` equals handoff target path;
- Git reports a linked worktree at that path;
- current branch equals the handoff target branch; and
- `targetProvisioning` still matches; a ready target has the same canonical receipt hash, while an unmanaged target still has no receipt.

Success records `verification.status: "verified"`. A missing/replaced ready receipt or any path/branch/provisioning difference records `verification.status: "mismatch"`, does not claim the transition verified, and injects recovery guidance containing expected and actual facts.

### 11.3 Dispose verification

Before any live-dispose teardown effect, the waiter verifies the canonical destination main-checkout path and exact expected destination branch. A mismatch skips `preRemove`, removal, receipt cleanup, and branch deletion, writes a mismatch teardown report, and still attempts successor launch so recovery can be surfaced. Immediately before `git branch -d`, the waiter verifies the destination path and branch again; a mismatch at that point skips branch deletion and records a partial teardown.

The successor reads the operation's teardown report and independently verifies:

- it is running from the expected main checkout on the exact expected destination branch;
- the old worktree is absent from `git worktree list --porcelain`;
- the old path is absent;
- the provisioning receipt is absent after successful removal; and
- branch state is classified.

Branch classification is:

- absent: `deleted`;
- present and not an ancestor of destination `HEAD`: `kept-unmerged`, a successful soft-dispose result;
- present and already merged into destination `HEAD`: `delete-failed`, making the result partial.

A destination path/branch mismatch sets verification status `mismatch`. A matching destination with a surviving old path/worktree registration, failed receipt cleanup, missing/failed teardown report, or merged branch that remains sets status `partial`. The successor records the full `SuccessorVerification` and surfaces `dispose-partial` rather than using wording that says the checkout “has been removed.”

## 12. Disposal state machine

### 12.1 Target selection

For a selector-less model disposal:

1. use the process worktree when Pi is inside a linked worktree;
2. otherwise use the current path target;
3. otherwise refuse `target-not-found`.

An explicit selector ignores any path target and resolves only its ordered exact branch candidates. It never overrides main-checkout or containment protections.

### 12.2 Model policy

After target resolution, a mutating disposal acquires its lifecycle claim before reading dirty state. The model tool then obtains `git status --porcelain --ignored`. Any output refuses disposal with `dirty-worktree`. For live disposal, the acknowledged waiter owns the transferred claim and repeats this check after process exit and again after `preRemove`, immediately before removal; a newly dirty target aborts teardown. It cannot confirm loss.

- Live target plus capable re-camp: schedule teardown after process exit, then relaunch main.
- Live target without capability: return `manual-restart`; do not remove anything or change the path target.
- Remote target: acquire its lifecycle claim, execute teardown synchronously, verify it, and return `disposed` or `dispose-partial`.
- `execution: "paths"` is refused for a live target with `live-cwd-unsafe`.

Remote disposal preserves existing behaviour but cannot prove whether an independently launched process has that checkout as its CWD or stores another session file there. Its outcome and documentation must say `remoteProcessLiveness: "unknown"`; it must not claim cross-process liveness safety. Cross-process occupancy coordination is outside this release.

### 12.3 Slash-command policy

Interactive slash disposal may show the existing confirmation with tracked, untracked, and ignored loss counts. Cancellation has no side effects. Confirmation authorizes only the data-loss check; all other safety invariants remain mandatory.

### 12.4 Teardown ordering

Live teardown reports live under:

```text
<git-common-dir>/pi-worktree/transitions/v1/<operationId>.json
```

They contain schema version, operation id, expected destination, each teardown stage's exit status, final observed path/registration/branch/receipt dispositions, and timestamp; they contain no command output or environment values. The waiter writes the report atomically before releasing its lifecycle claim. A missing or malformed report is partial, never implicit success. After a successor successfully decodes and independently verifies a complete result, it may remove the report after copying verification into in-memory status. Partial/mismatch reports remain until recovery completes or the user removes them.

Teardown order is:

1. verify waiter claim ownership and expected destination canonical path/branch;
2. for model disposal, recheck clean state;
3. run each `preRemove` hook from the target, fail-fast;
4. for model disposal, recheck clean state again;
5. request `git worktree remove --force` from the main checkout;
6. if removal fails, `git worktree prune` may repair stale metadata but must never fall back to `rm -rf`;
7. only when path and registration are gone, reverify destination path/branch and request `git branch -d`;
8. remove the provisioning receipt only when path and registration are gone;
9. observe all postconditions and atomically write the teardown report;
10. release the lifecycle claim and attempt successor launch.

A failed `preRemove` prevents removal. Errors are not treated as proof of success even when the successor is launched. If successor launch fails after report/release, a later manual launch using the recovery command reads the same report and independently re-verifies current state.

### 12.5 Hard destroy compatibility

`/worktree destroy` remains an interactive, slash-command-only destructive path rather than a `WorktreeSessionRequest` intent. It must reuse the shared exact target resolver, lifecycle claim, receipt store, main-checkout/live-CWD/session-file guards, and postcondition verifier. It may target `provisioning` or `failed` receipts. After explicit confirmation it retains hard `git branch -D`; the result is complete only when path, registration, branch, and receipt are absent. Failed `preRemove` still blocks removal. No model tool gains hard-delete authority.

## 13. Non-functional requirements

### N1. Locality

Target resolution, capability choice, effect ordering, receipt interpretation, transition state, and verification each have one implementation behind the Worktree Transition module.

### N2. Testability

The planner accepts injected runtime, Git, filesystem, transport, clock, id, and process facts. Deterministic tests need no real multiplexer. Process tests cover waiter and Pi lifecycle behaviour separately.

### N3. Compatibility

Current action names, branch resolution, generated names, sibling layout, explicit branch/base validation, startup reuse, soft dispose, hard destroy, and no-session idle relaunch remain supported unless this specification explicitly changes them.

The intentional model-tool change is that interactive `auto` prefers real re-camp rather than absolute-path selection. `execution: "paths"` preserves the old autonomous behaviour. Remote disposal retains the documented cross-process-liveness limitation in section 12.2 rather than strengthening the current safety claim.

### N4. Packaging

All imported transition modules under `extensions/` are included in the published package. `npm pack --dry-run` must prove inclusion.

### N5. Observability

Every outcome includes stable structured details. User-visible messages distinguish requested, scheduled, verified, partial, and failed states.

### N6. Performance

Non-hook planning and status inspection add no unbounded waits. Git and probe operations use explicit timeouts. Waiter polling remains detached and does not hold Pi shutdown open.

## 14. Falsifiable scenarios

Each scenario is a pass/fail contract. Scenario ids are stable inputs to the Build phase.

### Request and adapter scenarios

| ID | Given / When | Pass | Fail |
| --- | --- | --- | --- |
| S-REQ-01 | Equivalent model, slash, and startup requests resolve the same absent branch target. | Their planner snapshots have the same canonical branch/path/base and differ only in declared origin policy. | Any adapter computes target identity independently or produces another target. |
| S-REQ-02 | Model `create` includes both `name` and `branch`. | `refused/invalid-request`; no Git, receipt, target, or shutdown effect occurs. | Either selector silently wins. |
| S-REQ-03 | Model `enter` includes `base`. | `refused/invalid-request` with no side effects. | Base is accepted or ignored silently. |
| S-REQ-04 | Strict create names an exact existing checkout. | `refused/target-exists`; no receipt is written and no enter occurs. | Existing checkout is blessed, selected, or modified. |
| S-REQ-05 | `pi --worktree` names that same exact checkout. | Startup ensure enters it according to its receipt classification. | Startup behaves like strict create and rejects all existing targets. |
| S-REQ-06 | A caller requests `execution: paths`. | The process CWD is unchanged and a successful result says `path-target` with absolute paths required. | Result says entered/active or shutdown is requested. |
| S-REQ-07 | Model `enter` supplies neither `name` nor `branch`. | `refused/invalid-request`; no target lookup or effect occurs. | A generated or implicit target is entered. |
| S-REQ-08 | Model `dispose` supplies both `name` and `branch`. | `refused/invalid-request`; neither selector wins. | Either target is disposed. |
| S-REQ-09 | A path target exists and model `dispose` explicitly selects another branch. | Only the explicit selector's ordered exact candidates are considered. | The path target is disposed instead. |

### Capability and scheduling scenarios

| ID | Given / When | Pass | Fail |
| --- | --- | --- | --- |
| S-CAP-01 | TUI, readable session, exact target, and a probed cmux surface are available. | `auto` schedules cmux and returns `relaunch-scheduled` with recovery command. | It selects paths or reports active at origin. |
| S-CAP-02 | Valid herdr markers and leaked outer tmux variables coexist. | A successful herdr probe selects herdr. | tmux is selected. |
| S-CAP-03 | A cmux ownership marker exists but its probe fails while lower-level markers also exist. | Automatic scheduling is unavailable; no lower transport is used. | The command can be injected into a possibly stale lower pane. |
| S-CAP-04 | Herdr pane exists but workspace metadata is missing or mismatched. | Preflight fails before waiter spawn or shutdown. | Origin exits. |
| S-CAP-05 | TMUX exists but `TMUX_PANE` is absent or its probe fails. | Preflight fails; no untargeted `send-keys` is used. | Relaunch may land in an arbitrary pane. |
| S-CAP-06 | Model `auto` runs in RPC/JSON/print with a valid target. | Outcome is `path-target`. | Terminal injection or shutdown is attempted. |
| S-CAP-07 | Model `recamp` runs outside TUI. | Outcome is `manual-restart`, never `path-target`. | Forced recamp silently degrades to paths. |
| S-CAP-08 | An active model turn has no readable session file. | Automatic re-camp is not scheduled; result is `manual-restart` with `sessionCarry: fresh`. | The active task is silently abandoned into a fresh successor. |
| S-CAP-09 | Detached waiter emits `error` or no Node child-process `spawn` event within one second. | `failed/schedule-failed`; best-effort child termination, no pending state, and no shutdown. | Origin exits without an OS-acknowledged waiter process. |
| S-CAP-10 | A single model re-camp result is the only tool result in its batch. | Result has `terminate: true`, is persisted, and Pi settles without a follow-up model call before shutdown. | A redundant model turn is consumed or result is missing from the fork. |

### Provisioning scenarios

| ID | Given / When | Pass | Fail |
| --- | --- | --- | --- |
| S-PRO-01 | Create starts for an absent target. | Atomic `provisioning/git-worktree-add` receipt exists before Git mutation. | Git mutation precedes durable intent. |
| S-PRO-02 | Git, env linking, and every post-create hook succeed. | Receipt becomes `ready/complete` only after the final hook. | Ready is written earlier. |
| S-PRO-03 | Post-create hook 2 fails after hook 1 succeeds. | Result is `failed/hook-failed`, partial effects are reported, receipt is `failed/post-create` with index 1, and no re-camp occurs. | Checkout is reported ready or the failure is forgotten. |
| S-PRO-04 | The process dies after Git add while receipt is `provisioning`. | A restarted enter/create/ensure refuses `target-not-ready`. | Receipt-less in-memory state allows entry as ready. |
| S-PRO-05 | A manually created exact worktree has no receipt. | Enter/ensure allows it as `unmanaged` and never claims hooks ran. | It is called ready or rejected solely for being historical. |
| S-PRO-06 | A receipt contains invalid JSON, unknown schema, or a mismatched path. | Operation refuses `receipt-corrupt`. | It is treated as unmanaged or ready. |
| S-PRO-07 | A stale receipt remains but target path, registration, and the stale receipt's recorded branch are all absent. | Create may atomically discard it and start a new lifecycle. | Stale metadata permanently bricks a clean name. |
| S-PRO-08 | A stale receipt remains and any target path, registration, or stale recorded branch remains. | Operation fails closed with manual recovery. | It deletes or overwrites residual state automatically. |
| S-PRO-09 | Receipt writing fails after Git created the worktree. | Result is `failed/receipt-write-failed` with partial effects, and later operations cannot call the target ready. | The target is silently usable as managed ready. |
| S-PRO-10 | Configuration changes after a ready receipt was written. | Receipt remains ready and retains its creation digest for audit. | Enter unexpectedly reruns hooks or invalidates the checkout. |
| S-PRO-11 | Two processes concurrently create the same absent target. | Exactly one atomically acquires the lifecycle claim; the loser returns `refused/target-busy` and cannot overwrite any receipt state. | Both mutate Git or the losing operation writes `ready`/`failed` over the winner. |
| S-PRO-12 | The initial provisioning-receipt write fails before Git add. | `failed/receipt-write-failed`; no Git/path/branch effect occurs and the claim is safely released or reported. | Git creation begins without durable intent. |
| S-PRO-13 | A failed/provisioning target is clean and remotely disposed. | Disposal may remove it under normal safeguards and clears its receipt only after path and registration are verified absent. | It must be entered/blessed first, or receipt is cleared while checkout remains. |
| S-PRO-14 | Target registration or branch changes after preliminary resolution but before lifecycle-claim acquisition. | The authoritative re-read under the claim detects the difference and refuses before mutation. | The stale preliminary identity is mutated. |

### Transition and pending-state scenarios

| ID | Given / When | Pass | Fail |
| --- | --- | --- | --- |
| S-TRN-01 | Model enters a capable target during an active turn. | Tool result is recorded, waiter is acknowledged, pending is set, shutdown is requested, and successor forks complete history. | Shutdown precedes the result or waiter acknowledgement. |
| S-TRN-02 | A sibling tool appears before the transition call. | Earlier tool completes in source order before transition planning. | Calls execute concurrently. |
| S-TRN-03 | Any sibling tool appears after pending is set. | It is refused with `transition-pending`, regardless of whether it is read-only. | It executes. |
| S-TRN-04 | `worktree_session status` appears after pending is set. | It returns pending operation facts without mutation. | It is blocked or starts another transition. |
| S-TRN-05 | The model attempts another transition while one is pending. | It is refused `transition-pending`. | Two waiters or shutdown plans are created. |
| S-TRN-06 | Successor starts at expected canonical path and exact branch. | Verification is `verified`; only then are active status and success caveat emitted. | Origin-side scheduling alone produces active status. |
| S-TRN-07 | Successor starts at the wrong path or branch. | Verification is `mismatch`, expected/actual facts are shown, and no active claim is made. | The handoff assertion overrides Git reality. |
| S-TRN-08 | Process already occupies the exact target. | `already-active`; no waiter, shutdown, or path target remains. | A redundant re-camp or split target is created. |
| S-TRN-09 | A target was managed-ready at scheduling but its receipt is missing, replaced, or changed before successor verification. | Verification is `mismatch`; it is never silently downgraded to unmanaged. | Successor reports verified active. |
| S-TRN-10 | Successor receives a legacy unversioned handoff. | Existing orientation is preserved and transition verification is `legacy-unverified`. | Actual CWD is used as a tautological expected target or the legacy transition is called verified. |

### Disposal scenarios

| ID | Given / When | Pass | Fail |
| --- | --- | --- | --- |
| S-DSP-01 | Model disposes a dirty remote target. | `refused/dirty-worktree`; no hook, removal, branch deletion, or receipt deletion. | Any destructive effect runs. |
| S-DSP-02 | Model disposes its clean live worktree with capable transport. | Lifecycle-claim ownership transfers to the acknowledged waiter, teardown is scheduled after process exit, and origin returns `relaunch-scheduled`. | Worktree is removed under the live CWD or claim is reclaimable as soon as the origin exits. |
| S-DSP-03 | Model requests `paths` disposal of its live worktree. | `refused/live-cwd-unsafe`. | Live worktree is removed or treated as remote. |
| S-DSP-04 | Live disposal has no automatic transport. | `manual-restart`; no destructive effect occurs and instructions preserve soft-delete semantics. | Origin removes itself or hard-deletes the branch. |
| S-DSP-05 | `preRemove` fails. | Removal and branch deletion do not run; successor reports `dispose-partial` with old path intact. | Failure is hidden or worktree is removed. |
| S-DSP-06 | `git worktree remove` fails and prune cannot eliminate registration/path. | No `rm -rf` fallback runs; successor reports partial. | Unrelated reused path content can be recursively deleted. |
| S-DSP-07 | Removal succeeds and unmerged branch remains. | Successor reports successful disposal with `kept-unmerged`. | Retained branch is called teardown failure or hard-deleted. |
| S-DSP-08 | Removal succeeds but a merged branch remains. | Successor reports `dispose-partial/delete-failed`. | Disposal is called complete. |
| S-DSP-09 | Removal, soft branch deletion, and receipt cleanup all succeed. | Successor reports verified completion; old path/registration/receipt are absent. | Success is reported before all checks. |
| S-DSP-10 | Session file is inside the target worktree. | `refused/session-file-contained` before scheduling. | Teardown can delete the session before fork. |
| S-DSP-11 | Slash disposal sees ignored or uncommitted files and user cancels. | No effects occur. | Confirmation cancellation still schedules teardown. |
| S-DSP-12 | Remote clean disposal runs from main. | Teardown and verification complete synchronously as `disposed` or `dispose-partial`; process CWD remains main. | Result says Pi returned to main after a process move that never happened. |
| S-DSP-13 | Remote disposal is requested while independent-process occupancy cannot be established. | Outcome declares `remoteProcessLiveness: unknown` and makes no cross-process safety claim. | Result claims no other Pi/session can be using the target. |
| S-DSP-14 | Destination main branch changes after scheduling but before waiter teardown. | Waiter destination preflight writes a mismatch report and performs no `preRemove`, worktree removal, receipt cleanup, or branch deletion; successor verification is `mismatch`. | Any destructive effect runs against the unexpected destination branch. |
| S-DSP-15 | The live target becomes dirty after origin check but before removal. | Waiter recheck aborts before `git worktree remove`. | `--force` destroys newly observed files. |
| S-DSP-16 | Hard destroy succeeds for a failed-receipt target. | Path, registration, hard-deleted branch, and receipt are all verified absent. | Destroy reports complete while any remains. |
| S-DSP-17 | Live-dispose claim transfer to the spawned waiter cannot be persisted. | Shutdown is cancelled, the waiter is terminated best-effort and cannot pass its exact owner-tuple check, and no teardown effect can occur on later origin exit. | An armed waiter can later remove a supposedly cancelled target. |
| S-DSP-18 | Waiter completes teardown but successor transport launch fails. | Atomic teardown report exists, lifecycle claim is released, and the manual recovery command can launch a successor that re-verifies current state. | Claim leaks indefinitely or teardown success is unknowable. |
| S-DSP-19 | Waiter dies after claim transfer but before writing a report. | Its dead-PID claim is reclaimable under the fail-closed rules and successor/manual recovery reports missing teardown evidence as partial. | Missing report is treated as success or target is permanently locked without recovery. |

### Compatibility and packaging scenarios

| ID | Given / When | Pass | Fail |
| --- | --- | --- | --- |
| S-CMP-01 | Existing branch/ref/path injection and slug-collision regression cases run. | Every existing refusal and quoting test remains green. | New orchestration bypasses a safety helper. |
| S-CMP-02 | Pi version lacks required lifecycle semantics. | Automatic model re-camp is disabled; paths/manual outcome remains truthful. | Unsupported runtime shuts down as if supported. |
| S-CMP-03 | Package is dry-packed after module extraction. | Every runtime import under `extensions/` appears in the tarball. | Published install has missing modules. |
| S-CMP-04 | Existing unversioned handoff is decoded. | It retains current enter/dispose orientation behaviour. | Upgrade breaks sessions already carrying legacy handoff data. |
| S-CMP-05 | `npm run check` runs after implementation. | Typecheck, lint policy, and all deterministic tests complete successfully. | Required validation fails or is skipped. |
| S-CMP-06 | Installed `@earendil-works/pi-ai` is used to build the tool schema. | `StringEnum` is imported from that package and Google-family schema validation accepts the enum. | A non-existent helper or unsupported literal-union shape is used. |

## 15. Requirement traceability

| Plan objective | Contract sections | Primary scenarios |
| --- | --- | --- |
| O1 One behavioural contract | 4.2, 4.3, 10 | S-REQ-01, S-REQ-04, S-REQ-05 |
| O2 Real interactive re-camp | 7, 8 | S-CAP-01–10, S-TRN-01 |
| O3 Safe active-turn handoff | 8, 11 | S-TRN-01–07 |
| O4 Truthful fallbacks | 5, 7.3 | S-REQ-06, S-CAP-06–08 |
| O5 Coherent disposal | 12 | S-DSP-01–12 |
| O6 Maintainable orchestration | 4.3, N1, N2 | S-REQ-01, S-CMP-01 |

## 16. Decisions resolved from the plan

- Public request field: `execution` with `auto | recamp | paths`.
- TUI without safe automatic capability: `manual-restart`; non-TUI `auto`: `path-target`.
- No public `use`, `repair`, or `accept` action in this release.
- Partial provisioning recovery: manual preserve/remove/recreate; hooks are never automatically retried.
- Receipt location, key, lifecycle-claim ownership, v1 shape, atomic-write rules, corruption behaviour, and cleanup are fixed in section 9.
- Failed/provisioning recovery is clean remote dispose or confirmed hard destroy, never hook retry or manual blessing.
- Transport preflight includes a non-mutating ownership probe, not only executable and environment checks.
- Waiter acknowledgement means Node's OS `spawn` event within one second, not transport delivery.
- Pending policy blocks every later tool except exact transition status.
- Successor verification payload and dispose branch classification are fixed in section 11.

## 17. Build-phase inputs

The Build phase must decompose implementation work without weakening these seams:

1. transition request/outcome types and pure planner;
2. receipt store, lifecycle claims, concurrent-creator exclusion, and interrupted-provisioning recovery classification;
3. transport probe evidence and OS-spawn-acknowledged waiter scheduling;
4. Pi model-tool adapter, sequential execution, termination, and pending guard;
5. startup and slash-command adapter convergence;
6. versioned handoff and successor verification;
7. live and remote disposal executor;
8. documentation, provenance, package contents, and deterministic/process/manual validation.

Every build task must list the scenario ids it satisfies and the command or manual procedure that makes those scenarios fail before the implementation and pass afterward.
