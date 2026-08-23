import { spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	type Stats,
} from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";

export type IndexFlag = "assume-unchanged" | "skip-worktree";

export type WorktreeInventoryEntry =
	| {
			kind: "status";
			status: string;
			path: string;
			originalPath?: string;
	  }
	| { kind: "ignored"; path: string }
	| { kind: "index-flag"; path: string; flags: IndexFlag[] }
	| {
			kind: "initialized-submodule";
			path: string;
			commit: string;
			state: string;
	  }
	| { kind: "submodule-status"; path: string; status: string };

export interface WorktreeSafetySnapshot {
	worktreePath: string;
	administrativePath: string;
	identity: {
		head: string;
		branch: string | null;
	};
	protected: WorktreeInventoryEntry[];
	ignored: WorktreeInventoryEntry[];
	recoveryOids: string[];
}

export class WorktreeSafetyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorktreeSafetyError";
	}
}

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
	killed: boolean;
}

export interface GitRunOptions {
	cwd: string;
	input?: string;
	timeout?: number;
}

export type GitRunner = (
	args: readonly string[],
	options: GitRunOptions,
) => Promise<GitResult>;

const GIT_TIMEOUT_MS = 10_000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

const nodeGitRunner: GitRunner = (args, options) =>
	new Promise((resolveGit, rejectGit) => {
		const child = spawn("git", [...args], {
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let timedOut = false;
		let overflow = false;
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback();
		};
		const collect = (target: Buffer[]) => (chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
				overflow = true;
				child.kill("SIGTERM");
				return;
			}
			target.push(chunk);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, options.timeout ?? GIT_TIMEOUT_MS);
		child.stdout.on("data", collect(stdout));
		child.stderr.on("data", collect(stderr));
		child.on("error", (error) =>
			finish(() =>
				rejectGit(
					new WorktreeSafetyError(`Could not start Git: ${error.message}`),
				),
			),
		);
		child.on("close", (code, signal) =>
			finish(() => {
				if (overflow) {
					rejectGit(new WorktreeSafetyError("Git output exceeded 16 MiB."));
					return;
				}
				resolveGit({
					code: code ?? 1,
					stdout: Buffer.concat(stdout).toString("utf8"),
					stderr: Buffer.concat(stderr).toString("utf8"),
					killed: timedOut || signal !== null,
				});
			}),
		);
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EPIPE") return;
			finish(() =>
				rejectGit(
					new WorktreeSafetyError(
						`Could not write Git input: ${error.message}`,
					),
				),
			);
		});
		child.stdin.end(options.input ?? "");
	});

function splitTerminated(
	value: string,
	separator: string,
	source: string,
): string[] {
	if (!value) return [];
	if (!value.endsWith(separator)) {
		throw new WorktreeSafetyError(`${source} output is not terminated.`);
	}
	const fields = value.split(separator);
	fields.pop();
	return fields;
}

function normalizedOid(value: string, source: string): string | null {
	if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u.test(value)) {
		throw new WorktreeSafetyError(`${source} contains an invalid object ID.`);
	}
	if (/^0+$/u.test(value)) return null;
	return value.toLowerCase();
}

function uniqueInOrder(values: string[]): string[] {
	return [...new Set(values)];
}

function compareStrings(left: string, right: string): number {
	return left.localeCompare(right);
}

function nonEmptyLines(value: string, source: string): string[] {
	if (!value) return [];
	const lines = value.split(/\r?\n/u);
	if (lines.at(-1) === "") lines.pop();
	if (lines.some((line) => line.length === 0)) {
		throw new WorktreeSafetyError(`${source} contains an empty record.`);
	}
	return lines;
}

/** Parse `git status --porcelain=v1 -z`; rename records consume two fields. */
export function parsePorcelainInventory(value: string): {
	protected: WorktreeInventoryEntry[];
	ignored: WorktreeInventoryEntry[];
} {
	const fields = splitTerminated(value, "\0", "Git porcelain");
	const protectedEntries: WorktreeInventoryEntry[] = [];
	const ignored: WorktreeInventoryEntry[] = [];
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index] ?? "";
		if (field.length < 4 || field[2] !== " ") {
			throw new WorktreeSafetyError(
				"Git porcelain contains a malformed record.",
			);
		}
		const status = field.slice(0, 2);
		if (!/^(?:\?\?|!!|[ MADRCUT][ MADRCUT])$/u.test(status)) {
			throw new WorktreeSafetyError(
				`Git porcelain contains an invalid status ${JSON.stringify(status)}.`,
			);
		}
		const path = field.slice(3);
		if (!path) {
			throw new WorktreeSafetyError("Git porcelain contains an empty path.");
		}
		if (status === "!!") {
			ignored.push({ kind: "ignored", path });
			continue;
		}
		if (status.includes("R") || status.includes("C")) {
			const originalPath = fields[++index];
			if (!originalPath) {
				throw new WorktreeSafetyError(
					"Git porcelain rename or copy record has no original path.",
				);
			}
			protectedEntries.push({
				kind: "status",
				status,
				path,
				originalPath,
			});
			continue;
		}
		protectedEntries.push({ kind: "status", status, path });
	}
	return { protected: protectedEntries, ignored };
}

export function parseIndexFlagEntries(value: string): WorktreeInventoryEntry[] {
	const fields = splitTerminated(value, "\0", "Git index flag");
	const entries: WorktreeInventoryEntry[] = [];
	for (const field of fields) {
		if (
			field.length < 3 ||
			field[1] !== " " ||
			!/^[A-Za-z?]$/u.test(field[0] ?? "")
		) {
			throw new WorktreeSafetyError("Git index flag output is malformed.");
		}
		const tag = field[0] ?? "";
		const path = field.slice(2);
		if (!path) {
			throw new WorktreeSafetyError(
				"Git index flag output contains an empty path.",
			);
		}
		const flags: IndexFlag[] = [];
		if (/[a-z]/u.test(tag)) flags.push("assume-unchanged");
		if (tag.toUpperCase() === "S") flags.push("skip-worktree");
		if (flags.length > 0) entries.push({ kind: "index-flag", path, flags });
	}
	return entries;
}

async function runGit(
	runner: GitRunner,
	args: readonly string[],
	cwd: string,
	input?: string,
): Promise<string> {
	const result = await runner(args, {
		cwd,
		...(input === undefined ? {} : { input }),
	});
	if (result.killed) {
		throw new WorktreeSafetyError(
			`git ${args.slice(0, 2).join(" ")} timed out.`,
		);
	}
	if (result.code !== 0) {
		const detail = escapeForDisplay(
			(result.stderr || result.stdout).trim() || `exit ${result.code}`,
		);
		throw new WorktreeSafetyError(
			`git ${args.slice(0, 2).join(" ")} failed: ${detail}`,
		);
	}
	return result.stdout;
}

function parseNulPaths(value: string, source: string): string[] {
	const paths = splitTerminated(value, "\0", source);
	if (paths.some((path) => !path)) {
		throw new WorktreeSafetyError(`${source} contains an empty path.`);
	}
	return paths;
}

async function sparseManagedPaths(
	runner: GitRunner,
	cwd: string,
	candidates: readonly string[],
): Promise<ReadonlySet<string>> {
	if (candidates.length === 0) return new Set();
	const configArgs = ["config", "--bool", "--get", "core.sparseCheckout"];
	const config = await runner(configArgs, { cwd });
	if (config.killed) {
		throw new WorktreeSafetyError("git config sparseCheckout timed out.");
	}
	if (config.code === 1 || config.stdout.trim() === "false") return new Set();
	if (config.code !== 0 || config.stdout.trim() !== "true") {
		throw new WorktreeSafetyError(
			"Git could not determine whether sparse checkout is active.",
		);
	}
	const checkArgs = ["sparse-checkout", "check-rules", "-z"];
	const result = await runner(checkArgs, {
		cwd,
		input: `${candidates.join("\0")}\0`,
	});
	if (result.killed || result.code !== 0) {
		throw new WorktreeSafetyError(
			`git sparse-checkout check-rules failed: ${escapeForDisplay((result.stderr || result.stdout).trim() || `exit ${result.code}`)}`,
		);
	}
	const candidateSet = new Set(candidates);
	const included = new Set(parseNulPaths(result.stdout, "Git sparse rule"));
	for (const path of included) {
		if (!candidateSet.has(path)) {
			throw new WorktreeSafetyError(
				"Git sparse rule output contains an unexpected path.",
			);
		}
	}
	return new Set(candidates.filter((path) => !included.has(path)));
}

async function inspectStatusAndIndex(
	cwd: string,
	runner: GitRunner,
): Promise<{
	protected: WorktreeInventoryEntry[];
	ignored: WorktreeInventoryEntry[];
}> {
	const status = parsePorcelainInventory(
		await runGit(
			runner,
			[
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=all",
				"--ignored=matching",
				"--ignore-submodules=none",
			],
			cwd,
		),
	);
	const indexEntries = parseIndexFlagEntries(
		await runGit(runner, ["ls-files", "-v", "-z"], cwd),
	);
	const skipPaths = indexEntries.flatMap((entry) =>
		entry.kind === "index-flag" && entry.flags.includes("skip-worktree")
			? [entry.path]
			: [],
	);
	const sparseManaged = await sparseManagedPaths(runner, cwd, skipPaths);
	const visibleIndexEntries: WorktreeInventoryEntry[] = [];
	for (const entry of indexEntries) {
		if (entry.kind !== "index-flag") {
			visibleIndexEntries.push(entry);
			continue;
		}
		const flags = entry.flags.filter(
			(flag) => flag !== "skip-worktree" || !sparseManaged.has(entry.path),
		);
		if (flags.length > 0) visibleIndexEntries.push({ ...entry, flags });
	}
	return {
		protected: [...status.protected, ...visibleIndexEntries],
		ignored: status.ignored,
	};
}

function submodulePath(root: string, path: string): string {
	const absolute = resolve(root, path);
	const local = relative(root, absolute);
	if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
		throw new WorktreeSafetyError(
			"Git returned a submodule path outside the worktree.",
		);
	}
	return absolute;
}

function prefixInventoryEntry(
	prefix: string,
	entry: WorktreeInventoryEntry,
): WorktreeInventoryEntry {
	const path = posix.join(prefix, entry.path);
	if (entry.kind === "status") {
		return {
			...entry,
			path,
			...(entry.originalPath === undefined
				? {}
				: { originalPath: posix.join(prefix, entry.originalPath) }),
		};
	}
	return { ...entry, path };
}

export async function inspectWorktreeInventory(
	worktreePath: string,
	options: { runner?: GitRunner } = {},
): Promise<{
	protected: WorktreeInventoryEntry[];
	ignored: WorktreeInventoryEntry[];
}> {
	const runner = options.runner ?? nodeGitRunner;
	const inventory = await inspectStatusAndIndex(worktreePath, runner);
	const submodulePaths = parseNulPaths(
		await runGit(
			runner,
			[
				"submodule",
				"foreach",
				"--recursive",
				"--quiet",
				`printf '%s\\0' "$displaypath"`,
			],
			worktreePath,
		),
		"Git submodule",
	);
	for (const path of submodulePaths) {
		const cwd = submodulePath(worktreePath, path);
		const headLines = parseOidLines(
			await runGit(runner, ["rev-parse", "HEAD"], cwd),
			`submodule ${path} HEAD`,
		);
		if (headLines.length !== 1) {
			throw new WorktreeSafetyError(
				`Submodule ${escapeForDisplay(path)} has no unique HEAD object.`,
			);
		}
		inventory.protected.push({
			kind: "initialized-submodule",
			path,
			commit: headLines[0] ?? "",
			state: "initialized",
		});
		const nested = await inspectStatusAndIndex(cwd, runner);
		inventory.protected.push(
			...nested.protected.map((entry) => prefixInventoryEntry(path, entry)),
		);
		inventory.ignored.push(
			...nested.ignored.map((entry) => prefixInventoryEntry(path, entry)),
		);
	}
	return {
		protected: normalizeInventory(inventory.protected),
		ignored: normalizeInventory(inventory.ignored),
	};
}

export interface AdministrativeRecoveryInspection {
	administrativePath: string;
	identity: WorktreeSafetySnapshot["identity"];
	recoveryOids: string[];
}

function nodeErrorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

function inspectAdministrativeEntry(path: string): Stats {
	try {
		const stat = lstatSync(path);
		if (!stat) {
			throw new WorktreeSafetyError(
				`Administrative history entry disappeared: ${escapeForDisplay(path)}.`,
			);
		}
		return stat;
	} catch (error) {
		throw new WorktreeSafetyError(
			`Cannot inspect administrative history entry ${escapeForDisplay(path)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function readAdministrativeFile(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	const stat = inspectAdministrativeEntry(path);
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new WorktreeSafetyError(
			`Unexpected administrative history entry: ${escapeForDisplay(path)}.`,
		);
	}
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new WorktreeSafetyError(
			`Cannot read administrative history entry ${escapeForDisplay(path)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function readReflogTree(directory: string): string[] {
	if (!existsSync(directory)) return [];
	const stat = inspectAdministrativeEntry(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new WorktreeSafetyError(
			`Unexpected administrative history entry: ${escapeForDisplay(directory)}.`,
		);
	}
	let names: string[];
	try {
		names = readdirSync(directory).sort(compareStrings);
	} catch (error) {
		throw new WorktreeSafetyError(
			`Cannot read administrative history directory ${escapeForDisplay(directory)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const oids: string[] = [];
	for (const name of names) {
		const path = join(directory, name);
		const entry = inspectAdministrativeEntry(path);
		if (entry.isSymbolicLink()) {
			throw new WorktreeSafetyError(
				`Unexpected administrative history entry: ${escapeForDisplay(path)}.`,
			);
		}
		if (entry.isDirectory()) {
			oids.push(...readReflogTree(path));
			continue;
		}
		if (!entry.isFile()) {
			throw new WorktreeSafetyError(
				`Unexpected administrative history entry: ${escapeForDisplay(path)}.`,
			);
		}
		const contents = readAdministrativeFile(path);
		if (contents !== undefined) oids.push(...parseReflogOids(contents, path));
	}
	return oids;
}

function singleLine(value: string, source: string): string {
	const lines = nonEmptyLines(value, source);
	if (lines.length !== 1) {
		throw new WorktreeSafetyError(`${source} did not return one value.`);
	}
	return lines[0] ?? "";
}

async function symbolicHead(
	runner: GitRunner,
	worktreePath: string,
): Promise<string | null> {
	const result = await runner(["symbolic-ref", "-q", "HEAD"], {
		cwd: worktreePath,
	});
	if (result.killed) {
		throw new WorktreeSafetyError("git symbolic-ref HEAD timed out.");
	}
	if (result.code === 1) return null;
	if (result.code !== 0) {
		throw new WorktreeSafetyError(
			`git symbolic-ref HEAD failed: ${escapeForDisplay((result.stderr || result.stdout).trim() || `exit ${result.code}`)}`,
		);
	}
	const ref = singleLine(result.stdout, "git symbolic-ref HEAD");
	if (!ref.startsWith("refs/")) {
		throw new WorktreeSafetyError("Git returned an invalid symbolic HEAD ref.");
	}
	return ref;
}

async function administrativeCandidates(
	runner: GitRunner,
	worktreePath: string,
	administrativePath: string,
): Promise<string[]> {
	const candidates = readReflogTree(join(administrativePath, "logs"));
	const refs = await runGit(
		runner,
		[
			`--git-dir=${administrativePath}`,
			"for-each-ref",
			"--format=%(objectname)",
			"refs/worktree",
			"refs/bisect",
		],
		worktreePath,
	);
	candidates.push(...parseOidLines(refs, "per-worktree refs"));
	for (const name of [
		"ORIG_HEAD",
		"MERGE_HEAD",
		"REBASE_HEAD",
		"CHERRY_PICK_HEAD",
		"REVERT_HEAD",
		"BISECT_HEAD",
	]) {
		const contents = readAdministrativeFile(join(administrativePath, name));
		if (contents !== undefined) {
			candidates.push(...parseOidLines(contents, name));
		}
	}
	const fetchHead = readAdministrativeFile(
		join(administrativePath, "FETCH_HEAD"),
	);
	if (fetchHead !== undefined)
		candidates.push(...parseFetchHeadOids(fetchHead));
	return [...new Set(candidates)].sort(compareStrings);
}

async function isDurablyReachable(
	runner: GitRunner,
	worktreePath: string,
	oid: string,
): Promise<boolean> {
	const output = await runGit(
		runner,
		[
			"for-each-ref",
			"--format=%(refname)",
			`--contains=${oid}`,
			"refs/heads",
			"refs/tags",
			"refs/remotes",
		],
		worktreePath,
	);
	for (const ref of nonEmptyLines(output, `durable refs containing ${oid}`)) {
		if (!/^refs\/(?:heads|tags|remotes)\/.+/u.test(ref)) {
			throw new WorktreeSafetyError(
				"Git returned an unexpected durable ref name.",
			);
		}
		return true;
	}
	return false;
}

export async function inspectAdministrativeRecovery(
	worktreePath: string,
	options: { runner?: GitRunner } = {},
): Promise<AdministrativeRecoveryInspection> {
	const runner = options.runner ?? nodeGitRunner;
	const gitDirOutput = await runGit(
		runner,
		["rev-parse", "--path-format=absolute", "--git-dir"],
		worktreePath,
	);
	const gitDir = singleLine(gitDirOutput, "git rev-parse --git-dir");
	let administrativePath: string;
	try {
		administrativePath = realpathSync(resolve(worktreePath, gitDir));
	} catch (error) {
		if (nodeErrorCode(error) === "ENOENT") {
			throw new WorktreeSafetyError(
				"Git returned a missing worktree administrative directory.",
			);
		}
		throw new WorktreeSafetyError(
			`Cannot resolve the worktree administrative directory: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const headValues = parseOidLines(
		await runGit(runner, ["rev-parse", "HEAD"], worktreePath),
		"worktree HEAD",
	);
	if (headValues.length !== 1) {
		throw new WorktreeSafetyError(
			"Git did not return one worktree HEAD object.",
		);
	}
	const head = headValues[0];
	if (!head) {
		throw new WorktreeSafetyError("Git did not return a worktree HEAD object.");
	}
	const administrative = await administrativeCandidates(
		runner,
		worktreePath,
		administrativePath,
	);
	const candidates = [...new Set([head, ...administrative])].sort(
		compareStrings,
	);
	const recoveryOids: string[] = [];
	for (const oid of candidates) {
		if (!(await isDurablyReachable(runner, worktreePath, oid))) {
			recoveryOids.push(oid);
		}
	}
	return {
		administrativePath,
		identity: {
			head,
			branch: await symbolicHead(runner, worktreePath),
		},
		recoveryOids,
	};
}

export async function inspectWorktreeSafety(
	worktreePath: string,
	options: { runner?: GitRunner } = {},
): Promise<WorktreeSafetySnapshot> {
	let canonicalPath: string;
	try {
		canonicalPath = realpathSync(worktreePath);
	} catch (error) {
		throw new WorktreeSafetyError(
			`Cannot resolve worktree path ${escapeForDisplay(worktreePath)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const [inventory, recovery] = await Promise.all([
		inspectWorktreeInventory(canonicalPath, options),
		inspectAdministrativeRecovery(canonicalPath, options),
	]);
	return normalizeSafetySnapshot({
		worktreePath: canonicalPath,
		administrativePath: recovery.administrativePath,
		identity: recovery.identity,
		protected: inventory.protected,
		ignored: inventory.ignored,
		recoveryOids: recovery.recoveryOids,
	});
}

function formattedEntries(
	entries: readonly WorktreeInventoryEntry[],
): string[] {
	return entries.map((entry) => `- ${formatInventoryEntry(entry)}`);
}

export function disposeSafetyReason(
	snapshot: WorktreeSafetySnapshot,
): string | null {
	const normalized = normalizeSafetySnapshot(snapshot);
	if (
		normalized.protected.length === 0 &&
		normalized.ignored.length === 0 &&
		normalized.recoveryOids.length === 0
	) {
		return null;
	}
	const lines = [
		`Refusing to dispose ${escapeForDisplay(normalized.worktreePath)} because removal would discard worktree-local or recovery data.`,
	];
	if (normalized.protected.length > 0) {
		lines.push(
			"Protected worktree data:",
			...formattedEntries(normalized.protected),
		);
	}
	if (normalized.ignored.length > 0) {
		lines.push(
			"Ignored worktree data:",
			...formattedEntries(normalized.ignored),
		);
	}
	if (normalized.recoveryOids.length > 0) {
		lines.push(
			"Recovery-only commits not contained by a local branch, tag, or remote-tracking ref:",
			...normalized.recoveryOids.map((oid) => `- ${oid}`),
		);
	}
	lines.push(
		"Commit, remove, or move local data and preserve each recovery commit with a branch or tag before retrying.",
	);
	return lines.join("\n");
}

export function formatDestroyConfirmation(
	snapshot: WorktreeSafetySnapshot,
	branch: string,
): { title: string; body: string } {
	const normalized = normalizeSafetySnapshot(snapshot);
	const hasLocalData =
		normalized.protected.length > 0 || normalized.ignored.length > 0;
	const hasRecoveryData = normalized.recoveryOids.length > 0;
	let title = "Destroy worktree";
	if (hasLocalData && hasRecoveryData) {
		title = "Destroy worktree and discard local and recovery data";
	} else if (hasLocalData) {
		title = "Destroy worktree and discard local data";
	} else if (hasRecoveryData) {
		title = "Destroy worktree and discard recovery history";
	}
	const lines = [
		`Remove ${escapeForDisplay(normalized.worktreePath)} and hard-delete branch ${escapeForDisplay(branch)}?`,
	];
	if (normalized.protected.length > 0) {
		lines.push(
			"Protected worktree data:",
			...formattedEntries(normalized.protected),
		);
	}
	if (normalized.ignored.length > 0) {
		lines.push(
			"Ignored worktree data:",
			...formattedEntries(normalized.ignored),
		);
	}
	if (hasRecoveryData) {
		lines.push(
			"Recovery-only commits whose administrative pointers will be removed and may later be garbage-collected:",
			...normalized.recoveryOids.map((oid) => `- ${oid}`),
		);
	}
	if (!hasLocalData && !hasRecoveryData) {
		lines.push("No protected, ignored, or recovery-only state was found.");
	}
	return { title, body: lines.join("\n") };
}

export function describeSafetySnapshotChanges(
	approved: WorktreeSafetySnapshot,
	current: WorktreeSafetySnapshot,
): string[] {
	const left = normalizeSafetySnapshot(approved);
	const right = normalizeSafetySnapshot(current);
	const changes: string[] = [];
	if (
		left.worktreePath !== right.worktreePath ||
		left.administrativePath !== right.administrativePath ||
		JSON.stringify(left.identity) !== JSON.stringify(right.identity)
	) {
		changes.push("worktree identity");
	}
	if (JSON.stringify(left.protected) !== JSON.stringify(right.protected)) {
		changes.push("protected inventory");
	}
	if (JSON.stringify(left.ignored) !== JSON.stringify(right.ignored)) {
		changes.push("ignored inventory");
	}
	if (
		JSON.stringify(left.recoveryOids) !== JSON.stringify(right.recoveryOids)
	) {
		changes.push("recovery history");
	}
	return changes;
}

export function parseReflogOids(value: string, source: string): string[] {
	const oids: string[] = [];
	for (const line of nonEmptyLines(value, source)) {
		const match = /^(\S+) (\S+) .+> \d+ [+-]\d{4}(?:\t.*)?$/u.exec(line);
		if (!match) {
			throw new WorktreeSafetyError(
				`${source} contains a malformed reflog record.`,
			);
		}
		for (const candidate of [match[1] ?? "", match[2] ?? ""]) {
			const oid = normalizedOid(candidate, source);
			if (oid) oids.push(oid);
		}
	}
	return uniqueInOrder(oids);
}

export function parseOidLines(value: string, source: string): string[] {
	const oids: string[] = [];
	for (const line of nonEmptyLines(value, source)) {
		const oid = normalizedOid(line, source);
		if (oid) oids.push(oid);
	}
	return uniqueInOrder(oids);
}

export function parseFetchHeadOids(value: string): string[] {
	const oids: string[] = [];
	for (const line of nonEmptyLines(value, "FETCH_HEAD")) {
		const match = /^([^\t]+)\t(?:not-for-merge)?\t.*$/u.exec(line);
		if (!match) {
			throw new WorktreeSafetyError("FETCH_HEAD contains a malformed record.");
		}
		const oid = normalizedOid(match[1] ?? "", "FETCH_HEAD");
		if (oid) oids.push(oid);
	}
	return uniqueInOrder(oids);
}

function normalizeEntry(entry: WorktreeInventoryEntry): WorktreeInventoryEntry {
	switch (entry.kind) {
		case "status":
			return {
				kind: "status",
				status: entry.status,
				path: entry.path,
				...(entry.originalPath === undefined
					? {}
					: { originalPath: entry.originalPath }),
			};
		case "ignored":
			return { kind: "ignored", path: entry.path };
		case "index-flag": {
			const flags = [...new Set(entry.flags)].sort(
				compareStrings,
			) as IndexFlag[];
			return { kind: "index-flag", path: entry.path, flags };
		}
		case "initialized-submodule":
			return {
				kind: "initialized-submodule",
				path: entry.path,
				commit: entry.commit,
				state: entry.state,
			};
		case "submodule-status":
			return {
				kind: "submodule-status",
				path: entry.path,
				status: entry.status,
			};
	}
}

function normalizeInventory(
	entries: readonly WorktreeInventoryEntry[],
): WorktreeInventoryEntry[] {
	const byKey = new Map<string, WorktreeInventoryEntry>();
	for (const entry of entries) {
		const normalized = normalizeEntry(entry);
		byKey.set(JSON.stringify(normalized), normalized);
	}
	return [...byKey.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, entry]) => entry);
}

export function normalizeSafetySnapshot(
	snapshot: WorktreeSafetySnapshot,
): WorktreeSafetySnapshot {
	const head = normalizedOid(snapshot.identity.head, "worktree HEAD");
	if (!head) {
		throw new WorktreeSafetyError(
			"Worktree HEAD cannot be the null object ID.",
		);
	}
	const recoveryOids = snapshot.recoveryOids
		.map((oid) => normalizedOid(oid, "administrative recovery history"))
		.filter((oid): oid is string => oid !== null);
	return {
		worktreePath: snapshot.worktreePath,
		administrativePath: snapshot.administrativePath,
		identity: { head, branch: snapshot.identity.branch },
		protected: normalizeInventory(snapshot.protected),
		ignored: normalizeInventory(snapshot.ignored),
		recoveryOids: [...new Set(recoveryOids)].sort(compareStrings),
	};
}

export function sameSafetySnapshot(
	left: WorktreeSafetySnapshot,
	right: WorktreeSafetySnapshot,
): boolean {
	return (
		JSON.stringify(normalizeSafetySnapshot(left)) ===
		JSON.stringify(normalizeSafetySnapshot(right))
	);
}

function escapedControlCharacter(character: string): string | null {
	if (character === "\0") return "\\0";
	if (character === "\t") return "\\t";
	if (character === "\n") return "\\n";
	if (character === "\r") return "\\r";
	const code = character.codePointAt(0) ?? 0;
	if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
		return `\\x${code.toString(16).padStart(2, "0")}`;
	}
	return null;
}

export function escapeForDisplay(value: string): string {
	let escaped = "";
	for (const character of value) {
		escaped += escapedControlCharacter(character) ?? character;
	}
	return escaped;
}

function assertNever(value: never): never {
	throw new WorktreeSafetyError(
		`Unknown worktree inventory entry: ${JSON.stringify(value)}`,
	);
}

export function formatInventoryEntry(entry: WorktreeInventoryEntry): string {
	const path = escapeForDisplay(entry.path);
	switch (entry.kind) {
		case "status": {
			const label =
				entry.status === "??" ? "untracked" : `status ${entry.status}`;
			const original =
				entry.originalPath === undefined
					? ""
					: ` (from ${escapeForDisplay(entry.originalPath)})`;
			return `${label}: ${path}${original}`;
		}
		case "ignored":
			return `ignored: ${path}`;
		case "index-flag":
			return `index flag ${entry.flags.join("+")}: ${path}`;
		case "initialized-submodule":
			return `initialized submodule ${entry.state} ${entry.commit}: ${path}`;
		case "submodule-status":
			return `submodule status ${escapeForDisplay(entry.status)}: ${path}`;
		default:
			return assertNever(entry);
	}
}
