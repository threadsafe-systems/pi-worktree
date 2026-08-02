/**
 * Claim-race child process.
 *
 * Spawned by the receipt tests so the concurrent-creator guarantee is proven
 * across real OS processes rather than two calls in one event loop. The first
 * child holds its claim while alive, because a claim released by an exited
 * process is legitimately reclaimable and would not prove exclusion.
 *
 * Not named `*.test.ts`, so the discovery runner never executes it directly.
 */

import { writeFileSync } from "node:fs";
import { acquireClaim, createStore } from "../extensions/worktree-receipt.ts";

const [gitCommonDir, targetPath, operationId, holdMs, markerPath] =
	process.argv.slice(2);

const result = acquireClaim(createStore(gitCommonDir), targetPath, {
	operationId,
	pid: process.pid,
	role: "origin",
});
const verdict = result.ok ? "acquired" : result.code;
console.log(verdict);

if (markerPath) writeFileSync(markerPath, verdict);

const hold = Number(holdMs ?? 0);
if (hold > 0) {
	// Stay alive so a concurrent claimant observes a live owner rather than an
	// exited one. A timer keeps the event loop referenced without busy-waiting.
	setTimeout(() => {}, hold);
}
