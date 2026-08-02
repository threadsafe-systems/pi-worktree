import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ClaimOwner,
	acquireClaim,
	advanceReceipt,
	canDiscardStaleReceipt,
	canonicalJson,
	classifyProvisioning,
	configDigest,
	createStore,
	failedReceipt,
	newReceipt,
	readReceipt,
	readTeardownReport,
	readyReceipt,
	receiptHash,
	receiptPath,
	releaseClaim,
	removeReceipt,
	transferClaim,
	verifyClaim,
	writeReceipt,
	writeTeardownReport,
} from "../extensions/worktree-receipt.ts";

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

const HERE = dirname(fileURLToPath(import.meta.url));

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(path: string, timeoutMs: number): boolean {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return true;
		sleepSync(25);
	}
	return false;
}

function freshStore() {
	const dir = mkdtempSync(join(tmpdir(), "pi-wt-receipt-"));
	return { store: createStore(join(dir, ".git")), dir };
}

function owner(
	operationId = "op-1",
	role: "origin" | "waiter" = "origin",
): ClaimOwner {
	return { operationId, pid: process.pid, role };
}

function claimed(
	store: ReturnType<typeof createStore>,
	target: string,
	o: ClaimOwner,
) {
	const result = acquireClaim(store, target, o);
	assert.equal(result.ok, true, "expected claim acquisition to succeed");
	return o;
}

const TARGET = "/repo.worktrees/feat-x";

function seedReceipt(o: ClaimOwner) {
	return newReceipt({
		operationId: o.operationId,
		branch: "feat/x",
		worktreePath: TARGET,
		base: "HEAD",
		configDigest: configDigest({ postCreate: ["npm install"] }),
	});
}

// --- canonical encoding -----------------------------------------------------

check("canonical JSON is key-order independent", () => {
	assert.equal(
		canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
		canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
	);
});

check("receipt hash ignores formatting, not content", () => {
	const { store, dir } = freshStore();
	const o = claimed(store, TARGET, owner());
	const receipt = seedReceipt(o);
	assert.equal(receiptHash(receipt), receiptHash({ ...receipt }));
	assert.notEqual(
		receiptHash(receipt),
		receiptHash({ ...receipt, branch: "feat/y" }),
	);
	assert.ok(dir);
});

check("config digest covers hooks and env linking only", () => {
	const a = configDigest({ postCreate: ["npm install"], linkEnvFiles: true });
	assert.equal(
		a,
		configDigest({ linkEnvFiles: true, postCreate: ["npm install"] }),
	);
	assert.notEqual(
		a,
		configDigest({ postCreate: ["npm ci"], linkEnvFiles: true }),
	);
	assert.notEqual(
		a,
		configDigest({ postCreate: ["npm install"], linkEnvFiles: false }),
	);
	// linkEnvFiles defaults to true, matching the loader's default.
	assert.equal(a, configDigest({ postCreate: ["npm install"] }));
});

// --- S-PRO-01 / 02: durable intent before mutation, ready only at the end ----

check(
	"S-PRO-01: provisioning intent is durable before any git mutation",
	() => {
		const { store } = freshStore();
		const o = claimed(store, TARGET, owner());
		const receipt = seedReceipt(o);
		assert.equal(writeReceipt(store, o, receipt).ok, true);
		const read = readReceipt(store, TARGET);
		assert.equal(read.kind, "present");
		if (read.kind === "present") {
			assert.equal(read.receipt.state, "provisioning");
			assert.equal(read.receipt.stage, "git-worktree-add");
		}
		assert.equal(
			classifyProvisioning(read, { worktreePath: TARGET }),
			"provisioning",
		);
	},
);

check("S-PRO-02: ready is only reachable after the last stage", () => {
	const { store } = freshStore();
	const o = claimed(store, TARGET, owner());
	let receipt = seedReceipt(o);
	writeReceipt(store, o, receipt);
	for (const stage of ["link-env", "post-create"] as const) {
		receipt = advanceReceipt(
			receipt,
			stage,
			stage === "post-create" ? 0 : undefined,
		);
		writeReceipt(store, o, receipt);
		assert.notEqual(readReceipt(store, TARGET).kind, "absent");
		assert.equal(
			classifyProvisioning(readReceipt(store, TARGET), {
				worktreePath: TARGET,
			}),
			"provisioning",
			stage,
		);
	}
	writeReceipt(store, o, readyReceipt(receipt));
	assert.equal(
		classifyProvisioning(readReceipt(store, TARGET), { worktreePath: TARGET }),
		"ready",
	);
});

// --- S-PRO-03: a failed hook is recorded with its index ---------------------

check("S-PRO-03: a failed post-create hook records stage and index", () => {
	const { store } = freshStore();
	const o = claimed(store, TARGET, owner());
	const receipt = advanceReceipt(seedReceipt(o), "post-create", 1);
	writeReceipt(
		store,
		o,
		failedReceipt(receipt, { code: "hook-failed", exitCode: 2 }),
	);
	const read = readReceipt(store, TARGET);
	assert.equal(read.kind, "present");
	if (read.kind === "present") {
		assert.equal(read.receipt.state, "failed");
		assert.equal(read.receipt.stage, "post-create");
		assert.equal(read.receipt.postCreateIndex, 1);
		assert.equal(read.receipt.failure?.code, "hook-failed");
	}
	assert.equal(classifyProvisioning(read, { worktreePath: TARGET }), "failed");
});

// --- S-PRO-04: a crash leaves non-ready state -------------------------------

check(
	"S-PRO-04: an interrupted provisioning stays non-ready for a new process",
	() => {
		const { store, dir } = freshStore();
		const o = claimed(store, TARGET, owner());
		writeReceipt(store, o, seedReceipt(o));
		// A fresh store handle models a later process with no in-memory state.
		const reopened = createStore(join(dir, ".git"));
		const state = classifyProvisioning(readReceipt(reopened, TARGET), {
			worktreePath: TARGET,
		});
		assert.equal(state, "provisioning");
		assert.notEqual(state, "ready");
	},
);

// --- S-PRO-05: no receipt means unmanaged, not failed -----------------------

check("S-PRO-05: a receipt-less checkout classifies as unmanaged", () => {
	const { store } = freshStore();
	assert.equal(
		classifyProvisioning(readReceipt(store, TARGET), { worktreePath: TARGET }),
		"unmanaged",
	);
});

// --- S-PRO-06: corrupt receipts fail closed ---------------------------------

check(
	"S-PRO-06: invalid JSON, unknown schema, and mismatches are corrupt",
	() => {
		const { store } = freshStore();
		const o = claimed(store, TARGET, owner());
		const file = receiptPath(store, TARGET);
		mkdirSync(dirname(file), { recursive: true });

		writeFileSync(file, "{not json");
		assert.equal(readReceipt(store, TARGET).kind, "corrupt");

		writeFileSync(
			file,
			canonicalJson({ ...seedReceipt(o), schemaVersion: 99 }),
		);
		assert.equal(readReceipt(store, TARGET).kind, "corrupt");

		// Ready without a complete stage is an impossible combination.
		writeFileSync(file, canonicalJson({ ...seedReceipt(o), state: "ready" }));
		assert.equal(readReceipt(store, TARGET).kind, "corrupt");

		writeReceipt(store, o, readyReceipt(seedReceipt(o)));
		assert.equal(
			classifyProvisioning(readReceipt(store, TARGET), {
				worktreePath: "/somewhere/else",
			}),
			"corrupt",
		);
		assert.equal(
			classifyProvisioning(readReceipt(store, TARGET), {
				worktreePath: TARGET,
				branch: "feat/other",
			}),
			"corrupt",
		);
	},
);

// --- S-PRO-07 / 08: stale discard keys off the recorded branch --------------

check("S-PRO-07: a fully vanished target may be reclaimed", () => {
	const { store } = freshStore();
	const o = claimed(store, TARGET, owner());
	writeReceipt(
		store,
		o,
		failedReceipt(seedReceipt(o), { code: "hook-failed" }),
	);
	assert.equal(
		canDiscardStaleReceipt(readReceipt(store, TARGET), {
			pathPresent: false,
			registrationPresent: false,
			recordedBranchPresent: false,
		}),
		true,
	);
});

check("S-PRO-08: any surviving trace blocks automatic discard", () => {
	const { store } = freshStore();
	const o = claimed(store, TARGET, owner());
	writeReceipt(
		store,
		o,
		failedReceipt(seedReceipt(o), { code: "hook-failed" }),
	);
	const read = readReceipt(store, TARGET);
	for (const observed of [
		{
			pathPresent: true,
			registrationPresent: false,
			recordedBranchPresent: false,
		},
		{
			pathPresent: false,
			registrationPresent: true,
			recordedBranchPresent: false,
		},
		{
			pathPresent: false,
			registrationPresent: false,
			recordedBranchPresent: true,
		},
	]) {
		assert.equal(
			canDiscardStaleReceipt(read, observed),
			false,
			JSON.stringify(observed),
		);
	}
});

// --- S-PRO-09 / 12: write failures are visible ------------------------------

check("S-PRO-09: a receipt write without the claim is refused", () => {
	const { store } = freshStore();
	const o = claimed(store, TARGET, owner());
	const stranger = {
		operationId: "op-2",
		pid: process.pid,
		role: "origin" as const,
	};
	const result = writeReceipt(store, stranger, seedReceipt(o));
	assert.equal(result.ok, false);
	assert.equal(result.code, "receipt-write-failed");
});

check("S-PRO-12: an unwritable store surfaces receipt-write-failed", () => {
	const { store } = freshStore();
	const o = claimed(store, TARGET, owner());
	const receipt = seedReceipt(o);
	// A regular file where the receipt directory must be makes the write fail
	// without inventing an error class the runtime would not produce.
	removeReceipt(store, TARGET);
	const blocked = { ...receipt, worktreePath: TARGET };
	const badStore = createStore(join(freshStore().dir, "not-a-dir"));
	mkdirSync(dirname(badStore.root), { recursive: true });
	writeFileSync(badStore.root, "blocked");
	const result = writeReceipt(badStore, o, blocked);
	assert.equal(result.ok, false);
	assert.equal(result.code, "receipt-write-failed");
});

// --- S-PRO-10: config drift does not invalidate a ready checkout ------------

check("S-PRO-10: a later config change leaves a ready receipt ready", () => {
	const { store } = freshStore();
	const o = claimed(store, TARGET, owner());
	const receipt = readyReceipt(seedReceipt(o));
	writeReceipt(store, o, receipt);
	const laterDigest = configDigest({ postCreate: ["npm ci", "npm run build"] });
	assert.notEqual(receipt.configDigest, laterDigest);
	const read = readReceipt(store, TARGET);
	assert.equal(classifyProvisioning(read, { worktreePath: TARGET }), "ready");
	if (read.kind === "present")
		assert.equal(read.receipt.configDigest, receipt.configDigest);
});

// --- S-PRO-11: concurrent creators ------------------------------------------

check("S-PRO-11: only one of two concurrent claimants wins", () => {
	const { store } = freshStore();
	const first = acquireClaim(store, TARGET, owner("op-a"));
	const second = acquireClaim(store, TARGET, owner("op-b"));
	assert.equal(first.ok, true);
	assert.equal(second.ok, false);
	if (!second.ok) assert.equal(second.code, "target-busy");
});

check("S-PRO-11: the loser cannot overwrite the winner's receipt", () => {
	const { store } = freshStore();
	const winner = owner("op-a");
	claimed(store, TARGET, winner);
	const loser = owner("op-b");
	writeReceipt(store, winner, readyReceipt(seedReceipt(winner)));

	const overwrite = writeReceipt(
		store,
		loser,
		failedReceipt(seedReceipt(loser), { code: "hook-failed" }),
	);
	assert.equal(overwrite.ok, false);
	assert.equal(
		classifyProvisioning(readReceipt(store, TARGET), { worktreePath: TARGET }),
		"ready",
	);
});

check(
	"S-PRO-11: a second live process is excluded from the same target",
	() => {
		const { dir } = freshStore();
		const script = join(HERE, "fixtures-claim-race.ts");
		const gitDir = join(dir, ".git");
		const marker = join(dir, "first.verdict");

		// The holder must still be running when the challenger tries, otherwise the
		// dead-owner reclaim path would legitimately let the challenger through.
		const holder = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				script,
				gitDir,
				TARGET,
				"race-holder",
				"5000",
				marker,
			],
			{ stdio: "ignore" },
		);
		try {
			assert.equal(waitForFile(marker, 15_000), true, "holder never acquired");
			assert.equal(readFileSync(marker, "utf-8").trim(), "acquired");

			const challenger = spawnSync(
				process.execPath,
				["--import", "tsx", script, gitDir, TARGET, "race-challenger"],
				{ encoding: "utf-8" },
			);
			assert.equal(challenger.stdout.trim(), "target-busy");
		} finally {
			holder.kill("SIGKILL");
		}
		assert.ok(existsSync(gitDir));
	},
);

// --- claim ownership --------------------------------------------------------

check("owner tuple verification distinguishes role and pid", () => {
	const { store } = freshStore();
	const origin = claimed(store, TARGET, owner("op-1", "origin"));
	assert.equal(verifyClaim(store, TARGET, origin), true);
	assert.equal(
		verifyClaim(store, TARGET, { ...origin, role: "waiter" }),
		false,
	);
	assert.equal(
		verifyClaim(store, TARGET, { ...origin, pid: origin.pid + 1 }),
		false,
	);
	assert.equal(
		verifyClaim(store, TARGET, { ...origin, operationId: "op-2" }),
		false,
	);
});

check(
	"S-DSP-17 support: an untransferred waiter fails its ownership check",
	() => {
		const { store } = freshStore();
		const origin = claimed(store, TARGET, owner("op-1", "origin"));
		// Same operation id, waiter role: exactly the armed-waiter case.
		const waiter = {
			operationId: origin.operationId,
			pid: origin.pid,
			role: "waiter" as const,
		};
		assert.equal(verifyClaim(store, TARGET, waiter), false);

		assert.equal(transferClaim(store, TARGET, origin, waiter), true);
		assert.equal(verifyClaim(store, TARGET, waiter), true);
		assert.equal(verifyClaim(store, TARGET, origin), false);
	},
);

check("a dead owner's claim is reclaimable, a live one is not", () => {
	const { store } = freshStore();
	// PID 1 always exists but is not ours: ambiguous, so it must stay held.
	const held = acquireClaim(store, TARGET, {
		operationId: "op-x",
		pid: 1,
		role: "origin",
	});
	assert.equal(held.ok, true);
	const contested = acquireClaim(store, TARGET, owner("op-y"));
	assert.equal(contested.ok, false);

	// A PID that has certainly exited releases the target.
	const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	assert.equal(dead.status, 0);
	const other = "/repo.worktrees/feat-dead";
	acquireClaim(store, other, {
		operationId: "op-z",
		pid: 2_147_483_646,
		role: "origin",
	});
	const reclaimed = acquireClaim(store, other, owner("op-live"));
	assert.equal(reclaimed.ok, true);
});

check("release only succeeds for the current owner", () => {
	const { store } = freshStore();
	const o = claimed(store, TARGET, owner());
	assert.equal(
		releaseClaim(store, TARGET, { ...o, operationId: "other" }),
		false,
	);
	assert.equal(releaseClaim(store, TARGET, o), true);
	assert.equal(acquireClaim(store, TARGET, owner("op-next")).ok, true);
});

// --- teardown reports --------------------------------------------------------

check("a teardown report round-trips and a missing one is absent", () => {
	const { store } = freshStore();
	assert.equal(readTeardownReport(store, "op-1").kind, "absent");
	assert.equal(
		writeTeardownReport(store, {
			schemaVersion: 1,
			operationId: "op-1",
			expectedDestination: { path: "/repo", branch: "main" },
			stages: [{ name: "pre-remove", status: "failed", exitCode: 1 }],
			observed: {
				pathPresent: true,
				registrationPresent: true,
				branchPresent: true,
				receiptPresent: true,
			},
			completedAt: new Date().toISOString(),
		}),
		true,
	);
	const read = readTeardownReport(store, "op-1");
	assert.equal(read.kind, "present");
	if (read.kind === "present") {
		assert.equal(read.report.stages[0].status, "failed");
		assert.equal(read.report.observed.pathPresent, true);
	}
});

check("receipts and reports never capture hook text or output", () => {
	const { store } = freshStore();
	const o = claimed(store, TARGET, owner());
	writeReceipt(store, o, seedReceipt(o));
	const raw = readFileSync(receiptPath(store, TARGET), "utf-8");
	assert.equal(raw.includes("npm install"), false);
	assert.match(raw, /"configDigest":"[0-9a-f]{64}"/);
});

if (fail > 0) {
	console.error(`provisioning receipt tests: ${fail} FAILED of ${total}`);
	process.exit(1);
}
console.log(`provisioning receipt tests: OK (${total} cases)`);
