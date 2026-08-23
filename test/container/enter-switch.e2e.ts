/**
 * Container-only proof for live session replacement.
 *
 * This file is deliberately outside `test/*.test.ts`: the normal suite must
 * never call `switchSession`. It loads the real extension into a real runtime,
 * invokes the registered `/worktree enter` command, and replaces that runtime
 * inside a disposable container whose process and session store can be lost.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { encodeHandoff } from "../../extensions/worktree-handoff.ts";
import { TRANSITION_MESSAGE_TYPE } from "../../extensions/worktree-switch.ts";

if (
	!existsSync("/.dockerenv") ||
	process.env.PI_WORKTREE_CONTAINER_TEST !== "1"
) {
	throw new Error(
		"Refusing to run a live session-switch test outside its disposable container.",
	);
}

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

const extensionPath = new URL("../../extensions/worktree.ts", import.meta.url)
	.pathname;

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-container-")));
	const repo = join(root, "repo");
	mkdirSync(repo);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "test@example.invalid");
	git(repo, "config", "user.name", "test");
	writeFileSync(join(repo, "README.md"), "main\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "init");

	const worktree = join(root, "repo.worktrees", "feat-x");
	git(repo, "worktree", "add", "-b", "feat/x", worktree);

	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	mkdirSync(agentDir);
	mkdirSync(sessionDir);
	return { repo, worktree, agentDir, sessionDir };
}

const createRuntime: CreateAgentSessionRuntimeFactory = async ({
	cwd,
	agentDir,
	sessionManager,
	sessionStartEvent,
}) => {
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		resourceLoaderOptions: { additionalExtensionPaths: [extensionPath] },
	});
	return {
		...(await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
		})),
		services,
		diagnostics: services.diagnostics,
	};
};

type Runtime = Awaited<ReturnType<typeof createAgentSessionRuntime>>;

async function bind(runtime: Runtime, notices: string[]) {
	await runtime.session.bindExtensions({
		mode: "print",
		uiContext: {
			notify: (message: string) => notices.push(message),
			setStatus: () => {},
		} as never,
		commandContextActions: {
			waitForIdle: async () => {},
			switchSession: async (sessionPath: string, options?: never) =>
				runtime.switchSession(sessionPath, options),
		} as never,
	});
	return runtime.session.extensionRunner;
}

async function proveEnter(): Promise<void> {
	const fx = fixture();
	const notices: string[] = [];
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: fx.repo,
		agentDir: fx.agentDir,
		sessionManager: SessionManager.create(fx.repo, fx.sessionDir),
	});
	delete process.env.TMUX;
	delete process.env.CMUX_SURFACE_ID;
	delete process.env.HERDR_PANE_ID;
	process.env.PI_WT_HANDOFF = encodeHandoff({
		parentCwd: "/older-checkout",
		parentBranch: "older-branch",
		uncommitted: 0,
		kind: "enter",
	});

	try {
		const runner = await bind(runtime, notices);
		const command = runner.getCommand("worktree");
		assert.ok(command, "the extension did not register /worktree");
		await command.handler("enter feat/x", runner.createCommandContext());

		assert.equal(
			runtime.cwd,
			fx.worktree,
			`runtime stayed at ${runtime.cwd}; notices: ${JSON.stringify(notices)}`,
		);
		assert.equal(runtime.services.cwd, fx.worktree);
		assert.equal(runtime.session.sessionManager.getCwd(), fx.worktree);
		assert.equal(
			process.env.PI_WT_HANDOFF,
			undefined,
			"the replacement inherited an older transition handoff",
		);

		const entries = runtime.session.sessionManager.getEntries();
		assert.equal(
			entries.filter((entry) => entry.type === "message").length,
			0,
			"an idle enter must not invent a user or assistant turn",
		);
		const orientations = entries.filter(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === TRANSITION_MESSAGE_TYPE,
		);
		assert.equal(
			orientations.length,
			1,
			"the replacement needs one orientation",
		);
		const orientation = orientations[0];
		assert.equal(orientation?.type, "custom_message");
		if (orientation?.type !== "custom_message") return;
		assert.equal(orientation.customType, TRANSITION_MESSAGE_TYPE);
		assert.equal(orientation.display, true);
		assert.match(
			String(orientation.content),
			/Session migrated into a worktree/,
		);
		assert.match(
			String(orientation.content),
			new RegExp(escapeRegExp(fx.repo)),
		);
		assert.match(
			String(orientation.content),
			new RegExp(escapeRegExp(fx.worktree)),
		);
		assert.ok(
			!String(orientation.content).includes(process.cwd()),
			"orientation used the process cwd as the replacement location",
		);

		const context = runtime.session.sessionManager.buildSessionContext();
		assert.ok(
			JSON.stringify(context.messages).includes(
				"Session migrated into a worktree",
			),
			"orientation does not participate in the next model context",
		);
	} finally {
		delete process.env.PI_WT_HANDOFF;
		await runtime.dispose();
	}
}

async function proveRelaunchHandoffIsConsumed(): Promise<void> {
	const fx = fixture();
	const notices: string[] = [];
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: fx.repo,
		agentDir: fx.agentDir,
		sessionManager: SessionManager.create(fx.repo, fx.sessionDir),
	});
	process.env.PI_WT_HANDOFF = encodeHandoff({
		parentCwd: "/source-checkout",
		parentBranch: "main",
		uncommitted: 0,
		kind: "enter",
	});

	try {
		const runner = await bind(runtime, notices);
		const first = await runner.emitBeforeAgentStart(
			"anything",
			undefined,
			"BASE",
			{} as never,
		);
		assert.match(first?.systemPrompt ?? "", /Session migrated into a worktree/);
		assert.match(first?.systemPrompt ?? "", new RegExp(escapeRegExp(fx.repo)));
		assert.equal(process.env.PI_WT_HANDOFF, undefined);

		await runtime.session.reload();
		const reloadedRunner = await bind(runtime, notices);
		const second = await reloadedRunner.emitBeforeAgentStart(
			"anything else",
			undefined,
			"BASE",
			{} as never,
		);
		assert.doesNotMatch(
			second?.systemPrompt ?? "",
			/Session migrated into a worktree/,
		);
	} finally {
		delete process.env.PI_WT_HANDOFF;
		await runtime.dispose();
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

await proveEnter();
await proveRelaunchHandoffIsConsumed();
console.log("container enter-switch e2e: OK");
