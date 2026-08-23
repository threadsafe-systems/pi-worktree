import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	escapeForDisplay,
	executeWorktreeTeardown,
	normalizeSafetySnapshot,
	type WorktreeInventoryEntry,
	type WorktreeSafetySnapshot,
	type WorktreeTeardownResult,
} from "./worktree-safety.ts";

export interface DetachedTeardownRequestV1 {
	schemaVersion: 1;
	operationId: string;
	repoRoot: string;
	worktreePath: string;
	branch: string;
	expectedDestination: { path: string; branch: string };
	approvedSnapshot: WorktreeSafetySnapshot;
	preRemove: string[];
	ownerFile: string;
	receiptFile: string;
	reportFile: string;
}

interface DetachedTeardownReportV1 {
	schemaVersion: 1;
	operationId: string;
	expectedDestination: { path: string; branch: string };
	outcome: WorktreeTeardownResult["status"];
	reason: WorktreeTeardownResult["reason"];
	message: string;
	changes: string[];
	details: string[];
	stages: {
		name: string;
		status: "ok" | "skipped" | "failed";
	}[];
	observed: {
		pathPresent: boolean;
		registrationPresent: boolean;
		branchPresent: boolean;
		receiptPresent: boolean;
	};
	branchDisposition: "deleted" | "kept-unmerged" | "skipped";
	completedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string" || field.length === 0) {
		throw new Error(`Detached teardown request has no valid ${key}.`);
	}
	return field;
}

function stringArray(value: unknown, key: string): string[] {
	if (
		!Array.isArray(value) ||
		!value.every((entry) => typeof entry === "string")
	) {
		throw new Error(`Detached teardown request has no valid ${key}.`);
	}
	return value;
}

function inventoryEntry(value: unknown): WorktreeInventoryEntry {
	if (!isRecord(value)) throw new Error("Invalid worktree inventory entry.");
	const kind = requiredString(value, "kind");
	const path = requiredString(value, "path");
	if (kind === "ignored") return { kind, path };
	if (kind === "status") {
		const status = requiredString(value, "status");
		const originalPath = value.originalPath;
		if (originalPath !== undefined && typeof originalPath !== "string") {
			throw new Error("Invalid original worktree inventory path.");
		}
		return {
			kind,
			status,
			path,
			...(originalPath === undefined ? {} : { originalPath }),
		};
	}
	if (kind === "index-flag") {
		const flags = stringArray(value.flags, "index flags");
		if (
			!flags.every(
				(flag) => flag === "assume-unchanged" || flag === "skip-worktree",
			)
		) {
			throw new Error("Invalid worktree index flag.");
		}
		return { kind, path, flags };
	}
	if (kind === "initialized-submodule") {
		return {
			kind,
			path,
			commit: requiredString(value, "commit"),
			state: requiredString(value, "state"),
		};
	}
	if (kind === "submodule-status") {
		return { kind, path, status: requiredString(value, "status") };
	}
	throw new Error(
		`Unknown worktree inventory kind: ${escapeForDisplay(kind)}.`,
	);
}

function safetySnapshot(value: unknown): WorktreeSafetySnapshot {
	if (!isRecord(value)) throw new Error("Invalid worktree safety snapshot.");
	if (!isRecord(value.identity)) {
		throw new Error("Invalid worktree safety identity.");
	}
	const branch = value.identity.branch;
	if (branch !== null && typeof branch !== "string") {
		throw new Error("Invalid worktree safety branch.");
	}
	if (!Array.isArray(value.protected) || !Array.isArray(value.ignored)) {
		throw new Error("Invalid worktree safety inventory.");
	}
	return normalizeSafetySnapshot({
		worktreePath: requiredString(value, "worktreePath"),
		administrativePath: requiredString(value, "administrativePath"),
		identity: {
			head: requiredString(value.identity, "head"),
			branch,
		},
		protected: value.protected.map(inventoryEntry),
		ignored: value.ignored.map(inventoryEntry),
		recoveryOids: stringArray(value.recoveryOids, "recoveryOids"),
	});
}

function parseRequest(value: unknown): DetachedTeardownRequestV1 {
	if (!isRecord(value) || value.schemaVersion !== 1) {
		throw new Error("Unsupported detached teardown request.");
	}
	if (!isRecord(value.expectedDestination)) {
		throw new Error("Invalid detached teardown destination.");
	}
	const request: DetachedTeardownRequestV1 = {
		schemaVersion: 1,
		operationId: requiredString(value, "operationId"),
		repoRoot: requiredString(value, "repoRoot"),
		worktreePath: requiredString(value, "worktreePath"),
		branch: requiredString(value, "branch"),
		expectedDestination: {
			path: requiredString(value.expectedDestination, "path"),
			branch: requiredString(value.expectedDestination, "branch"),
		},
		approvedSnapshot: safetySnapshot(value.approvedSnapshot),
		preRemove: stringArray(value.preRemove, "preRemove"),
		ownerFile: requiredString(value, "ownerFile"),
		receiptFile: requiredString(value, "receiptFile"),
		reportFile: requiredString(value, "reportFile"),
	};
	if (
		resolve(request.approvedSnapshot.worktreePath) !==
		resolve(request.worktreePath)
	) {
		throw new Error("Detached teardown snapshot names a different worktree.");
	}
	return request;
}

function writeJsonAtomic(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function writeDetachedTeardownRequest(
	file: string,
	request: DetachedTeardownRequestV1,
): void {
	const normalized = parseRequest(request);
	writeJsonAtomic(file, normalized);
}

function readDetachedTeardownRequest(file: string): DetachedTeardownRequestV1 {
	try {
		return parseRequest(JSON.parse(readFileSync(file, "utf8")));
	} catch (error) {
		throw new Error(
			`Cannot read detached teardown request ${escapeForDisplay(file)}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

function ownsClaim(
	request: DetachedTeardownRequestV1,
	waiterPid: number,
): boolean {
	try {
		const owner = JSON.parse(readFileSync(request.ownerFile, "utf8"));
		return (
			isRecord(owner) &&
			owner.operationId === request.operationId &&
			owner.pid === waiterPid &&
			owner.role === "waiter"
		);
	} catch {
		return false;
	}
}

function claimFailure(): WorktreeTeardownResult {
	return {
		status: "refused",
		reason: "claim-failed",
		message: "The detached waiter does not own this worktree claim.",
		changes: [],
		pathGone: false,
		registrationGone: false,
		branchDisposition: "not-attempted",
		details: [],
	};
}

function observedRegistration(request: DetachedTeardownRequestV1): boolean {
	const result = spawnSync("git", ["worktree", "list", "--porcelain", "-z"], {
		cwd: request.repoRoot,
		encoding: "utf8",
	});
	if (result.status !== 0 || !result.stdout.endsWith("\0")) return true;
	return result.stdout
		.split("\0")
		.some(
			(field) =>
				field.startsWith("worktree ") &&
				resolve(field.slice("worktree ".length)) ===
					resolve(request.worktreePath),
		);
}

function observedBranch(request: DetachedTeardownRequestV1): boolean {
	return (
		spawnSync(
			"git",
			["show-ref", "--verify", "--quiet", `refs/heads/${request.branch}`],
			{ cwd: request.repoRoot },
		).status === 0
	);
}

type StageStatus = DetachedTeardownReportV1["stages"][number]["status"];

function destinationStage(result: WorktreeTeardownResult): StageStatus {
	if (result.reason === "claim-failed") return "skipped";
	return result.reason === "destination-changed" ? "failed" : "ok";
}

function preRemoveStage(
	result: WorktreeTeardownResult,
	hasHooks: boolean,
): StageStatus {
	if (
		result.reason === "claim-failed" ||
		result.reason === "destination-changed"
	) {
		return "skipped";
	}
	if (result.reason === "hook-failed") return "failed";
	return hasHooks ? "ok" : "skipped";
}

function safetyStage(result: WorktreeTeardownResult): StageStatus {
	if (
		result.reason === "claim-failed" ||
		result.reason === "destination-changed" ||
		result.reason === "hook-failed"
	) {
		return "skipped";
	}
	if (
		result.reason === "inspection-failed" ||
		result.reason === "snapshot-changed"
	) {
		return "failed";
	}
	return "ok";
}

function removalStage(result: WorktreeTeardownResult): StageStatus {
	if (result.pathGone && result.registrationGone) return "ok";
	return result.reason === "removal-incomplete" ? "failed" : "skipped";
}

function branchStage(result: WorktreeTeardownResult): StageStatus {
	if (result.status === "complete") return "ok";
	return result.branchDisposition === "delete-failed" ? "failed" : "skipped";
}

function stageReport(
	result: WorktreeTeardownResult,
	hasHooks: boolean,
): DetachedTeardownReportV1["stages"] {
	return [
		{
			name: "claim",
			status: result.reason === "claim-failed" ? "failed" : "ok",
		},
		{ name: "destination", status: destinationStage(result) },
		{ name: "dirty", status: "skipped" },
		{ name: "pre-remove", status: preRemoveStage(result, hasHooks) },
		{ name: "dirty-recheck", status: safetyStage(result) },
		{ name: "remove", status: removalStage(result) },
		{ name: "branch", status: branchStage(result) },
	];
}

function reportBranchDisposition(
	result: WorktreeTeardownResult,
): DetachedTeardownReportV1["branchDisposition"] {
	if (
		result.branchDisposition === "deleted" ||
		result.branchDisposition === "absent"
	) {
		return "deleted";
	}
	if (result.branchDisposition === "kept-unmerged") return "kept-unmerged";
	return "skipped";
}

function buildReport(
	request: DetachedTeardownRequestV1,
	result: WorktreeTeardownResult,
): DetachedTeardownReportV1 {
	return {
		schemaVersion: 1,
		operationId: request.operationId,
		expectedDestination: request.expectedDestination,
		outcome: result.status,
		reason: result.reason,
		message: result.message,
		changes: result.changes,
		details: result.reason === "hook-failed" ? [] : result.details,
		stages: stageReport(result, request.preRemove.length > 0),
		observed: {
			pathPresent: existsSync(request.worktreePath),
			registrationPresent: observedRegistration(request),
			branchPresent: observedBranch(request),
			receiptPresent: existsSync(request.receiptFile),
		},
		branchDisposition: reportBranchDisposition(result),
		completedAt: new Date().toISOString(),
	};
}

export async function runDetachedTeardownRequest(
	requestFile: string,
	waiterPid: number,
): Promise<WorktreeTeardownResult> {
	const request = readDetachedTeardownRequest(requestFile);
	const claimOwned = ownsClaim(request, waiterPid);
	let result = claimFailure();
	if (claimOwned) {
		try {
			result = await executeWorktreeTeardown({
				repoRoot: request.repoRoot,
				worktreePath: request.worktreePath,
				branch: request.branch,
				mode: "dispose",
				approvedSnapshot: request.approvedSnapshot,
				expectedDestination: request.expectedDestination,
				preRemove: request.preRemove,
			});
		} catch (error) {
			result = {
				status: "refused",
				reason: "inspection-failed",
				message: `Detached teardown failed closed: ${error instanceof Error ? error.message : String(error)}`,
				changes: [],
				pathGone: false,
				registrationGone: false,
				branchDisposition: "not-attempted",
				details: [],
			};
		}
	}
	if (result.pathGone && result.registrationGone) {
		rmSync(request.receiptFile, { force: true });
	}
	const report = buildReport(request, result);
	writeJsonAtomic(request.reportFile, report);
	if (claimOwned) {
		rmSync(dirname(request.ownerFile), { recursive: true, force: true });
		rmSync(requestFile, { force: true });
	}
	return result;
}

async function runCli(): Promise<void> {
	const requestFile = process.argv[2];
	const waiterPid = Number(process.argv[3]);
	if (!requestFile || !Number.isSafeInteger(waiterPid) || waiterPid <= 0) {
		throw new Error(
			"Usage: node worktree-teardown.ts <request-file> <waiter-pid>",
		);
	}
	const result = await runDetachedTeardownRequest(requestFile, waiterPid);
	if (result.status !== "complete") process.exitCode = 1;
}

const entry = process.argv[1]
	? pathToFileURL(resolve(process.argv[1])).href
	: undefined;
if (entry === import.meta.url) {
	runCli().catch((error) => {
		process.stderr.write(
			`Detached teardown could not write authoritative evidence: ${escapeForDisplay(error instanceof Error ? error.message : String(error))}\n`,
		);
		process.exitCode = 2;
	});
}
