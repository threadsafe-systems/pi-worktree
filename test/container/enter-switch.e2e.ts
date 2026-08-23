/**
 * Container-only proof for live session replacement.
 *
 * This file is deliberately outside `test/*.test.ts`: the normal suite must
 * never call `switchSession`. It loads the real extension into a real runtime,
 * invokes the registered session-switching commands, and replaces that runtime
 * inside a disposable container whose process and session store can be lost.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { encodeHandoff } from "../../extensions/worktree-handoff.ts";
import {
	claimPath,
	createStore,
	readTeardownReport,
	receiptPath,
	reportPath,
} from "../../extensions/worktree-receipt.ts";
import { inspectWorktreeSafety } from "../../extensions/worktree-safety.ts";
import {
	runDetachedTeardownRequest,
	writeDetachedTeardownRequest,
} from "../../extensions/worktree-teardown.ts";
import {
	TRANSITION_MESSAGE_TYPE,
	TRANSITION_VERIFICATION_TYPE,
} from "../../extensions/worktree-switch.ts";

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
let extraExtensionPaths: string[] = [];
let extensionFlagValues: Map<string, string | boolean> | undefined;

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-container-")));
	const repo = join(root, "repo");
	mkdirSync(repo);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "test@example.invalid");
	git(repo, "config", "user.name", "test");
	writeFileSync(join(repo, ".gitignore"), "*.cache\n");
	writeFileSync(join(repo, "README.md"), "main\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "init");

	const worktree = join(root, "repo.worktrees", "feat-x");
	git(repo, "worktree", "add", "-b", "feat/x", worktree);

	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	mkdirSync(agentDir);
	mkdirSync(sessionDir);
	return { root, repo, worktree, agentDir, sessionDir };
}

function addWorktree(fx: ReturnType<typeof fixture>, branch: string): string {
	const path = join(fx.root, "repo.worktrees", branch.replaceAll("/", "-"));
	git(fx.repo, "worktree", "add", "-b", branch, path);
	return path;
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
		extensionFlagValues,
		resourceLoaderOptions: {
			additionalExtensionPaths: [extensionPath, ...extraExtensionPaths],
		},
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
		onError: ({ error }) => notices.push(`extension-error: ${error}`),
	});
	return runtime.session.extensionRunner;
}

async function attach(runtime: Runtime, notices: string[]) {
	runtime.setRebindSession(async () => {
		await bind(runtime, notices);
	});
	return bind(runtime, notices);
}

async function proveEnter(): Promise<void> {
	const fx = fixture();
	const notices: string[] = [];
	const sourceManager = SessionManager.create(fx.repo);
	const sourceSessionDir = sourceManager.getSessionDir();
	const targetSessionDir = SessionManager.create(fx.worktree).getSessionDir();
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: fx.repo,
		agentDir: fx.agentDir,
		sessionManager: sourceManager,
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
		const runner = await attach(runtime, notices);
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
		assert.notEqual(sourceSessionDir, targetSessionDir);
		assert.equal(
			runtime.session.sessionManager.getSessionDir(),
			targetSessionDir,
			"the target session stayed in the source checkout's default store",
		);
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

		assert.ok(
			entries.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === TRANSITION_VERIFICATION_TYPE,
			),
			"successful target verification was not persisted",
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

async function proveCancellationCleansTarget(): Promise<void> {
	const fx = fixture();
	const notices: string[] = [];
	const cancelExtension = join(fx.root, "cancel-switch.ts");
	writeFileSync(
		cancelExtension,
		`export default function (pi) {\n  pi.on("session_before_switch", () => ({ cancel: true }));\n}\n`,
	);
	extraExtensionPaths = [cancelExtension];
	const before = readdirSync(fx.sessionDir).sort();
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: fx.repo,
		agentDir: fx.agentDir,
		sessionManager: SessionManager.create(fx.repo, fx.sessionDir),
	});
	process.env.PI_WT_HANDOFF = "predecessor-handoff";

	try {
		const runner = await attach(runtime, notices);
		const command = runner.getCommand("worktree");
		assert.ok(command);
		await command.handler("enter feat/x", runner.createCommandContext());

		assert.equal(runtime.cwd, fx.repo);
		assert.equal(process.env.PI_WT_HANDOFF, "predecessor-handoff");
		assert.deepEqual(readdirSync(fx.sessionDir).sort(), before);
		assert.ok(notices.some((notice) => notice.includes("cancelled")));
	} finally {
		extraExtensionPaths = [];
		delete process.env.PI_WT_HANDOFF;
		await runtime.dispose();
	}
}

async function proveCliFlagDoesNotReplay(): Promise<void> {
	const fx = fixture();
	const target = addWorktree(fx, "feat/y");
	const notices: string[] = [];
	extensionFlagValues = new Map([["worktree", "feat/x"]]);
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: fx.worktree,
		agentDir: fx.agentDir,
		sessionManager: SessionManager.create(fx.worktree, fx.sessionDir),
	});

	try {
		const runner = await attach(runtime, notices);
		assert.equal(runtime.cwd, fx.worktree);
		const command = runner.getCommand("worktree");
		assert.ok(command);
		await command.handler("enter feat/y", runner.createCommandContext());
		assert.equal(
			runtime.cwd,
			target,
			`the replacement replayed --worktree feat/x: ${JSON.stringify(notices)}`,
		);
	} finally {
		extensionFlagValues = undefined;
		await runtime.dispose();
	}
}

async function proveSuccessorVerification(): Promise<void> {
	const fx = fixture();
	const notices: string[] = [];
	const commonDir = resolve(
		fx.repo,
		git(fx.repo, "rev-parse", "--git-common-dir"),
	);
	const corruptReceipt = receiptPath(createStore(commonDir), fx.worktree);
	const mutationExtension = join(fx.root, "mutate-receipt.ts");
	writeFileSync(
		mutationExtension,
		`import { mkdirSync, writeFileSync } from "node:fs";\nimport { dirname } from "node:path";\nconst receipt = ${JSON.stringify(corruptReceipt)};\nexport default function (pi) {\n  pi.on("session_before_switch", (event) => {\n    if (event.reason !== "resume") return;\n    mkdirSync(dirname(receipt), { recursive: true });\n    writeFileSync(receipt, "not-json");\n  });\n}\n`,
	);
	extraExtensionPaths = [mutationExtension];
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: fx.repo,
		agentDir: fx.agentDir,
		sessionManager: SessionManager.create(fx.repo, fx.sessionDir),
	});

	try {
		const runner = await attach(runtime, notices);
		const command = runner.getCommand("worktree");
		assert.ok(command);
		await command.handler("enter feat/x", runner.createCommandContext());
		assert.equal(runtime.cwd, fx.worktree);

		const verificationMessages = runtime.session.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === TRANSITION_VERIFICATION_TYPE,
			);
		assert.equal(
			verificationMessages.length,
			1,
			JSON.stringify({
				entries: runtime.session.sessionManager.getEntries(),
				notices,
			}),
		);
		const verificationMessage = verificationMessages[0];
		assert.equal(verificationMessage?.type, "custom_message");
		if (verificationMessage?.type !== "custom_message") return;
		assert.match(
			String(verificationMessage.content),
			/transition did NOT land as planned/i,
		);

		await runtime.session.reload();
		await bind(runtime, notices);
		const afterReload = runtime.session.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					(entry.type === "custom" || entry.type === "custom_message") &&
					entry.customType === TRANSITION_VERIFICATION_TYPE,
			);
		assert.equal(afterReload.length, 1);
	} finally {
		extraExtensionPaths = [];
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
		const runner = await attach(runtime, notices);
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

async function proveDisposeSwitchesBeforeRemoval(): Promise<void> {
	const fx = fixture();
	const notices: string[] = [];
	const heartbeat = join(fx.root, "dispose-heartbeat");
	const heartbeatExtension = join(fx.root, "dispose-heartbeat.ts");
	writeFileSync(
		heartbeatExtension,
		`import { writeFileSync } from "node:fs";\nexport default function (pi) {\n  pi.on("session_start", (event) => {\n    if (event.reason !== "resume") return;\n    let ticks = 0;\n    writeFileSync(${JSON.stringify(heartbeat)}, "0");\n    globalThis.__piWorktreeDisposeHeartbeat = setInterval(() => writeFileSync(${JSON.stringify(heartbeat)}, String(++ticks)), 10);\n  });\n}\n`,
	);
	mkdirSync(join(fx.repo, ".pi"));
	writeFileSync(
		join(fx.repo, ".pi", "worktree.json"),
		JSON.stringify({
			preRemove: [
				`before=$(cat ${heartbeat}); sleep 0.2; after=$(cat ${heartbeat}); [ "$after" -gt "$before" ]`,
			],
		}),
	);
	extraExtensionPaths = [heartbeatExtension];
	const commonDir = resolve(
		fx.repo,
		git(fx.repo, "rev-parse", "--git-common-dir"),
	);
	const store = createStore(commonDir);
	const receipt = receiptPath(store, fx.worktree);
	mkdirSync(dirname(receipt), { recursive: true });
	writeFileSync(receipt, "successful-receipt");
	const sourceManager = SessionManager.create(fx.worktree);
	sourceManager.appendMessage({
		role: "user",
		content: "carried-dispose-marker",
	} as never);
	sourceManager.appendMessage({
		role: "assistant",
		content: "ready-to-leave",
	} as never);
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: fx.worktree,
		agentDir: fx.agentDir,
		sessionManager: sourceManager,
	});
	const originalProcessCwd = process.cwd();
	process.chdir(fx.worktree);

	try {
		const runner = await attach(runtime, notices);
		const command = runner.getCommand("worktree");
		assert.ok(command, "the extension did not register /worktree");
		await command.handler("dispose", runner.createCommandContext());

		assert.equal(
			runtime.cwd,
			fx.repo,
			`runtime stayed in the disposed worktree: ${JSON.stringify(notices)}`,
		);
		assert.equal(runtime.session.sessionManager.getCwd(), fx.repo);
		assert.equal(
			process.cwd(),
			fx.repo,
			"the OS cwd still names the removed launch directory",
		);
		assert.equal(existsSync(fx.worktree), false, "the worktree path survived");
		assert.doesNotMatch(
			git(fx.repo, "worktree", "list", "--porcelain"),
			new RegExp(escapeRegExp(fx.worktree)),
		);
		assert.throws(() =>
			git(fx.repo, "show-ref", "--verify", "refs/heads/feat/x"),
		);
		assert.equal(
			existsSync(receipt),
			false,
			"successful teardown kept receipt",
		);
		assert.equal(
			existsSync(claimPath(store, fx.worktree)),
			false,
			"successful teardown leaked its lifecycle claim",
		);

		const entries = runtime.session.sessionManager.getEntries();
		assert.ok(
			JSON.stringify(entries).includes("carried-dispose-marker"),
			"the replacement lost the source conversation",
		);
		const disposalOrientation = entries.find(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === TRANSITION_MESSAGE_TYPE,
		);
		assert.equal(
			disposalOrientation?.type,
			"custom_message",
			"the replacement has no disposal orientation",
		);
		if (disposalOrientation?.type === "custom_message") {
			assert.doesNotMatch(
				String(disposalOrientation.content),
				/forked|shutdown/i,
				"the orientation describes a process relaunch that did not happen",
			);
		}
		const verificationEntry = entries.find(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === TRANSITION_VERIFICATION_TYPE,
		);
		assert.equal(
			verificationEntry?.type,
			"custom_message",
			"the disposal result was not persisted",
		);
		if (verificationEntry?.type !== "custom_message") return;
		const verificationDetails = verificationEntry.details as {
			verification?: {
				status?: string;
				branchDisposition?: string;
				pathDisposition?: string;
				registrationDisposition?: string;
				receiptDisposition?: string;
			};
		};
		assert.equal(verificationDetails.verification?.status, "verified");
		assert.equal(
			verificationDetails.verification?.branchDisposition,
			"deleted",
		);
		assert.equal(verificationDetails.verification?.pathDisposition, "removed");
		assert.equal(
			verificationDetails.verification?.registrationDisposition,
			"removed",
		);
		assert.equal(
			verificationDetails.verification?.receiptDisposition,
			"removed",
		);
	} finally {
		const heartbeatGlobal = globalThis as typeof globalThis & {
			__piWorktreeDisposeHeartbeat?: ReturnType<typeof setInterval>;
		};
		if (heartbeatGlobal.__piWorktreeDisposeHeartbeat) {
			clearInterval(heartbeatGlobal.__piWorktreeDisposeHeartbeat);
			delete heartbeatGlobal.__piWorktreeDisposeHeartbeat;
		}
		extraExtensionPaths = [];
		await runtime.dispose();
		process.chdir(originalProcessCwd);
	}
}

async function proveDetachedMainCanReceiveDisposal(): Promise<void> {
	const fx = fixture();
	const notices: string[] = [];
	git(fx.repo, "checkout", "--detach");
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: fx.worktree,
		agentDir: fx.agentDir,
		sessionManager: SessionManager.create(fx.worktree),
	});
	const originalProcessCwd = process.cwd();
	process.chdir(fx.worktree);

	try {
		const runner = await attach(runtime, notices);
		const command = runner.getCommand("worktree");
		assert.ok(command);
		await command.handler("dispose", runner.createCommandContext());

		assert.equal(runtime.cwd, fx.repo);
		assert.equal(process.cwd(), fx.repo);
		assert.equal(existsSync(fx.worktree), false);
		assert.throws(() =>
			git(fx.repo, "show-ref", "--verify", "refs/heads/feat/x"),
		);
		const entry = runtime.session.sessionManager
			.getEntries()
			.find(
				(candidate) =>
					candidate.type === "custom_message" &&
					candidate.customType === TRANSITION_VERIFICATION_TYPE,
			);
		assert.equal(entry?.type, "custom_message");
		if (entry?.type !== "custom_message") return;
		const details = entry.details as {
			verification?: {
				status?: string;
				expected?: { branch?: string | null };
				actual?: { branch?: string | null };
			};
		};
		assert.equal(details.verification?.status, "verified");
		assert.equal(details.verification?.expected?.branch, null);
		assert.equal(details.verification?.actual?.branch, null);
	} finally {
		await runtime.dispose();
		process.chdir(originalProcessCwd);
	}
}

async function proveUnmergedBranchSurvivesDisposal(): Promise<void> {
	const fx = fixture();
	const notices: string[] = [];
	writeFileSync(join(fx.worktree, "feature.txt"), "unmerged\n");
	git(fx.worktree, "add", "feature.txt");
	git(fx.worktree, "commit", "-m", "unmerged work");
	const commonDir = resolve(
		fx.repo,
		git(fx.repo, "rev-parse", "--git-common-dir"),
	);
	const store = createStore(commonDir);
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: fx.worktree,
		agentDir: fx.agentDir,
		sessionManager: SessionManager.create(fx.worktree),
	});
	const originalProcessCwd = process.cwd();
	process.chdir(fx.worktree);

	try {
		const runner = await attach(runtime, notices);
		const command = runner.getCommand("worktree");
		assert.ok(command);
		await command.handler("dispose", runner.createCommandContext());

		assert.equal(runtime.cwd, fx.repo);
		assert.equal(existsSync(fx.worktree), false);
		assert.doesNotThrow(() =>
			git(fx.repo, "show-ref", "--verify", "refs/heads/feat/x"),
		);
		assert.throws(() =>
			git(fx.repo, "merge-base", "--is-ancestor", "feat/x", "main"),
		);
		assert.equal(existsSync(claimPath(store, fx.worktree)), false);
		const entry = runtime.session.sessionManager
			.getEntries()
			.find(
				(candidate) =>
					candidate.type === "custom_message" &&
					candidate.customType === TRANSITION_VERIFICATION_TYPE,
			);
		assert.equal(entry?.type, "custom_message");
		if (entry?.type !== "custom_message") return;
		const details = entry.details as {
			verification?: { status?: string; branchDisposition?: string };
		};
		assert.equal(details.verification?.status, "verified");
		assert.equal(details.verification?.branchDisposition, "kept-unmerged");
	} finally {
		await runtime.dispose();
		process.chdir(originalProcessCwd);
	}
}

async function proveLandingMismatchSkipsTeardown(): Promise<void> {
	const fx = fixture();
	const notices: string[] = [];
	const mutationExtension = join(fx.root, "change-main-branch.ts");
	writeFileSync(
		mutationExtension,
		`import { execFileSync } from "node:child_process";\nexport default function (pi) {\n  pi.on("session_start", (event) => {\n    if (event.reason === "resume") execFileSync("git", ["switch", "-c", "moved-main"], { cwd: ${JSON.stringify(fx.repo)} });\n  });\n}\n`,
	);
	extraExtensionPaths = [mutationExtension];
	const commonDir = resolve(
		fx.repo,
		git(fx.repo, "rev-parse", "--git-common-dir"),
	);
	const store = createStore(commonDir);
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: fx.worktree,
		agentDir: fx.agentDir,
		sessionManager: SessionManager.create(fx.worktree),
	});
	const originalProcessCwd = process.cwd();
	process.chdir(fx.worktree);

	try {
		const runner = await attach(runtime, notices);
		const command = runner.getCommand("worktree");
		assert.ok(command);
		await command.handler("dispose", runner.createCommandContext());

		assert.equal(runtime.cwd, fx.repo);
		assert.equal(process.cwd(), fx.repo);
		assert.equal(
			git(fx.repo, "rev-parse", "--abbrev-ref", "HEAD"),
			"moved-main",
		);
		assert.equal(
			existsSync(fx.worktree),
			true,
			"a landing mismatch still removed the worktree",
		);
		assert.equal(existsSync(claimPath(store, fx.worktree)), false);
		const entry = runtime.session.sessionManager
			.getEntries()
			.find(
				(candidate) =>
					candidate.type === "custom_message" &&
					candidate.customType === TRANSITION_VERIFICATION_TYPE,
			);
		assert.equal(entry?.type, "custom_message");
		if (entry?.type !== "custom_message") return;
		const details = entry.details as {
			verification?: {
				status?: string;
				expected?: { branch?: string };
				actual?: { branch?: string };
			};
		};
		assert.equal(details.verification?.status, "mismatch");
		assert.equal(details.verification?.expected?.branch, "main");
		assert.equal(details.verification?.actual?.branch, "moved-main");
	} finally {
		extraExtensionPaths = [];
		await runtime.dispose();
		process.chdir(originalProcessCwd);
	}
}

async function proveFailedHookPersistsPartialOutcome(): Promise<void> {
	const fx = fixture();
	const notices: string[] = [];
	mkdirSync(join(fx.repo, ".pi"));
	writeFileSync(
		join(fx.repo, ".pi", "worktree.json"),
		JSON.stringify({ preRemove: ["echo hook-failed >&2; exit 42"] }),
	);
	const commonDir = resolve(
		fx.repo,
		git(fx.repo, "rev-parse", "--git-common-dir"),
	);
	const store = createStore(commonDir);
	const receipt = receiptPath(store, fx.worktree);
	mkdirSync(dirname(receipt), { recursive: true });
	writeFileSync(receipt, "retained-receipt");
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: fx.worktree,
		agentDir: fx.agentDir,
		sessionManager: SessionManager.create(fx.worktree),
	});
	const originalProcessCwd = process.cwd();
	process.chdir(fx.worktree);

	try {
		const runner = await attach(runtime, notices);
		const command = runner.getCommand("worktree");
		assert.ok(command);
		await command.handler("dispose", runner.createCommandContext());

		assert.equal(runtime.cwd, fx.repo);
		assert.equal(process.cwd(), fx.repo);
		assert.equal(existsSync(fx.worktree), true);
		assert.equal(existsSync(receipt), true, "partial teardown removed receipt");
		assert.equal(
			existsSync(claimPath(store, fx.worktree)),
			false,
			"partial teardown leaked its lifecycle claim",
		);
		const entry = runtime.session.sessionManager
			.getEntries()
			.find(
				(candidate) =>
					candidate.type === "custom_message" &&
					candidate.customType === TRANSITION_VERIFICATION_TYPE,
			);
		assert.equal(entry?.type, "custom_message");
		if (entry?.type !== "custom_message") return;
		const details = entry.details as {
			verification?: { status?: string; branchDisposition?: string };
		};
		assert.equal(details.verification?.status, "partial");
		assert.equal(details.verification?.branchDisposition, "not-attempted");
		assert.match(String(entry.content), /hook-failed/);
	} finally {
		await runtime.dispose();
		process.chdir(originalProcessCwd);
	}
}

async function proveHookCreatedStateRefuses(): Promise<void> {
	const fx = fixture();
	const notices: string[] = [];
	mkdirSync(join(fx.repo, ".pi"));
	writeFileSync(
		join(fx.repo, ".pi", "worktree.json"),
		JSON.stringify({ preRemove: ["touch late.cache"] }),
	);
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: fx.worktree,
		agentDir: fx.agentDir,
		sessionManager: SessionManager.create(fx.worktree),
	});
	const originalProcessCwd = process.cwd();
	process.chdir(fx.worktree);

	try {
		const runner = await attach(runtime, notices);
		const command = runner.getCommand("worktree");
		assert.ok(command);
		await command.handler("dispose", runner.createCommandContext());

		assert.equal(runtime.cwd, fx.repo);
		assert.equal(existsSync(fx.worktree), true);
		assert.equal(existsSync(join(fx.worktree, "late.cache")), true);
		const entry = runtime.session.sessionManager
			.getEntries()
			.find(
				(candidate) =>
					candidate.type === "custom_message" &&
					candidate.customType === TRANSITION_VERIFICATION_TYPE,
			);
		assert.equal(entry?.type, "custom_message");
		if (entry?.type !== "custom_message") return;
		const details = entry.details as {
			verification?: { status?: string; branchDisposition?: string };
		};
		assert.equal(details.verification?.status, "partial");
		assert.equal(details.verification?.branchDisposition, "not-attempted");
		assert.match(String(entry.content), /ignored inventory/);
	} finally {
		await runtime.dispose();
		process.chdir(originalProcessCwd);
	}
}

async function detachedReportCase(
	preRemove: string[],
): Promise<{ outcome?: string; pathPresent: boolean }> {
	const fx = fixture();
	const commonDir = resolve(
		fx.repo,
		git(fx.repo, "rev-parse", "--git-common-dir"),
	);
	const store = createStore(commonDir);
	const operationId =
		preRemove.length === 0 ? "detached-complete" : "detached-refused";
	const ownerFile = join(claimPath(store, fx.worktree), "owner.json");
	const receipt = receiptPath(store, fx.worktree);
	const report = reportPath(store, operationId);
	const requestFile = `${report}.request.json`;
	mkdirSync(dirname(ownerFile), { recursive: true });
	mkdirSync(dirname(receipt), { recursive: true });
	writeFileSync(
		ownerFile,
		JSON.stringify({ operationId, pid: 4242, role: "waiter" }),
	);
	writeFileSync(receipt, "retained-receipt");
	writeDetachedTeardownRequest(requestFile, {
		schemaVersion: 1,
		operationId,
		repoRoot: fx.repo,
		worktreePath: fx.worktree,
		branch: "feat/x",
		expectedDestination: { path: fx.repo, branch: "main" },
		approvedSnapshot: await inspectWorktreeSafety(fx.worktree),
		preRemove,
		ownerFile,
		receiptFile: receipt,
		reportFile: report,
	});
	await runDetachedTeardownRequest(requestFile, 4242);
	const recorded = readTeardownReport(store, operationId);
	assert.equal(recorded.kind, "present");
	return {
		outcome: recorded.kind === "present" ? recorded.report.outcome : undefined,
		pathPresent: existsSync(fx.worktree),
	};
}

async function proveDetachedReportsCompleteAndRefused(): Promise<void> {
	const complete = await detachedReportCase([]);
	assert.deepEqual(complete, { outcome: "complete", pathPresent: false });
	const refused = await detachedReportCase(["touch late.cache"]);
	assert.deepEqual(refused, { outcome: "refused", pathPresent: true });
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

await proveEnter();
await proveCancellationCleansTarget();
await proveCliFlagDoesNotReplay();
await proveSuccessorVerification();
await proveRelaunchHandoffIsConsumed();
await proveDisposeSwitchesBeforeRemoval();
await proveDetachedMainCanReceiveDisposal();
await proveUnmergedBranchSurvivesDisposal();
await proveLandingMismatchSkipsTeardown();
await proveFailedHookPersistsPartialOutcome();
await proveHookCreatedStateRefuses();
await proveDetachedReportsCompleteAndRefused();
console.log("container session-switch e2e: OK");
