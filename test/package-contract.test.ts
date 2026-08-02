import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTestFiles } from "./run-all.ts";

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

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

/** Every runtime file the extension entry point can reach. */
function reachableExtensionFiles(): string[] {
	const seen = new Set<string>();
	const queue = ["worktree.ts"];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		const source = readFileSync(join(ROOT, "extensions", file), "utf-8");
		for (const match of source.matchAll(/from "\.\/([^"]+)"/g)) {
			queue.push(match[1]);
		}
	}
	return [...seen].sort();
}

// --- S-CMP-03: everything imported at runtime is published --------------------

check(
	"S-CMP-03: the published package contains every reachable extension file",
	() => {
		const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
			cwd: ROOT,
			encoding: "utf-8",
			timeout: 120_000,
		});
		assert.equal(packed.status, 0, packed.stderr);
		const entries: string[] = JSON.parse(packed.stdout)[0].files.map(
			(f: { path: string }) => f.path,
		);

		for (const file of reachableExtensionFiles()) {
			assert.ok(
				entries.includes(`extensions/${file}`),
				`extensions/${file} is imported at runtime but would not be published`,
			);
		}
	},
);

check("the extension entry point really does span several modules", () => {
	// Guards the test above against silently passing if the imports were inlined.
	assert.ok(
		reachableExtensionFiles().length >= 4,
		reachableExtensionFiles().join(", "),
	);
});

// --- S-CMP-02: the declared runtime floor ------------------------------------

check(
	"S-CMP-02: the package declares the Pi lifecycle floor it depends on",
	() => {
		assert.equal(
			pkg.peerDependencies["@earendil-works/pi-coding-agent"],
			">=0.83.0",
		);
		assert.equal(pkg.peerDependencies["@earendil-works/pi-ai"], ">=0.83.0");
	},
);

check("S-CMP-02: the installed Pi satisfies that floor", () => {
	const installed = JSON.parse(
		readFileSync(
			join(ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json"),
			"utf-8",
		),
	).version as string;
	const [major, minor] = installed.split(".").map(Number);
	assert.ok(
		major > 0 || minor >= 83,
		`installed pi-coding-agent ${installed} predates the 0.83 lifecycle contracts`,
	);
});

check("S-CMP-02: StringEnum resolves from the declared pi-ai peer", () => {
	const helpers = readFileSync(
		join(
			ROOT,
			"node_modules/@earendil-works/pi-ai/dist/utils/typebox-helpers.d.ts",
		),
		"utf-8",
	);
	assert.match(helpers, /export declare function StringEnum/);
});

// --- S-CMP-05: the regression net is discovery-based ---------------------------

check("S-CMP-05: npm test runs the discovery aggregator", () => {
	assert.equal(pkg.scripts.test, "tsx test/run-all.ts");
	assert.match(pkg.scripts.lint, /--error-on-warnings/);
});

check(
	"S-CMP-05: discovery would pick up planned test files that do not exist yet",
	() => {
		const planned = [
			"decision.test.ts",
			"handoff.test.ts",
			"transition-planner.test.ts",
			"provisioning-receipt.test.ts",
			"transport.test.ts",
			"worktree-adapters.test.ts",
			"package-contract.test.ts",
			"successor-verification.test.ts",
			"disposal.test.ts",
			"process-lifecycle.test.ts",
		];
		const discovered = discoverTestFiles([
			...planned,
			"run-all.ts",
			"fixtures-claim-race.ts",
		]);
		for (const file of planned) {
			assert.ok(
				discovered.includes(file),
				`${file} would not join the regression net`,
			);
		}
		assert.equal(
			discovered.includes("run-all.ts"),
			false,
			"the runner must not run itself",
		);
		assert.equal(
			discovered.includes("fixtures-claim-race.ts"),
			false,
			"helper fixtures must not be run as tests",
		);
	},
);

check("every present test file is discovered", () => {
	const onDisk = readdirSync(join(ROOT, "test")).filter((f) =>
		f.endsWith(".test.ts"),
	);
	const discovered = discoverTestFiles(readdirSync(join(ROOT, "test")));
	assert.deepEqual(discovered, onDisk.sort());
});

// --- S-CMP-01: documented behaviour matches the shipped contract ----------------

check(
	"S-CMP-01: README no longer promises absolute-path targeting as the default",
	() => {
		const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
		assert.match(
			readme,
			/execution/,
			"README must document the execution preference",
		);
		assert.equal(
			/after `create`\/`enter`, the agent\s*\n?should use absolute paths/i.test(
				readme,
			),
			false,
			"README still states the superseded absolute-path default",
		);
	},
);

if (fail > 0) {
	console.error(`package contract tests: ${fail} FAILED of ${total}`);
	process.exit(1);
}
console.log(`package contract tests: OK (${total} cases)`);
