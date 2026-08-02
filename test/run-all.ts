/**
 * Test entry point: discovers and runs every `test/*.test.ts` file.
 *
 * Discovery rather than an explicit list means a test added by a later task
 * joins the regression net automatically, so "the full suite passed" cannot
 * quietly mean "the suite as it was two tasks ago passed".
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Select test files from a directory listing.
 *
 * Split from the filesystem so it can be exercised against a synthetic listing,
 * including filenames that do not exist yet.
 */
export function discoverTestFiles(entries: string[]): string[] {
	return entries.filter((entry) => entry.endsWith(".test.ts")).sort();
}

function main(): void {
	const testDir = dirname(fileURLToPath(import.meta.url));
	const files = discoverTestFiles(readdirSync(testDir));

	if (files.length === 0) {
		console.error("run-all: no test files discovered");
		process.exit(1);
	}

	const failures: string[] = [];
	for (const file of files) {
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", join(testDir, file)],
			{ stdio: "inherit" },
		);
		if (result.status !== 0) failures.push(file);
	}

	if (failures.length > 0) {
		console.error(`run-all: FAILED (${failures.join(", ")})`);
		process.exit(1);
	}
	console.log(`run-all: OK (${files.length} test files)`);
}

// Only run the suite when invoked directly, so the discovery helper can be
// imported by the package-contract test without spawning every test again.
const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === selfPath) {
	main();
}
