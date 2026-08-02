import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	type CommandResult,
	type MuxCandidate,
	type ProbeDeps,
	SPAWN_ACK_TIMEOUT_MS,
	buildWaiterInvocation,
	pickRelaunchMux,
	probeTransport,
	scheduleWaiter,
	selectTransport,
} from "../extensions/worktree-transport.ts";

let fail = 0;
let total = 0;
const check = (name: string, fn: () => void) => {
	total++;
	try {
		fn();
	} catch (e) {
		fail++;
		console.error(`FAIL: ${name}\n  ${(e as Error).message}`);
	}
};

const checkAsync = async (name: string, fn: () => Promise<void>) => {
	total++;
	try {
		await fn();
	} catch (e) {
		fail++;
		console.error(`FAIL: ${name}\n  ${(e as Error).message}`);
	}
};

function deps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
	return {
		hasExecutable: () => true,
		run: (): CommandResult => ({ code: 0, stdout: "", stderr: "" }),
		...overrides,
	};
}

/** A probe backend that reports the queried pane as live. */
function agreeingDeps(target: string, seen: string[][] = []): ProbeDeps {
	return deps({
		run: (command, args) => {
			seen.push([command, ...args]);
			return { code: 0, stdout: target, stderr: "" };
		},
	});
}

const HERDR: MuxCandidate = {
	kind: "herdr",
	target: "wG:p1",
	workspaceId: "wG",
};
const TMUX: MuxCandidate = { kind: "tmux", target: "%5" };
const CMUX: MuxCandidate = { kind: "cmux", target: "s1" };

// --- ownership precedence ----------------------------------------------------

check("cmux outranks herdr and tmux", () => {
	assert.deepEqual(
		pickRelaunchMux({
			CMUX_SURFACE_ID: "s1",
			HERDR_PANE_ID: "wG:p1",
			TMUX: "/tmp/tmux-1/default,1,0",
			TMUX_PANE: "%5",
		}),
		{ kind: "cmux", target: "s1" },
	);
});

check("S-CAP-02: herdr beats a leaked outer TMUX", () => {
	assert.deepEqual(
		pickRelaunchMux({
			HERDR_PANE_ID: "wG:p1",
			HERDR_WORKSPACE_ID: "wG",
			TMUX: "/tmp/tmux-1/default,1,0",
			TMUX_PANE: "%5",
		}),
		HERDR,
	);
});

check(
	"S-CAP-02: a probed herdr pane is selected over a leaked tmux pane",
	() => {
		const selection = selectTransport(
			{
				HERDR_PANE_ID: "wG:p1",
				HERDR_WORKSPACE_ID: "wG",
				TMUX: "/tmp/tmux-1/default,1,0",
				TMUX_PANE: "%5",
			},
			agreeingDeps("wG:p1"),
		);
		assert.equal(selection.available, true);
		if (selection.available) assert.equal(selection.candidate.kind, "herdr");
	},
);

check("no multiplexer means no transport", () => {
	assert.equal(pickRelaunchMux({}), null);
	const selection = selectTransport({}, deps());
	assert.equal(selection.available, false);
});

// --- a failed higher probe never falls through -------------------------------

check(
	"S-CAP-03: a failing cmux probe does not fall back to herdr or tmux",
	() => {
		const env = {
			CMUX_SURFACE_ID: "s1",
			HERDR_PANE_ID: "wG:p1",
			HERDR_WORKSPACE_ID: "wG",
			TMUX: "/tmp/tmux-1/default,1,0",
			TMUX_PANE: "%5",
		};
		const selection = selectTransport(
			env,
			deps({ run: () => ({ code: 0, stdout: "s9 s8", stderr: "" }) }),
		);
		assert.equal(selection.available, false);
		assert.equal(selection.probe?.kind, "cmux");
		assert.equal(selection.probe?.status, "owner-mismatch");
	},
);

check(
	"S-CAP-03: a missing cmux executable does not fall through either",
	() => {
		const selection = selectTransport(
			{ CMUX_SURFACE_ID: "s1", TMUX: "/tmp/t,1,0", TMUX_PANE: "%5" },
			deps({ hasExecutable: (name) => name !== "cmux" }),
		);
		assert.equal(selection.available, false);
		assert.equal(selection.probe?.status, "missing-executable");
		assert.equal(selection.probe?.kind, "cmux");
	},
);

// --- herdr workspace metadata ------------------------------------------------

check("S-CAP-04: a herdr pane without a workspace id fails preflight", () => {
	const probe = probeTransport(
		{ kind: "herdr", target: "wG:p1", workspaceId: "" },
		deps(),
	);
	assert.equal(probe.status, "owner-mismatch");
	assert.match(probe.detail ?? "", /workspace id is missing/);
});

check(
	"S-CAP-04: a herdr workspace that does not report the pane fails closed",
	() => {
		const probe = probeTransport(
			HERDR,
			deps({ run: () => ({ code: 0, stdout: "wG:p7\nwG:p9", stderr: "" }) }),
		);
		assert.equal(probe.status, "owner-mismatch");
	},
);

check("S-CAP-04: the herdr query is scoped to the claimed workspace", () => {
	const seen: string[][] = [];
	probeTransport(HERDR, agreeingDeps("wG:p1", seen));
	assert.deepEqual(seen[0], ["herdr", "pane", "list", "--workspace", "wG"]);
});

// --- tmux pane targeting -----------------------------------------------------

check("S-CAP-05: TMUX without TMUX_PANE fails preflight", () => {
	const candidate = pickRelaunchMux({ TMUX: "/tmp/tmux-1/default,1,0" });
	assert.deepEqual(candidate, { kind: "tmux", target: "" });
	const probe = probeTransport(candidate as MuxCandidate, deps());
	assert.equal(probe.status, "owner-mismatch");
	assert.match(probe.detail ?? "", /TMUX_PANE is missing/);
});

check("S-CAP-05: a tmux probe that cannot see the pane fails closed", () => {
	const probe = probeTransport(
		TMUX,
		deps({ run: () => ({ code: 1, stdout: "", stderr: "" }) }),
	);
	// A query that cannot run at all leaves identifier evidence standing, but it
	// must say so rather than claim verified ownership.
	assert.equal(probe.status, "available");
	assert.equal(probe.observed, undefined);
	assert.match(probe.detail ?? "", /not independently verified/);

	const disagreeing = probeTransport(
		TMUX,
		deps({ run: () => ({ code: 0, stdout: "%9", stderr: "" }) }),
	);
	assert.equal(disagreeing.status, "owner-mismatch");
});

check("S-CAP-05: no waiter script ever broadcasts to the active pane", () => {
	const { args } = buildWaiterInvocation({
		candidate: TMUX,
		parentPid: 4242,
		typedCmd: "cd '/wt' && pi",
	});
	const script = args[1];
	assert.match(script, /tmux send-keys -t "\$target" -l --/);
	assert.equal(
		/send-keys\s+-l\s+--/.test(script.replace(/-t "\$target" /g, "-t X ")),
		false,
	);
});

check("a probe that throws is reported, not swallowed", () => {
	const probe = probeTransport(
		TMUX,
		deps({
			run: () => {
				throw new Error("probe exploded");
			},
		}),
	);
	assert.equal(probe.status, "probe-failed");
	assert.equal(probe.detail, "probe exploded");
});

check("probe queries are bounded", () => {
	let timeout = 0;
	probeTransport(
		TMUX,
		deps({
			run: (_c, _a, t) => {
				timeout = t;
				return { code: 0, stdout: "%5", stderr: "" };
			},
		}),
	);
	assert.ok(timeout > 0 && timeout <= 5_000, `probe timeout was ${timeout}`);
});

// --- waiter script construction ----------------------------------------------

check(
	"dynamic values are arguments, never interpolated into the script",
	() => {
		const nasty = "cd '/wt; rm -rf $HOME' && pi";
		const { command, args } = buildWaiterInvocation({
			candidate: HERDR,
			parentPid: 7,
			typedCmd: nasty,
			recamp: { targetCwd: "/wt path/x", tabLabel: "feat/x" },
		});
		assert.equal(command, "bash");
		assert.equal(args[0], "-c");
		assert.equal(
			args[1].includes(nasty),
			false,
			"command text leaked into the script body",
		);
		assert.equal(
			args[1].includes("/wt path/x"),
			false,
			"target path leaked into the script body",
		);
		assert.ok(args.includes(nasty));
		assert.ok(args.includes("/wt path/x"));
		assert.equal(args[3], "7");
	},
);

check("every transport waits for the originating pi process to exit", () => {
	for (const candidate of [CMUX, HERDR, TMUX]) {
		const { args } = buildWaiterInvocation({
			candidate,
			parentPid: 11,
			typedCmd: "cd '/wt' && pi",
			recamp: { targetCwd: "/wt", tabLabel: "feat/x" },
		});
		assert.match(args[1], /while kill -0 "\$parent"/, candidate.kind);
	}
});

check("herdr re-camp opens a labelled tab and closes the origin pane", () => {
	const { args } = buildWaiterInvocation({
		candidate: HERDR,
		parentPid: 11,
		typedCmd: "cd '/wt' && pi",
		recamp: { targetCwd: "/wt", tabLabel: "feat/x" },
	});
	assert.match(args[1], /herdr tab create --workspace "\$ws"/);
	assert.match(args[1], /herdr pane close "\$origin"/);
	assert.ok(args.includes("feat/x"));
});

check("a pre-script runs before the relaunch keys are sent", () => {
	const { args } = buildWaiterInvocation({
		candidate: TMUX,
		parentPid: 11,
		typedCmd: "cd '/repo' && pi",
		preScript: "git worktree remove --force '/wt'",
	});
	const script = args[1];
	assert.ok(
		script.indexOf('bash -c "$pre"') < script.indexOf("tmux send-keys"),
	);
	assert.ok(args.includes("git worktree remove --force '/wt'"));
});

// --- OS spawn acknowledgement ------------------------------------------------

class FakeChild extends EventEmitter {
	pid = 4242;
	exitCode: number | null = null;
	signalCode: string | null = null;
	unrefCalls = 0;
	killCalls = 0;
	unref() {
		this.unrefCalls++;
	}
	kill() {
		this.killCalls++;
		this.emit("exit");
		return true;
	}
}

function fakeSpawn(child: FakeChild, behaviour: "spawn" | "error" | "silent") {
	return {
		spawn: () => {
			if (behaviour === "spawn") setImmediate(() => child.emit("spawn"));
			if (behaviour === "error")
				setImmediate(() => child.emit("error", new Error("ENOENT bash")));
			return child as unknown as ChildProcess;
		},
		timeoutMs: 60,
	};
}

const invocation = buildWaiterInvocation({
	candidate: TMUX,
	parentPid: 1,
	typedCmd: "cd '/wt' && pi",
});

await checkAsync(
	"S-CAP-09: an acknowledged spawn yields a live handle",
	async () => {
		const child = new FakeChild();
		const result = await scheduleWaiter(invocation, fakeSpawn(child, "spawn"));
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.handle.pid, 4242);
			assert.equal(
				child.unrefCalls,
				0,
				"the waiter must stay referenced until committed",
			);
			result.handle.commitDetach();
			assert.equal(child.unrefCalls, 1);
		}
	},
);

await checkAsync("S-CAP-09: a spawn error is schedule-failed", async () => {
	const result = await scheduleWaiter(
		new FakeChild() && invocation,
		fakeSpawn(new FakeChild(), "error"),
	);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.code, "schedule-failed");
		assert.match(result.reason, /ENOENT/);
	}
});

await checkAsync(
	"S-CAP-09: no acknowledgement within the deadline is schedule-failed",
	async () => {
		const child = new FakeChild();
		const result = await scheduleWaiter(invocation, fakeSpawn(child, "silent"));
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /did not start/);
		assert.ok(
			child.killCalls >= 1,
			"an unacknowledged child must not be left running",
		);
	},
);

await checkAsync(
	"S-CAP-09: a throwing spawn is schedule-failed, not an exception",
	async () => {
		const result = await scheduleWaiter(invocation, {
			spawn: () => {
				throw new Error("EAGAIN");
			},
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /EAGAIN/);
	},
);

await checkAsync(
	"S-DSP-17 support: an uncommitted waiter can be aborted",
	async () => {
		const child = new FakeChild();
		const result = await scheduleWaiter(invocation, fakeSpawn(child, "spawn"));
		assert.equal(result.ok, true);
		if (result.ok) {
			await result.handle.abortAndWait();
			assert.ok(child.killCalls >= 1);
			assert.equal(child.unrefCalls, 0);
		}
	},
);

check("the acknowledgement deadline is bounded", () => {
	assert.ok(SPAWN_ACK_TIMEOUT_MS > 0 && SPAWN_ACK_TIMEOUT_MS <= 5_000);
});

if (fail > 0) {
	console.error(`transport tests: ${fail} FAILED of ${total}`);
	process.exit(1);
}
console.log(`transport tests: OK (${total} cases)`);
