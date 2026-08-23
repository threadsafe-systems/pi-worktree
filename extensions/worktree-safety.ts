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
