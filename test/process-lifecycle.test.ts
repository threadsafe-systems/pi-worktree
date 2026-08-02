import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildWaiterInvocation,
	scheduleWaiter,
} from "../extensions/worktree-transport.ts";

let fail = 0;
let total = 0;
const checkAsync = async (name: string, fn: () => Promise<void>) => {
	total++;
	try {
		await fn();
	} catch (e) {
		fail++;
		console.error(`FAIL: ${name}\n  ${(e as Error).message}`);
	}
};

/**
 * Async by necessity, not style: the waiter watches for the originating pid to
 * disappear, and a killed child stays a reapable zombie — still answering
 * `kill -0` — until its parent's event loop reaps it. Blocking here would keep
 * the "dead" process visible and the waiter would spin forever.
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForFile(path: string, timeoutMs = 15_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return true;
		await sleep(20);
	}
	return false;
}

const PI_ROOT = join(
	dirname(dirname(fileURLToPath(import.meta.url))),
	"node_modules/@earendil-works/pi-coding-agent",
);

// --- the waiter must not act before the originating process exits ------------

await checkAsync(
	"the waiter blocks until the originating pi process has exited",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-wt-lifecycle-"));
		const marker = join(dir, "teardown-ran");

		// A real process to wait on, standing in for the pi being replaced.
		const parent = spawn("sleep", ["30"], { stdio: "ignore" });
		assert.ok(parent.pid, "no parent pid");

		const invocation = buildWaiterInvocation({
			candidate: { kind: "tmux", target: "%99" },
			parentPid: parent.pid as number,
			typedCmd: "true",
			preScript: `touch ${JSON.stringify(marker)}`,
		});
		const scheduled = await scheduleWaiter(invocation);
		assert.equal(scheduled.ok, true);

		try {
			// While the parent lives, teardown must not have run.
			await sleep(700);
			assert.equal(
				existsSync(marker),
				false,
				"teardown ran while the originating process was still alive",
			);

			parent.kill("SIGKILL");
			assert.equal(
				await waitForFile(marker),
				true,
				"teardown never ran after the parent exited",
			);
		} finally {
			parent.kill("SIGKILL");
			if (scheduled.ok) await scheduled.handle.abortAndWait();
		}
	},
);

// --- teardown evidence survives a failed transport launch --------------------

await checkAsync(
	"S-DSP-18: teardown still records itself when the relaunch cannot land",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-wt-lifecycle-"));
		const report = join(dir, "report.json");

		const parent = spawn("sleep", ["30"], { stdio: "ignore" });
		assert.ok(parent.pid);

		// `%99` does not exist and tmux may not be installed at all, so the relaunch
		// keys cannot land. The teardown evidence must survive that regardless.
		const invocation = buildWaiterInvocation({
			candidate: { kind: "tmux", target: "%99" },
			parentPid: parent.pid as number,
			typedCmd: "definitely-not-a-real-command",
			preScript: `printf '{"schemaVersion":1,"operationId":"op-x"}' > ${JSON.stringify(report)}`,
		});
		const scheduled = await scheduleWaiter(invocation);
		assert.equal(scheduled.ok, true);

		try {
			parent.kill("SIGKILL");
			assert.equal(
				await waitForFile(report),
				true,
				"no teardown report after transport failure",
			);
			assert.match(readFileSync(report, "utf-8"), /"operationId":"op-x"/);
		} finally {
			parent.kill("SIGKILL");
			if (scheduled.ok) await scheduled.handle.abortAndWait();
		}
	},
);

// --- an aborted waiter never runs its payload --------------------------------

await checkAsync(
	"S-DSP-17: an aborted waiter never runs its teardown",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-wt-lifecycle-"));
		const marker = join(dir, "should-never-exist");

		const parent = spawn("sleep", ["30"], { stdio: "ignore" });
		assert.ok(parent.pid);

		const scheduled = await scheduleWaiter(
			buildWaiterInvocation({
				candidate: { kind: "tmux", target: "%99" },
				parentPid: parent.pid as number,
				typedCmd: "true",
				preScript: `touch ${JSON.stringify(marker)}`,
			}),
		);
		assert.equal(scheduled.ok, true);
		if (scheduled.ok) await scheduled.handle.abortAndWait();

		parent.kill("SIGKILL");
		await sleep(700);
		assert.equal(
			existsSync(marker),
			false,
			"a killed waiter still tore down the target",
		);
	},
);

// --- the Pi lifecycle contracts this design depends on -----------------------

await checkAsync(
	"S-CMP-02: the installed agent core only terminates an all-terminating batch",
	async () => {
		const loop = readFileSync(
			join(
				PI_ROOT,
				"node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js",
			),
			"utf-8",
		);
		// A batch ends only when every finalized result asked to terminate, which is
		// why a refused sibling can still cost one follow-up turn.
		assert.match(
			loop,
			/finalizedCalls\.length > 0 && finalizedCalls\.every\(\(finalized\) => finalized\.result\.terminate === true\)/,
		);
	},
);

await checkAsync(
	"S-CMP-02: one sequential tool makes its whole batch sequential",
	async () => {
		const loop = readFileSync(
			join(
				PI_ROOT,
				"node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js",
			),
			"utf-8",
		);
		assert.match(loop, /executionMode === "sequential"/);
		assert.match(loop, /hasSequentialToolCall/);
	},
);

await checkAsync(
	"S-CMP-02: shutdown is deferred and ctx.mode is exposed",
	async () => {
		const types = readFileSync(
			join(PI_ROOT, "dist/core/extensions/types.d.ts"),
			"utf-8",
		);
		assert.match(types, /mode: ExtensionMode;/);
		assert.match(types, /executionMode\?: ToolExecutionMode;/);
		assert.match(types, /shutdown\(\): void;/);

		const shutdownExample = readFileSync(
			join(PI_ROOT, "examples/extensions/shutdown-command.ts"),
			"utf-8",
		);
		assert.match(shutdownExample, /deferred until agent is idle/);
	},
);

await checkAsync(
	"S-TRN-03: pi consults the tool_call guard for every call in a batch",
	async () => {
		const loop = readFileSync(
			join(
				PI_ROOT,
				"node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js",
			),
			"utf-8",
		);
		// The pending guard is only worth anything if pi asks per call, inside the
		// batch, and turns a block into a result instead of running the tool.
		assert.match(loop, /if \(beforeResult\?\.block\)/);
		assert.match(
			loop,
			/createErrorToolResult\(beforeResult\.reason \|\| "Tool execution was blocked"\)/,
		);

		// Both batch paths prepare each call individually, so a guard set partway
		// through a batch still applies to the calls that follow it.
		const sequential = loop.slice(loop.indexOf("executeToolCallsSequential"));
		assert.match(sequential.slice(0, 2000), /await prepareToolCall\(/);
		const parallel = loop.slice(loop.indexOf("executeToolCallsParallel"));
		assert.match(parallel.slice(0, 2000), /await prepareToolCall\(/);
	},
);

if (fail > 0) {
	console.error(`process lifecycle tests: ${fail} FAILED of ${total}`);
	process.exit(1);
}
console.log(`process lifecycle tests: OK (${total} cases)`);
