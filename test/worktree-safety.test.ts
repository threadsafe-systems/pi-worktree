import assert from "node:assert/strict";
import {
	describeSafetySnapshotChanges,
	disposeSafetyReason,
	escapeForDisplay,
	formatDestroyConfirmation,
	formatInventoryEntry,
	normalizeSafetySnapshot,
	parseFetchHeadOids,
	parseIndexFlagEntries,
	parseOidLines,
	parsePorcelainInventory,
	parseReflogOids,
	sameSafetySnapshot,
	type WorktreeSafetySnapshot,
} from "../extensions/worktree-safety.ts";

let total = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
	total++;
	try {
		fn();
	} catch (error) {
		failed++;
		console.error(`FAIL: ${name}`);
		console.error(error instanceof Error ? error.message : String(error));
	}
}

const SHA1_A = "a".repeat(40);
const SHA1_B = "b".repeat(40);
const SHA256_C = "c".repeat(64);

check(
	"porcelain parser preserves NUL-delimited paths and rename identity",
	() => {
		const inventory = parsePorcelainInventory(
			` M file with space\0?? --leading\0!! ignored\nname\0R  renamed\0old name\0`,
		);
		assert.deepEqual(inventory.protected, [
			{ kind: "status", status: " M", path: "file with space" },
			{ kind: "status", status: "??", path: "--leading" },
			{
				kind: "status",
				status: "R ",
				path: "renamed",
				originalPath: "old name",
			},
		]);
		assert.deepEqual(inventory.ignored, [
			{ kind: "ignored", path: "ignored\nname" },
		]);
	},
);

check("porcelain parser rejects truncated and malformed records", () => {
	assert.throws(() => parsePorcelainInventory("?? missing terminator"));
	assert.throws(() => parsePorcelainInventory("broken\0"));
	assert.throws(() => parsePorcelainInventory("R  renamed\0"));
});

check(
	"index parser identifies assume-unchanged and skip-worktree flags",
	() => {
		assert.deepEqual(
			parseIndexFlagEntries(
				`h assume.txt\0S skipped.txt\0s both\nflags.txt\0H normal.txt\0`,
			),
			[
				{
					kind: "index-flag",
					path: "assume.txt",
					flags: ["assume-unchanged"],
				},
				{
					kind: "index-flag",
					path: "skipped.txt",
					flags: ["skip-worktree"],
				},
				{
					kind: "index-flag",
					path: "both\nflags.txt",
					flags: ["assume-unchanged", "skip-worktree"],
				},
			],
		);
		assert.throws(() => parseIndexFlagEntries("Smissing-space\0"));
		assert.throws(() => parseIndexFlagEntries("S no-terminator"));
	},
);

check("reflog parser validates records and supports SHA-1 and SHA-256", () => {
	assert.deepEqual(
		parseReflogOids(
			`${"0".repeat(40)} ${SHA1_A} Agent <agent@example.com> 1 +0000\tcommit: one\n${SHA256_C} ${SHA256_C} Agent <agent@example.com> 2 +0000\tcommit: two\n`,
			"logs/HEAD",
		),
		[SHA1_A, SHA256_C],
	);
	assert.throws(() => parseReflogOids("not a reflog\n", "logs/HEAD"));
	assert.throws(() =>
		parseReflogOids(`${SHA1_A} nope who 1 +0000\tbad\n`, "logs/HEAD"),
	);
});

check("OID line and FETCH_HEAD parsers reject malformed object names", () => {
	assert.deepEqual(parseOidLines(`${SHA1_A}\n${SHA256_C}\n`, "MERGE_HEAD"), [
		SHA1_A,
		SHA256_C,
	]);
	assert.deepEqual(
		parseFetchHeadOids(
			`${SHA1_A}\t\tbranch 'main' of example\n${SHA1_B}\tnot-for-merge\ttag 'v1' of example\n`,
		),
		[SHA1_A, SHA1_B],
	);
	assert.throws(() => parseOidLines("abc\n", "MERGE_HEAD"));
	assert.throws(() => parseFetchHeadOids(`${SHA1_A} missing-tabs\n`));
});

check(
	"snapshot normalization is deterministic and equality is order-free",
	() => {
		const left: WorktreeSafetySnapshot = {
			worktreePath: "/repo.worktrees/feat-x",
			administrativePath: "/repo/.git/worktrees/feat-x",
			identity: { head: SHA1_A, branch: "refs/heads/feat/x" },
			protected: [
				{ kind: "status", status: "??", path: "z" },
				{ kind: "status", status: " M", path: "a" },
				{ kind: "status", status: "??", path: "z" },
			],
			ignored: [
				{ kind: "ignored", path: "tmp" },
				{ kind: "ignored", path: "tmp" },
			],
			recoveryOids: [SHA1_B.toUpperCase(), SHA1_A, SHA1_A],
		};
		const right: WorktreeSafetySnapshot = {
			...left,
			protected: [
				{ kind: "status", status: " M", path: "a" },
				{ kind: "status", status: "??", path: "z" },
			],
			ignored: [{ kind: "ignored", path: "tmp" }],
			recoveryOids: [SHA1_A, SHA1_B],
		};
		const normalized = normalizeSafetySnapshot(left);
		assert.deepEqual(normalized.recoveryOids, [SHA1_A, SHA1_B]);
		assert.equal(normalized.protected.length, 2);
		assert.equal(normalized.ignored.length, 1);
		assert.equal(sameSafetySnapshot(left, right), true);
		assert.equal(
			sameSafetySnapshot(left, { ...right, recoveryOids: [SHA1_A] }),
			false,
		);
	},
);

check(
	"display escaping makes control bytes visible without changing Unicode",
	() => {
		assert.equal(
			escapeForDisplay("line\n\t\u001b[31m café\u0085"),
			"line\\n\\t\\x1b[31m café\\x85",
		);
		assert.equal(
			formatInventoryEntry({ kind: "ignored", path: "odd\nname" }),
			"ignored: odd\\nname",
		);
		assert.equal(
			formatInventoryEntry({
				kind: "index-flag",
				path: "secret",
				flags: ["assume-unchanged", "skip-worktree"],
			}),
			"index flag assume-unchanged+skip-worktree: secret",
		);
	},
);

check("dispose refusal lists exact inventory and recovery objects", () => {
	const snapshot: WorktreeSafetySnapshot = {
		worktreePath: "/repo.worktrees/feat-\u001b",
		administrativePath: "/repo/.git/worktrees/feat-x",
		identity: { head: SHA1_A, branch: "refs/heads/feat/x" },
		protected: [
			{
				kind: "index-flag",
				path: "hidden\nfile",
				flags: ["assume-unchanged"],
			},
		],
		ignored: [{ kind: "ignored", path: "local.cache" }],
		recoveryOids: [SHA1_B],
	};
	const reason = disposeSafetyReason(snapshot);
	assert.match(reason ?? "", /feat-\\x1b/);
	assert.match(reason ?? "", /index flag assume-unchanged: hidden\\nfile/);
	assert.match(reason ?? "", /ignored: local\.cache/);
	assert.match(reason ?? "", new RegExp(SHA1_B));
	assert.doesNotMatch(reason ?? "", /\b[123] file/);
	assert.equal(
		disposeSafetyReason({
			...snapshot,
			protected: [],
			ignored: [],
			recoveryOids: [],
		}),
		null,
	);
});

check("destroy confirmation identifies every approved risk category", () => {
	const snapshot: WorktreeSafetySnapshot = {
		worktreePath: "/repo.worktrees/feat-x",
		administrativePath: "/repo/.git/worktrees/feat-x",
		identity: { head: SHA1_A, branch: "refs/heads/feat/x" },
		protected: [{ kind: "status", status: " M", path: "tracked.txt" }],
		ignored: [{ kind: "ignored", path: "local.cache" }],
		recoveryOids: [SHA1_B],
	};
	const confirmation = formatDestroyConfirmation(snapshot, "feat/x");
	assert.match(confirmation.title, /discard local and recovery data/i);
	assert.match(confirmation.body, /status {2}M: tracked\.txt/);
	assert.match(confirmation.body, /ignored: local\.cache/);
	assert.match(confirmation.body, new RegExp(SHA1_B));
	assert.match(confirmation.body, /hard-delete branch feat\/x/);
});

check("snapshot mismatch names each changed class", () => {
	const approved: WorktreeSafetySnapshot = {
		worktreePath: "/repo.worktrees/feat-x",
		administrativePath: "/repo/.git/worktrees/feat-x",
		identity: { head: SHA1_A, branch: "refs/heads/feat/x" },
		protected: [],
		ignored: [],
		recoveryOids: [],
	};
	assert.deepEqual(
		describeSafetySnapshotChanges(approved, {
			...approved,
			identity: { ...approved.identity, head: SHA1_B },
			protected: [{ kind: "status", status: "??", path: "new" }],
			ignored: [{ kind: "ignored", path: "cache" }],
			recoveryOids: [SHA1_B],
		}),
		[
			"worktree identity",
			"protected inventory",
			"ignored inventory",
			"recovery history",
		],
	);
	assert.deepEqual(describeSafetySnapshotChanges(approved, approved), []);
});

if (failed > 0) {
	console.error(`worktree safety tests: ${failed} FAILED of ${total}`);
	process.exit(1);
}
console.log(`worktree safety tests: OK (${total} cases)`);
