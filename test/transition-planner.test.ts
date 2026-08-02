import assert from "node:assert/strict";
import {
	type BranchResolver,
	type CheckoutState,
	type ExecutionFacts,
	buildDetails,
	decidePendingToolCall,
	orderedBranchCandidates,
	selectExecution,
	sessionCarryFor,
	validateTransitionRequest,
} from "../extensions/worktree-transition.ts";

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

const MAIN: CheckoutState = { path: "/repo", branch: "main", kind: "main" };

const capable: ExecutionFacts = {
	execution: "auto",
	mode: "tui",
	piCompatible: true,
	transportAvailable: true,
	alreadyAtTarget: false,
	activeTurn: true,
	sessionFileReadable: true,
};

// --- S-REQ-02: create with both selectors is refused -----------------------

check("S-REQ-02: create with both name and branch is invalid", () => {
	const r = validateTransitionRequest({
		origin: "model",
		intent: "create",
		name: "my-feature",
		branch: "feat/other",
	});
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.equal(r.error.code, "invalid-request");
		assert.match(r.error.reason, /either name or branch/);
	}
});

check("S-REQ-02: create with only one selector is accepted", () => {
	for (const req of [
		{ origin: "model" as const, intent: "create" as const, name: "my-feature" },
		{ origin: "model" as const, intent: "create" as const, branch: "feat/x" },
	]) {
		assert.equal(validateTransitionRequest(req).ok, true);
	}
});

// --- S-REQ-03: enter rejects base ------------------------------------------

check("S-REQ-03: enter with base is invalid", () => {
	const r = validateTransitionRequest({
		origin: "model",
		intent: "enter",
		name: "feat/x",
		base: "origin/main",
	});
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error.reason, /base is only valid for create/);
});

check("S-REQ-03: dispose with base is invalid", () => {
	const r = validateTransitionRequest({
		origin: "model",
		intent: "dispose",
		name: "feat/x",
		base: "HEAD",
	});
	assert.equal(r.ok, false);
});

check("S-REQ-03: create keeps base", () => {
	const r = validateTransitionRequest({
		origin: "model",
		intent: "create",
		name: "x",
		base: "origin/main",
	});
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.request.base, "origin/main");
});

// --- S-REQ-07: enter requires a selector ------------------------------------

check("S-REQ-07: enter with no selector is invalid", () => {
	const r = validateTransitionRequest({ origin: "model", intent: "enter" });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error.reason, /requires a name or branch/);
});

check("S-REQ-07: blank selector counts as absent", () => {
	const r = validateTransitionRequest({
		origin: "model",
		intent: "enter",
		name: "   ",
	});
	assert.equal(r.ok, false);
});

// --- S-REQ-08: dispose rejects both selectors -------------------------------

check("S-REQ-08: dispose with both name and branch is invalid", () => {
	const r = validateTransitionRequest({
		origin: "model",
		intent: "dispose",
		name: "x",
		branch: "feat/y",
	});
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.code, "invalid-request");
});

check(
	"S-REQ-08: selectorless dispose is allowed and marked selectorless",
	() => {
		const r = validateTransitionRequest({ origin: "model", intent: "dispose" });
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.request.selectorless, true);
	},
);

// --- status is inspection only ----------------------------------------------

check("status refuses selectors, base, and execution", () => {
	for (const extra of [
		{ name: "x" },
		{ branch: "feat/x" },
		{ base: "HEAD" },
		{ execution: "recamp" as const },
	]) {
		const r = validateTransitionRequest({
			origin: "model",
			intent: "status",
			...extra,
		});
		assert.equal(r.ok, false, JSON.stringify(extra));
	}
	assert.equal(
		validateTransitionRequest({ origin: "model", intent: "status" }).ok,
		true,
	);
});

check("execution defaults per origin", () => {
	const model = validateTransitionRequest({
		origin: "model",
		intent: "create",
	});
	const slash = validateTransitionRequest({
		origin: "slash",
		intent: "create",
	});
	const startup = validateTransitionRequest({
		origin: "startup",
		intent: "ensure",
	});
	assert.equal(model.ok && model.request.execution, "auto");
	assert.equal(slash.ok && slash.request.execution, "recamp");
	assert.equal(startup.ok && startup.request.execution, "recamp");
});

check("unknown execution is refused", () => {
	const r = validateTransitionRequest({
		origin: "model",
		intent: "enter",
		name: "x",
		execution: "teleport" as never,
	});
	assert.equal(r.ok, false);
});

// --- S-REQ-06 support: paths never implies a process move -------------------

check("S-REQ-06: paths keeps the process where it is", () => {
	const decision = selectExecution({ ...capable, execution: "paths" });
	assert.deepEqual(decision, { kind: "path-target" });
	const details = buildDetails({
		action: "enter",
		outcome: "path-target",
		process: MAIN,
		target: {
			path: "/repo.worktrees/feat-x",
			branch: "feat/x",
			kind: "linked",
		},
		requestedExecution: "paths",
	});
	assert.equal(details.sessionMode, "path-target");
	assert.equal(details.requiresAbsolutePaths, true);
	assert.equal(details.process.path, "/repo");
});

check("paths dispose requires an explicit remote target", () => {
	const r = validateTransitionRequest({
		origin: "model",
		intent: "dispose",
		execution: "paths",
	});
	assert.equal(r.ok, false);
});

// --- S-CAP-06 / 07 / 08: fallback selection ---------------------------------

check("S-CAP-06: headless auto selects path targeting", () => {
	for (const mode of ["rpc", "json", "print"] as const) {
		assert.deepEqual(
			selectExecution({ ...capable, mode, transportAvailable: false }),
			{ kind: "path-target" },
			mode,
		);
	}
});

check("S-CAP-07: forced recamp never degrades to paths", () => {
	for (const mode of ["rpc", "json", "print"] as const) {
		const d = selectExecution({
			...capable,
			mode,
			execution: "recamp",
			transportAvailable: false,
		});
		assert.equal(d.kind, "manual-restart", mode);
	}
});

check(
	"S-CAP-08: active turn without a session file cannot auto re-camp",
	() => {
		const d = selectExecution({ ...capable, sessionFileReadable: false });
		assert.deepEqual(d, {
			kind: "manual-restart",
			code: "session-unavailable",
		});
	},
);

check("S-CAP-08: an idle session may start fresh", () => {
	const facts = { ...capable, activeTurn: false, sessionFileReadable: false };
	const d = selectExecution(facts);
	assert.equal(d.kind, "recamp");
	assert.equal(sessionCarryFor(d, facts), "fresh");
});

check("capable TUI re-camps and carries the session", () => {
	const d = selectExecution(capable);
	assert.equal(d.kind, "recamp");
	assert.equal(sessionCarryFor(d, capable), "fork");
});

check("already-active short-circuits every preference", () => {
	for (const execution of ["auto", "recamp", "paths"] as const) {
		assert.deepEqual(
			selectExecution({ ...capable, execution, alreadyAtTarget: true }),
			{ kind: "already-active" },
		);
	}
});

check("an incompatible Pi disables automatic re-camp", () => {
	const d = selectExecution({ ...capable, piCompatible: false });
	assert.deepEqual(d, {
		kind: "manual-restart",
		code: "unsupported-pi-version",
	});
	const headless = selectExecution({
		...capable,
		piCompatible: false,
		mode: "print",
	});
	assert.deepEqual(headless, { kind: "path-target" });
});

check("TUI without a probed transport reports manual restart", () => {
	const d = selectExecution({ ...capable, transportAvailable: false });
	assert.deepEqual(d, {
		kind: "manual-restart",
		code: "transport-unavailable",
	});
});

// --- candidate ordering ------------------------------------------------------

const resolver: BranchResolver = {
	resolve: (input) => (input.includes("/") ? input : `feat/${input}`),
	isValidExplicit: (branch) => !branch.includes(" "),
};

check("literal input outranks its conventional resolution", () => {
	const r = validateTransitionRequest({
		origin: "model",
		intent: "enter",
		name: "foo",
	});
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.deepEqual(orderedBranchCandidates(r.request, resolver), [
			"foo",
			"feat/foo",
		]);
	}
});

check("an exact branch is the only candidate", () => {
	const r = validateTransitionRequest({
		origin: "model",
		intent: "enter",
		branch: "release/2.0",
	});
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.deepEqual(orderedBranchCandidates(r.request, resolver), [
			"release/2.0",
		]);
	}
});

check("an unsafe explicit branch yields no candidates", () => {
	const r = validateTransitionRequest({
		origin: "model",
		intent: "enter",
		branch: "bad branch",
	});
	assert.equal(r.ok, true);
	if (r.ok) assert.deepEqual(orderedBranchCandidates(r.request, resolver), []);
});

check("candidates do not duplicate an already-conventional name", () => {
	const r = validateTransitionRequest({
		origin: "model",
		intent: "enter",
		name: "feat/foo",
	});
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.deepEqual(orderedBranchCandidates(r.request, resolver), [
			"feat/foo",
		]);
	}
});

// --- pending guard -----------------------------------------------------------

check("no pending transition allows every tool", () => {
	assert.deepEqual(
		decidePendingToolCall({ toolName: "bash", pending: false }),
		{ allow: true },
	);
});

check("a pending transition blocks even read-only tools", () => {
	for (const toolName of ["bash", "read", "grep", "edit", "some_other_tool"]) {
		const d = decidePendingToolCall({ toolName, pending: true });
		assert.equal(d.allow, false, toolName);
		if (!d.allow) assert.equal(d.code, "transition-pending");
	}
});

check(
	"a pending transition still allows exactly worktree_session status",
	() => {
		assert.deepEqual(
			decidePendingToolCall({
				toolName: "worktree_session",
				action: "status",
				pending: true,
			}),
			{ allow: true },
		);
		const another = decidePendingToolCall({
			toolName: "worktree_session",
			action: "enter",
			pending: true,
		});
		assert.equal(another.allow, false);
	},
);

// --- envelope invariants ------------------------------------------------------

check("scheduled relaunch is reported as pending, not active", () => {
	const d = buildDetails({
		action: "enter",
		outcome: "relaunch-scheduled",
		process: MAIN,
		transport: "herdr",
	});
	assert.equal(d.sessionMode, "relaunch-pending");
	assert.equal(d.requiresAbsolutePaths, false);
	assert.equal(d.remoteProcessLiveness, "not-applicable");
	assert.equal("ok" in d, false);
});

check("transport is always present on a finalized outcome", () => {
	const d = buildDetails({
		action: "create",
		outcome: "manual-restart",
		process: MAIN,
	});
	assert.equal(d.transport, "none");
});

if (fail > 0) {
	console.error(`transition planner tests: ${fail} FAILED of ${total}`);
	process.exit(1);
}
console.log(`transition planner tests: OK (${total} cases)`);
