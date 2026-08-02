/**
 * Durable provisioning evidence for managed worktrees.
 *
 * A worktree becomes usable in stages: `git worktree add`, env linking, then
 * project hooks. A process that dies midway leaves a real checkout that was
 * never provisioned, and nothing in Git records that. These receipts record it,
 * so a later session refuses a half-built checkout instead of treating its
 * existence as proof it is ready.
 *
 * State lives in the repository's common Git administrative directory: it
 * survives restarts, is scoped to the repository, and never dirties a checkout.
 *
 * Concurrency is real here — this package exists to run several agents in
 * parallel — so every mutating operation takes a lifecycle claim first. The
 * claim is a directory, because `mkdir` is the portable atomic test-and-set.
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type { ProvisioningState } from "./worktree-transition.ts";

/** Layout version. A receipt written by a future layout is never guessed at. */
export const RECEIPT_SCHEMA_VERSION = 1 as const;
export const REPORT_SCHEMA_VERSION = 1 as const;

/**
 * How long a claim directory with no readable owner file is tolerated before it
 * may be reclaimed. It only occurs when a process died between creating the
 * directory and describing itself, so the window is generous relative to that
 * gap but short enough that a crash does not brick a branch name forever.
 */
export const ORPHAN_CLAIM_GRACE_MS = 30_000;

export type ProvisioningStage =
	| "git-worktree-add"
	| "link-env"
	| "post-create"
	| "complete";

export interface ProvisioningReceiptV1 {
	schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
	operationId: string;
	branch: string;
	worktreePath: string;
	base: string;
	state: "provisioning" | "ready" | "failed";
	stage: ProvisioningStage;
	/** Zero-based index of the post-create hook in flight or that failed. */
	postCreateIndex?: number;
	configDigest: string;
	startedAt: string;
	updatedAt: string;
	failure?: {
		code: "git-failed" | "hook-failed" | "receipt-write-failed";
		exitCode?: number;
	};
}

export interface TeardownReportV1 {
	schemaVersion: typeof REPORT_SCHEMA_VERSION;
	operationId: string;
	expectedDestination: { path: string; branch: string };
	stages: {
		name: string;
		status: "ok" | "skipped" | "failed";
		exitCode?: number;
	}[];
	observed: {
		pathPresent: boolean;
		registrationPresent: boolean;
		branchPresent: boolean;
		receiptPresent: boolean;
	};
	completedAt: string;
}

export interface ClaimOwner {
	operationId: string;
	pid: number;
	role: "origin" | "waiter";
}

interface StoredClaim extends ClaimOwner {
	createdAt: string;
}

/** Paths this module owns, rooted at the repository's common Git directory. */
export interface ReceiptStore {
	/** `<git-common-dir>/pi-worktree`. */
	root: string;
}

export function createStore(gitCommonDir: string): ReceiptStore {
	return { root: join(gitCommonDir, "pi-worktree") };
}

function provisioningDir(store: ReceiptStore): string {
	return join(store.root, "provisioning", "v1");
}

function transitionsDir(store: ReceiptStore): string {
	return join(store.root, "transitions", "v1");
}

/** Receipts are keyed by target path, so a reused path reuses its evidence. */
export function receiptKey(canonicalTargetPath: string): string {
	return sha256Hex(canonicalTargetPath);
}

export function receiptPath(
	store: ReceiptStore,
	canonicalTargetPath: string,
): string {
	return join(
		provisioningDir(store),
		`${receiptKey(canonicalTargetPath)}.json`,
	);
}

export function claimPath(
	store: ReceiptStore,
	canonicalTargetPath: string,
): string {
	return join(
		provisioningDir(store),
		`${receiptKey(canonicalTargetPath)}.claim`,
	);
}

export function reportPath(store: ReceiptStore, operationId: string): string {
	return join(transitionsDir(store), `${encodeURIComponent(operationId)}.json`);
}

// ---------------------------------------------------------------------------
// Canonical encoding
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted at every depth.
 *
 * The successor compares a receipt hash taken by another process, so identity
 * must not depend on key insertion order or formatting.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object")
		return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => compareKeys(a, b))
		.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
	return `{${entries.join(",")}}`;
}

function compareKeys(a: string, b: string): number {
	if (a < b) return -1;
	return a > b ? 1 : 0;
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Hash used to prove a ready receipt was not replaced mid-transition. */
export function receiptHash(receipt: ProvisioningReceiptV1): string {
	return sha256Hex(canonicalJson(receipt));
}

/**
 * Audit digest of the provisioning configuration in force at creation time.
 *
 * Only the inputs that decide what provisioning does are included; a later
 * config change is recorded history, not grounds to invalidate a ready
 * checkout, so this is never compared for equality during enter.
 */
export function configDigest(config: {
	linkEnvFiles?: boolean;
	postCreate?: string[];
}): string {
	return sha256Hex(
		canonicalJson({
			linkEnvFiles: config.linkEnvFiles !== false,
			postCreate: config.postCreate ?? [],
		}),
	);
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function flushDir(dir: string): void {
	// Renames are only durable once the directory entry is flushed. Not every
	// platform allows opening a directory; a failure here costs durability on
	// power loss, never correctness in the running process.
	try {
		const fd = openSync(dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		// best-effort
	}
}

function writeFileAtomic(target: string, contents: string, dir: string): void {
	ensureDir(dir);
	const tmp = join(
		dir,
		`.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	const fd = openSync(tmp, "wx", 0o600);
	try {
		writeSync(fd, contents);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, target);
	flushDir(dir);
}

// ---------------------------------------------------------------------------
// Lifecycle claims
// ---------------------------------------------------------------------------

export type ClaimResult =
	| { ok: true; owner: ClaimOwner }
	| { ok: false; code: "target-busy"; reason: string; heldBy?: ClaimOwner };

/**
 * Whether a process is definitely gone.
 *
 * `EPERM` means the PID exists but belongs to someone else, which is ambiguous
 * — it could be the real owner or an unrelated recycled PID — so it counts as
 * alive and the caller fails closed rather than stealing a live claim.
 */
export function isProcessGone(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
}

function readClaim(dir: string): StoredClaim | null {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, "owner.json"), "utf-8"));
		if (
			parsed &&
			typeof parsed.operationId === "string" &&
			typeof parsed.pid === "number" &&
			(parsed.role === "origin" || parsed.role === "waiter")
		) {
			return parsed as StoredClaim;
		}
	} catch {
		// unreadable or malformed: treated as an in-progress or damaged claim
	}
	return null;
}

function writeClaimOwner(dir: string, owner: ClaimOwner): void {
	writeFileAtomic(
		join(dir, "owner.json"),
		canonicalJson({ ...owner, createdAt: new Date().toISOString() }),
		dir,
	);
}

/**
 * Take exclusive ownership of a target's lifecycle.
 *
 * `mkdir` is the atomic step: exactly one concurrent caller creates the
 * directory, and every other caller sees EEXIST and is told the target is busy.
 */
export function acquireClaim(
	store: ReceiptStore,
	canonicalTargetPath: string,
	owner: ClaimOwner,
): ClaimResult {
	const dir = claimPath(store, canonicalTargetPath);
	ensureDir(provisioningDir(store));
	try {
		mkdirSync(dir, { mode: 0o700 });
		writeClaimOwner(dir, owner);
		return { ok: true, owner };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}

	const held = readClaim(dir);
	if (held && isProcessGone(held.pid)) {
		writeClaimOwner(dir, owner);
		return { ok: true, owner };
	}
	if (!held && orphanedLongerThanGrace(dir)) {
		writeClaimOwner(dir, owner);
		return { ok: true, owner };
	}
	return {
		ok: false,
		code: "target-busy",
		reason: held
			? `Another worktree operation (pid ${held.pid}) holds this target.`
			: "Another worktree operation is claiming this target.",
		...(held
			? {
					heldBy: {
						operationId: held.operationId,
						pid: held.pid,
						role: held.role,
					},
				}
			: {}),
	};
}

function orphanedLongerThanGrace(dir: string): boolean {
	try {
		return Date.now() - statSync(dir).mtimeMs > ORPHAN_CLAIM_GRACE_MS;
	} catch {
		return false;
	}
}

/**
 * Confirm the complete owner tuple still matches.
 *
 * Operation id alone is not enough: a live-dispose waiter shares its origin's
 * operation id, so only pid and role distinguish an armed waiter from an origin
 * whose ownership transfer never persisted.
 */
export function verifyClaim(
	store: ReceiptStore,
	canonicalTargetPath: string,
	owner: ClaimOwner,
): boolean {
	const held = readClaim(claimPath(store, canonicalTargetPath));
	return (
		held !== null &&
		held.operationId === owner.operationId &&
		held.pid === owner.pid &&
		held.role === owner.role
	);
}

/** Hand ownership to another process, which must already exist. */
export function transferClaim(
	store: ReceiptStore,
	canonicalTargetPath: string,
	from: ClaimOwner,
	to: ClaimOwner,
): boolean {
	if (!verifyClaim(store, canonicalTargetPath, from)) return false;
	try {
		writeClaimOwner(claimPath(store, canonicalTargetPath), to);
	} catch {
		return false;
	}
	return verifyClaim(store, canonicalTargetPath, to);
}

export function releaseClaim(
	store: ReceiptStore,
	canonicalTargetPath: string,
	owner: ClaimOwner,
): boolean {
	if (!verifyClaim(store, canonicalTargetPath, owner)) return false;
	rmSync(claimPath(store, canonicalTargetPath), {
		recursive: true,
		force: true,
	});
	return true;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export type ReceiptRead =
	| { kind: "absent" }
	| { kind: "corrupt"; reason: string }
	| { kind: "present"; receipt: ProvisioningReceiptV1; hash: string };

export function readReceipt(
	store: ReceiptStore,
	canonicalTargetPath: string,
): ReceiptRead {
	const file = receiptPath(store, canonicalTargetPath);
	if (!existsSync(file)) return { kind: "absent" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf-8"));
	} catch {
		return { kind: "corrupt", reason: "receipt is not valid JSON" };
	}
	const invalid = receiptShapeError(parsed);
	if (invalid) return { kind: "corrupt", reason: invalid };
	const receipt = parsed as ProvisioningReceiptV1;
	return { kind: "present", receipt, hash: receiptHash(receipt) };
}

function receiptShapeError(value: unknown): string | null {
	if (!value || typeof value !== "object") return "receipt is not an object";
	const r = value as Partial<ProvisioningReceiptV1>;
	if (r.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
		return `unsupported receipt schemaVersion ${String(r.schemaVersion)}`;
	}
	for (const field of [
		"operationId",
		"branch",
		"worktreePath",
		"base",
		"configDigest",
	] as const) {
		if (typeof r[field] !== "string" || r[field] === "")
			return `receipt is missing ${field}`;
	}
	if (
		r.state !== "provisioning" &&
		r.state !== "ready" &&
		r.state !== "failed"
	) {
		return `unknown receipt state ${String(r.state)}`;
	}
	if (r.state === "ready" && r.stage !== "complete") {
		return "receipt claims ready without completing provisioning";
	}
	if (r.state !== "ready" && r.stage === "complete") {
		return "receipt is complete without being ready";
	}
	return null;
}

/**
 * Classify a target for the planner.
 *
 * A receipt describing a different branch or path is not evidence about this
 * target, so it is corrupt rather than ignored: silently discarding it would
 * let a stale record hide a real half-provisioned checkout.
 */
export function classifyProvisioning(
	read: ReceiptRead,
	expected: { worktreePath: string; branch?: string },
): ProvisioningState | "corrupt" {
	if (read.kind === "absent") return "unmanaged";
	if (read.kind === "corrupt") return "corrupt";
	if (read.receipt.worktreePath !== expected.worktreePath) return "corrupt";
	if (expected.branch && read.receipt.branch !== expected.branch)
		return "corrupt";
	return read.receipt.state;
}

export interface ReceiptWriteResult {
	ok: boolean;
	code?: "receipt-write-failed";
	reason?: string;
	hash?: string;
}

/** Persist a receipt, refusing if this operation no longer owns the target. */
export function writeReceipt(
	store: ReceiptStore,
	owner: ClaimOwner,
	receipt: ProvisioningReceiptV1,
): ReceiptWriteResult {
	if (!verifyClaim(store, receipt.worktreePath, owner)) {
		return {
			ok: false,
			code: "receipt-write-failed",
			reason: "this operation no longer holds the target's lifecycle claim",
		};
	}
	try {
		writeFileAtomic(
			receiptPath(store, receipt.worktreePath),
			canonicalJson(receipt),
			provisioningDir(store),
		);
	} catch (err) {
		return {
			ok: false,
			code: "receipt-write-failed",
			reason: (err as Error).message,
		};
	}
	return { ok: true, hash: receiptHash(receipt) };
}

export function removeReceipt(
	store: ReceiptStore,
	canonicalTargetPath: string,
): void {
	rmSync(receiptPath(store, canonicalTargetPath), { force: true });
}

export function newReceipt(input: {
	operationId: string;
	branch: string;
	worktreePath: string;
	base: string;
	configDigest: string;
	now?: string;
}): ProvisioningReceiptV1 {
	const now = input.now ?? new Date().toISOString();
	return {
		schemaVersion: RECEIPT_SCHEMA_VERSION,
		operationId: input.operationId,
		branch: input.branch,
		worktreePath: input.worktreePath,
		base: input.base,
		state: "provisioning",
		stage: "git-worktree-add",
		configDigest: input.configDigest,
		startedAt: now,
		updatedAt: now,
	};
}

export function advanceReceipt(
	receipt: ProvisioningReceiptV1,
	stage: ProvisioningStage,
	postCreateIndex?: number,
): ProvisioningReceiptV1 {
	return {
		...receipt,
		stage,
		...(postCreateIndex === undefined ? {} : { postCreateIndex }),
		updatedAt: new Date().toISOString(),
	};
}

export function readyReceipt(
	receipt: ProvisioningReceiptV1,
): ProvisioningReceiptV1 {
	const { postCreateIndex: _dropped, failure: _cleared, ...rest } = receipt;
	return {
		...rest,
		state: "ready",
		stage: "complete",
		updatedAt: new Date().toISOString(),
	};
}

export function failedReceipt(
	receipt: ProvisioningReceiptV1,
	failure: NonNullable<ProvisioningReceiptV1["failure"]>,
): ProvisioningReceiptV1 {
	return {
		...receipt,
		state: "failed",
		failure,
		updatedAt: new Date().toISOString(),
	};
}

/**
 * Whether a leftover receipt may be dropped so a clean name is reusable.
 *
 * Every trace the receipt describes must be gone. The branch checked is the one
 * the *stale receipt* recorded, not the branch now being requested: the receipt
 * is evidence about its own operation, and a surviving branch from that
 * operation still needs a human decision.
 */
export function canDiscardStaleReceipt(
	read: ReceiptRead,
	observed: {
		pathPresent: boolean;
		registrationPresent: boolean;
		recordedBranchPresent: boolean;
	},
): boolean {
	if (read.kind === "absent") return true;
	if (observed.pathPresent || observed.registrationPresent) return false;
	return !observed.recordedBranchPresent;
}

// ---------------------------------------------------------------------------
// Teardown reports
// ---------------------------------------------------------------------------

/**
 * Record what a detached teardown actually did.
 *
 * The process that ran teardown is gone by the time anyone can ask, so its
 * successor reads this instead of assuming that scheduling implied success.
 */
export function writeTeardownReport(
	store: ReceiptStore,
	report: TeardownReportV1,
): boolean {
	try {
		writeFileAtomic(
			reportPath(store, report.operationId),
			canonicalJson(report),
			transitionsDir(store),
		);
		return true;
	} catch {
		return false;
	}
}

export type ReportRead =
	| { kind: "absent" }
	| { kind: "corrupt"; reason: string }
	| { kind: "present"; report: TeardownReportV1 };

export function readTeardownReport(
	store: ReceiptStore,
	operationId: string,
): ReportRead {
	const file = reportPath(store, operationId);
	if (!existsSync(file)) return { kind: "absent" };
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8"));
		if (
			parsed?.schemaVersion !== REPORT_SCHEMA_VERSION ||
			typeof parsed.operationId !== "string"
		) {
			return { kind: "corrupt", reason: "unsupported teardown report" };
		}
		return { kind: "present", report: parsed as TeardownReportV1 };
	} catch {
		return { kind: "corrupt", reason: "teardown report is not valid JSON" };
	}
}

export function removeTeardownReport(
	store: ReceiptStore,
	operationId: string,
): void {
	rmSync(reportPath(store, operationId), { force: true });
}
