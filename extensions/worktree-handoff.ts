/**
 * What a session is told when it wakes up somewhere new.
 *
 * A relaunched session inherits its predecessor's history but none of its
 * certainty: it cannot know whether the move succeeded, whether the worktree it
 * was told about is really the one it landed in, or whether a teardown it
 * scheduled actually happened. The payload here carries the predecessor's
 * *expectations*, and the verification functions compare them against what the
 * successor can observe for itself.
 *
 * The two are deliberately separate. An assertion carried in a handoff is a
 * claim; only the successor's own reading of git and the filesystem is
 * evidence, and where they disagree the evidence wins.
 */

import { shQuote } from "./worktree-shell.ts";
import type {
	CheckoutState,
	ProvisioningState,
	SuccessorVerification,
	TransitionCode,
} from "./worktree-transition.ts";

/** Handoff payload carried across a worktree relaunch, decoded by the new
 *  session to orient the agent. `kind` distinguishes entering a worktree from
 *  disposing one and returning to the main checkout. */
export interface WtHandoff {
	parentCwd: string;
	parentBranch: string;
	uncommitted: number;
	/** Count of gitignored local files destroyed on dispose (e.g. .env.local). */
	ignored?: number;
	kind?: "enter" | "dispose";
}

export function encodeHandoff(h: WtHandoff): string {
	return Buffer.from(JSON.stringify(h)).toString("base64");
}

export function decodeHandoff(b64: string): WtHandoff | null {
	try {
		const h = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
		if (
			h &&
			typeof h.parentCwd === "string" &&
			typeof h.parentBranch === "string" &&
			typeof h.uncommitted === "number"
		) {
			return {
				parentCwd: h.parentCwd,
				parentBranch: h.parentBranch,
				uncommitted: h.uncommitted,
				...(typeof h.ignored === "number" ? { ignored: h.ignored } : {}),
				kind: h.kind === "dispose" ? "dispose" : "enter",
			};
		}
	} catch {
		// fall through to null
	}
	return null;
}

/** The one-turn orientation note injected into the relaunched session. */
export function handoffCaveat(
	h: WtHandoff,
	currentCwd: string,
	currentBranch: string,
): string {
	if (h.kind === "dispose") {
		const lost: string[] = [];
		if (h.uncommitted > 0)
			lost.push(`${h.uncommitted} uncommitted/untracked file(s)`);
		if ((h.ignored ?? 0) > 0)
			lost.push(
				`${h.ignored} gitignored file(s) (e.g. .env.local / local DBs)`,
			);
		const wip = lost.length
			? `- WARNING: the disposed worktree had ${lost.join(" and ")} that were destroyed with it — they are gone.`
			: `- The disposed worktree had no uncommitted or gitignored local files.`;
		return (
			`## Session moved back to the main checkout\n` +
			`This session was forked out of the worktree at ${h.parentCwd} (branch ${h.parentBranch}) back into the main repository at ${currentCwd}. Removal of that worktree and a soft-delete (git branch -d) of branch ${h.parentBranch} were requested during shutdown — verify with \`git worktree list\` and \`git branch\`, and re-run cleanup if either remains (an unmerged branch is deliberately kept).\n` +
			`- Repo-relative paths are unchanged (\`src/foo.ts\` is still \`src/foo.ts\`).\n` +
			`- Absolute paths, and any path under the old worktree directory, no longer resolve.\n` +
			`${wip}\n` +
			`Continue the task here on ${currentBranch || "the main branch"}.`
		);
	}
	const wip =
		h.uncommitted > 0
			? `- WARNING: ${h.uncommitted} file(s) had uncommitted changes in ${h.parentCwd}. A worktree is a fresh checkout, so those changes are NOT present here — retrieve them from ${h.parentCwd} if this work depends on them.`
			: `- The previous checkout had no uncommitted changes.`;
	return (
		`## Session migrated into a worktree\n` +
		`This session was forked from ${h.parentCwd} (branch ${h.parentBranch}) into this git worktree at ${currentCwd} (branch ${currentBranch}).\n` +
		`- Repo-relative paths are unchanged (\`src/foo.ts\` is still \`src/foo.ts\`).\n` +
		`- Absolute paths, and any path relative to the previous working directory, now resolve under this worktree.\n` +
		`${wip}\n` +
		`Continue the task here and commit to ${currentBranch}.`
	);
}

/** Build the shell command typed into the pane to relaunch pi in a directory.
 *  Optionally forks the parent session (to carry history) and passes a base64
 *  handoff payload via PI_WT_HANDOFF for the new session to decode.
 *
 *  `continuation` is passed as pi's positional initial message. A forked
 *  session otherwise loads history and waits at the editor, so this is the
 *  only thing that makes an interrupted task resume without a human nudge. */
export function buildRelaunchCommand(
	targetDir: string,
	forkSessionFile?: string,
	handoffB64?: string,
	continuation?: string,
): string {
	const envPrefix = handoffB64 ? `PI_WT_HANDOFF=${shQuote(handoffB64)} ` : "";
	const forkArg = forkSessionFile ? ` --fork ${shQuote(forkSessionFile)}` : "";
	const msgArg = continuation?.trim() ? ` ${shQuote(continuation.trim())}` : "";
	return `cd ${shQuote(targetDir)} && ${envPrefix}pi${forkArg}${msgArg}`;
}

/** Initial message for a session that hopped while the agent was mid-task.
 *
 *  `ctx.shutdown()` aborts the turn in flight, so the carried history can end
 *  on an unanswered tool call or a side effect whose result was never seen.
 *  The message therefore tells the agent to re-establish state before acting:
 *  a bare "continue" invites it to redo work that already succeeded. */
export function buildContinuationMessage(
	kind: WtHandoff["kind"],
	targetCwd: string,
): string {
	const where =
		kind === "dispose"
			? `back to the main checkout at ${targetCwd}, and the worktree you were in has been removed`
			: `into the worktree at ${targetCwd}`;
	return (
		`[automatic] Your session was moved ${where}. The turn you were running ` +
		`was interrupted by that hop, so work may be half-finished.\n\n` +
		`Re-establish where you actually got to before doing anything: check ` +
		`git status and the files you were editing. Do not redo steps that ` +
		`already completed. Then carry on with the task you were working on.`
	);
}

// ---------------------------------------------------------------------------
// Versioned transition handoff
// ---------------------------------------------------------------------------

/**
 * Handoff v2.
 *
 * v1 recorded only where the session came from, which is enough to explain the
 * move but not to check it: with no expected destination, "did I land in the
 * right place?" can only be answered tautologically. v2 carries the target the
 * predecessor intended, so a successor can disagree with it.
 */
export interface TransitionHandoffV2 {
	schemaVersion: 2;
	operationId: string;
	kind: "enter" | "dispose";
	source: CheckoutState;
	target: CheckoutState;
	targetProvisioning: "ready" | "unmanaged";
	/** Identity of the ready receipt at scheduling time. Absent when unmanaged. */
	expectedReceiptHash?: string;
	sessionCarry: "fork" | "fresh";
	uncommitted: number;
	ignored?: number;
	dispose?: {
		removedPath: string;
		branch: string;
	};
}

export function encodeTransitionHandoff(handoff: TransitionHandoffV2): string {
	return Buffer.from(JSON.stringify(handoff)).toString("base64");
}

export type DecodedHandoff =
	| { version: 2; handoff: TransitionHandoffV2 }
	| { version: 1; legacy: WtHandoff }
	| null;

/**
 * Decode either handoff generation.
 *
 * A session forked by an older build is still in flight somewhere, so v1 must
 * keep working. It is reported as its own version rather than upgraded, because
 * the fields v2 verification needs were never recorded and inventing them would
 * manufacture agreement.
 */
export function decodeTransitionHandoff(b64: string): DecodedHandoff {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
	} catch {
		return null;
	}
	const candidate = parsed as Partial<TransitionHandoffV2>;
	if (candidate?.schemaVersion === 2 && isValidV2(candidate)) {
		return { version: 2, handoff: candidate as TransitionHandoffV2 };
	}
	const legacy = decodeHandoff(b64);
	return legacy ? { version: 1, legacy } : null;
}

function isValidV2(h: Partial<TransitionHandoffV2>): boolean {
	if (h.kind !== "enter" && h.kind !== "dispose") return false;
	if (typeof h.operationId !== "string" || h.operationId === "") return false;
	if (!isCheckout(h.source) || !isCheckout(h.target)) return false;
	if (h.targetProvisioning !== "ready" && h.targetProvisioning !== "unmanaged")
		return false;
	// A ready target is only checkable if its receipt identity travelled with it.
	if (
		h.targetProvisioning === "ready" &&
		typeof h.expectedReceiptHash !== "string"
	)
		return false;
	if (
		h.targetProvisioning === "unmanaged" &&
		h.expectedReceiptHash !== undefined
	)
		return false;
	return typeof h.uncommitted === "number";
}

function isCheckout(value: unknown): value is CheckoutState {
	const c = value as Partial<CheckoutState> | undefined;
	return (
		typeof c?.path === "string" &&
		(typeof c.branch === "string" || c.branch === null) &&
		(c.kind === "main" || c.kind === "linked")
	);
}

// ---------------------------------------------------------------------------
// Successor verification
// ---------------------------------------------------------------------------

/** What the successor can see for itself. */
export interface ObservedEntry {
	actual: CheckoutState;
	registrationPresent: boolean;
	provisioning: ProvisioningState | "corrupt";
	/** Receipt identity as read now, when one exists. */
	receiptHash?: string;
}

const sameCheckout = (a: CheckoutState, b: CheckoutState) =>
	a.path === b.path && a.branch === b.branch;

/**
 * Did this session land where its predecessor said it would?
 *
 * A `ready` target that has lost or changed its receipt is a mismatch, never a
 * silent downgrade to `unmanaged`: something replaced the provisioning evidence
 * between scheduling and arrival, and calling that "unmanaged" would hide it.
 */
export function verifyEnter(
	handoff: TransitionHandoffV2,
	observed: ObservedEntry,
	now: string,
): SuccessorVerification {
	const issues: TransitionCode[] = [];
	if (!sameCheckout(handoff.target, observed.actual))
		issues.push("target-conflict");
	if (!observed.registrationPresent) issues.push("target-not-found");

	if (observed.provisioning === "corrupt") {
		issues.push("receipt-corrupt");
	} else if (handoff.targetProvisioning === "ready") {
		if (
			observed.provisioning !== "ready" ||
			observed.receiptHash !== handoff.expectedReceiptHash
		) {
			issues.push("target-not-ready");
		}
	} else if (observed.provisioning !== "unmanaged") {
		issues.push("target-conflict");
	}

	return {
		kind: "enter",
		status: issues.length === 0 ? "verified" : "mismatch",
		operationId: handoff.operationId,
		checkedAt: now,
		expected: handoff.target,
		actual: observed.actual,
		expectedProvisioning: handoff.targetProvisioning,
		actualProvisioning: observed.provisioning,
		registrationDisposition: observed.registrationPresent
			? "present"
			: "removed",
		issues,
	};
}

export type BranchDisposition =
	| "deleted"
	| "kept-unmerged"
	| "delete-failed"
	| "unknown";

/** What the successor observes about a worktree it was told had been removed. */
export interface ObservedTeardown {
	actual: CheckoutState;
	pathPresent: boolean;
	registrationPresent: boolean;
	receiptPresent: boolean;
	branchDisposition: BranchDisposition;
	/** Absent when the waiter never wrote one. */
	reportPresent: boolean;
}

/**
 * Did the teardown this session scheduled actually happen?
 *
 * A retained unmerged branch is the intended outcome of a soft dispose, so it
 * is reported as success. Anything else that survived — the path, the git
 * registration, the receipt, a branch that could have been deleted — is partial,
 * and so is a missing report, because "no evidence" is not evidence of success.
 */
export function verifyDispose(
	handoff: TransitionHandoffV2,
	observed: ObservedTeardown,
	now: string,
): SuccessorVerification {
	const issues: TransitionCode[] = [];
	const destinationMatches = sameCheckout(handoff.target, observed.actual);
	if (!destinationMatches) issues.push("target-conflict");

	if (observed.pathPresent || observed.registrationPresent)
		issues.push("dispose-partial");
	if (
		observed.receiptPresent &&
		!observed.pathPresent &&
		!observed.registrationPresent
	) {
		issues.push("dispose-partial");
	}
	if (observed.branchDisposition === "delete-failed")
		issues.push("dispose-partial");
	if (!observed.reportPresent) issues.push("dispose-partial");

	let status: SuccessorVerification["status"] = "verified";
	if (!destinationMatches) status = "mismatch";
	else if (issues.length > 0) status = "partial";

	return {
		kind: "dispose",
		status,
		operationId: handoff.operationId,
		checkedAt: now,
		expected: handoff.target,
		actual: observed.actual,
		branchDisposition: observed.branchDisposition,
		pathDisposition: observed.pathPresent ? "present" : "removed",
		registrationDisposition: observed.registrationPresent
			? "present"
			: "removed",
		receiptDisposition: observed.receiptPresent ? "present" : "removed",
		issues,
	};
}

/** A v1 payload cannot be checked, and must not be reported as if it were. */
export function legacyVerification(
	actual: CheckoutState,
	now: string,
	kind: "enter" | "dispose",
): SuccessorVerification {
	return {
		kind,
		status: "legacy-unverified",
		checkedAt: now,
		actual,
		issues: [],
	};
}

/** Orientation note for a verified or disputed v2 transition. */
export function transitionCaveat(verification: SuccessorVerification): string {
	if (verification.status === "mismatch") {
		const expected = verification.expected;
		return (
			`## Worktree transition did NOT land as planned\n` +
			`This session expected to be in ${expected?.branch ?? "(unknown)"} at ${expected?.path ?? "(unknown)"}, ` +
			`but it is actually in ${verification.actual.branch ?? "(detached)"} at ${verification.actual.path}.\n` +
			`Reasons: ${verification.issues.join(", ") || "unknown"}.\n` +
			`Do NOT assume the intended worktree is in use. Verify with \`git worktree list\` and \`git status\` before writing anything.`
		);
	}
	if (verification.kind === "dispose" && verification.status === "partial") {
		return (
			`## Worktree disposal did not fully complete\n` +
			`Teardown left: ${verification.issues.join(", ")}.\n` +
			`path: ${verification.pathDisposition}, registration: ${verification.registrationDisposition}, ` +
			`branch: ${verification.branchDisposition}, receipt: ${verification.receiptDisposition}.\n` +
			`Check \`git worktree list\` and \`git branch\`, and finish the cleanup manually.`
		);
	}
	return "";
}
