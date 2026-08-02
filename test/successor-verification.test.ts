import assert from "node:assert/strict";
import {
	type TransitionHandoffV2,
	decodeTransitionHandoff,
	encodeHandoff,
	encodeTransitionHandoff,
	legacyVerification,
	transitionCaveat,
	verifyDispose,
	verifyEnter,
} from "../extensions/worktree-handoff.ts";
import type { CheckoutState } from "../extensions/worktree-transition.ts";

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

const NOW = "2026-08-02T12:00:00.000Z";
const MAIN: CheckoutState = { path: "/repo", branch: "main", kind: "main" };
const TARGET: CheckoutState = {
	path: "/repo.worktrees/feat-x",
	branch: "feat/x",
	kind: "linked",
};

function handoff(
	overrides: Partial<TransitionHandoffV2> = {},
): TransitionHandoffV2 {
	return {
		schemaVersion: 2,
		operationId: "op-1",
		kind: "enter",
		source: MAIN,
		target: TARGET,
		targetProvisioning: "ready",
		expectedReceiptHash: "hash-a",
		sessionCarry: "fork",
		uncommitted: 0,
		...overrides,
	};
}

// --- encoding ----------------------------------------------------------------

check("a v2 handoff round-trips", () => {
	const decoded = decodeTransitionHandoff(encodeTransitionHandoff(handoff()));
	assert.equal(decoded?.version, 2);
	if (decoded?.version === 2) assert.deepEqual(decoded.handoff, handoff());
});

check("S-CMP-04: a legacy payload decodes as version 1", () => {
	const decoded = decodeTransitionHandoff(
		encodeHandoff({
			parentCwd: "/repo",
			parentBranch: "main",
			uncommitted: 2,
			kind: "enter",
		}),
	);
	assert.equal(decoded?.version, 1);
	if (decoded?.version === 1) {
		assert.equal(decoded.legacy.parentCwd, "/repo");
		assert.equal(decoded.legacy.uncommitted, 2);
	}
});

check("garbage decodes to nothing", () => {
	assert.equal(decodeTransitionHandoff("not-base64-json"), null);
});

check("a v2 payload missing its receipt identity is not accepted as v2", () => {
	const broken = { ...handoff(), expectedReceiptHash: undefined };
	const decoded = decodeTransitionHandoff(
		Buffer.from(JSON.stringify(broken)).toString("base64"),
	);
	// It must not masquerade as a checkable transition.
	assert.notEqual(decoded?.version, 2);
});

check("an unmanaged handoff must not carry a receipt hash", () => {
	const contradictory = handoff({ targetProvisioning: "unmanaged" });
	const decoded = decodeTransitionHandoff(
		Buffer.from(JSON.stringify(contradictory)).toString("base64"),
	);
	assert.notEqual(decoded?.version, 2);
});

// --- verified entry ----------------------------------------------------------

check("S-TRN-06: landing exactly where planned verifies", () => {
	const v = verifyEnter(
		handoff(),
		{
			actual: TARGET,
			registrationPresent: true,
			provisioning: "ready",
			receiptHash: "hash-a",
		},
		NOW,
	);
	assert.equal(v.status, "verified");
	assert.deepEqual(v.issues, []);
	assert.equal(v.operationId, "op-1");
	assert.equal(transitionCaveat(v), "", "a verified move needs no warning");
});

check(
	"S-TRN-06: an unmanaged target verifies when it is still unmanaged",
	() => {
		const v = verifyEnter(
			handoff({
				targetProvisioning: "unmanaged",
				expectedReceiptHash: undefined,
			}),
			{ actual: TARGET, registrationPresent: true, provisioning: "unmanaged" },
			NOW,
		);
		assert.equal(v.status, "verified");
	},
);

// --- wrong destination -------------------------------------------------------

check("S-TRN-07: a different path or branch is a mismatch, not success", () => {
	for (const actual of [
		{ ...TARGET, path: "/repo.worktrees/feat-other" },
		{ ...TARGET, branch: "feat/other" },
	]) {
		const v = verifyEnter(
			handoff(),
			{
				actual,
				registrationPresent: true,
				provisioning: "ready",
				receiptHash: "hash-a",
			},
			NOW,
		);
		assert.equal(v.status, "mismatch", JSON.stringify(actual));
		assert.ok(v.issues.includes("target-conflict"));
		assert.match(transitionCaveat(v), /did NOT land as planned/);
		assert.match(transitionCaveat(v), /Do NOT assume/);
	}
});

check("S-TRN-07: an unregistered target is a mismatch", () => {
	const v = verifyEnter(
		handoff(),
		{
			actual: TARGET,
			registrationPresent: false,
			provisioning: "ready",
			receiptHash: "hash-a",
		},
		NOW,
	);
	assert.equal(v.status, "mismatch");
	assert.ok(v.issues.includes("target-not-found"));
	assert.equal(v.registrationDisposition, "removed");
});

// --- provisioning identity ---------------------------------------------------

check(
	"S-TRN-09: a ready target whose receipt vanished is never downgraded",
	() => {
		const v = verifyEnter(
			handoff(),
			{ actual: TARGET, registrationPresent: true, provisioning: "unmanaged" },
			NOW,
		);
		assert.equal(v.status, "mismatch");
		assert.ok(v.issues.includes("target-not-ready"));
		assert.equal(v.actualProvisioning, "unmanaged");
		assert.equal(v.expectedProvisioning, "ready");
	},
);

check(
	"S-TRN-09: a replaced receipt is a mismatch even if it still reads ready",
	() => {
		const v = verifyEnter(
			handoff(),
			{
				actual: TARGET,
				registrationPresent: true,
				provisioning: "ready",
				receiptHash: "hash-b",
			},
			NOW,
		);
		assert.equal(v.status, "mismatch");
		assert.ok(v.issues.includes("target-not-ready"));
	},
);

check("S-TRN-09: a corrupt receipt is reported as corrupt", () => {
	const v = verifyEnter(
		handoff(),
		{ actual: TARGET, registrationPresent: true, provisioning: "corrupt" },
		NOW,
	);
	assert.equal(v.status, "mismatch");
	assert.ok(v.issues.includes("receipt-corrupt"));
});

// --- legacy payloads ---------------------------------------------------------

check("S-TRN-10: a legacy transition is explicitly unverified", () => {
	const v = legacyVerification(TARGET, NOW, "enter");
	assert.equal(v.status, "legacy-unverified");
	assert.equal(
		v.expected,
		undefined,
		"there was never an expected target to check",
	);
	assert.deepEqual(v.issues, []);
	assert.equal(
		transitionCaveat(v),
		"",
		"unverifiable is not the same as wrong",
	);
});

// --- disposal outcomes -------------------------------------------------------

const disposeHandoff = handoff({
	kind: "dispose",
	source: TARGET,
	target: MAIN,
	targetProvisioning: "unmanaged",
	expectedReceiptHash: undefined,
	dispose: { removedPath: TARGET.path, branch: "feat/x" },
});

function observed(
	overrides: Partial<Parameters<typeof verifyDispose>[1]> = {},
) {
	return {
		actual: MAIN,
		pathPresent: false,
		registrationPresent: false,
		receiptPresent: false,
		branchDisposition: "deleted" as const,
		reportPresent: true,
		...overrides,
	};
}

check("S-DSP-09: a complete teardown verifies", () => {
	const v = verifyDispose(disposeHandoff, observed(), NOW);
	assert.equal(v.status, "verified");
	assert.deepEqual(v.issues, []);
	assert.equal(v.pathDisposition, "removed");
	assert.equal(transitionCaveat(v), "");
});

check("S-DSP-07: a retained unmerged branch is success, not failure", () => {
	const v = verifyDispose(
		disposeHandoff,
		observed({ branchDisposition: "kept-unmerged" }),
		NOW,
	);
	assert.equal(v.status, "verified");
	assert.equal(v.branchDisposition, "kept-unmerged");
});

check("S-DSP-08: a merged branch that survived is partial", () => {
	const v = verifyDispose(
		disposeHandoff,
		observed({ branchDisposition: "delete-failed" }),
		NOW,
	);
	assert.equal(v.status, "partial");
	assert.ok(v.issues.includes("dispose-partial"));
	assert.match(transitionCaveat(v), /did not fully complete/);
});

check("S-DSP-05: a surviving worktree is partial", () => {
	for (const residue of [
		{ pathPresent: true },
		{ registrationPresent: true },
	]) {
		const v = verifyDispose(disposeHandoff, observed(residue), NOW);
		assert.equal(v.status, "partial", JSON.stringify(residue));
		assert.match(transitionCaveat(v), /finish the cleanup manually/);
	}
});

check("a leftover receipt after successful removal is partial", () => {
	const v = verifyDispose(
		disposeHandoff,
		observed({ receiptPresent: true }),
		NOW,
	);
	assert.equal(v.status, "partial");
	assert.equal(v.receiptDisposition, "present");
});

// --- missing teardown evidence -----------------------------------------------

check(
	"S-DSP-19: a missing teardown report is partial, never assumed success",
	() => {
		const v = verifyDispose(
			disposeHandoff,
			observed({ reportPresent: false }),
			NOW,
		);
		assert.equal(v.status, "partial");
		assert.ok(v.issues.includes("dispose-partial"));
	},
);

// --- destination mismatch ----------------------------------------------------

check("S-DSP-14: landing on an unexpected destination is a mismatch", () => {
	const v = verifyDispose(
		disposeHandoff,
		observed({ actual: { ...MAIN, branch: "release/9" } }),
		NOW,
	);
	assert.equal(v.status, "mismatch");
	assert.ok(v.issues.includes("target-conflict"));
	assert.match(transitionCaveat(v), /did NOT land as planned/);
});

if (fail > 0) {
	console.error(`successor verification tests: ${fail} FAILED of ${total}`);
	process.exit(1);
}
console.log(`successor verification tests: OK (${total} cases)`);
