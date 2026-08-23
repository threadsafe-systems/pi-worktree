import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildVerifiedTeardownScript } from "../extensions/worktree.ts";
import {
	acquireClaim,
	canonicalJson,
	claimPath,
	configDigest,
	createStore,
	newReceipt,
	readTeardownReport,
	receiptPath,
	readyReceipt,
	reportPath,
	writeReceipt,
} from "../extensions/worktree-receipt.ts";
import {
	writeDetachedTeardownRequest,
	type DetachedTeardownRequestV1,
} from "../extensions/worktree-teardown.ts";
import {
	inspectWorktreeSafety,
	type WorktreeSafetySnapshot,
} from "../extensions/worktree-safety.ts";

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

function sleepSync(ms: number) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(path: string, timeoutMs = 15_000): boolean {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return true;
		sleepSync(20);
	}
	return false;
}

function git(cwd: string, ...args: string[]) {
	const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (r.status !== 0) {
		throw new Error(`git ${args.join(" ")}: ${r.stderr}${r.stdout}`);
	}
	return r.stdout;
}

const BRANCH = "feat/doomed";

/** A repository with one linked worktree and a ready provisioning receipt. */
function fixture(opts: { commitInWorktree?: boolean } = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-dispose-")));
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	git(root, "init", "-b", "main", "repo");
	git(repo, "config", "user.email", "test@example.invalid");
	git(repo, "config", "user.name", "Test");
	writeFileSync(join(repo, "README.md"), "# fixture\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "init");

	const wt = join(root, "wt");
	git(repo, "worktree", "add", "-b", BRANCH, wt, "HEAD");
	if (opts.commitInWorktree) {
		writeFileSync(join(wt, "work.txt"), "unmerged\n");
		git(wt, "add", "-A");
		git(wt, "commit", "-m", "work");
	}

	const store = createStore(join(repo, ".git"));
	const operationId = "op-teardown";
	const owner = { operationId, pid: process.pid, role: "origin" as const };
	acquireClaim(store, wt, owner);
	writeReceipt(
		store,
		owner,
		readyReceipt(
			newReceipt({
				operationId,
				branch: BRANCH,
				worktreePath: wt,
				base: "HEAD",
				configDigest: configDigest({}),
			}),
		),
	);

	return { root, repo, wt, store, operationId };
}

interface RunResult {
	pathPresent: boolean;
	registrationPresent: boolean;
	branchPresent: boolean;
	receiptPresent: boolean;
	report: ReturnType<typeof readTeardownReport>;
	stageStatus: (name: string) => string | undefined;
}

/**
 * Run a teardown script as the detached waiter would.
 *
 * The script proves it owns the claim by matching its own pid, which is only
 * knowable once bash is running: the prelude publishes that pid and then waits,
 * so the test can write the owner file the case under test requires before the
 * teardown proceeds.
 */
async function runTeardown(
	f: ReturnType<typeof fixture>,
	script: string | Promise<string>,
	ownerPid: (waiterPid: number) => number | null,
): Promise<RunResult> {
	const resolvedScript = await script;
	const pidFile = join(f.root, "waiter.pid");
	const goFile = join(f.root, "go");
	// Invoke the teardown exactly as the real waiter does: as its OWN shell, with
	// the waiter's pid passed in as $1. Running it in the harness's shell would
	// make $$ agree by accident and hide a production mismatch.
	const waiter = [
		'echo $$ > "$1"',
		'while [ ! -e "$2" ]; do sleep 0.02; done',
		'bash -c "$3" pi-worktree-teardown "$$"',
	].join("\n");

	const child = spawn(
		"bash",
		["-c", waiter, "waiter", pidFile, goFile, resolvedScript],
		{
			stdio: "ignore",
		},
	);
	const exited = new Promise<void>((r) => child.once("exit", () => r()));

	assert.equal(waitForFile(pidFile), true, "waiter never reported its pid");
	const waiterPid = Number(readFileSync(pidFile, "utf-8").trim());
	const claimed = ownerPid(waiterPid);
	if (claimed !== null) {
		const dir = claimPath(f.store, f.wt);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "owner.json"),
			canonicalJson({
				createdAt: new Date().toISOString(),
				operationId: f.operationId,
				pid: claimed,
				role: "waiter",
			}),
		);
	}
	writeFileSync(goFile, "");
	await exited;

	const listed = git(f.repo, "worktree", "list", "--porcelain");
	const branches = git(f.repo, "branch", "--format=%(refname:short)");
	const report = readTeardownReport(f.store, f.operationId);
	return {
		pathPresent: existsSync(f.wt),
		registrationPresent: listed.split("\n").includes(`worktree ${f.wt}`),
		branchPresent: branches.split("\n").some((b) => b.trim() === BRANCH),
		receiptPresent: existsSync(receiptPath(f.store, f.wt)),
		report,
		stageStatus: (name) =>
			report.kind === "present"
				? report.report.stages.find((s) => s.name === name)?.status
				: undefined,
	};
}

async function scriptFor(
	f: ReturnType<typeof fixture>,
	overrides: {
		preRemove?: string[];
		destination?: string;
		approvedSnapshot?: WorktreeSafetySnapshot;
	} = {},
): Promise<string> {
	const reportFile = reportPath(f.store, f.operationId);
	const requestFile = `${reportFile}.request.json`;
	const request: DetachedTeardownRequestV1 = {
		schemaVersion: 1,
		operationId: f.operationId,
		repoRoot: f.repo,
		worktreePath: f.wt,
		branch: BRANCH,
		expectedDestination: {
			path: f.repo,
			branch: overrides.destination ?? "main",
		},
		approvedSnapshot:
			overrides.approvedSnapshot ?? (await inspectWorktreeSafety(f.wt)),
		preRemove: overrides.preRemove ?? [],
		ownerFile: join(claimPath(f.store, f.wt), "owner.json"),
		receiptFile: receiptPath(f.store, f.wt),
		reportFile,
	};
	writeDetachedTeardownRequest(requestFile, request);
	return buildVerifiedTeardownScript({ requestFile });
}

// --- the complete path -------------------------------------------------------

await checkAsync(
	"S-DSP-09: a clean teardown removes path, registration, and receipt",
	async () => {
		const f = fixture();
		const r = await runTeardown(f, scriptFor(f), (pid) => pid);
		assert.equal(r.pathPresent, false, "worktree directory survived");
		assert.equal(r.registrationPresent, false, "git still lists the worktree");
		assert.equal(r.receiptPresent, false, "provisioning receipt survived");
		assert.equal(
			r.branchPresent,
			false,
			"a merged branch should be soft-deleted",
		);
		assert.equal(r.report.kind, "present");
		assert.equal(r.stageStatus("claim"), "ok");
		assert.equal(r.stageStatus("destination"), "ok");
		assert.equal(r.stageStatus("remove"), "ok");
	},
);

// --- an unmerged branch is kept, and that is success -------------------------

await checkAsync(
	"S-DSP-07: an unmerged branch survives a successful teardown",
	async () => {
		const f = fixture({ commitInWorktree: true });
		const r = await runTeardown(f, scriptFor(f), (pid) => pid);
		assert.equal(r.pathPresent, false);
		assert.equal(r.registrationPresent, false);
		assert.equal(
			r.branchPresent,
			true,
			"unmerged work must not be silently deleted",
		);
		assert.equal(r.stageStatus("branch"), "ok");
	},
);

// --- branch disposition is decided while the facts are current ---------------

await checkAsync(
	"teardown records why the branch survived, not just that it did",
	async () => {
		const f = fixture({ commitInWorktree: true });
		const r = await runTeardown(f, scriptFor(f), (pid) => pid);
		assert.equal(r.report.kind, "present");
		if (r.report.kind === "present") {
			assert.equal(r.report.report.branchDisposition, "kept-unmerged");
		}
	},
);

await checkAsync("a deleted branch is recorded as deleted", async () => {
	const f = fixture();
	const r = await runTeardown(f, scriptFor(f), (pid) => pid);
	assert.equal(r.report.kind, "present");
	if (r.report.kind === "present") {
		assert.equal(r.report.report.branchDisposition, "deleted");
	}
});

await checkAsync("an aborted teardown records no branch action", async () => {
	const f = fixture();
	const r = await runTeardown(f, scriptFor(f), (pid) => pid + 1);
	assert.equal(r.report.kind, "present");
	if (r.report.kind === "present") {
		assert.equal(r.report.report.branchDisposition, "skipped");
	}
	assert.equal(r.branchPresent, true);
});

// --- an untransferred waiter must not act ------------------------------------

await checkAsync(
	"S-DSP-17: a waiter that does not own the claim removes nothing",
	async () => {
		const f = fixture();
		// The origin's transfer never happened, so the claim still names another pid.
		const r = await runTeardown(f, scriptFor(f), (pid) => pid + 1);
		assert.equal(
			r.pathPresent,
			true,
			"an unowned waiter tore down the worktree",
		);
		assert.equal(r.registrationPresent, true);
		assert.equal(r.branchPresent, true);
		assert.equal(r.receiptPresent, true);
		assert.equal(r.stageStatus("claim"), "failed");
		assert.equal(
			existsSync(claimPath(f.store, f.wt)),
			true,
			"an unowned waiter released another process's claim",
		);
	},
);

await checkAsync(
	"S-DSP-17: a missing claim file also stops teardown",
	async () => {
		const f = fixture();
		const r = await runTeardown(f, scriptFor(f), () => null);
		assert.equal(r.pathPresent, true);
		assert.equal(r.stageStatus("claim"), "failed");
	},
);

// --- the destination must still be the one that was planned for --------------

await checkAsync(
	"S-DSP-14: a moved destination branch aborts before any removal",
	async () => {
		const f = fixture();
		// The repository moved to another branch after the transition was scheduled.
		git(f.repo, "checkout", "-q", "-b", "release/9");
		const r = await runTeardown(f, scriptFor(f), (pid) => pid);
		assert.equal(
			r.pathPresent,
			true,
			"teardown ran against an unexpected destination",
		);
		assert.equal(r.registrationPresent, true);
		assert.equal(r.branchPresent, true);
		assert.equal(r.stageStatus("destination"), "failed");
		assert.equal(
			r.stageStatus("remove"),
			"skipped",
			"removal must not even be attempted",
		);
	},
);

// --- cleanliness is rechecked at teardown time -------------------------------

await checkAsync(
	"S-DSP-15: a target that became dirty is not force-removed",
	async () => {
		const f = fixture();
		const approvedSnapshot = await inspectWorktreeSafety(f.wt);
		writeFileSync(
			join(f.wt, "late-edit.txt"),
			"written after the model checked\n",
		);
		const r = await runTeardown(
			f,
			scriptFor(f, { approvedSnapshot }),
			(pid) => pid,
		);
		assert.equal(
			r.pathPresent,
			true,
			"--force destroyed files written after the check",
		);
		assert.equal(r.stageStatus("dirty-recheck"), "failed");
		assert.equal(
			r.report.kind === "present" ? r.report.report.outcome : undefined,
			"refused",
		);
		assert.ok(existsSync(join(f.wt, "late-edit.txt")));
	},
);

await checkAsync(
	"S-DSP-15: a hook that dirties the target aborts the recheck",
	async () => {
		const f = fixture();
		const r = await runTeardown(
			f,
			scriptFor(f, { preRemove: ["echo late > hook-artifact.txt"] }),
			(pid) => pid,
		);
		assert.equal(r.pathPresent, true);
		assert.equal(r.stageStatus("pre-remove"), "ok");
		assert.equal(r.stageStatus("dirty-recheck"), "failed");
	},
);

// --- a failing preRemove hook blocks removal ---------------------------------

await checkAsync(
	"S-DSP-05: a failing pre-remove hook stops the teardown",
	async () => {
		const f = fixture();
		const r = await runTeardown(
			f,
			scriptFor(f, { preRemove: ["exit 7"] }),
			(pid) => pid,
		);
		assert.equal(
			r.pathPresent,
			true,
			"removal ran despite a failed pre-remove hook",
		);
		assert.equal(r.registrationPresent, true);
		assert.equal(r.branchPresent, true);
		assert.equal(r.stageStatus("pre-remove"), "failed");
	},
);

await checkAsync(
	"S-DSP-05: a later hook does not run after an earlier one fails",
	async () => {
		const f = fixture();
		const marker = join(f.root, "second-hook-ran");
		const r = await runTeardown(
			f,
			scriptFor(f, { preRemove: ["exit 7", `touch ${marker}`] }),
			(pid) => pid,
		);
		assert.equal(existsSync(marker), false, "hooks are not fail-fast");
		assert.equal(r.pathPresent, true);
	},
);

// --- evidence is always written ----------------------------------------------

await checkAsync(
	"S-DSP-19: every teardown writes a report, including refusals",
	async () => {
		for (const [label, ownerPid] of [
			["owned", (pid: number) => pid],
			["unowned", (pid: number) => pid + 1],
		] as const) {
			const f = fixture();
			const r = await runTeardown(f, scriptFor(f), ownerPid);
			assert.equal(r.report.kind, "present", `${label}: no teardown report`);
			if (r.report.kind === "present") {
				assert.equal(r.report.report.operationId, f.operationId);
				assert.equal(r.report.report.expectedDestination.branch, "main");
				assert.equal(r.report.report.observed.pathPresent, r.pathPresent);
				assert.equal(
					r.report.report.observed.registrationPresent,
					r.registrationPresent,
				);
			}
		}
	},
);

// --- no recursive-delete fallback anywhere in teardown -----------------------

await checkAsync(
	"S-DSP-06: teardown never falls back to a recursive delete",
	async () => {
		const f = fixture();
		const script = await scriptFor(f, { preRemove: ["true"] });
		assert.doesNotMatch(script, /\bgit (?:worktree|branch)\b|\brm\s+-/);
		assert.ok(script.startsWith(`'${process.execPath}' `));
		assert.match(
			script,
			/^'.+' '.+worktree-teardown\.ts' '.+\.request\.json' "\$1"$/,
		);
	},
);

await checkAsync(
	"detached teardown pins the current Pi Node executable",
	async () => {
		const script = buildVerifiedTeardownScript({
			requestFile: "/tmp/request with space.json",
			nodePath: "/runtime/node with space",
			entrypoint: "/package/worktree-teardown.ts",
		});
		assert.equal(
			script,
			"'/runtime/node with space' '/package/worktree-teardown.ts' '/tmp/request with space.json' \"$1\"",
		);
	},
);

// --- claim cleanup -----------------------------------------------------------

await checkAsync(
	"a completed teardown releases its lifecycle claim",
	async () => {
		const f = fixture();
		await runTeardown(f, scriptFor(f), (pid) => pid);
		assert.equal(
			existsSync(claimPath(f.store, f.wt)),
			false,
			"claim leaked after teardown",
		);
		assert.equal(existsSync(dirname(reportPath(f.store, f.operationId))), true);
	},
);

if (fail > 0) {
	console.error(`disposal tests: ${fail} FAILED of ${total}`);
	process.exit(1);
}
console.log(`disposal tests: OK (${total} cases)`);
