import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import {
	branchToDirName,
	buildCreateScript,
	buildDestroyScript,
	buildDisposeScript,
	buildRelaunchCommand,
	decodeHandoff,
	encodeHandoff,
	getWorktreeDir,
	getWorktreePath,
	handoffCaveat,
	isPathInside,
	isValidBaseRef,
	isValidExplicitBranch,
	parseCreateArgs,
	parseWorktreeList,
	planCreate,
	resolveBranch,
	resolveDestroyTarget,
	type WtHandoff,
} from "../extensions/worktree.ts";

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

check("relaunch command: fork + handoff env, safely quoted", () => {
	const cmd = buildRelaunchCommand("/wt path/x", "/s s.jsonl", "YWJjPT0=");
	assert.equal(
		cmd,
		"cd '/wt path/x' && PI_WT_HANDOFF='YWJjPT0=' pi --fork '/s s.jsonl'",
	);
});

check("relaunch command: no session -> plain pi (back-compat)", () => {
	assert.equal(buildRelaunchCommand("/wt"), "cd '/wt' && pi");
});

check("relaunch command: fork without handoff", () => {
	assert.equal(
		buildRelaunchCommand("/wt", "/s.jsonl"),
		"cd '/wt' && pi --fork '/s.jsonl'",
	);
});

check("handoff encode/decode round-trips", () => {
	const h: WtHandoff = {
		parentCwd: "/repo",
		parentBranch: "main",
		uncommitted: 3,
		kind: "enter",
	};
	assert.deepEqual(decodeHandoff(encodeHandoff(h)), h);
});

check("decode rejects garbage", () => {
	assert.equal(decodeHandoff("not-base64-json"), null);
	assert.equal(
		decodeHandoff(Buffer.from('{"parentCwd":1}').toString("base64")),
		null,
	);
});

check("caveat warns about uncommitted WIP and states path semantics", () => {
	const c = handoffCaveat(
		{ parentCwd: "/repo", parentBranch: "main", uncommitted: 2 },
		"/repo.worktrees/x",
		"worktree/x",
	);
	assert.match(c, /2 file\(s\) had uncommitted changes/);
	assert.match(c, /Repo-relative paths are unchanged/);
	assert.match(c, /worktree\/x/);
});

check("caveat is clean when no WIP", () => {
	const c = handoffCaveat(
		{ parentCwd: "/repo", parentBranch: "dev", uncommitted: 0 },
		"/wt",
		"worktree/x",
	);
	assert.match(c, /no uncommitted changes/);
	assert.doesNotMatch(c, /WARNING/);
});

check("resolveBranch: explicit type/id passes through", () => {
	assert.equal(
		resolveBranch("feat/use-conventional-commits", {}),
		"feat/use-conventional-commits",
	);
});

check("resolveBranch: two-token form joins identifier with hyphens", () => {
	assert.equal(resolveBranch("fix login bug", {}), "fix/login-bug");
});

check("resolveBranch: bare identifier gets default type", () => {
	assert.equal(resolveBranch("cleanup", {}), "feat/cleanup");
});

check("resolveBranch: defaultType override honoured", () => {
	assert.equal(
		resolveBranch("cleanup", { defaultType: "chore" }),
		"chore/cleanup",
	);
});

check("resolveBranch: empty input generates a feat/ name", () => {
	assert.match(resolveBranch("", {}), /^feat\/[a-z]+-[a-z]+$/);
});

check("resolveBranch: unknown type rejected", () => {
	assert.throws(() => resolveBranch("wip/foo", {}), /Unknown branch type/);
});

check("resolveBranch: malformed identifier rejected", () => {
	assert.throws(() => resolveBranch("feat/Foo_Bar", {}), /Invalid identifier/);
});

check("getWorktreeDir: sibling default (never nested)", () => {
	assert.equal(getWorktreeDir("/home/x/repo", {}), "/home/x/repo.worktrees");
});

check("getWorktreeDir: explicit dir resolves relative to repo root", () => {
	assert.equal(
		getWorktreeDir("/home/x/repo", { dir: ".wt" }),
		"/home/x/repo/.wt",
	);
});

check("branchToDirName: slashes collapse to hyphens", () => {
	assert.equal(
		branchToDirName("feat/use-conventional-commits"),
		"feat-use-conventional-commits",
	);
});

check(
	"buildDisposeScript: preRemove, cd repo, remove, branch -d (soft) in order",
	() => {
		const s = buildDisposeScript("/repo", "/repo.worktrees/feat-x", "feat/x", [
			"dropdb foo",
		]);
		const iHook = s.indexOf("dropdb foo");
		const iCd = s.indexOf("cd '/repo'");
		const iRemove = s.indexOf(
			"git worktree remove --force '/repo.worktrees/feat-x'",
		);
		const iBranch = s.indexOf("git branch -d 'feat/x'");
		assert.ok(
			iHook >= 0 && iCd > iHook && iRemove > iCd && iBranch > iRemove,
			s,
		);
	},
);

check("dispose relaunch command targets the repo root", () => {
	assert.equal(
		buildRelaunchCommand("/repo", "/s.jsonl", "YWJjPT0="),
		"cd '/repo' && PI_WT_HANDOFF='YWJjPT0=' pi --fork '/s.jsonl'",
	);
});

check("dispose handoff round-trips with kind", () => {
	const h: WtHandoff = {
		parentCwd: "/repo.worktrees/feat-x",
		parentBranch: "feat/x",
		uncommitted: 1,
		ignored: 2,
		kind: "dispose",
	};
	assert.deepEqual(decodeHandoff(encodeHandoff(h)), h);
});

check("dispose caveat describes return to main and lost WIP", () => {
	const c = handoffCaveat(
		{
			parentCwd: "/repo.worktrees/feat-x",
			parentBranch: "feat/x",
			uncommitted: 2,
			kind: "dispose",
		},
		"/repo",
		"main",
	);
	assert.match(c, /moved back to the main checkout/);
	assert.match(c, /destroyed/);
	assert.match(c, /soft-delete/);
	assert.match(c, /verify with/);
	assert.match(c, /git worktree list/);
});

check("dispose caveat labels lost files as uncommitted/untracked (R2)", () => {
	const c = handoffCaveat(
		{
			parentCwd: "/wt",
			parentBranch: "feat/x",
			uncommitted: 2,
			ignored: 0,
			kind: "dispose",
		},
		"/repo",
		"main",
	);
	assert.match(c, /uncommitted\/untracked/);
	assert.doesNotMatch(c, /uncommitted tracked/);
});

check("dispose caveat warns that gitignored files were destroyed", () => {
	const c = handoffCaveat(
		{
			parentCwd: "/wt",
			parentBranch: "feat/x",
			uncommitted: 0,
			ignored: 3,
			kind: "dispose",
		},
		"/repo",
		"main",
	);
	assert.match(c, /gitignored/i);
	assert.match(c, /3 gitignored/);
});

check("dispose caveat is clean when nothing was lost", () => {
	const c = handoffCaveat(
		{
			parentCwd: "/wt",
			parentBranch: "feat/x",
			uncommitted: 0,
			ignored: 0,
			kind: "dispose",
		},
		"/repo",
		"main",
	);
	assert.doesNotMatch(c, /WARNING/);
});

check("resolveBranch: injection-y default type from config is rejected", () => {
	assert.throws(
		() =>
			resolveBranch("foo", { defaultType: "feat$(id)", types: ["feat$(id)"] }),
		/Invalid branch type/,
	);
});

check(
	"resolveBranch: injection-y explicit type rejected even if whitelisted",
	() => {
		assert.throws(
			() => resolveBranch("feat`id`/foo", { types: ["feat`id`"] }),
			/Invalid branch type/,
		);
	},
);

check("resolveBranch: genuinely unknown type still reports as unknown", () => {
	assert.throws(() => resolveBranch("wip/foo", {}), /Unknown branch type/);
});

check(
	"resolveBranch: hyphenated custom type rejected (keeps slugs injective)",
	() => {
		// feat-fix/foo and feat/fix-foo would otherwise slug to the same directory.
		// Forbidding hyphens in the type makes branchToDirName provably injective.
		assert.throws(
			() => resolveBranch("feat-fix/foo", { types: ["feat-fix"] }),
			/Invalid branch type/,
		);
	},
);

check(
	"buildCreateScript: shQuotes paths/branch and never force-deletes a branch",
	() => {
		const s = buildCreateScript("/repo", "/repo.worktrees/feat-x", "feat/x");
		assert.match(
			s,
			/git worktree add -b 'feat\/x' '\/repo.worktrees\/feat-x' 'HEAD'/,
		);
		assert.match(s, /cd '\/repo'/);
		assert.doesNotMatch(s, /branch -D/);
	},
);

check(
	"buildCreateScript: neutralises shell metacharacters in the repo path",
	() => {
		const s = buildCreateScript(
			"/tmp/r$(touch pwn)",
			"/tmp/r$(touch pwn).worktrees/feat-x",
			"feat/x",
		);
		// The dangerous substring only ever appears inside single quotes.
		for (const m of s.matchAll(/\$\(touch pwn\)/g)) {
			const before = s.lastIndexOf("'", m.index);
			const quotedOpen =
				before >= 0 && s.slice(before, m.index).indexOf("'", 1) === -1;
			assert.ok(quotedOpen, `unquoted injection at ${m.index}: ${s}`);
		}
	},
);

check("buildDestroyScript: shQuotes and hard-deletes the branch", () => {
	const s = buildDestroyScript("/repo", "/repo.worktrees/feat-x", "feat/x", [
		"dropdb foo",
	]);
	assert.match(s, /git worktree remove --force '\/repo.worktrees\/feat-x'/);
	assert.match(s, /git branch -D 'feat\/x'/);
	assert.match(s, /dropdb foo/);
});

check(
	"teardown never rm -rf's on failure (prunes instead) — no blunt delete",
	() => {
		// A stale worktree path can be reused by unrelated content; git refuses to
		// remove it, so an rm -rf fallback would destroy that unrelated data.
		for (const s of [
			buildDisposeScript("/repo", "/repo.worktrees/feat-x", "feat/x"),
			buildDestroyScript("/repo", "/repo.worktrees/feat-x", "feat/x"),
		]) {
			assert.doesNotMatch(s, /rm -rf/);
			assert.match(s, /git worktree prune/);
		}
	},
);

check(
	"teardown: preRemove hooks are fail-fast (set -e brackets), none without hooks",
	() => {
		const withHooks = buildDestroyScript(
			"/repo",
			"/repo.worktrees/feat-x",
			"feat/x",
			["backup.sh"],
		);
		assert.match(withHooks, /set -e/);
		assert.match(withHooks, /set \+e/);
		const noHooks = buildDestroyScript(
			"/repo",
			"/repo.worktrees/feat-x",
			"feat/x",
		);
		assert.doesNotMatch(noHooks, /set -e/);
	},
);

check("isPathInside: detects nested and equal paths, rejects siblings", () => {
	assert.equal(isPathInside("/a/b/c", "/a/b"), true);
	assert.equal(isPathInside("/a/b", "/a/b"), true);
	assert.equal(isPathInside("/a/bc", "/a/b"), false);
	assert.equal(isPathInside("/a", "/a/b"), false);
});

check(
	"isPathInside: resolves symlinks so a linked cwd is still detected (R3)",
	() => {
		const base = mkdtempSync(pjoin(tmpdir(), "wt-isinside-"));
		const real = pjoin(base, "real");
		mkdirSync(pjoin(real, "sub"), { recursive: true });
		const link = pjoin(base, "link");
		symlinkSync(real, link);
		// A path reached via the symlink must be recognised as inside the real dir.
		assert.equal(isPathInside(pjoin(link, "sub"), real), true);
		assert.equal(isPathInside(link, real), true);
	},
);

check(
	"isPathInside: resolves an intermediate symlink even when the leaf is missing",
	() => {
		const base = mkdtempSync(pjoin(tmpdir(), "wt-isinside2-"));
		const real = pjoin(base, "real");
		mkdirSync(real, { recursive: true });
		const link = pjoin(base, "link");
		symlinkSync(real, link);
		// Leaf does not exist yet, but the symlinked parent resolves into `real`.
		assert.equal(isPathInside(pjoin(link, "not-created-yet"), real), true);
	},
);

check(
	"resolveDestroyTarget: picks the exact-branch worktree, never the main checkout",
	() => {
		const list = [
			{ path: "/repo", branch: "feat/main" },
			{ path: "/repo.worktrees/feat-x", branch: "feat/x" },
		];
		assert.deepEqual(resolveDestroyTarget(list, "feat/x", "/repo"), {
			path: "/repo.worktrees/feat-x",
		});
	},
);

check(
	"resolveDestroyTarget: refuses the main working tree (regression guard)",
	() => {
		const list = [{ path: "/repo", branch: "feat/main" }];
		const r = resolveDestroyTarget(list, "feat/main", "/repo");
		assert.ok("error" in r);
		assert.match((r as { error: string }).error, /main working tree/);
	},
);

check("resolveDestroyTarget: refuses when no worktree is on the branch", () => {
	const list = [{ path: "/repo", branch: "main" }];
	const r = resolveDestroyTarget(list, "feat/nope", "/repo");
	assert.ok("error" in r);
	assert.match((r as { error: string }).error, /No worktree/);
});

check(
	"parseWorktreeList: extracts path + branch, handles slashes and detached",
	() => {
		const porcelain = [
			"worktree /repo",
			"HEAD abc123",
			"branch refs/heads/main",
			"",
			"worktree /repo.worktrees/feat-x",
			"HEAD def456",
			"branch refs/heads/feat/x",
			"",
			"worktree /repo.worktrees/detached",
			"HEAD 999aaa",
			"detached",
			"",
		].join("\n");
		const list = parseWorktreeList(porcelain);
		assert.equal(list.length, 3);
		assert.deepEqual(list[0], { path: "/repo", branch: "main" });
		assert.deepEqual(list[1], {
			path: "/repo.worktrees/feat-x",
			branch: "feat/x",
		});
		assert.deepEqual(list[2], {
			path: "/repo.worktrees/detached",
			branch: null,
		});
	},
);

check(
	"parseWorktreeList: disambiguates the N1 slug collision by exact branch",
	() => {
		// feat/fix-foo and feat-fix/foo both slug to feat-fix-foo, but git records
		// the true branch, so lookup-by-branch picks the right checkout.
		const porcelain = [
			"worktree /repo.worktrees/feat-fix-foo",
			"branch refs/heads/feat/fix-foo",
			"",
		].join("\n");
		const byBranch = parseWorktreeList(porcelain).find(
			(w: { path: string; branch: string | null }) =>
				w.branch === "feat/fix-foo",
		);
		assert.equal(byBranch?.path, "/repo.worktrees/feat-fix-foo");
		assert.equal(
			parseWorktreeList(porcelain).find(
				(w: { path: string; branch: string | null }) =>
					w.branch === "feat-fix/foo",
			),
			undefined,
		);
	},
);

check("enter handoff defaults kind to enter on decode", () => {
	const legacy = encodeHandoff({
		parentCwd: "/repo",
		parentBranch: "main",
		uncommitted: 0,
	});
	assert.equal(decodeHandoff(legacy)?.kind, "enter");
});

// --- Ergonomic overrides: --dir / --branch / --base ---

check("parseCreateArgs: positional name plus --dir/--branch/--base (space + = forms)", () => {
	assert.deepEqual(parseCreateArgs("my-thing --dir /tmp/wt --branch feature/x --base develop"), {
		name: "my-thing",
		dir: "/tmp/wt",
		branch: "feature/x",
		base: "develop",
	});
	assert.deepEqual(parseCreateArgs("--branch=feature/y --base=HEAD~2 thing"), {
		name: "thing",
		branch: "feature/y",
		base: "HEAD~2",
	});
});

check("parseCreateArgs: two-token positional name is preserved for resolveBranch", () => {
	assert.deepEqual(parseCreateArgs("fix login-bug"), { name: "fix login-bug" });
});

check("isValidExplicitBranch: accepts real branches, rejects unsafe/illegal", () => {
	for (const ok of ["feature/x", "Release-1.2", "a/b/c", "hotfix_9"]) {
		assert.equal(isValidExplicitBranch(ok), true, ok);
	}
	for (const bad of ["", "foo bar", "$(touch pwn)", "a..b", "a//b", "feat/", "x.lock", "-lead", "a`b`"]) {
		assert.equal(isValidExplicitBranch(bad), false, bad);
	}
});

check("isValidBaseRef: accepts refs, rejects leading dash and shell metachars", () => {
	for (const ok of ["HEAD", "origin/main", "v1.2.3", "HEAD~3", "abc123"]) {
		assert.equal(isValidBaseRef(ok), true, ok);
	}
	for (const bad of ["", "-x", "$(x)", "a b", "a;b", "a`b`"]) {
		assert.equal(isValidBaseRef(bad), false, bad);
	}
});

check("getWorktreeDir/getWorktreePath: --dir override wins over sibling default", () => {
	assert.equal(getWorktreeDir("/repo", {}, "/tmp/wts"), "/tmp/wts");
	assert.equal(getWorktreeDir("/repo", { dir: ".wt" }, "/tmp/wts"), "/tmp/wts");
	assert.equal(
		getWorktreePath("/repo", {}, "feat/x", "/tmp/wts"),
		"/tmp/wts/feat-x",
	);
});

check("buildCreateScript: base defaults to HEAD and is shQuote'd when overridden", () => {
	assert.match(buildCreateScript("/repo", "/repo.worktrees/feat-x", "feat/x"), /'HEAD'$/m);
	const s = buildCreateScript("/repo", "/repo.worktrees/feat-x", "feat/x", "develop");
	assert.match(s, /git worktree add -b 'feat\/x' '\/repo.worktrees\/feat-x' 'develop'/);
});

check("planCreate: name resolves to a conventional branch + sibling path", () => {
	const p = planCreate("/repo", {}, { name: "login-bug" });
	assert.deepEqual(p, {
		branch: "feat/login-bug",
		worktreePath: "/repo.worktrees/feat-login-bug",
		base: "HEAD",
	});
});

check("planCreate: --branch is used verbatim; --dir + --base flow through", () => {
	const p = planCreate("/repo", {}, {
		name: "ignored",
		branch: "release/2.0",
		dir: "/tmp/wts",
		base: "origin/main",
	});
	assert.deepEqual(p, {
		branch: "release/2.0",
		worktreePath: "/tmp/wts/release-2.0",
		base: "origin/main",
	});
});

check("planCreate: rejects an injection-y --branch and --base", () => {
	assert.throws(() => planCreate("/repo", {}, { branch: "feat/$(touch x)" }), /Invalid .*branch/i);
	assert.throws(() => planCreate("/repo", {}, { name: "x", base: "-rf" }), /Invalid .*base/i);
});

if (fail > 0) {
	console.error(`handoff tests: ${fail} of ${total} FAILED`);
	process.exit(1);
}
console.log(`handoff tests: OK (${total} cases)`);
