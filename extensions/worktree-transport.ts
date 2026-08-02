/**
 * Terminal-multiplexer transports and the detached relaunch waiter.
 *
 * Pi cannot change its own working directory, so moving a session means exiting
 * and having something else start the replacement in the right place. That
 * "something else" is a detached waiter which blocks on the old PID and then
 * types a command into the multiplexer that owns this pane.
 *
 * Two things make that dangerous, and both are handled here. Keys typed at the
 * wrong pane land in an unrelated shell, so ownership is established before the
 * origin agrees to die. And a waiter that never actually started would strand
 * the session, so scheduling resolves only on the OS spawn event.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import type { TransportKind } from "./worktree-transition.ts";

/** Environment facts for multiplexer detection, injected for testability. */
export interface MuxEnv {
	CMUX_SURFACE_ID?: string;
	HERDR_PANE_ID?: string;
	HERDR_WORKSPACE_ID?: string;
	TMUX?: string;
	TMUX_PANE?: string;
}

/** Where a re-camped session should land: a tab at `targetCwd`, branch-labelled. */
export interface RecampTarget {
	targetCwd: string;
	tabLabel: string;
}

export type MuxCandidate =
	| { kind: "cmux"; target: string }
	| { kind: "herdr"; target: string; workspaceId: string }
	| { kind: "tmux"; target: string };

/**
 * Pick the terminal multiplexer that owns the current pane, if any.
 *
 * Precedence: cmux, then herdr, then tmux. cmux and herdr both stamp a
 * per-surface/per-pane id on the processes they spawn, so their presence is
 * definitive for THIS process. TMUX is checked last because it can leak into
 * herdr panes (e.g. when the herdr server was started from inside a tmux
 * session); typing into that stale outer pane would land the relaunch command
 * somewhere unrelated.
 */
export function pickRelaunchMux(env: MuxEnv): MuxCandidate | null {
	if (env.CMUX_SURFACE_ID) return { kind: "cmux", target: env.CMUX_SURFACE_ID };
	if (env.HERDR_PANE_ID) {
		return {
			kind: "herdr",
			target: env.HERDR_PANE_ID,
			workspaceId: env.HERDR_WORKSPACE_ID ?? "",
		};
	}
	if (env.TMUX) return { kind: "tmux", target: env.TMUX_PANE ?? "" };
	return null;
}

// ---------------------------------------------------------------------------
// Ownership probing
// ---------------------------------------------------------------------------

export type ProbeStatus =
	| "available"
	| "not-owned"
	| "missing-executable"
	| "owner-mismatch"
	| "probe-failed";

export interface TransportProbe {
	kind: TransportKind;
	status: ProbeStatus;
	/** Identifiers this process claims to own. */
	expected: Record<string, string>;
	/** Identifiers a read-only query actually reported, when one could run. */
	observed?: Record<string, string>;
	detail?: string;
}

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ProbeDeps {
	hasExecutable(name: string): boolean;
	/** Run a read-only query. Must never mutate multiplexer state. */
	run(command: string, args: string[], timeoutMs: number): CommandResult;
}

/** Every probe query is bounded so a wedged multiplexer cannot stall planning. */
export const PROBE_TIMEOUT_MS = 3_000;

/**
 * Verify that this process really owns the pane it is about to type into.
 *
 * Identifier completeness is checked first and is always decisive: an
 * unaddressable pane would fall back to an untargeted broadcast, which is
 * exactly how a relaunch ends up in someone else's shell.
 *
 * A vendor read-only query runs afterwards where one is known. If that query
 * cannot run at all — an older CLI without the subcommand — the probe keeps the
 * identifier evidence and records that ownership is unverified, rather than
 * failing a setup that works today. If the query does run and disagrees, that
 * is a stale pane and the probe fails closed.
 */
export function probeTransport(
	candidate: MuxCandidate,
	deps: ProbeDeps,
): TransportProbe {
	const kind = candidate.kind;
	if (!deps.hasExecutable(kind)) {
		return {
			kind,
			status: "missing-executable",
			expected: expectedIds(candidate),
		};
	}
	const expected = expectedIds(candidate);

	if (candidate.kind === "herdr" && !candidate.workspaceId) {
		return {
			kind,
			status: "owner-mismatch",
			expected,
			detail: "herdr pane id is present but its workspace id is missing",
		};
	}
	if (candidate.kind === "tmux" && !candidate.target) {
		return {
			kind,
			status: "owner-mismatch",
			expected,
			detail:
				"TMUX is set but TMUX_PANE is missing, so no pane can be targeted",
		};
	}
	if (!candidate.target) {
		return {
			kind,
			status: "not-owned",
			expected,
			detail: "no owning surface id",
		};
	}

	return verifyOwnership(candidate, expected, deps);
}

function expectedIds(candidate: MuxCandidate): Record<string, string> {
	if (candidate.kind === "herdr") {
		return { pane: candidate.target, workspace: candidate.workspaceId };
	}
	return { [candidate.kind === "cmux" ? "surface" : "pane"]: candidate.target };
}

/** Read-only queries used to confirm the pane still exists and is ours. */
function ownershipQuery(candidate: MuxCandidate): {
	command: string;
	args: string[];
} {
	switch (candidate.kind) {
		case "cmux":
			return { command: "cmux", args: ["list"] };
		case "herdr":
			return {
				command: "herdr",
				args: ["pane", "list", "--workspace", candidate.workspaceId],
			};
		default:
			return {
				command: "tmux",
				args: ["display-message", "-p", "-t", candidate.target, "#{pane_id}"],
			};
	}
}

function verifyOwnership(
	candidate: MuxCandidate,
	expected: Record<string, string>,
	deps: ProbeDeps,
): TransportProbe {
	const { command, args } = ownershipQuery(candidate);
	let result: CommandResult;
	try {
		result = deps.run(command, args, PROBE_TIMEOUT_MS);
	} catch (err) {
		return {
			kind: candidate.kind,
			status: "probe-failed",
			expected,
			detail: (err as Error).message,
		};
	}

	const output = `${result.stdout}\n${result.stderr}`;
	if (result.code !== 0 && result.stdout.trim() === "") {
		// The CLI rejected the query outright (unknown subcommand, unsupported
		// version). Identifier evidence stands on its own; ownership is simply
		// not independently confirmed.
		return {
			kind: candidate.kind,
			status: "available",
			expected,
			detail:
				"ownership not independently verified: the transport has no usable read-only query",
		};
	}
	if (result.stdout.includes(candidate.target)) {
		return {
			kind: candidate.kind,
			status: "available",
			expected,
			observed: { ...expected },
		};
	}
	return {
		kind: candidate.kind,
		status: "owner-mismatch",
		expected,
		detail: `the transport did not report ${candidate.target} as a live pane`,
		...(output.trim()
			? { observed: { reported: result.stdout.trim().slice(0, 200) } }
			: {}),
	};
}

export type TransportSelection =
	| { available: true; candidate: MuxCandidate; probe: TransportProbe }
	| { available: false; probe?: TransportProbe; reason: string };

/**
 * Choose the transport to relaunch through.
 *
 * A failed probe on the owning multiplexer never falls through to a lower one:
 * the lower variables belong to an outer or stale session, and typing there is
 * how a relaunch command reaches an unrelated shell.
 */
export function selectTransport(
	env: MuxEnv,
	deps: ProbeDeps,
): TransportSelection {
	const candidate = pickRelaunchMux(env);
	if (!candidate)
		return {
			available: false,
			reason: "no cmux, herdr, or tmux pane owns this process",
		};

	const probe = probeTransport(candidate, deps);
	if (probe.status === "available")
		return { available: true, candidate, probe };
	return {
		available: false,
		probe,
		reason:
			probe.detail ??
			`${candidate.kind} ownership could not be confirmed (${probe.status})`,
	};
}

// ---------------------------------------------------------------------------
// Waiter scheduling
// ---------------------------------------------------------------------------

/** How long to wait for the OS to confirm the waiter process actually started. */
export const SPAWN_ACK_TIMEOUT_MS = 1_000;

export interface WaiterInvocation {
	command: string;
	args: string[];
}

/**
 * Build the detached waiter invocation.
 *
 * Dynamic values are passed as positional arguments to `bash -c`, never
 * interpolated into the script body, so a path containing spaces or quotes
 * cannot alter the script. The pre-script is invoked as its own shell, so the
 * waiter's pid is passed to it as `$1`: a teardown that must prove it owns the
 * target cannot read that from its own `$$`, which belongs to the child. The waiter blocks on the originating PID because
 * keys sent while Pi still owns the pane in raw mode are swallowed, and because
 * `pi --fork` snapshots the session file as of its last flush.
 */
export function buildWaiterInvocation(opts: {
	candidate: MuxCandidate;
	parentPid: number;
	typedCmd: string;
	preScript?: string;
	recamp?: RecampTarget;
}): WaiterInvocation {
	const pre = opts.preScript ?? "";
	const { candidate } = opts;
	let script: string;
	let dynamic: string[];

	if (candidate.kind === "cmux") {
		script = `
      parent="$1"; surface="$2"; cmd="$3"; pre="$4"
      while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done
      sleep 0.15
      if [ -n "$pre" ]; then bash -c "$pre" pi-worktree-teardown "$$"; fi
      cmux send --surface "$surface" -- "$cmd"
      cmux send --surface "$surface" -- $'\\r'
    `;
		dynamic = [candidate.target, opts.typedCmd, pre];
	} else if (candidate.kind === "herdr" && opts.recamp) {
		// A new tab keeps the branch visible in the workspace. If tab creation
		// fails, typing into the originating pane is better than stranding a
		// session whose process has already exited.
		script = `
      parent="$1"; ws="$2"; target="$3"; label="$4"; origin="$5"; cmd="$6"; pre="$7"
      while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done
      sleep 0.15
      if [ -n "$pre" ]; then bash -c "$pre" pi-worktree-teardown "$$"; fi
      created=$(herdr tab create --workspace "$ws" --cwd "$target" --label "$label" --focus 2>/dev/null)
      pane=$(printf '%s' "$created" | sed -n 's/.*"pane_id":"\\([^"]*\\)".*/\\1/p' | head -1)
      if [ -n "$pane" ]; then
        herdr pane run "$pane" "$cmd"
        herdr pane close "$origin" >/dev/null 2>&1
      else
        herdr pane send-text "$origin" "$cmd"
        herdr pane send-keys "$origin" enter
      fi
    `;
		dynamic = [
			candidate.workspaceId,
			opts.recamp.targetCwd,
			opts.recamp.tabLabel,
			candidate.target,
			opts.typedCmd,
			pre,
		];
	} else if (candidate.kind === "herdr") {
		script = `
      parent="$1"; target="$2"; cmd="$3"; pre="$4"
      while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done
      sleep 0.15
      if [ -n "$pre" ]; then bash -c "$pre" pi-worktree-teardown "$$"; fi
      herdr pane send-text "$target" "$cmd"
      herdr pane send-keys "$target" enter
    `;
		dynamic = [candidate.target, opts.typedCmd, pre];
	} else {
		// `-l` types the command literally; a separate Enter submits it. The pane
		// is always addressed explicitly, never broadcast to the active pane.
		script = `
      parent="$1"; target="$2"; cmd="$3"; pre="$4"
      while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done
      sleep 0.15
      if [ -n "$pre" ]; then bash -c "$pre" pi-worktree-teardown "$$"; fi
      tmux send-keys -t "$target" -l -- "$cmd"
      tmux send-keys -t "$target" Enter
    `;
		dynamic = [candidate.target, opts.typedCmd, pre];
	}

	return {
		command: "bash",
		args: [
			"-c",
			script,
			"pi-worktree-relaunch",
			String(opts.parentPid),
			...dynamic,
		],
	};
}

/**
 * A spawned waiter that is running but not yet released.
 *
 * The child stays referenced until `commitDetach()`. Live disposal uses that
 * window to hand its lifecycle claim to this exact PID; if that hand-off cannot
 * be persisted, `abortAndWait()` kills a waiter that would otherwise tear down
 * a worktree the user was told would survive.
 */
export interface WaiterHandle {
	pid: number;
	commitDetach(): void;
	abortAndWait(): Promise<void>;
}

export type ScheduleResult =
	| { ok: true; handle: WaiterHandle }
	| { ok: false; code: "schedule-failed"; reason: string };

export interface SpawnDeps {
	spawn(command: string, args: string[]): ChildProcess;
	timeoutMs?: number;
}

export const defaultSpawnDeps: SpawnDeps = {
	spawn: (command, args) =>
		nodeSpawn(command, args, { detached: true, stdio: "ignore" }),
};

/**
 * Start the waiter and resolve only once the OS confirms it exists.
 *
 * A boolean "we called spawn" is not evidence: the origin is about to exit, and
 * a child that never started leaves nothing to bring the session back.
 */
export function scheduleWaiter(
	invocation: WaiterInvocation,
	deps: SpawnDeps = defaultSpawnDeps,
): Promise<ScheduleResult> {
	const timeoutMs = deps.timeoutMs ?? SPAWN_ACK_TIMEOUT_MS;
	return new Promise<ScheduleResult>((resolve) => {
		let child: ChildProcess;
		try {
			child = deps.spawn(invocation.command, invocation.args);
		} catch (err) {
			resolve({
				ok: false,
				code: "schedule-failed",
				reason: (err as Error).message,
			});
			return;
		}

		let settled = false;
		const finish = (result: ScheduleResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		const timer = setTimeout(() => {
			killQuietly(child);
			finish({
				ok: false,
				code: "schedule-failed",
				reason: `the relaunch waiter did not start within ${timeoutMs}ms`,
			});
		}, timeoutMs);
		// Deliberately referenced: this timer is the only thing that can resolve the
		// promise when the child never reports back, so unreferencing it would hang
		// the caller instead of failing it.

		child.once("error", (err: Error) => {
			finish({ ok: false, code: "schedule-failed", reason: err.message });
		});
		child.once("spawn", () => {
			finish({ ok: true, handle: makeHandle(child) });
		});
	});
}

function makeHandle(child: ChildProcess): WaiterHandle {
	return {
		pid: child.pid ?? -1,
		commitDetach() {
			child.unref();
		},
		abortAndWait() {
			return new Promise<void>((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null) {
					resolve();
					return;
				}
				child.once("exit", () => resolve());
				killQuietly(child);
				// Never block shutdown on a child that refuses to die; the owner-tuple
				// check is the real guarantee that it cannot act.
				setTimeout(() => resolve(), SPAWN_ACK_TIMEOUT_MS);
			});
		},
	};
}

function killQuietly(child: ChildProcess): void {
	try {
		child.kill("SIGKILL");
	} catch {
		// already gone
	}
}
