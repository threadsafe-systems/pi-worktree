/**
 * Moving a live session into another checkout without restarting pi.
 *
 * `ctx.switchSession` rebuilds the runtime around the cwd recorded in the
 * target session file: tools are reconstructed against it, and settings,
 * extensions and context files are re-resolved from it. So changing directory
 * is really a matter of writing a session document that says where it lives.
 *
 * Two properties of pi's session persistence make that harder than it sounds.
 *
 * A session file is not written until the session holds an assistant message —
 * entries are buffered in memory and the whole document is flushed at once.
 * Before that the file is empty on disk and `SessionManager.forkFrom` rejects
 * it, so a brand-new session and a turn still in flight both need the target
 * built from the in-memory entries instead.
 *
 * The persisted leaf can also be ahead of the active one, because navigating
 * the session tree moves the active branch without rewriting the file. Forking
 * the file in that state would carry the session to a leaf the user has
 * already moved away from, so the active branch is written explicitly.
 *
 * Note that the OS working directory of the process is untouched: pi never
 * calls `process.chdir`. `ctx.cwd` moves, `process.cwd()` does not, so anything
 * downstream that wants to know where the session is must read the context.
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	type ExtensionCommandContext,
	SessionManager,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** How the target session document should be produced. */
export type TargetSessionPlan =
	/** Copy the source file's tree wholesale; the file is authoritative. */
	| { kind: "fork"; source: string }
	/** Write the active branch out; the file is absent, empty, or stale. */
	| { kind: "entries"; reason: "unflushed" | "stale-leaf" }
	/** Nothing to carry. */
	| { kind: "empty" };

/** Observable state of the session being moved. */
export interface SourceSessionState {
	/** Path pi assigned to the session, whether or not it has been written. */
	sessionFile?: string;
	/** Whether that path holds a non-empty document. */
	flushed: boolean;
	/** Leaf recorded in the file, when it has been written. */
	persistedLeafId: string | null;
	/** Leaf the session is actually on. */
	activeLeafId: string | null;
	/** Entries on the active branch. */
	entryCount: number;
}

/**
 * Choose how to build the target document.
 *
 * Forking is preferred because it carries the whole session tree, not just the
 * active path, but it is only correct when the file exists and agrees with the
 * session about where the leaf is.
 */
export function planTargetSession(
	state: SourceSessionState,
): TargetSessionPlan {
	if (state.entryCount === 0) return { kind: "empty" };
	if (!state.sessionFile || !state.flushed) {
		return { kind: "entries", reason: "unflushed" };
	}
	if (state.persistedLeafId !== state.activeLeafId) {
		return { kind: "entries", reason: "stale-leaf" };
	}
	return { kind: "fork", source: state.sessionFile };
}

/** Read the source state from a session manager. */
export function readSourceState(sm: {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	getEntries(): readonly SessionEntry[];
	getBranch(): readonly SessionEntry[];
}): SourceSessionState {
	const sessionFile = sm.getSessionFile();
	const flushed = isNonEmptyFile(sessionFile);
	return {
		...(sessionFile ? { sessionFile } : {}),
		flushed,
		persistedLeafId: flushed
			? SessionManager.open(sessionFile as string).getLeafId()
			: null,
		activeLeafId: sm.getLeafId(),
		entryCount: sm.getBranch().length,
	};
}

function isNonEmptyFile(path: string | undefined): boolean {
	if (!path || !existsSync(path)) return false;
	try {
		return statSync(path).size > 0;
	} catch {
		return false;
	}
}

/**
 * Write the target session and return its path.
 *
 * The result is re-opened and checked before it is handed back: a document
 * that does not name the target cwd would switch the session somewhere other
 * than the caller asked for, which is worse than refusing to switch at all.
 */
export function materializeTargetSession(opts: {
	plan: TargetSessionPlan;
	targetCwd: string;
	entries: readonly SessionEntry[];
	expectedLeafId: string | null;
	sessionDir?: string;
	parentSession?: string;
}): string {
	const { plan, targetCwd, sessionDir } = opts;

	if (plan.kind === "fork") {
		const forked = SessionManager.forkFrom(plan.source, targetCwd, sessionDir);
		const file = forked.getSessionFile();
		if (!file || !existsSync(file)) {
			throw new Error("pi did not create the target session file.");
		}
		return verifyTarget(file, targetCwd, forked.getLeafId());
	}

	const target = SessionManager.create(
		targetCwd,
		sessionDir,
		opts.parentSession ? { parentSession: opts.parentSession } : undefined,
	);
	const file = target.getSessionFile();
	const header = target.getHeader();
	if (!file || !header) {
		throw new Error("pi could not prepare a target session.");
	}

	const carried = plan.kind === "entries" ? opts.entries : [];
	const document = [header, ...carried]
		.map((entry) => JSON.stringify(entry))
		.join("\n");
	writeFileSync(file, `${document}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});

	return verifyTarget(
		file,
		targetCwd,
		plan.kind === "entries" ? opts.expectedLeafId : null,
	);
}

/**
 * Compared after resolution because pi normalises the cwd it records — a
 * caller's trailing separator must not read as pi having chosen a different
 * directory.
 */
function verifyTarget(
	file: string,
	targetCwd: string,
	expectedLeafId: string | null,
): string {
	const verified = SessionManager.open(file);
	if (resolve(verified.getCwd()) !== resolve(targetCwd)) {
		throw new Error(
			`Target session names ${verified.getCwd()}, not ${targetCwd}.`,
		);
	}
	if (verified.getLeafId() !== expectedLeafId) {
		throw new Error("Target session does not resume the active branch.");
	}
	return file;
}

/** Outcome of an attempted in-process move. */
export type SwitchOutcome =
	| { moved: true }
	| { moved: false; reason: "cancelled" | "failed"; detail?: string };

/**
 * Whether an in-process move should be attempted instead of a relaunch.
 *
 * Off unless asked for, so the relaunch remains the path every existing
 * session takes.
 */
export function inProcessSwitchEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.PI_WT_SWITCH === "1";
}

/**
 * Name of the environment variable carrying the transition handoff.
 *
 * A relaunch passes it to the replacement process; an in-process switch has no
 * new process to pass it to, so it is published here and consumed by the
 * extension instance the switch creates. Either way exactly one reader is
 * expected, and the reader clears it — a handoff left set outlives the move it
 * describes and would be re-consumed by the next session in this process.
 */
export const HANDOFF_ENV = "PI_WT_HANDOFF";

/**
 * Move this session into `targetCwd`.
 *
 * Waits for the agent to stop streaming first, so the turn in flight is part
 * of the carried conversation rather than lost to the teardown.
 *
 * `handoff` orients the replacement: without it the new session arrives in a
 * different directory with no account of how it got there. `continuation` is
 * submitted as a message and is for the mid-task case only — a session that
 * hopped from an idle prompt would otherwise open by burning a turn on a
 * message nobody asked for.
 *
 * A failure here leaves the checkout alone. The worktree exists either way,
 * and destroying it because the session could not follow would turn a
 * recoverable problem into a lost one.
 */
export async function switchIntoCheckout(
	ctx: ExtensionCommandContext,
	targetCwd: string,
	options: { continuation?: string; handoff?: string } = {},
): Promise<SwitchOutcome> {
	const priorHandoff = process.env[HANDOFF_ENV];
	try {
		await ctx.waitForIdle();

		const sm = ctx.sessionManager;
		const state = readSourceState(sm);
		const plan = planTargetSession(state);
		const sessionDir = sm.getSessionDir();
		const target = materializeTargetSession({
			plan,
			targetCwd,
			entries: sm.getBranch(),
			expectedLeafId: state.activeLeafId,
			...(sessionDir ? { sessionDir } : {}),
			...(state.sessionFile ? { parentSession: state.sessionFile } : {}),
		});

		if (options.handoff) process.env[HANDOFF_ENV] = options.handoff;
		else delete process.env[HANDOFF_ENV];

		const continuation = options.continuation?.trim();
		const result = await ctx.switchSession(target, {
			withSession: async (replacement) => {
				if (continuation) await replacement.sendUserMessage(continuation);
			},
		});

		if (result.cancelled) {
			restoreHandoff(priorHandoff);
			return { moved: false, reason: "cancelled" };
		}
		return { moved: true };
	} catch (error) {
		restoreHandoff(priorHandoff);
		return {
			moved: false,
			reason: "failed",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Put the environment back when the move did not happen. */
function restoreHandoff(prior: string | undefined): void {
	if (prior === undefined) delete process.env[HANDOFF_ENV];
	else process.env[HANDOFF_ENV] = prior;
}
