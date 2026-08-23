import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	inspectAdministrativeRecovery,
	WorktreeSafetyError,
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

function fixture(): { root: string; repo: string; worktree: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-recovery-")));
	const repo = join(root, "repo");
	const worktree = join(root, "worktree");
	mkdirSync(repo);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test User");
	writeFileSync(join(repo, "tracked.txt"), "base\n");
	git(repo, "add", "tracked.txt");
	git(repo, "commit", "-m", "initial");
	git(repo, "worktree", "add", "-b", "feat/x", worktree);
	return { root, repo, worktree: realpathSync(worktree) };
}

await check("reflog-only commit is a recovery risk until tagged", async () => {
	const fx = fixture();
	writeFileSync(join(fx.worktree, "recovery.txt"), "recovery\n");
	git(fx.worktree, "add", "recovery.txt");
	git(fx.worktree, "commit", "-m", "recovery commit");
	const recoveryOid = git(fx.worktree, "rev-parse", "HEAD");
	git(fx.worktree, "reset", "--hard", "HEAD~1");

	const before = await inspectAdministrativeRecovery(fx.worktree);
	assert.equal(before.identity.branch, "refs/heads/feat/x");
	assert.equal(before.identity.head, git(fx.worktree, "rev-parse", "HEAD"));
	assert.equal(before.recoveryOids.includes(recoveryOid), true);
	assert.equal(
		before.administrativePath,
		realpathSync(git(fx.worktree, "rev-parse", "--absolute-git-dir")),
	);

	git(fx.repo, "tag", "rescue", recoveryOid);
	const after = await inspectAdministrativeRecovery(fx.worktree);
	assert.equal(after.recoveryOids.includes(recoveryOid), false);
});

await check("detached worktree identity records a null branch", async () => {
	const fx = fixture();
	git(fx.worktree, "checkout", "--detach");
	const recovery = await inspectAdministrativeRecovery(fx.worktree);
	assert.equal(recovery.identity.branch, null);
	assert.equal(recovery.identity.head, git(fx.worktree, "rev-parse", "HEAD"));
});

await check("unreferenced detached HEAD is risky without reflogs", async () => {
	const fx = fixture();
	writeFileSync(join(fx.worktree, "detached.txt"), "detached\n");
	git(fx.worktree, "add", "detached.txt");
	git(fx.worktree, "commit", "-m", "detached commit");
	const detachedOid = git(fx.worktree, "rev-parse", "HEAD");
	git(fx.worktree, "checkout", "--detach");
	git(fx.worktree, "branch", "-f", "feat/x", "HEAD~1");
	const administrativePath = git(
		fx.worktree,
		"rev-parse",
		"--absolute-git-dir",
	);
	rmSync(join(administrativePath, "logs"), { recursive: true, force: true });

	const recovery = await inspectAdministrativeRecovery(fx.worktree);
	assert.equal(recovery.identity.head, detachedOid);
	assert.equal(recovery.recoveryOids.includes(detachedOid), true);
});

await check("symlinked administrative log entries fail closed", async () => {
	const fx = fixture();
	const administrativePath = git(
		fx.worktree,
		"rev-parse",
		"--absolute-git-dir",
	);
	const target = join(fx.root, "outside-log");
	writeFileSync(target, "not inspected\n");
	symlinkSync(target, join(administrativePath, "logs", "linked"));
	await assert.rejects(
		inspectAdministrativeRecovery(fx.worktree),
		(error) =>
			error instanceof WorktreeSafetyError &&
			/unexpected administrative history entry/i.test(error.message),
	);
});

await check("malformed pseudoref fails closed", async () => {
	const fx = fixture();
	const administrativePath = git(
		fx.worktree,
		"rev-parse",
		"--absolute-git-dir",
	);
	writeFileSync(join(administrativePath, "MERGE_HEAD"), "not-an-object\n");
	await assert.rejects(
		inspectAdministrativeRecovery(fx.worktree),
		(error) =>
			error instanceof WorktreeSafetyError &&
			/MERGE_HEAD contains an invalid object ID/.test(error.message),
	);
});

if (failed > 0) {
	console.error(`worktree recovery tests: ${failed} FAILED of ${total}`);
	process.exit(1);
}
console.log(`worktree recovery tests: OK (${total} cases)`);
