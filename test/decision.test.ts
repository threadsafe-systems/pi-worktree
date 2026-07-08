import assert from "node:assert/strict";
import {
	MARKER_REL,
	LOCAL_MARKER_REL,
	shouldBlock,
	type WorktreeMarker,
} from "../extensions/worktree.ts";

// Pure decision-matrix tests. No filesystem or git; all facts injected.
const enforced: WorktreeMarker = {
	enforce: true,
	allowPaths: ["docs/", "CHANGELOG.md"],
};

const cases: Array<[string, boolean, Parameters<typeof shouldBlock>[0]]> = [
	[
		"block write in enforced main checkout",
		true,
		{
			toolName: "write",
			mainCheckout: true,
			marker: enforced,
			relPath: "src/x.ts",
		},
	],
	[
		"block edit in enforced main checkout",
		true,
		{
			toolName: "edit",
			mainCheckout: true,
			marker: enforced,
			relPath: "src/x.ts",
		},
	],
	[
		"allow in a linked worktree",
		false,
		{
			toolName: "write",
			mainCheckout: false,
			marker: enforced,
			relPath: "src/x.ts",
		},
	],
	[
		"allow when not opted in (null marker)",
		false,
		{
			toolName: "write",
			mainCheckout: true,
			marker: null,
			relPath: "src/x.ts",
		},
	],
	[
		"allow when marker disabled",
		false,
		{
			toolName: "write",
			mainCheckout: true,
			marker: { enforce: false },
			relPath: "src/x.ts",
		},
	],
	[
		"allow non-mutating tool",
		false,
		{
			toolName: "read",
			mainCheckout: true,
			marker: enforced,
			relPath: "src/x.ts",
		},
	],
	[
		"block editing the committed marker via write/edit (toggle uses the script, not the tool)",
		true,
		{
			toolName: "write",
			mainCheckout: true,
			marker: enforced,
			relPath: MARKER_REL,
		},
	],
	[
		"block editing the local override marker via write/edit",
		true,
		{
			toolName: "write",
			mainCheckout: true,
			marker: enforced,
			relPath: LOCAL_MARKER_REL,
		},
	],
	[
		"allow allowPaths dir prefix",
		false,
		{
			toolName: "write",
			mainCheckout: true,
			marker: enforced,
			relPath: "docs/plan.md",
		},
	],
	[
		"allow allowPaths exact file",
		false,
		{
			toolName: "edit",
			mainCheckout: true,
			marker: enforced,
			relPath: "CHANGELOG.md",
		},
	],
	[
		"block a sibling that only prefix-collides with an allowPath",
		true,
		{
			toolName: "write",
			mainCheckout: true,
			marker: enforced,
			relPath: "docs-internal/x.md",
		},
	],
];

let failures = 0;
for (const [name, expected, input] of cases) {
	try {
		assert.equal(shouldBlock(input), expected);
	} catch {
		failures++;
		console.error(`FAIL: ${name} (expected block=${expected})`);
	}
}
if (failures > 0) {
	console.error(`decision tests: ${failures} FAILED`);
	process.exit(1);
}
console.log(`decision tests: OK (${cases.length} cases)`);
