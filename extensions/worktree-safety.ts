import { spawn } from "node:child_process";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

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

export function parseReflogOids(value: string, source: string): string[] {
	const oids: string[] = [];
	for (const line of nonEmptyLines(value, source)) {
		const match = /^(\S+) (\S+) .+> \d+ [+-]\d{4}\t.*$/u.exec(line);
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
			const flags = [...new Set(entry.flags)].sort() as IndexFlag[];
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
		recoveryOids: [...new Set(recoveryOids)].sort(),
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

export function escapeForDisplay(value: string): string {
	let escaped = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (character === "\0") escaped += "\\0";
		else if (character === "\t") escaped += "\\t";
		else if (character === "\n") escaped += "\\n";
		else if (character === "\r") escaped += "\\r";
		else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			escaped += `\\x${code.toString(16).padStart(2, "0")}`;
		} else escaped += character;
	}
	return escaped;
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
	}
}
