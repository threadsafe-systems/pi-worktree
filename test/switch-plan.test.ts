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
	materializeTargetSession,
	planTargetSession,
	readSourceState,
	type SourceSessionState,
	TRANSITION_MESSAGE_TYPE,
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

function state(
	overrides: Partial<SourceSessionState> = {},
): SourceSessionState {
	return {
		sessionFile: "/sessions/a.jsonl",
		flushed: true,
		persistedLeafId: "leaf-1",
		activeLeafId: "leaf-1",
		totalEntryCount: 3,
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
	assert.deepEqual(planTargetSession(state({ totalEntryCount: 0 })), {
		kind: "empty",
	});
	assert.deepEqual(
		planTargetSession(state({ totalEntryCount: 0, flushed: false })),
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
	assert.deepEqual(planTargetSession(state({ persistedLeafId: "leaf-9" })), {
		kind: "entries",
		reason: "stale-leaf",
	});
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
	assert.ok(observed.totalEntryCount > 0);
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
		entries: sm.getEntries(),
		expectedLeafId: observed.activeLeafId,
		sessionDir: fx.sessionDir,
		orientation: { content: "orientation" },
	});

	const written = SessionManager.open(file);
	assert.equal(written.getCwd(), fx.worktree);
	assert.equal(written.getLeafEntry()?.parentId, sm.getLeafId());
	assert.ok(JSON.stringify(written.getEntries()).includes("carried-marker"));
});

check("orientation is persisted after the carried conversation", () => {
	const fx = fixture();
	const sm = SessionManager.create(fx.repo, fx.sessionDir);
	sm.appendMessage({ role: "user", content: "carried-marker" } as never);
	const sourceLeaf = sm.getLeafId();

	const observed = readSourceState(sm);
	const file = materializeTargetSession({
		plan: planTargetSession(observed),
		targetCwd: fx.worktree,
		entries: sm.getEntries(),
		expectedLeafId: observed.activeLeafId,
		sessionDir: fx.sessionDir,
		orientation: {
			content: "moved-to-worktree-marker",
			details: { targetCwd: fx.worktree },
		},
	});

	const written = SessionManager.open(file);
	const leaf = written.getLeafEntry();
	assert.equal(leaf?.type, "custom_message");
	if (leaf?.type !== "custom_message") return;
	assert.equal(leaf.customType, TRANSITION_MESSAGE_TYPE);
	assert.equal(leaf.content, "moved-to-worktree-marker");
	assert.equal(leaf.display, true);
	assert.deepEqual(leaf.details, { targetCwd: fx.worktree });
	assert.equal(leaf.parentId, sourceLeaf);
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
		entries: sm.getEntries(),
		expectedLeafId: observed.activeLeafId,
		sessionDir: fx.sessionDir,
		orientation: { content: "orientation" },
	});

	const written = SessionManager.open(file);
	assert.equal(written.getCwd(), fx.worktree);
	const carried = JSON.stringify(written.getEntries());
	assert.ok(carried.includes("carried-marker"));
	assert.ok(carried.includes("reply-marker"));
});

check("an empty session attaches orientation at the root", () => {
	const fx = fixture();
	const sm = SessionManager.create(fx.repo, fx.sessionDir);

	const observed = readSourceState(sm);
	const file = materializeTargetSession({
		plan: planTargetSession(observed),
		targetCwd: fx.worktree,
		entries: sm.getEntries(),
		expectedLeafId: observed.activeLeafId,
		sessionDir: fx.sessionDir,
		orientation: { content: "orientation" },
	});

	const written = SessionManager.open(file);
	assert.equal(written.getCwd(), fx.worktree);
	assert.equal(written.getEntries().length, 1);
	assert.equal(written.getLeafEntry()?.parentId, null);
});

check("a reset leaf preserves the whole tree beside root orientation", () => {
	const fx = fixture();
	const sm = SessionManager.create(fx.repo, fx.sessionDir);
	sm.appendMessage({ role: "user", content: "first-user" } as never);
	sm.appendMessage({ role: "assistant", content: "first-assistant" } as never);
	sm.appendMessage({ role: "user", content: "second-user" } as never);
	sm.appendMessage({ role: "assistant", content: "second-assistant" } as never);
	sm.resetLeaf();

	const observed = readSourceState(sm);
	assert.equal(observed.totalEntryCount, 4);
	assert.equal(observed.activeLeafId, null);
	assert.deepEqual(planTargetSession(observed), {
		kind: "entries",
		reason: "stale-leaf",
	});

	const file = materializeTargetSession({
		plan: planTargetSession(observed),
		targetCwd: fx.worktree,
		entries: sm.getEntries(),
		expectedLeafId: null,
		sessionDir: fx.sessionDir,
		orientation: { content: "root-orientation" },
	});
	const written = SessionManager.open(file);
	const serialized = JSON.stringify(written.getEntries());
	assert.match(serialized, /first-user/);
	assert.match(serialized, /second-assistant/);
	assert.equal(written.getLeafEntry()?.parentId, null);
});

check("a rewound leaf preserves sibling entries", () => {
	const fx = fixture();
	const sm = SessionManager.create(fx.repo, fx.sessionDir);
	sm.appendMessage({ role: "user", content: "first-user" } as never);
	sm.appendMessage({ role: "assistant", content: "selected-parent" } as never);
	const selectedLeaf = sm.getLeafId();
	sm.appendMessage({ role: "user", content: "abandoned-user" } as never);
	sm.appendMessage({
		role: "assistant",
		content: "abandoned-assistant",
	} as never);
	assert.ok(selectedLeaf);
	sm.branch(selectedLeaf);

	const observed = readSourceState(sm);
	const file = materializeTargetSession({
		plan: planTargetSession(observed),
		targetCwd: fx.worktree,
		entries: sm.getEntries(),
		expectedLeafId: selectedLeaf,
		sessionDir: fx.sessionDir,
		orientation: { content: "rewound-orientation" },
	});
	const written = SessionManager.open(file);
	assert.match(JSON.stringify(written.getEntries()), /abandoned-assistant/);
	assert.equal(written.getLeafEntry()?.parentId, selectedLeaf);
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
				entries: sm.getEntries(),
				expectedLeafId: "a-leaf-the-entries-do-not-end-on",
				sessionDir: fx.sessionDir,
				orientation: { content: "orientation" },
			}),
		/does not contain the active leaf/,
	);
});

check("a trailing separator on the target is not a mismatch", () => {
	const fx = fixture();
	const sm = SessionManager.create(fx.repo, fx.sessionDir);
	sm.appendMessage({ role: "user", content: "x" } as never);

	const file = materializeTargetSession({
		plan: { kind: "entries", reason: "unflushed" },
		targetCwd: `${fx.worktree}${sep}`,
		entries: sm.getEntries(),
		expectedLeafId: sm.getLeafId(),
		sessionDir: fx.sessionDir,
		orientation: { content: "orientation" },
	});

	assert.equal(SessionManager.open(file).getCwd(), fx.worktree);
});

if (fail > 0) {
	console.error(`switch plan tests: ${fail} of ${total} FAILED`);
	process.exit(1);
}
console.log(`switch plan tests: OK (${total} cases)`);
