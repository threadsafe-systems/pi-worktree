import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	inspectWorktreeInventory,
	type GitRunner,
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

function fixture(prefix = "pi-wt-safety-git-"): string {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test User");
	writeFileSync(join(repo, ".gitignore"), "*.cache\n");
	writeFileSync(join(repo, "tracked.txt"), "base\n");
	git(repo, "add", ".gitignore", "tracked.txt");
	git(repo, "commit", "-m", "initial");
	return repo;
}

await check("inventory preserves exact status and ignored paths", async () => {
	const repo = fixture();
	writeFileSync(join(repo, "tracked.txt"), "changed\n");
	writeFileSync(join(repo, "--leading"), "new\n");
	writeFileSync(join(repo, "line\nbreak café"), "new\n");
	writeFileSync(join(repo, "ignored\nvalue.cache"), "ignored\n");

	const inventory = await inspectWorktreeInventory(repo);
	assert.ok(
		inventory.protected.some(
			(entry) => entry.kind === "status" && entry.path === "tracked.txt",
		),
	);
	assert.ok(
		inventory.protected.some(
			(entry) => entry.kind === "status" && entry.path === "--leading",
		),
	);
	assert.ok(
		inventory.protected.some(
			(entry) => entry.kind === "status" && entry.path === "line\nbreak café",
		),
	);
	assert.ok(
		inventory.ignored.some(
			(entry) =>
				entry.kind === "ignored" && entry.path === "ignored\nvalue.cache",
		),
	);
});

await check(
	"assume-unchanged is protected when porcelain is clean",
	async () => {
		const repo = fixture();
		git(repo, "update-index", "--assume-unchanged", "tracked.txt");
		writeFileSync(join(repo, "tracked.txt"), "hidden change\n");
		assert.equal(git(repo, "status", "--porcelain"), "");

		const inventory = await inspectWorktreeInventory(repo);
		assert.ok(
			inventory.protected.some(
				(entry) =>
					entry.kind === "index-flag" &&
					entry.path === "tracked.txt" &&
					entry.flags.includes("assume-unchanged"),
			),
		);
	},
);

await check("unmanaged skip-worktree is protected", async () => {
	const repo = fixture();
	git(repo, "update-index", "--skip-worktree", "tracked.txt");
	writeFileSync(join(repo, "tracked.txt"), "hidden change\n");
	assert.equal(git(repo, "status", "--porcelain"), "");

	const inventory = await inspectWorktreeInventory(repo);
	assert.ok(
		inventory.protected.some(
			(entry) =>
				entry.kind === "index-flag" &&
				entry.path === "tracked.txt" &&
				entry.flags.includes("skip-worktree"),
		),
	);
});

await check("Git-proven sparse skip-worktree state is allowed", async () => {
	const repo = fixture();
	mkdirSync(join(repo, "included"));
	mkdirSync(join(repo, "excluded"));
	writeFileSync(join(repo, "included", "visible.txt"), "visible\n");
	writeFileSync(join(repo, "excluded", "hidden.txt"), "hidden\n");
	git(repo, "add", "included", "excluded");
	git(repo, "commit", "-m", "add sparse paths");
	git(repo, "sparse-checkout", "init", "--cone");
	git(repo, "sparse-checkout", "set", "included");

	const inventory = await inspectWorktreeInventory(repo);
	assert.equal(
		inventory.protected.some(
			(entry) =>
				entry.kind === "index-flag" && entry.path === "excluded/hidden.txt",
		),
		false,
	);
});

await check("failed sparse-rule proof refuses inspection", async () => {
	const runner: GitRunner = async (args) => {
		const command = args.join(" ");
		if (command.startsWith("status ")) {
			return { code: 0, stdout: "", stderr: "", killed: false };
		}
		if (command === "ls-files -v -z") {
			return {
				code: 0,
				stdout: "S hidden.txt\0",
				stderr: "",
				killed: false,
			};
		}
		if (command === "config --bool --get core.sparseCheckout") {
			return { code: 0, stdout: "true\n", stderr: "", killed: false };
		}
		if (command === "sparse-checkout check-rules -z") {
			return { code: 1, stdout: "", stderr: "unsupported", killed: false };
		}
		throw new Error(`unexpected git command: ${command}`);
	};
	await assert.rejects(
		inspectWorktreeInventory("/repo", { runner }),
		(error) =>
			error instanceof WorktreeSafetyError &&
			/sparse-checkout check-rules failed/.test(error.message),
	);
});

await check(
	"initialized submodules and their ignored state are inventoried",
	async () => {
		const submodule = fixture("pi-wt-safety-submodule-");
		const parent = fixture("pi-wt-safety-parent-");
		git(
			parent,
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			submodule,
			"deps/sub",
		);
		git(parent, "commit", "-am", "add submodule");
		writeFileSync(join(parent, "deps", "sub", "local.cache"), "ignored\n");

		const inventory = await inspectWorktreeInventory(parent);
		assert.ok(
			inventory.protected.some(
				(entry) =>
					entry.kind === "initialized-submodule" && entry.path === "deps/sub",
			),
		);
		assert.ok(
			inventory.ignored.some(
				(entry) =>
					entry.kind === "ignored" && entry.path === "deps/sub/local.cache",
			),
		);
	},
);

if (failed > 0) {
	console.error(`worktree safety git tests: ${failed} FAILED of ${total}`);
	process.exit(1);
}
console.log(`worktree safety git tests: OK (${total} cases)`);
