import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	executeWorktreeTeardown,
	inspectWorktreeSafety,
} from "../extensions/worktree-safety.ts";

let total = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
	total++;
	try {
		await fn();
	} catch (error) {
		failed++;
		console.error(`FAIL: ${name}`);
		console.error(error instanceof Error ? error.stack : String(error));
	}
}

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function fixture(worktreeName = "worktree"): {
	root: string;
	repo: string;
	worktree: string;
	branch: string;
} {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-teardown-")));
	const repo = join(root, "repo");
	const worktree = join(root, worktreeName);
	mkdirSync(repo);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test User");
	writeFileSync(join(repo, ".gitignore"), "*.cache\n");
	writeFileSync(join(repo, "tracked.txt"), "base\n");
	git(repo, "add", ".gitignore", "tracked.txt");
	git(repo, "commit", "-m", "initial");
	git(repo, "worktree", "add", "-b", "feat/x", worktree);
	return {
		root,
		repo,
		worktree: realpathSync(worktree),
		branch: "feat/x",
	};
}

await check(
	"clean dispose removes a weird path and merged branch",
	async () => {
		const fx = fixture("worktree\nwith space");
		const approvedSnapshot = await inspectWorktreeSafety(fx.worktree);
		const result = await executeWorktreeTeardown({
			repoRoot: fx.repo,
			worktreePath: fx.worktree,
			branch: fx.branch,
			mode: "dispose",
			approvedSnapshot,
		});
		assert.equal(result.status, "complete");
		assert.equal(result.pathGone, true);
		assert.equal(result.registrationGone, true);
		assert.equal(result.branchDisposition, "deleted");
		assert.equal(existsSync(fx.worktree), false);
		assert.throws(() =>
			git(fx.repo, "show-ref", "--verify", `refs/heads/${fx.branch}`),
		);
	},
);

await check(
	"dispose keeps an unmerged branch as a complete outcome",
	async () => {
		const fx = fixture();
		writeFileSync(join(fx.worktree, "feature.txt"), "feature\n");
		git(fx.worktree, "add", "feature.txt");
		git(fx.worktree, "commit", "-m", "feature");
		const approvedSnapshot = await inspectWorktreeSafety(fx.worktree);
		const result = await executeWorktreeTeardown({
			repoRoot: fx.repo,
			worktreePath: fx.worktree,
			branch: fx.branch,
			mode: "dispose",
			approvedSnapshot,
		});
		assert.equal(result.status, "complete");
		assert.equal(result.branchDisposition, "kept-unmerged");
		assert.doesNotThrow(() =>
			git(fx.repo, "show-ref", "--verify", `refs/heads/${fx.branch}`),
		);
	},
);

await check("hook-created safety state refuses before mutation", async () => {
	const fx = fixture();
	const approvedSnapshot = await inspectWorktreeSafety(fx.worktree);
	const result = await executeWorktreeTeardown({
		repoRoot: fx.repo,
		worktreePath: fx.worktree,
		branch: fx.branch,
		mode: "dispose",
		approvedSnapshot,
		preRemove: ["touch late.cache"],
	});
	assert.equal(result.status, "refused");
	assert.equal(result.reason, "snapshot-changed");
	assert.deepEqual(result.changes, ["ignored inventory"]);
	assert.equal(existsSync(fx.worktree), true);
	assert.doesNotThrow(() =>
		git(fx.repo, "show-ref", "--verify", `refs/heads/${fx.branch}`),
	);
});

await check(
	"hook-created recovery history refuses before mutation",
	async () => {
		const fx = fixture();
		const approvedSnapshot = await inspectWorktreeSafety(fx.worktree);
		const result = await executeWorktreeTeardown({
			repoRoot: fx.repo,
			worktreePath: fx.worktree,
			branch: fx.branch,
			mode: "dispose",
			approvedSnapshot,
			preRemove: [
				"git commit --allow-empty -m late-recovery >/dev/null && git reset --hard HEAD~1 >/dev/null",
			],
		});
		assert.equal(result.status, "refused");
		assert.equal(result.reason, "snapshot-changed");
		assert.deepEqual(result.changes, ["recovery history"]);
		assert.equal(existsSync(fx.worktree), true);
	},
);

await check(
	"destroy refuses when a hook removes approved inventory",
	async () => {
		const fx = fixture();
		writeFileSync(join(fx.worktree, "local.cache"), "approved\n");
		const approvedSnapshot = await inspectWorktreeSafety(fx.worktree);
		const result = await executeWorktreeTeardown({
			repoRoot: fx.repo,
			worktreePath: fx.worktree,
			branch: fx.branch,
			mode: "destroy",
			approvedSnapshot,
			preRemove: ["rm local.cache"],
		});
		assert.equal(result.status, "refused");
		assert.equal(result.reason, "snapshot-changed");
		assert.deepEqual(result.changes, ["ignored inventory"]);
		assert.equal(existsSync(fx.worktree), true);
	},
);

await check("preRemove hooks stop at the first failure", async () => {
	const fx = fixture();
	const approvedSnapshot = await inspectWorktreeSafety(fx.worktree);
	const result = await executeWorktreeTeardown({
		repoRoot: fx.repo,
		worktreePath: fx.worktree,
		branch: fx.branch,
		mode: "dispose",
		approvedSnapshot,
		preRemove: ["exit 7", "touch should-not-exist"],
	});
	assert.equal(result.status, "refused");
	assert.equal(result.reason, "hook-failed");
	assert.equal(existsSync(join(fx.worktree, "should-not-exist")), false);
	assert.equal(existsSync(fx.worktree), true);
});

await check(
	"destroy revalidates with its hard-deleted branch excluded",
	async () => {
		const fx = fixture();
		writeFileSync(join(fx.worktree, "feature.txt"), "feature\n");
		git(fx.worktree, "add", "feature.txt");
		git(fx.worktree, "commit", "-m", "feature");
		const featureOid = git(fx.worktree, "rev-parse", "HEAD");
		const approvedSnapshot = await inspectWorktreeSafety(fx.worktree, {
			excludedDurableRefs: [`refs/heads/${fx.branch}`],
		});
		assert.equal(approvedSnapshot.recoveryOids.includes(featureOid), true);

		const result = await executeWorktreeTeardown({
			repoRoot: fx.repo,
			worktreePath: fx.worktree,
			branch: fx.branch,
			mode: "destroy",
			approvedSnapshot,
		});
		assert.equal(result.status, "complete");
		assert.equal(result.branchDisposition, "deleted");
		assert.equal(existsSync(fx.worktree), false);
	},
);

await check(
	"destroy removes the exact dirty snapshot a human approved",
	async () => {
		const fx = fixture();
		writeFileSync(join(fx.worktree, "tracked.txt"), "discard me\n");
		writeFileSync(join(fx.worktree, "local.cache"), "discard me\n");
		const approvedSnapshot = await inspectWorktreeSafety(fx.worktree);
		assert.ok(approvedSnapshot.protected.length > 0);
		assert.ok(approvedSnapshot.ignored.length > 0);
		const result = await executeWorktreeTeardown({
			repoRoot: fx.repo,
			worktreePath: fx.worktree,
			branch: fx.branch,
			mode: "destroy",
			approvedSnapshot,
		});
		assert.equal(result.status, "complete");
		assert.equal(result.branchDisposition, "deleted");
		assert.equal(existsSync(fx.worktree), false);
		assert.throws(() =>
			git(fx.repo, "show-ref", "--verify", `refs/heads/${fx.branch}`),
		);
	},
);

if (failed > 0) {
	console.error(`worktree teardown tests: ${failed} FAILED of ${total}`);
	process.exit(1);
}
console.log(`worktree teardown tests: OK (${total} cases)`);
