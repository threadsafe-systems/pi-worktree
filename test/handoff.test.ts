import assert from "node:assert/strict";
import {
	buildRelaunchCommand,
	decodeHandoff,
	encodeHandoff,
	handoffCaveat,
	type WtHandoff,
} from "../extensions/worktree.ts";

let fail = 0;
const check = (name: string, fn: () => void) => {
	try {
		fn();
	} catch (e) {
		fail++;
		console.error(`FAIL: ${name}\n  ${(e as Error).message}`);
	}
};

check("relaunch command: fork + handoff env, safely quoted", () => {
	const cmd = buildRelaunchCommand("/wt path/x", "/s s.jsonl", "YWJjPT0=");
	assert.equal(cmd, "cd '/wt path/x' && PI_WT_HANDOFF='YWJjPT0=' pi --fork '/s s.jsonl'");
});

check("relaunch command: no session -> plain pi (back-compat)", () => {
	assert.equal(buildRelaunchCommand("/wt"), "cd '/wt' && pi");
});

check("relaunch command: fork without handoff", () => {
	assert.equal(buildRelaunchCommand("/wt", "/s.jsonl"), "cd '/wt' && pi --fork '/s.jsonl'");
});

check("handoff encode/decode round-trips", () => {
	const h: WtHandoff = { parentCwd: "/repo", parentBranch: "main", uncommitted: 3 };
	assert.deepEqual(decodeHandoff(encodeHandoff(h)), h);
});

check("decode rejects garbage", () => {
	assert.equal(decodeHandoff("not-base64-json"), null);
	assert.equal(decodeHandoff(Buffer.from('{"parentCwd":1}').toString("base64")), null);
});

check("caveat warns about uncommitted WIP and states path semantics", () => {
	const c = handoffCaveat({ parentCwd: "/repo", parentBranch: "main", uncommitted: 2 }, "/repo.worktrees/x", "worktree/x");
	assert.match(c, /2 file\(s\) had uncommitted changes/);
	assert.match(c, /Repo-relative paths are unchanged/);
	assert.match(c, /worktree\/x/);
});

check("caveat is clean when no WIP", () => {
	const c = handoffCaveat({ parentCwd: "/repo", parentBranch: "dev", uncommitted: 0 }, "/wt", "worktree/x");
	assert.match(c, /no uncommitted changes/);
	assert.doesNotMatch(c, /WARNING/);
});

if (fail > 0) {
	console.error(`handoff tests: ${fail} FAILED`);
	process.exit(1);
}
console.log("handoff tests: OK (8 cases)");
