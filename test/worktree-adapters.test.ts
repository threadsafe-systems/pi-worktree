import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worktreeExtension from "../extensions/worktree.ts";
import { acquireClaim, createStore } from "../extensions/worktree-receipt.ts";
import type { TransitionDetails } from "../extensions/worktree-transition.ts";

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

// --- harness -----------------------------------------------------------------

interface Registered {
	tool?: {
		name: string;
		executionMode?: string;
		parameters: { properties: Record<string, unknown> };
		promptGuidelines?: string[];
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: undefined,
			onUpdate: undefined,
			ctx: unknown,
		) => Promise<{
			content: { text: string }[];
			details: unknown;
			terminate?: boolean;
		}>;
	};
	toolCall?: (event: unknown, ctx: unknown) => Promise<unknown>;
}

/**
 * A Pi stub that runs real commands.
 *
 * Faking git would only prove the fake agrees with itself; these tests care
 * about how the extension reacts to actual worktree state.
 */
function harness(cwd: string) {
	const registered: Registered = {};
	const shutdowns: number[] = [];
	const pi = {
		registerTool: (tool: unknown) => {
			registered.tool = tool as Registered["tool"];
		},
		registerCommand: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		setSessionName: () => {},
		on: (event: string, handler: unknown) => {
			if (event === "tool_call")
				registered.toolCall = handler as Registered["toolCall"];
		},
		exec: async (
			command: string,
			args: string[],
			opts?: { cwd?: string; timeout?: number },
		) => {
			const r = spawnSync(command, args, {
				cwd: opts?.cwd ?? cwd,
				encoding: "utf-8",
				timeout: opts?.timeout ?? 30_000,
			});
			return {
				code: r.status ?? 1,
				stdout: r.stdout ?? "",
				stderr: r.stderr ?? "",
			};
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: the stub implements only what the extension touches.
	worktreeExtension(pi as any);

	const ctx = {
		cwd,
		mode: "print" as const,
		hasUI: false,
		isIdle: () => true,
		shutdown: () => shutdowns.push(1),
		ui: { setStatus: () => {}, notify: () => {}, confirm: async () => false },
		sessionManager: { getSessionFile: () => undefined },
	};

	const call = async (params: Record<string, unknown>) => {
		const result = await registered.tool?.execute(
			"id",
			params,
			undefined,
			undefined,
			ctx,
		);
		if (!result) throw new Error("tool did not run");
		return {
			text: result.content.map((c) => c.text).join("\n"),
			details: result.details as TransitionDetails,
			terminate: result.terminate,
		};
	};

	return { registered, call, shutdowns, ctx };
}

function git(cwd: string, ...args: string[]) {
	const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (r.status !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
}

function newRepo(worktreeConfig?: Record<string, unknown>) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-adapters-")));
	const repo = join(root, "repo");
	spawnSync("mkdir", ["-p", join(repo, ".pi")]);
	git(root, "init", "-b", "main", "repo");
	git(repo, "config", "user.email", "test@example.invalid");
	git(repo, "config", "user.name", "Test");
	writeFileSync(join(repo, "README.md"), "# fixture\n");
	if (worktreeConfig) {
		writeFileSync(
			join(repo, ".pi", "worktree.json"),
			JSON.stringify(worktreeConfig),
		);
	}
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "init");
	return { root, repo };
}

// --- tool registration -------------------------------------------------------

await checkAsync(
	"S-CMP-06: the tool schema uses enum shapes and sequential execution",
	async () => {
		const { repo } = newRepo();
		const { registered } = harness(repo);
		const tool = registered.tool;
		assert.ok(tool, "worktree_session was not registered");
		assert.equal(tool.name, "worktree_session");
		assert.equal(tool.executionMode, "sequential");

		const action = tool.parameters.properties.action as {
			enum?: string[];
			anyOf?: unknown;
		};
		assert.deepEqual(action.enum, ["status", "create", "enter", "dispose"]);
		assert.equal(
			action.anyOf,
			undefined,
			"a literal union would break Google-family providers",
		);

		const execution = tool.parameters.properties.execution as {
			enum?: string[];
		};
		assert.deepEqual(execution.enum, ["auto", "recamp", "paths"]);

		const guidance = (tool.promptGuidelines ?? []).join(" ");
		assert.match(guidance, /only tool call/i);
		assert.match(guidance, /path-target/);
		assert.match(guidance, /manual-restart/);
	},
);

// --- status ------------------------------------------------------------------

await checkAsync(
	"status reports the process checkout, not a selected target",
	async () => {
		const { repo } = newRepo();
		const { call } = harness(repo);
		const { details, text } = await call({ action: "status" });
		assert.equal(details.outcome, "status");
		assert.equal(details.process.kind, "main");
		assert.equal(details.process.branch, "main");
		assert.equal(details.sessionMode, "process");
		assert.equal(details.requiresAbsolutePaths, false);
		assert.match(text, /pathTarget: none/);
		assert.equal(/selectedWorktree/.test(text), false);
	},
);

// --- refusals are structured, not thrown -------------------------------------

await checkAsync(
	"S-REQ-02: a both-selector request is a structured refusal",
	async () => {
		const { repo } = newRepo();
		const { call } = harness(repo);
		const { details, text } = await call({
			action: "create",
			name: "a",
			branch: "feat/b",
		});
		assert.equal(details.outcome, "refused");
		assert.equal(details.code, "invalid-request");
		assert.equal(details.process.path, repo);
		assert.match(text, /Refused/);
	},
);

// --- create provisions and reports truthfully --------------------------------

await checkAsync(
	"S-PRO-02 / S-REQ-06: create provisions, then reports path-target",
	async () => {
		const { repo } = newRepo({ postCreate: ["touch provisioned.marker"] });
		const { call, shutdowns } = harness(repo);

		const { details, text } = await call({
			action: "create",
			name: "feat/alpha",
		});
		assert.equal(details.outcome, "path-target", JSON.stringify(details));
		assert.equal(details.provisioning, "ready");
		assert.equal(details.sessionMode, "path-target");
		assert.equal(details.requiresAbsolutePaths, true);
		assert.equal(
			details.process.path,
			repo,
			"the process must not claim to have moved",
		);
		assert.ok(details.target);
		assert.ok(
			existsSync(join(details.target?.path ?? "", "provisioned.marker")),
			"hooks did not run",
		);
		assert.match(text, /cd .* && <command>/);
		assert.deepEqual(
			shutdowns,
			[],
			"a headless fallback must never request shutdown",
		);
	},
);

// --- strict create never adopts an existing checkout -------------------------

await checkAsync(
	"S-REQ-04: create refuses an existing exact checkout",
	async () => {
		const { repo } = newRepo();
		const { call } = harness(repo);
		await call({ action: "create", name: "feat/beta" });
		const again = await call({ action: "create", name: "feat/beta" });
		assert.equal(again.details.outcome, "refused");
		assert.equal(again.details.code, "target-exists");
		assert.match(again.text, /Use enter/);
	},
);

// --- enter -------------------------------------------------------------------

await checkAsync(
	"enter selects a provisioned worktree and reports it ready",
	async () => {
		const { repo } = newRepo();
		const { call } = harness(repo);
		const created = await call({ action: "create", name: "feat/gamma" });
		const entered = await call({ action: "enter", name: "feat/gamma" });
		assert.equal(entered.details.outcome, "path-target");
		assert.equal(entered.details.provisioning, "ready");
		assert.equal(entered.details.target?.path, created.details.target?.path);
	},
);

await checkAsync("enter refuses a branch with no linked worktree", async () => {
	const { repo } = newRepo();
	const { call } = harness(repo);
	const { details } = await call({ action: "enter", name: "feat/missing" });
	assert.equal(details.outcome, "refused");
	assert.equal(details.code, "target-not-found");
});

await checkAsync("enter refuses the main checkout", async () => {
	const { repo } = newRepo();
	const { call } = harness(repo);
	const { details, text } = await call({ action: "enter", branch: "main" });
	assert.equal(details.outcome, "refused");
	assert.match(text, /main working tree/);
});

// --- historical checkouts stay usable, without false claims ------------------

await checkAsync(
	"S-PRO-05: a hand-made worktree enters as unmanaged",
	async () => {
		const { root, repo } = newRepo({
			postCreate: ["touch provisioned.marker"],
		});
		const manual = join(root, "manual-wt");
		git(repo, "worktree", "add", "-b", "feat/manual", manual, "HEAD");

		const { call } = harness(repo);
		const { details, text } = await call({
			action: "enter",
			name: "feat/manual",
		});
		assert.equal(details.outcome, "path-target");
		assert.equal(details.provisioning, "unmanaged");
		assert.match(text, /no provisioning record/);
		assert.equal(existsSync(join(manual, "provisioned.marker")), false);
	},
);

// --- a failed hook is durable and blocks entry -------------------------------

await checkAsync(
	"S-PRO-03/04: a failed post-create hook blocks later entry",
	async () => {
		const { repo } = newRepo({ postCreate: ["exit 3"] });
		const { call } = harness(repo);

		const created = await call({ action: "create", name: "feat/broken" });
		assert.equal(created.details.outcome, "refused");
		assert.equal(created.details.code, "hook-failed");
		assert.match(created.text, /NOT provisioned/);

		// A brand-new harness models a later session with no in-memory state.
		const { call: laterCall } = harness(repo);
		const entered = await laterCall({ action: "enter", name: "feat/broken" });
		assert.equal(entered.details.outcome, "refused");
		assert.equal(entered.details.code, "target-not-ready");
		assert.match(entered.text, /half-built/);

		const recreated = await laterCall({
			action: "create",
			name: "feat/broken",
		});
		assert.equal(
			recreated.details.outcome,
			"refused",
			"a half-built checkout must not be recreated over",
		);
	},
);

// --- already inside the target -----------------------------------------------

await checkAsync(
	"S-TRN-08: a session already in the target reports already-active",
	async () => {
		const { repo } = newRepo();
		const { call } = harness(repo);
		const created = await call({ action: "create", name: "feat/delta" });
		const targetPath = created.details.target?.path ?? "";

		// A session whose cwd is the worktree is already where it needs to be.
		const inside = harness(targetPath);
		const { details, text } = await inside.call({
			action: "enter",
			name: "feat/delta",
		});
		assert.equal(details.outcome, "already-active");
		assert.equal(details.sessionMode, "process");
		assert.equal(details.requiresAbsolutePaths, false);
		assert.equal(details.process.path, targetPath);
		assert.match(text, /Already working/);
	},
);

// --- remote disposal ---------------------------------------------------------

await checkAsync("S-DSP-01: model dispose refuses a dirty target", async () => {
	const { repo } = newRepo();
	const { call } = harness(repo);
	const created = await call({ action: "create", name: "feat/dirty" });
	writeFileSync(
		join(created.details.target?.path ?? "", "scratch.txt"),
		"wip\n",
	);

	const { details } = await call({ action: "dispose", name: "feat/dirty" });
	assert.equal(details.outcome, "refused");
	assert.equal(details.code, "dirty-worktree");
	assert.ok(
		existsSync(created.details.target?.path ?? ""),
		"a refusal must not remove anything",
	);
});

await checkAsync(
	"S-DSP-12: clean remote disposal verifies and admits unknown liveness",
	async () => {
		const { repo } = newRepo();
		const { call } = harness(repo);
		const created = await call({ action: "create", name: "feat/gone" });
		const targetPath = created.details.target?.path ?? "";

		const { details, text } = await call({
			action: "dispose",
			name: "feat/gone",
		});
		assert.equal(details.outcome, "disposed", text);
		assert.equal(details.remoteProcessLiveness, "unknown");
		assert.equal(
			details.process.path,
			repo,
			"the process must not claim to have moved",
		);
		assert.equal(existsSync(targetPath), false);
		assert.equal(
			git(repo, "worktree", "list", "--porcelain").includes(targetPath),
			false,
		);
		assert.match(text, /could not be determined/);
	},
);

await checkAsync(
	"S-DSP-03: dispose refuses to remove the checkout it is standing in",
	async () => {
		const { repo } = newRepo();
		const { call } = harness(repo);
		const created = await call({ action: "create", name: "feat/live" });
		const targetPath = created.details.target?.path ?? "";

		const inside = harness(targetPath);
		const { details } = await inside.call({ action: "dispose" });
		assert.equal(details.code, "live-cwd-unsafe");
		assert.equal(existsSync(targetPath), true);
	},
);

// --- teardown safety under hostile hooks and contention ----------------------

await checkAsync(
	"S-DSP-05: a remote pre-remove hook containing exit cannot skip teardown",
	async () => {
		// A hook that ends the shell used to take the whole script with it, silently
		// skipping removal and every check after it.
		const { repo } = newRepo({ preRemove: ["exit 7"] });
		const { call } = harness(repo);
		const created = await call({ action: "create", name: "feat/hooked" });
		const targetPath = created.details.target?.path ?? "";

		const { details } = await call({ action: "dispose", name: "feat/hooked" });
		assert.equal(
			details.outcome,
			"dispose-partial",
			"a failed hook must not report success",
		);
		assert.equal(
			existsSync(targetPath),
			true,
			"removal ran despite a failed pre-remove hook",
		);
	},
);

await checkAsync(
	"S-DSP-15: remote dispose rechecks cleanliness after its hooks",
	async () => {
		// The dirty check happens before the script runs, so a hook that writes into
		// the target would otherwise have its output destroyed by --force.
		const { repo } = newRepo({ preRemove: ["echo late > hook-artifact.txt"] });
		const { call } = harness(repo);
		const created = await call({ action: "create", name: "feat/late-write" });
		const targetPath = created.details.target?.path ?? "";

		const { details } = await call({
			action: "dispose",
			name: "feat/late-write",
		});
		assert.equal(details.outcome, "dispose-partial");
		assert.equal(
			existsSync(targetPath),
			true,
			"--force destroyed post-check hook output",
		);
		assert.equal(existsSync(join(targetPath, "hook-artifact.txt")), true);
	},
);

await checkAsync(
	"remote dispose takes an exclusive claim on its target",
	async () => {
		const { repo } = newRepo();
		const { call } = harness(repo);
		const created = await call({ action: "create", name: "feat/contended" });
		const targetPath = created.details.target?.path ?? "";

		// Another live operation already owns this target.
		const store = createStore(join(repo, ".git"));
		const held = acquireClaim(store, targetPath, {
			operationId: "other-op",
			pid: process.pid,
			role: "origin",
		});
		assert.equal(held.ok, true);

		const { details } = await call({
			action: "dispose",
			name: "feat/contended",
		});
		assert.equal(details.outcome, "refused");
		assert.equal(details.code, "target-busy");
		assert.equal(
			existsSync(targetPath),
			true,
			"a contended target must not be torn down",
		);
	},
);

await checkAsync(
	"an operational git failure is a structured result, not a thrown string",
	async () => {
		// Rooted outside any repository, so every git call this tool makes fails.
		const notARepo = realpathSync(
			mkdtempSync(join(tmpdir(), "pi-wt-not-a-repo-")),
		);
		const { call } = harness(notARepo);
		const result = await call({ action: "status" });
		const details = result.details;
		assert.equal(details.outcome, "failed");
		assert.equal(details.code, "git-failed");
		assert.ok(details.recovery?.instructions.length);
		assert.match(result.text, /failed/i);
	},
);

// --- pending guard wiring ----------------------------------------------------

await checkAsync(
	"the tool_call guard lets unrelated tools through when idle",
	async () => {
		const { repo } = newRepo();
		const { registered, ctx } = harness(repo);
		const verdict = await registered.toolCall?.(
			{ toolName: "bash", input: { command: "ls" } },
			ctx,
		);
		assert.equal(
			verdict,
			undefined,
			"nothing is pending, so nothing should be blocked",
		);
	},
);

if (fail > 0) {
	console.error(`worktree adapter tests: ${fail} FAILED of ${total}`);
	process.exit(1);
}
console.log(`worktree adapter tests: OK (${total} cases)`);
