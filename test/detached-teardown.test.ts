import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	runDetachedTeardownRequest,
	writeDetachedTeardownRequest,
	type DetachedTeardownRequestV1,
} from "../extensions/worktree-teardown.js";
import { inspectWorktreeSafety } from "../extensions/worktree-safety.ts";

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

async function fixture(): Promise<{
	root: string;
	repo: string;
	worktree: string;
	branch: string;
	requestFile: string;
	reportFile: string;
	ownerFile: string;
	receiptFile: string;
	request: DetachedTeardownRequestV1;
}> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-detached-")));
	const repo = join(root, "repo");
	const worktree = join(root, "worktree with space");
	const branch = "feat/x";
	mkdirSync(repo);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test User");
	writeFileSync(join(repo, ".gitignore"), "*.cache\n");
	writeFileSync(join(repo, "tracked.txt"), "base\n");
	git(repo, "add", ".gitignore", "tracked.txt");
	git(repo, "commit", "-m", "initial");
	git(repo, "worktree", "add", "-b", branch, worktree);
	const canonicalWorktree = realpathSync(worktree);
	const evidence = join(root, "evidence");
	const requestFile = join(evidence, "request.json");
	const reportFile = join(evidence, "report.json");
	const ownerFile = join(evidence, "claim", "owner.json");
	const receiptFile = join(evidence, "receipt.json");
	mkdirSync(dirname(ownerFile), { recursive: true });
	writeFileSync(receiptFile, "receipt\n");
	const approvedSnapshot = await inspectWorktreeSafety(canonicalWorktree);
	return {
		root,
		repo,
		worktree: canonicalWorktree,
		branch,
		requestFile,
		reportFile,
		ownerFile,
		receiptFile,
		request: {
			schemaVersion: 1,
			operationId: "op-detached",
			repoRoot: repo,
			worktreePath: canonicalWorktree,
			branch,
			expectedDestination: { path: repo, branch: "main" },
			approvedSnapshot,
			preRemove: [],
			ownerFile,
			receiptFile,
			reportFile,
		},
	};
}

function writeOwner(file: string, pid: number): void {
	writeFileSync(
		file,
		JSON.stringify({ operationId: "op-detached", pid, role: "waiter" }),
	);
}

function readReport(file: string): Record<string, unknown> {
	return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

await check(
	"detached teardown writes complete evidence and clears ownership",
	async () => {
		const fx = await fixture();
		writeOwner(fx.ownerFile, 4242);
		writeDetachedTeardownRequest(fx.requestFile, fx.request);
		const result = await runDetachedTeardownRequest(fx.requestFile, 4242);
		assert.equal(result.status, "complete");
		const report = readReport(fx.reportFile);
		assert.equal(report.outcome, "complete");
		assert.deepEqual(report.observed, {
			pathPresent: false,
			registrationPresent: false,
			branchPresent: false,
			receiptPresent: false,
		});
		assert.equal(existsSync(fx.ownerFile), false);
		assert.equal(existsSync(fx.requestFile), false);
	},
);

await check(
	"Node executes the shipped TypeScript entrypoint directly",
	async () => {
		const fx = await fixture();
		writeOwner(fx.ownerFile, 4242);
		writeDetachedTeardownRequest(fx.requestFile, fx.request);
		const entrypoint = fileURLToPath(
			new URL("../extensions/worktree-teardown.ts", import.meta.url),
		);
		const child = spawnSync(
			process.execPath,
			[entrypoint, fx.requestFile, "4242"],
			{ cwd: fx.repo, encoding: "utf8" },
		);
		assert.equal(child.status, 0, child.stderr || child.stdout);
		assert.equal(readReport(fx.reportFile).outcome, "complete");
	},
);

await check(
	"detached drift writes refused evidence and preserves data",
	async () => {
		const fx = await fixture();
		writeOwner(fx.ownerFile, 4242);
		const request = {
			...fx.request,
			preRemove: ["touch late.cache"],
		};
		writeDetachedTeardownRequest(fx.requestFile, request);
		const result = await runDetachedTeardownRequest(fx.requestFile, 4242);
		assert.equal(result.status, "refused");
		assert.equal(result.reason, "snapshot-changed");
		const report = readReport(fx.reportFile);
		assert.equal(report.outcome, "refused");
		assert.equal(report.reason, "snapshot-changed");
		assert.equal(existsSync(fx.worktree), true);
		assert.equal(existsSync(fx.receiptFile), true);
		assert.equal(existsSync(fx.ownerFile), false);
	},
);

await check("detached reports do not persist failing hook output", async () => {
	const fx = await fixture();
	writeOwner(fx.ownerFile, 4242);
	const secret = "SUPER_SECRET_API_KEY=do-not-persist";
	writeDetachedTeardownRequest(fx.requestFile, {
		...fx.request,
		preRemove: [`printf '${secret}\\n' >&2; exit 1`],
	});
	const result = await runDetachedTeardownRequest(fx.requestFile, 4242);
	assert.equal(result.status, "refused");
	assert.match(result.details.join("\n"), /SUPER_SECRET_API_KEY/);
	const report = readReport(fx.reportFile);
	assert.deepEqual(report.details, []);
	assert.doesNotMatch(readFileSync(fx.reportFile, "utf8"), /SUPER_SECRET/);
});

await check(
	"claim mismatch refuses without releasing another owner",
	async () => {
		const fx = await fixture();
		writeOwner(fx.ownerFile, 7);
		writeDetachedTeardownRequest(fx.requestFile, fx.request);
		const result = await runDetachedTeardownRequest(fx.requestFile, 4242);
		assert.equal(result.status, "refused");
		assert.equal(result.reason, "claim-failed");
		const report = readReport(fx.reportFile);
		assert.equal(report.outcome, "refused");
		assert.equal(report.reason, "claim-failed");
		assert.equal(existsSync(fx.worktree), true);
		assert.equal(existsSync(fx.ownerFile), true);
		assert.equal(existsSync(fx.receiptFile), true);
	},
);

if (failed > 0) {
	console.error(`detached teardown tests: ${failed} FAILED of ${total}`);
	process.exit(1);
}
console.log(`detached teardown tests: OK (${total} cases)`);
