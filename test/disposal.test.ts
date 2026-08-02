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
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
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
	script: string,
	ownerPid: (waiterPid: number) => number | null,
): Promise<RunResult> {
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
		["-c", waiter, "waiter", pidFile, goFile, script],
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

function scriptFor(
	f: ReturnType<typeof fixture>,
	overrides: { preRemove?: string[]; destination?: string } = {},
) {
	return buildVerifiedTeardownScript({
		repoRoot: f.repo,
		worktreePath: f.wt,
		branch: BRANCH,
		...(overrides.preRemove ? { preRemove: overrides.preRemove } : {}),
		operationId: f.operationId,
		waiterOwnerFile: join(claimPath(f.store, f.wt), "owner.json"),
		receiptFile: receiptPath(f.store, f.wt),
		reportFile: reportPath(f.store, f.operationId),
		expectedDestinationBranch: overrides.destination ?? "main",
	});
}

// --- S-DSP-09: the complete path ------------------------------------------------

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

// --- S-DSP-07: an unmerged branch is kept, and that is success -------------------

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

// --- branch disposition is decided while the facts are current --------------------

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

// --- S-DSP-17: an untransferred waiter must not act -------------------------------

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

// --- S-DSP-14: the destination must still be the one that was planned for ---------

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
			undefined,
			"removal must not even be attempted",
		);
	},
);

// --- S-DSP-15: cleanliness is rechecked at teardown time ---------------------------

await checkAsync(
	"S-DSP-15: a target that became dirty is not force-removed",
	async () => {
		const f = fixture();
		writeFileSync(
			join(f.wt, "late-edit.txt"),
			"written after the model checked\n",
		);
		const r = await runTeardown(f, scriptFor(f), (pid) => pid);
		assert.equal(
			r.pathPresent,
			true,
			"--force destroyed files written after the check",
		);
		assert.equal(r.stageStatus("dirty"), "failed");
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

// --- S-DSP-05: a failing preRemove hook blocks removal ------------------------------

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

// --- S-DSP-19: evidence is always written ---------------------------------------------

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

// --- S-DSP-06: no recursive-delete fallback anywhere in teardown -----------------------

await checkAsync(
	"S-DSP-06: teardown never falls back to a recursive delete",
	async () => {
		const f = fixture();
		const script = scriptFor(f, { preRemove: ["true"] });
		// `rm -rf` on the claim directory is the only permitted recursive removal.
		const recursive = [
			...script.matchAll(/rm\s+-[a-z]*r[a-z]*\s+("?\$?[^\n]*)/g),
		].map((m) => m[0].trim());
		for (const use of recursive) {
			assert.match(
				use,
				/dirname "\$owner"/,
				`unexpected recursive delete: ${use}`,
			);
		}
		assert.equal(/rm -rf "\$wt"/.test(script), false);
		assert.match(
			script,
			/git worktree prune/,
			"stale metadata should be pruned, not deleted",
		);
	},
);

// --- claim cleanup ----------------------------------------------------------------------

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
