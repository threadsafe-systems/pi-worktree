/**
 * Choosing how to build the session document for a target checkout.
 *
 * The interesting cases are the ones where the session file on disk disagrees
 * with the session in memory: pi buffers entries until an assistant message
 * arrives, and navigating the session tree moves the active leaf without
 * rewriting the file. Forking is only correct when the two agree.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	inProcessSwitchEnabled,
	materializeTargetSession,
	planTargetSession,
	readSourceState,
	type SourceSessionState,
} from "../extensions/worktree-switch.ts";

let fail = 0;
let total = 0;
const check = (name: string, fn: () => void) => {
	total++;
	try {
		fn();
	} catch (e) {
		fail++;
		console.error(`FAIL: ${name}\n  ${(e as Error).message}`);
	}
};

function state(overrides: Partial<SourceSessionState> = {}): SourceSessionState {
	return {
		sessionFile: "/sessions/a.jsonl",
		flushed: true,
		persistedLeafId: "leaf-1",
		activeLeafId: "leaf-1",
		entryCount: 3,
		...overrides,
	};
}

check("a flushed file that agrees with the session is forked", () => {
	assert.deepEqual(planTargetSession(state()), {
		kind: "fork",
		source: "/sessions/a.jsonl",
	});
});

check("a session with nothing to carry produces an empty target", () => {
	assert.deepEqual(planTargetSession(state({ entryCount: 0 })), {
		kind: "empty",
	});
	assert.deepEqual(
		planTargetSession(state({ entryCount: 0, flushed: false })),
		{ kind: "empty" },
	);
});

check("a turn still in flight is carried by its entries, not its file", () => {
	assert.deepEqual(planTargetSession(state({ flushed: false })), {
		kind: "entries",
		reason: "unflushed",
	});
});

check("a session with no file at all is carried by its entries", () => {
	assert.deepEqual(
		planTargetSession(state({ sessionFile: undefined, flushed: false })),
		{ kind: "entries", reason: "unflushed" },
	);
});

check("a file whose leaf is ahead of the session is not forked", () => {
	assert.deepEqual(
		planTargetSession(state({ persistedLeafId: "leaf-9" })),
		{ kind: "entries", reason: "stale-leaf" },
	);
});

check("the in-process switch is off unless asked for", () => {
	assert.equal(inProcessSwitchEnabled({}), false);
	assert.equal(inProcessSwitchEnabled({ PI_WT_SWITCH: "" }), false);
	assert.equal(inProcessSwitchEnabled({ PI_WT_SWITCH: "0" }), false);
	assert.equal(inProcessSwitchEnabled({ PI_WT_SWITCH: "true" }), false);
	assert.equal(inProcessSwitchEnabled({ PI_WT_SWITCH: "1" }), true);
});

// --- against real session files -------------------------------------------

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-plan-")));
	const repo = join(root, "repo");
	mkdirSync(repo);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "test@example.invalid");
	git(repo, "config", "user.name", "test");
	writeFileSync(join(repo, "a.txt"), "a\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "init");
	const worktree = join(root, "wt");
	git(repo, "worktree", "add", "-b", "feat/x", worktree);
	const sessionDir = join(root, "sessions");
	mkdirSync(sessionDir);
	return { repo, worktree, sessionDir };
}

check("an unflushed session reports itself as such", () => {
	const fx = fixture();
	const sm = SessionManager.create(fx.repo, fx.sessionDir);
	sm.appendMessage({ role: "user", content: "in flight" } as never);

	const observed = readSourceState(sm);
	assert.equal(observed.flushed, false);
	assert.equal(observed.persistedLeafId, null);
	assert.equal(observed.activeLeafId, sm.getLeafId());
	assert.ok(observed.entryCount > 0);
	assert.equal(planTargetSession(observed).kind, "entries");
});

check("an unflushed conversation reaches the target intact", () => {
	const fx = fixture();
	const sm = SessionManager.create(fx.repo, fx.sessionDir);
	sm.appendMessage({ role: "user", content: "carried-marker" } as never);

	const observed = readSourceState(sm);
	const file = materializeTargetSession({
		plan: planTargetSession(observed),
		targetCwd: fx.worktree,
		entries: sm.getBranch(),
		expectedLeafId: observed.activeLeafId,
		sessionDir: fx.sessionDir,
	});

	const written = SessionManager.open(file);
	assert.equal(written.getCwd(), fx.worktree);
	assert.equal(written.getLeafId(), sm.getLeafId());
	assert.ok(JSON.stringify(written.getEntries()).includes("carried-marker"));
});

check("a flushed conversation reaches the target intact", () => {
	const fx = fixture();
	const sm = SessionManager.create(fx.repo, fx.sessionDir);
	sm.appendMessage({ role: "user", content: "carried-marker" } as never);
	sm.appendMessage({ role: "assistant", content: "reply-marker" } as never);

	const observed = readSourceState(sm);
	assert.equal(observed.flushed, true);
	assert.equal(planTargetSession(observed).kind, "fork");

	const file = materializeTargetSession({
		plan: planTargetSession(observed),
		targetCwd: fx.worktree,
		entries: sm.getBranch(),
		expectedLeafId: observed.activeLeafId,
		sessionDir: fx.sessionDir,
	});

	const written = SessionManager.open(file);
	assert.equal(written.getCwd(), fx.worktree);
	const carried = JSON.stringify(written.getEntries());
	assert.ok(carried.includes("carried-marker"));
	assert.ok(carried.includes("reply-marker"));
});

check("an empty session yields a target with no entries", () => {
	const fx = fixture();
	const sm = SessionManager.create(fx.repo, fx.sessionDir);

	const observed = readSourceState(sm);
	const file = materializeTargetSession({
		plan: planTargetSession(observed),
		targetCwd: fx.worktree,
		entries: sm.getBranch(),
		expectedLeafId: observed.activeLeafId,
		sessionDir: fx.sessionDir,
	});

	const written = SessionManager.open(file);
	assert.equal(written.getCwd(), fx.worktree);
	assert.equal(written.getEntries().length, 0);
	assert.equal(written.getLeafId(), null);
});

check("a target that does not resume the active branch is refused", () => {
	const fx = fixture();
	const sm = SessionManager.create(fx.repo, fx.sessionDir);
	sm.appendMessage({ role: "user", content: "x" } as never);

	assert.throws(
		() =>
			materializeTargetSession({
				plan: { kind: "entries", reason: "unflushed" },
				targetCwd: fx.worktree,
				entries: sm.getBranch(),
				expectedLeafId: "a-leaf-the-entries-do-not-end-on",
				sessionDir: fx.sessionDir,
			}),
		/does not resume the active branch/,
	);
});

check("a trailing separator on the target is not a mismatch", () => {
	const fx = fixture();
	const sm = SessionManager.create(fx.repo, fx.sessionDir);
	sm.appendMessage({ role: "user", content: "x" } as never);

	const file = materializeTargetSession({
		plan: { kind: "entries", reason: "unflushed" },
		targetCwd: `${fx.worktree}${sep}`,
		entries: sm.getBranch(),
		expectedLeafId: sm.getLeafId(),
		sessionDir: fx.sessionDir,
	});

	assert.equal(SessionManager.open(file).getCwd(), fx.worktree);
});

if (fail > 0) {
	console.error(`switch plan tests: ${fail} of ${total} FAILED`);
	process.exit(1);
}
console.log(`switch plan tests: OK (${total} cases)`);
