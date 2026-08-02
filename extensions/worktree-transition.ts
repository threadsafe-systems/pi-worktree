/**
 * Worktree transition contracts and the pure transition planner.
 *
 * Pi's tools bind to the process working directory at startup, so "use this
 * worktree" has two incompatible meanings: move the process there, or keep the
 * process where it is and rewrite every path. The types here force a caller to
 * say which one actually happened, and the planner decides which one is
 * available before any side effect runs.
 *
 * Everything in this module is pure. Git, the filesystem, transports, and Pi's
 * lifecycle arrive as injected facts so the decision table can be tested
 * without a repository, a multiplexer, or a live agent turn.
 */

/** Pi run modes. Only `tui` can carry a session into a replacement process. */
export type RunMode = "tui" | "rpc" | "json" | "print";

/** Public action names on the model-callable tool. */
export type TransitionAction = "status" | "create" | "enter" | "dispose";

/**
 * Internal intents. `ensure` is startup-only (create-or-reuse) and is
 * deliberately absent from the public action list so model-driven `create`
 * cannot silently adopt an existing checkout.
 */
export type TransitionIntent =
	| "status"
	| "create"
	| "ensure"
	| "enter"
	| "dispose";

export type ExecutionPreference = "auto" | "recamp" | "paths";

export type TransitionOrigin = "model" | "slash" | "startup";

export type TransportKind = "cmux" | "herdr" | "tmux";

/** How this session reaches the worktree it is working on. */
export type SessionMode = "process" | "relaunch-pending" | "path-target";

/**
 * Provisioning classification of a target. `unmanaged` is a checkout with no
 * receipt (created manually or before this feature existed): usable, but its
 * project hooks were never observed to run.
 */
export type ProvisioningState =
	| "ready"
	| "unmanaged"
	| "provisioning"
	| "failed";

export type TransitionOutcomeName =
	| "status"
	| "already-active"
	| "relaunch-scheduled"
	| "path-target"
	| "manual-restart"
	| "disposed"
	| "dispose-partial"
	| "refused"
	| "failed";

/** Stable machine-readable reasons. Rendered text is derived from these. */
export type TransitionCode =
	| "invalid-request"
	| "target-not-found"
	| "target-exists"
	| "target-conflict"
	| "target-main-checkout"
	| "target-not-ready"
	| "target-busy"
	| "receipt-corrupt"
	| "receipt-write-failed"
	| "branch-conflict"
	| "dirty-worktree"
	| "live-cwd-unsafe"
	| "session-file-contained"
	| "unsupported-pi-version"
	| "transport-unavailable"
	| "transport-preflight-failed"
	| "session-unavailable"
	| "schedule-failed"
	| "git-failed"
	| "hook-failed"
	| "transition-pending"
	| "dispose-partial";

export interface CheckoutState {
	/** Canonical absolute path. */
	path: string;
	/** Exact branch name, or null for a detached HEAD. */
	branch: string | null;
	kind: "main" | "linked";
}

export interface TransitionRequest {
	origin: TransitionOrigin;
	intent: TransitionIntent;
	execution?: ExecutionPreference;
	/** Conventional shorthand, e.g. `my-feature` or `fix login bug`. */
	name?: string;
	/** Exact branch, bypassing conventional resolution. */
	branch?: string;
	/** Base ref for create/ensure only. */
	base?: string;
}

/** A request that passed validation, with defaults resolved. */
export interface NormalizedRequest {
	origin: TransitionOrigin;
	intent: TransitionIntent;
	execution: ExecutionPreference;
	name?: string;
	branch?: string;
	base?: string;
	/** True when the caller named no target at all. */
	selectorless: boolean;
}

export interface SuccessorVerification {
	kind: "enter" | "dispose";
	status: "verified" | "partial" | "mismatch" | "legacy-unverified";
	operationId?: string;
	checkedAt: string;
	expected?: CheckoutState;
	actual: CheckoutState;
	expectedProvisioning?: "ready" | "unmanaged";
	actualProvisioning?: ProvisioningState | "corrupt";
	branchDisposition?: "deleted" | "kept-unmerged" | "delete-failed" | "unknown";
	pathDisposition?: "removed" | "present";
	registrationDisposition?: "removed" | "present";
	receiptDisposition?: "removed" | "present" | "mismatched";
	issues: TransitionCode[];
}

/**
 * The common envelope returned to every caller.
 *
 * There is deliberately no boolean success field: `relaunch-scheduled`,
 * `path-target`, `manual-restart`, and a verified move are all "not an error"
 * yet mean completely different things about where the process actually is.
 */
export interface TransitionDetails {
	schemaVersion: 1;
	operationId?: string;
	action: TransitionAction;
	requestedExecution?: ExecutionPreference;
	outcome: TransitionOutcomeName;
	code?: TransitionCode;
	process: CheckoutState;
	target?: CheckoutState;
	sessionMode: SessionMode;
	requiresAbsolutePaths: boolean;
	provisioning?: ProvisioningState;
	transport: TransportKind | "none";
	sessionCarry?: "fork" | "fresh" | "none";
	remoteProcessLiveness: "not-applicable" | "unknown";
	partialEffects?: string[];
	recovery?: { command?: string; instructions: string[] };
	verification?: SuccessorVerification;
}

export interface PendingTransition {
	operationId: string;
	action: Exclude<TransitionAction, "status">;
	target: CheckoutState;
	transport: TransportKind;
	scheduledAt: string;
	recoveryCommand: string;
}

export interface StatusOutcome extends TransitionDetails {
	outcome: "status";
	pathTarget?: CheckoutState;
	pending?: PendingTransition;
	targetProvisioning?: ProvisioningState;
	lastVerification?: SuccessorVerification;
	discipline: "on" | "off";
	defaultWorktreeBase: string;
}

/** The public action a given intent is reported as. */
export function actionForIntent(intent: TransitionIntent): TransitionAction {
	// `ensure` is a startup convenience over create/enter; it is reported as
	// `create` so callers never see an action the tool schema does not offer.
	return intent === "ensure" ? "create" : intent;
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export interface RequestRejection {
	code: "invalid-request";
	reason: string;
}

export type ValidationResult =
	| { ok: true; request: NormalizedRequest }
	| { ok: false; error: RequestRejection };

const DEFAULT_EXECUTION: Record<TransitionOrigin, ExecutionPreference> = {
	model: "auto",
	slash: "recamp",
	startup: "recamp",
};

const EXECUTIONS: ExecutionPreference[] = ["auto", "recamp", "paths"];

function trimmed(value: string | undefined): string | undefined {
	const t = (value ?? "").trim();
	return t.length > 0 ? t : undefined;
}

/**
 * Validate a request's shape before anything touches Git.
 *
 * Selector exclusivity is enforced rather than resolved by precedence: a caller
 * that sends both a shorthand name and an exact branch has two different
 * targets in mind, and silently picking one can act on the wrong checkout.
 */
export function validateTransitionRequest(
	raw: TransitionRequest,
): ValidationResult {
	const name = trimmed(raw.name);
	const branch = trimmed(raw.branch);
	const base = trimmed(raw.base);
	const execution = raw.execution ?? DEFAULT_EXECUTION[raw.origin];

	if (!EXECUTIONS.includes(execution)) {
		return reject(`Unknown execution "${execution}".`);
	}

	if (raw.intent === "status") {
		if (name || branch || base || raw.execution !== undefined) {
			return reject(
				"status takes no name, branch, base, or execution — it only reports current state.",
			);
		}
		return {
			ok: true,
			request: {
				origin: raw.origin,
				intent: "status",
				execution: "paths",
				selectorless: true,
			},
		};
	}

	if (name && branch) {
		return reject(
			"Use either name or branch, not both: they can resolve to different checkouts.",
		);
	}

	if (base && raw.intent !== "create" && raw.intent !== "ensure") {
		return reject(
			`base is only valid for create; ${raw.intent} takes no base.`,
		);
	}

	if (raw.intent === "enter" && !name && !branch) {
		return reject(
			"enter requires a name or branch identifying an existing worktree.",
		);
	}

	if (raw.intent === "dispose" && execution === "paths") {
		// Path targeting means "stay here and use absolute paths", which cannot
		// describe removing the checkout the process is standing in. The executor
		// still refuses a live target explicitly; this only blocks the meaningless
		// combination early.
		if (!name && !branch) {
			return reject(
				'dispose with execution "paths" requires an explicit remote target.',
			);
		}
	}

	return {
		ok: true,
		request: {
			origin: raw.origin,
			intent: raw.intent,
			execution,
			...(name ? { name } : {}),
			...(branch ? { branch } : {}),
			...(base ? { base } : {}),
			selectorless: !name && !branch,
		},
	};
}

function reject(reason: string): ValidationResult {
	return { ok: false, error: { code: "invalid-request", reason } };
}

// ---------------------------------------------------------------------------
// Target candidates
// ---------------------------------------------------------------------------

/** Branch resolution injected from the adapter so this module stays pure. */
export interface BranchResolver {
	/** Conventional resolution, e.g. `login-bug` -> `fix/login-bug`. Throws on invalid input. */
	resolve(input: string): string;
	/** Git-ref and shell safety for an exact `--branch` value. */
	isValidExplicit(branch: string): boolean;
}

/**
 * Ordered, deduplicated branch candidates for a read path (enter/dispose).
 *
 * The literal input comes first so `dispose foo` prefers a real `foo` worktree
 * over a colliding `feat/foo` one.
 */
export function orderedBranchCandidates(
	request: NormalizedRequest,
	deps: BranchResolver,
): string[] {
	if (request.branch) {
		return deps.isValidExplicit(request.branch) ? [request.branch] : [];
	}
	if (!request.name) return [];
	const out = [request.name];
	try {
		const resolved = deps.resolve(request.name);
		if (resolved !== request.name) out.push(resolved);
	} catch {
		// Not conventional shorthand: the literal is the only candidate.
	}
	return out;
}

// ---------------------------------------------------------------------------
// Capability selection
// ---------------------------------------------------------------------------

export interface ExecutionFacts {
	execution: ExecutionPreference;
	mode: RunMode;
	/** Whether the host Pi provides the lifecycle guarantees re-camping needs. */
	piCompatible: boolean;
	/** Whether a transport passed its ownership probe. */
	transportAvailable: boolean;
	/** Process CWD and branch already equal the resolved target. */
	alreadyAtTarget: boolean;
	/** An agent turn is in flight, so history must survive the hop. */
	activeTurn: boolean;
	/** A session file exists and can be read by `pi --fork`. */
	sessionFileReadable: boolean;
}

export type ExecutionDecision =
	| { kind: "already-active" }
	| { kind: "recamp" }
	| { kind: "path-target" }
	| { kind: "manual-restart"; code: TransitionCode };

/**
 * Choose how a create/enter request reaches its target.
 *
 * A forced `recamp` never degrades to path targeting: a caller that asked for a
 * real process move must be told it did not happen rather than silently handed
 * a different contract.
 */
export function selectExecution(facts: ExecutionFacts): ExecutionDecision {
	if (facts.alreadyAtTarget) return { kind: "already-active" };
	if (facts.execution === "paths") return { kind: "path-target" };

	const blocker = recampBlocker(facts);
	if (!blocker) return { kind: "recamp" };

	// In a terminal the user can act on a restart command, so a truthful manual
	// instruction beats silently switching to absolute paths. Headless `auto`
	// has nobody to read that instruction and keeps working via path targeting.
	if (facts.mode === "tui" || facts.execution === "recamp") {
		return { kind: "manual-restart", code: blocker };
	}
	return { kind: "path-target" };
}

function recampBlocker(facts: ExecutionFacts): TransitionCode | null {
	if (!facts.piCompatible) return "unsupported-pi-version";
	if (facts.mode !== "tui") return "transport-unavailable";
	if (!facts.transportAvailable) return "transport-unavailable";
	// Re-camping mid-turn without forkable history would abandon the task the
	// agent is running, so it is treated as missing capability, not a detail.
	if (facts.activeTurn && !facts.sessionFileReadable)
		return "session-unavailable";
	return null;
}

/** Session carry implied by a decision, for truthful reporting. */
export function sessionCarryFor(
	decision: ExecutionDecision,
	facts: ExecutionFacts,
): "fork" | "fresh" | "none" {
	if (decision.kind !== "recamp") return "none";
	return facts.sessionFileReadable ? "fork" : "fresh";
}

// ---------------------------------------------------------------------------
// Pending-transition guard
// ---------------------------------------------------------------------------

export interface ToolCallFacts {
	toolName: string;
	/** Parsed action when the call targets the worktree tool. */
	action?: string;
	pending: boolean;
}

export type PendingDecision =
	| { allow: true }
	| { allow: false; code: "transition-pending"; reason: string };

/**
 * Decide whether a tool call may run while a transition is pending.
 *
 * Once shutdown has been requested every later side effect belongs to the
 * replacement session, so all tools are refused — including read-only ones,
 * whose results would be reasoned about in the wrong working directory.
 */
export function decidePendingToolCall(call: ToolCallFacts): PendingDecision {
	if (!call.pending) return { allow: true };
	if (call.toolName === "worktree_session" && call.action === "status") {
		return { allow: true };
	}
	return {
		allow: false,
		code: "transition-pending",
		reason:
			"A worktree transition is pending: this session is shutting down and a replacement will resume in the target checkout. Only worktree_session status is available until then.",
	};
}

// ---------------------------------------------------------------------------
// Detail construction
// ---------------------------------------------------------------------------

export interface DetailsInput {
	action: TransitionAction;
	outcome: TransitionOutcomeName;
	process: CheckoutState;
	requestedExecution?: ExecutionPreference;
	operationId?: string;
	code?: TransitionCode;
	target?: CheckoutState;
	sessionMode?: SessionMode;
	provisioning?: ProvisioningState;
	transport?: TransportKind | "none";
	sessionCarry?: "fork" | "fresh" | "none";
	remoteProcessLiveness?: "not-applicable" | "unknown";
	partialEffects?: string[];
	recovery?: { command?: string; instructions: string[] };
	verification?: SuccessorVerification;
}

/** Build the common envelope, deriving the fields that must not disagree. */
export function buildDetails(input: DetailsInput): TransitionDetails {
	const sessionMode: SessionMode =
		input.sessionMode ?? sessionModeFor(input.outcome);
	return {
		schemaVersion: 1,
		action: input.action,
		outcome: input.outcome,
		process: input.process,
		sessionMode,
		requiresAbsolutePaths: sessionMode === "path-target",
		transport: input.transport ?? "none",
		remoteProcessLiveness: input.remoteProcessLiveness ?? "not-applicable",
		...(input.operationId ? { operationId: input.operationId } : {}),
		...(input.requestedExecution
			? { requestedExecution: input.requestedExecution }
			: {}),
		...(input.code ? { code: input.code } : {}),
		...(input.target ? { target: input.target } : {}),
		...(input.provisioning ? { provisioning: input.provisioning } : {}),
		...(input.sessionCarry ? { sessionCarry: input.sessionCarry } : {}),
		...(input.partialEffects?.length
			? { partialEffects: input.partialEffects }
			: {}),
		...(input.recovery ? { recovery: input.recovery } : {}),
		...(input.verification ? { verification: input.verification } : {}),
	};
}

function sessionModeFor(outcome: TransitionOutcomeName): SessionMode {
	if (outcome === "relaunch-scheduled") return "relaunch-pending";
	if (outcome === "path-target") return "path-target";
	return "process";
}

/**
 * Rejection envelope for a request that never reached target resolution.
 * `process` is still reported so the caller can see where it actually is.
 */
export function refusedDetails(
	action: TransitionAction,
	process: CheckoutState,
	code: TransitionCode,
	requestedExecution?: ExecutionPreference,
): TransitionDetails {
	return buildDetails({
		action,
		outcome: "refused",
		process,
		code,
		...(requestedExecution ? { requestedExecution } : {}),
	});
}
