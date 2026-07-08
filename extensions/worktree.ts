import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Name generator (adjective-noun)
// ---------------------------------------------------------------------------

export const ADJECTIVES = [
	"bright",
	"calm",
	"cool",
	"dark",
	"dry",
	"fast",
	"firm",
	"flat",
	"fresh",
	"gold",
	"green",
	"keen",
	"kind",
	"late",
	"lean",
	"live",
	"long",
	"loud",
	"neat",
	"new",
	"nice",
	"odd",
	"old",
	"pale",
	"pink",
	"pure",
	"rare",
	"raw",
	"red",
	"rich",
	"ripe",
	"safe",
	"shy",
	"slim",
	"slow",
	"soft",
	"sour",
	"tall",
	"thin",
	"warm",
	"weak",
	"wide",
	"wild",
	"wise",
	"bold",
	"cold",
	"deep",
	"fair",
	"free",
	"glad",
];

export const NOUNS = [
	"ant",
	"ape",
	"bat",
	"bee",
	"bug",
	"cat",
	"cod",
	"cow",
	"cub",
	"doe",
	"dog",
	"eel",
	"elk",
	"emu",
	"ewe",
	"fly",
	"fox",
	"gnu",
	"hen",
	"hog",
	"jay",
	"kit",
	"koi",
	"lark",
	"lynx",
	"moth",
	"mule",
	"newt",
	"owl",
	"pike",
	"pony",
	"pug",
	"ram",
	"ray",
	"seal",
	"slug",
	"swan",
	"toad",
	"wasp",
	"wren",
	"yak",
	"bass",
	"bear",
	"boar",
	"buck",
	"bull",
	"carp",
	"clam",
	"colt",
	"crab",
];

export function generateName(): string {
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
	const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
	return `${adj}-${noun}`;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/** Get the real repo root (handles being inside a worktree). */
async function getRepoRoot(pi: ExtensionAPI): Promise<string> {
	// git rev-parse --git-common-dir gives the main repo's .git even from inside
	// a linked worktree; its parent is the main repo root.
	const r = await pi.exec(
		"git",
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		{ timeout: 5_000 },
	);
	if (r.code !== 0) throw new Error("Not inside a git repository");
	const commonDir = r.stdout.trim();
	return dirname(commonDir);
}

/** Legacy cwd-based detection kept for callers that only have a path.
 *  Returns the flat worktree directory slug, not the branch. */
export function detectWorktreeName(cwd: string): string | null {
	const m = cwd.match(/\.worktrees[\\/]([^\\/]+)/);
	return m ? m[1] : null;
}

export interface DetectedWorktree {
	branch: string;
	worktreePath: string;
}

/**
 * Detect via git whether the current working directory is a linked worktree
 * (as opposed to the main checkout). Returns the checked-out branch and the
 * worktree top-level path, or null when in the main checkout / not in git.
 */
export async function detectWorktree(
	pi: ExtensionAPI,
): Promise<DetectedWorktree | null> {
	const abs = ["--path-format=absolute"];
	const gitDir = await pi.exec("git", ["rev-parse", ...abs, "--git-dir"], {
		timeout: 5_000,
	});
	const commonDir = await pi.exec(
		"git",
		["rev-parse", ...abs, "--git-common-dir"],
		{ timeout: 5_000 },
	);
	if (gitDir.code !== 0 || commonDir.code !== 0) return null;
	// In the main checkout --git-dir and --git-common-dir are identical; in a
	// linked worktree --git-dir points at .git/worktrees/<slug>.
	if (gitDir.stdout.trim() === commonDir.stdout.trim()) return null;
	const top = await pi.exec("git", ["rev-parse", ...abs, "--show-toplevel"], {
		timeout: 5_000,
	});
	const br = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
		timeout: 5_000,
	});
	return {
		branch: br.code === 0 ? br.stdout.trim() : "",
		worktreePath: top.code === 0 ? top.stdout.trim() : process.cwd(),
	};
}

// ---------------------------------------------------------------------------
// Config: project-level hooks
// ---------------------------------------------------------------------------

export interface WorktreeConfig {
	/** Worktree base directory. When omitted, a sibling directory next to the
	 *  repo is used (`<repoRoot>.worktrees`). When set, it resolves relative to
	 *  the repo root. */
	dir?: string;
	/** Default conventional-commit type used when the input has no explicit
	 *  `type/` prefix. Default: "feat". */
	defaultType?: string;
	/** Override the set of accepted conventional-commit types. */
	types?: string[];
	/** Shell commands to run after worktree creation (cwd = worktree). Each string is a separate step. */
	postCreate?: string[];
	/** Shell commands to run before worktree removal (cwd = worktree). */
	preRemove?: string[];
	/** Env files to symlink from main repo (glob-like basenames). Default: all gitignored .env* except .env.local */
	linkEnvFiles?: boolean;
}

export function loadConfig(repoRoot: string): WorktreeConfig {
	const configPath = join(repoRoot, ".pi", "worktree.json");
	if (existsSync(configPath)) {
		try {
			return JSON.parse(readFileSync(configPath, "utf-8"));
		} catch {
			return {};
		}
	}
	return {};
}

// ---------------------------------------------------------------------------
// Worktree discipline: optional main-checkout write/edit guard
// ---------------------------------------------------------------------------

export interface WorktreeMarker {
	enforce?: boolean;
	allowPaths?: string[];
}

export const MARKER_REL = ".pi/worktree-discipline.json";
export const LOCAL_MARKER_REL = ".pi/worktree-discipline.local.json";

/** Read the effective discipline marker for a repo root. The local override wins. */
export function readMarker(root: string): WorktreeMarker | null {
	for (const rel of [LOCAL_MARKER_REL, MARKER_REL]) {
		try {
			return JSON.parse(
				readFileSync(join(root, rel), "utf8"),
			) as WorktreeMarker;
		} catch {
			// not present or unreadable: fall through to the next candidate
		}
	}
	return null;
}

/**
 * A linked worktree's `.git` is a FILE (a `gitdir:` pointer); the primary
 * checkout's `.git` is a DIRECTORY. This works wherever the worktree lives on
 * disk, so it is more robust than matching the configured worktree path.
 */
export function isMainCheckout(root: string): boolean {
	try {
		return statSync(join(root, ".git")).isDirectory();
	} catch {
		return false; // no .git at the root: do not gate
	}
}

function nearestExistingDir(start: string): string | null {
	let dir = start;
	for (;;) {
		try {
			if (statSync(dir).isDirectory()) return dir;
		} catch {
			// keep walking up
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Does `relPath` sit under one of the allowPaths prefixes (repo-relative)? */
function isAllowListed(relPath: string, allowPaths: string[]): boolean {
	return allowPaths.some(
		(a) => relPath === a || relPath.startsWith(a.endsWith("/") ? a : `${a}/`),
	);
}

/**
 * Pure discipline decision: block this tool call? No filesystem or git access;
 * all facts are injected, so this remains trivially unit-testable.
 */
export function shouldBlock(opts: {
	toolName: string;
	mainCheckout: boolean;
	marker: WorktreeMarker | null;
	relPath: string;
}): boolean {
	const { toolName, mainCheckout, marker, relPath } = opts;
	if (toolName !== "write" && toolName !== "edit") return false;
	if (!marker || marker.enforce !== true) return false; // default off / not opted in
	if (!mainCheckout) return false; // worktrees are always allowed
	// The marker files are NOT exempt. Toggling enforcement goes through the
	// worktree-enforce script / command (pi.exec, not the gated write/edit tools),
	// so exempting them here would let an agent self-authorise by rewriting policy.
	if (isAllowListed(relPath, marker.allowPaths ?? [])) return false;
	return true;
}

/** Expand a leading `~` or `~/` to the user's home directory. */
export function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) {
		return join(homedir(), p.slice(2));
	}
	return p;
}

export function getWorktreeDir(
	repoRoot: string,
	config: WorktreeConfig,
	dirOverride?: string,
): string {
	// Per-invocation override wins, then config.dir; both resolve relative to the
	// repo root. Otherwise use a sibling base directory (never nested inside it).
	const dir = dirOverride ?? config.dir;
	if (dir) return resolve(repoRoot, expandHome(dir));
	return `${repoRoot}.worktrees`;
}

// ---------------------------------------------------------------------------
// Conventional-commit branch naming
// ---------------------------------------------------------------------------

/** Conventional-commit types accepted as branch prefixes. */
export const CONVENTIONAL_TYPES = [
	"feat",
	"fix",
	"chore",
	"docs",
	"refactor",
	"test",
	"perf",
	"build",
	"ci",
	"style",
	"revert",
];

export const DEFAULT_TYPE = "feat";

export function isValidIdentifier(id: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/.test(id);
}

/** A branch type must be a single hyphen-free token. Forbidding hyphens keeps
 *  `branchToDirName` injective: with hyphen-free types, the text up to the first
 *  `-` in a slug uniquely identifies the type, so no two distinct branches can
 *  collide on the same worktree directory. */
export function isValidType(type: string): boolean {
	return /^[a-z0-9]+$/.test(type);
}

/** Normalise a git branch (e.g. "feat/foo") into a flat worktree directory
 *  name ("feat-foo"). A worktree is a single directory, so slashes collapse. */
export function branchToDirName(branch: string): string {
	return branch.replace(/\//g, "-");
}

/**
 * Resolve raw command input into a conventional-commit branch
 * ("<type>/<identifier>"). Accepts:
 *   - "feat/use-cc"  -> as-is (type validated)
 *   - "feat use-cc"  -> "feat/use-cc"
 *   - "use-cc"       -> "<defaultType>/use-cc"
 *   - ""             -> "<defaultType>/<generated-name>"
 * Throws on an unknown type or a malformed identifier.
 */
export function resolveBranch(input: string, config: WorktreeConfig): string {
	const defaultType = config.defaultType ?? DEFAULT_TYPE;
	const types = config.types ?? CONVENTIONAL_TYPES;
	const trimmed = (input ?? "").trim();

	let type = defaultType;
	let identifier: string;

	if (!trimmed) {
		identifier = generateName();
	} else if (trimmed.includes("/")) {
		const [t, ...rest] = trimmed.split("/");
		type = t;
		identifier = rest.join("-");
	} else {
		const parts = trimmed.split(/\s+/);
		if (parts.length >= 2 && types.includes(parts[0])) {
			type = parts[0];
			identifier = parts.slice(1).join("-");
		} else {
			identifier = parts.join("-");
		}
	}

	if (!types.includes(type)) {
		throw new Error(
			`Unknown branch type "${type}". Valid types: ${types.join(", ")}`,
		);
	}
	// Defence in depth: even a whitelisted type must be shell/ref-safe AND
	// hyphen-free (see isValidType) so worktree slugs stay collision-proof. A
	// committed .pi/worktree.json can supply arbitrary `types`/`defaultType`.
	if (!isValidType(type)) {
		throw new Error(
			`Invalid branch type "${type}". A type must be a single hyphen-free token of lowercase letters and digits.`,
		);
	}
	if (!isValidIdentifier(identifier)) {
		throw new Error(
			`Invalid identifier "${identifier}". Use kebab-case: lowercase letters, digits and hyphens.`,
		);
	}
	return `${type}/${identifier}`;
}

/** Absolute worktree path for a branch under the worktree base directory. */
export function getWorktreePath(
	repoRoot: string,
	config: WorktreeConfig,
	branch: string,
	dirOverride?: string,
): string {
	return join(
		getWorktreeDir(repoRoot, config, dirOverride),
		branchToDirName(branch),
	);
}

/** A git-ref-safe, shell-safe explicit branch name (for `--branch`). Allows
 *  slashes and mixed case but forbids shell metacharacters and the git ref
 *  patterns git itself rejects. */
export function isValidExplicitBranch(branch: string): boolean {
	if (!branch) return false;
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return false;
	if (branch.includes("..") || branch.includes("//")) return false;
	if (branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock"))
		return false;
	return true;
}

/** A shell-safe base ref (for `--base`). Must not begin with `-` (else git reads
 *  it as a flag) and must avoid shell metacharacters. git validates the rest. */
export function isValidBaseRef(ref: string): boolean {
	return /^[A-Za-z0-9_][A-Za-z0-9._/@~^-]*$/.test(ref);
}

// ---------------------------------------------------------------------------
// Command argument parsing + create planning
// ---------------------------------------------------------------------------

export interface CreateOptions {
	/** Positional worktree name (fed to resolveBranch unless `branch` is set). */
	name?: string;
	/** Per-invocation worktree base directory override. */
	dir?: string;
	/** Exact branch name, bypassing conventional-commit resolution. */
	branch?: string;
	/** Base ref to branch from. Default: HEAD. */
	base?: string;
}

/** Parse `/worktree create` args: a positional name plus `--dir`, `--branch`,
 *  `--base` (both `--flag value` and `--flag=value` forms). Positional tokens
 *  join with a space so `resolveBranch` still sees the two-token type form. */
export function parseCreateArgs(raw: string): CreateOptions {
	const tokens = (raw ?? "").trim().split(/\s+/).filter(Boolean);
	const opts: CreateOptions = {};
	const positionals: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (!tok.startsWith("--")) {
			positionals.push(tok);
			continue;
		}
		const eq = tok.indexOf("=");
		const flag = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
		const inlineVal = eq >= 0 ? tok.slice(eq + 1) : undefined;
		const takeValue = (name: string): string => {
			if (inlineVal !== undefined) {
				if (inlineVal === "") throw new Error(`--${name} requires a value.`);
				return inlineVal;
			}
			const next = i + 1 < tokens.length ? tokens[i + 1] : undefined;
			if (next === undefined || next.startsWith("--")) {
				throw new Error(`--${name} requires a value.`);
			}
			i++;
			return next;
		};
		if (flag === "dir") {
			opts.dir = takeValue("dir");
		} else if (flag === "branch") {
			opts.branch = takeValue("branch");
		} else if (flag === "base") {
			opts.base = takeValue("base");
		}
	}
	if (positionals.length > 0) opts.name = positionals.join(" ");
	return opts;
}

export interface CreatePlan {
	branch: string;
	worktreePath: string;
	base: string;
}

/** Resolve create options into a concrete branch, worktree path and base ref.
 *  An explicit `--branch` bypasses conventional resolution but is still
 *  validated for git-ref/shell safety; `--base` likewise. Throws on invalid. */
export function planCreate(
	repoRoot: string,
	config: WorktreeConfig,
	opts: CreateOptions,
): CreatePlan {
	let branch: string;
	if (opts.branch !== undefined) {
		const b = opts.branch.trim();
		if (!isValidExplicitBranch(b)) {
			throw new Error(
				`Invalid --branch "${b}". Use a git-ref-safe name (letters, digits, ., _, -, /); no shell metacharacters, "..", "//", or trailing "/"/".lock".`,
			);
		}
		branch = b;
	} else {
		branch = resolveBranch(opts.name ?? "", config);
	}
	const base = (opts.base ?? "").trim() || "HEAD";
	if (base !== "HEAD" && !isValidBaseRef(base)) {
		throw new Error(
			`Invalid --base "${base}". Use a ref name (letters, digits, ., _, -, /, @, ~, ^) that does not start with "-".`,
		);
	}
	const worktreePath = getWorktreePath(repoRoot, config, branch, opts.dir);
	// The sibling-layout invariant (worktree lives OUTSIDE the repo) is what the
	// detect/dispose/destroy design relies on. A `--dir` that lands the worktree
	// inside the repo (or its .git) would break that and can corrupt git metadata.
	if (isPathInside(worktreePath, repoRoot)) {
		throw new Error(
			`Refusing to create a worktree inside the repository (${worktreePath}). The worktree directory must live outside the repo (default: the sibling ${repoRoot}.worktrees).`,
		);
	}
	return {
		branch,
		worktreePath,
		base,
	};
}

/** Canonicalise a path (resolve symlinks) when it exists, else resolve it
 *  lexically. Used so path-containment checks are not fooled by symlinks. */
function canonicalPath(p: string): string {
	const abs = resolve(p);
	try {
		return realpathSync(abs);
	} catch {
		// Leaf does not exist: canonicalise the nearest existing ancestor (so
		// intermediate symlinks are still resolved) and re-append the missing tail.
		const missing: string[] = [];
		let dir = abs;
		for (;;) {
			const parent = dirname(dir);
			missing.unshift(basename(dir));
			if (parent === dir) return abs; // reached root, nothing resolved
			try {
				return join(realpathSync(parent), ...missing);
			} catch {
				dir = parent;
			}
		}
	}
}

/** True when `child` is `parent` itself or nested beneath it. Both operands are
 *  canonicalised (symlinks resolved) before the prefix-boundary comparison. */
export function isPathInside(child: string, parent: string): boolean {
	const c = canonicalPath(child);
	const p = canonicalPath(parent);
	return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Parse `git worktree list --porcelain` into path + branch records. The branch
 *  is the short name (refs/heads/ stripped) or null for detached/bare entries. */
export function parseWorktreeList(
	porcelain: string,
): { path: string; branch: string | null }[] {
	const out: { path: string; branch: string | null }[] = [];
	let cur: { path: string; branch: string | null } | null = null;
	for (const raw of porcelain.split("\n")) {
		const line = raw.trimEnd();
		if (line.startsWith("worktree ")) {
			if (cur) out.push(cur);
			cur = { path: line.slice("worktree ".length), branch: null };
		} else if (line.startsWith("branch ") && cur) {
			const ref = line.slice("branch ".length);
			cur.branch = ref.startsWith("refs/heads/")
				? ref.slice("refs/heads/".length)
				: ref;
		}
	}
	if (cur) out.push(cur);
	return out;
}

/** Choose the worktree to destroy for a branch from a parsed worktree list.
 *  Matches on the EXACT branch (so hyphen/slash slug collisions cannot pick the
 *  wrong checkout) and refuses the main working tree, whose removal would
 *  `rm -rf` the source repository. Matches on ANY of the candidate branch names
 *  so `/worktree destroy` accepts both the literal branch and its conventional
 *  form (create/destroy symmetry). */
export function resolveDestroyTarget(
	worktrees: { path: string; branch: string | null }[],
	branches: string[],
	repoRoot: string,
): { path: string; branch: string } | { error: string } {
	const entry =
		// Match in candidate priority order (literal input before its conventional
		// form), NOT git-list order, so `destroy foo` prefers a literal `foo`
		// worktree over a colliding `feat/foo` one.
		branches
			.map((b) => worktrees.find((w) => w.branch === b))
			.find((w): w is { path: string; branch: string } => w !== undefined);
	if (!entry || entry.branch === null) {
		const names = branches.map((b) => `"${b}"`).join(" or ") || "(none)";
		return {
			error: `No worktree is checked out on branch ${names}. Run /worktree list to see existing worktrees.`,
		};
	}
	if (canonicalPath(entry.path) === canonicalPath(repoRoot)) {
		return {
			error: `Branch "${entry.branch}" is checked out in the main working tree — refusing to destroy the main checkout.`,
		};
	}
	return { path: entry.path, branch: entry.branch };
}

/** Candidate branch names to match when destroying: the literal input plus its
 *  conventional-commit resolution (when that differs and is valid). Lets destroy
 *  accept both `feat/foo` shorthand and an explicit `--branch` name. */
export function destroyCandidates(
	input: string,
	config: WorktreeConfig,
): string[] {
	const t = (input ?? "").trim();
	if (!t) return [];
	const out = [t];
	try {
		const resolved = resolveBranch(t, config);
		if (resolved !== t) out.push(resolved);
	} catch {
		// non-conventional explicit branch: literal is the only candidate
	}
	return out;
}

// ---------------------------------------------------------------------------
// Relaunch helpers
// ---------------------------------------------------------------------------

/** Single-quote a string for safe literal use inside a POSIX shell command. */
function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Handoff payload carried across a worktree relaunch, decoded by the new
 *  session to orient the agent. `kind` distinguishes entering a worktree from
 *  disposing one and returning to the main checkout. */
export interface WtHandoff {
	parentCwd: string;
	parentBranch: string;
	uncommitted: number;
	/** Count of gitignored local files destroyed on dispose (e.g. .env.local). */
	ignored?: number;
	kind?: "enter" | "dispose";
}

export function encodeHandoff(h: WtHandoff): string {
	return Buffer.from(JSON.stringify(h)).toString("base64");
}

export function decodeHandoff(b64: string): WtHandoff | null {
	try {
		const h = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
		if (
			h &&
			typeof h.parentCwd === "string" &&
			typeof h.parentBranch === "string" &&
			typeof h.uncommitted === "number"
		) {
			return {
				parentCwd: h.parentCwd,
				parentBranch: h.parentBranch,
				uncommitted: h.uncommitted,
				...(typeof h.ignored === "number" ? { ignored: h.ignored } : {}),
				kind: h.kind === "dispose" ? "dispose" : "enter",
			};
		}
	} catch {
		// fall through to null
	}
	return null;
}

/** The one-turn orientation note injected into the relaunched session. */
export function handoffCaveat(
	h: WtHandoff,
	currentCwd: string,
	currentBranch: string,
): string {
	if (h.kind === "dispose") {
		const lost: string[] = [];
		if (h.uncommitted > 0)
			lost.push(`${h.uncommitted} uncommitted/untracked file(s)`);
		if ((h.ignored ?? 0) > 0)
			lost.push(
				`${h.ignored} gitignored file(s) (e.g. .env.local / local DBs)`,
			);
		const wip = lost.length
			? `- WARNING: the disposed worktree had ${lost.join(" and ")} that were destroyed with it — they are gone.`
			: `- The disposed worktree had no uncommitted or gitignored local files.`;
		return (
			`## Session moved back to the main checkout\n` +
			`This session was forked out of the worktree at ${h.parentCwd} (branch ${h.parentBranch}) back into the main repository at ${currentCwd}. Removal of that worktree and a soft-delete (git branch -d) of branch ${h.parentBranch} were requested during shutdown — verify with \`git worktree list\` and \`git branch\`, and re-run cleanup if either remains (an unmerged branch is deliberately kept).\n` +
			`- Repo-relative paths are unchanged (\`src/foo.ts\` is still \`src/foo.ts\`).\n` +
			`- Absolute paths, and any path under the old worktree directory, no longer resolve.\n` +
			`${wip}\n` +
			`Continue the task here on ${currentBranch || "the main branch"}.`
		);
	}
	const wip =
		h.uncommitted > 0
			? `- WARNING: ${h.uncommitted} file(s) had uncommitted changes in ${h.parentCwd}. A worktree is a fresh checkout, so those changes are NOT present here — retrieve them from ${h.parentCwd} if this work depends on them.`
			: `- The previous checkout had no uncommitted changes.`;
	return (
		`## Session migrated into a worktree\n` +
		`This session was forked from ${h.parentCwd} (branch ${h.parentBranch}) into this git worktree at ${currentCwd} (branch ${currentBranch}).\n` +
		`- Repo-relative paths are unchanged (\`src/foo.ts\` is still \`src/foo.ts\`).\n` +
		`- Absolute paths, and any path relative to the previous working directory, now resolve under this worktree.\n` +
		`${wip}\n` +
		`Continue the task here and commit to ${currentBranch}.`
	);
}

/** Build the shell command typed into the pane to relaunch pi in a directory.
 *  Optionally forks the parent session (to carry history) and passes a base64
 *  handoff payload via PI_WT_HANDOFF for the new session to decode. */
export function buildRelaunchCommand(
	targetDir: string,
	forkSessionFile?: string,
	handoffB64?: string,
): string {
	const envPrefix = handoffB64 ? `PI_WT_HANDOFF=${shQuote(handoffB64)} ` : "";
	const forkArg = forkSessionFile ? ` --fork ${shQuote(forkSessionFile)}` : "";
	return `cd ${shQuote(targetDir)} && ${envPrefix}pi${forkArg}`;
}

/** Shared worktree-teardown script builder (used by dispose and destroy). All
 *  paths and the branch name are shQuote'd. `hardDelete` selects `git branch -D`
 *  (destroy) vs `-d` (dispose, which keeps an unmerged branch). */
function buildTeardownScript(
	repoRoot: string,
	worktreePath: string,
	branch: string,
	preRemove: string[] | undefined,
	hardDelete: boolean,
): string {
	const lines: string[] = [];
	const hooks = preRemove ?? [];
	if (hooks.length) {
		// Fail-fast: a failing preRemove hook (e.g. a backup) must abort before the
		// irreversible worktree/branch removal below.
		lines.push("set -e");
		for (const cmd of hooks) {
			lines.push(`cd ${shQuote(worktreePath)} && ${cmd}`);
		}
		lines.push("set +e");
	}
	lines.push(`cd ${shQuote(repoRoot)}`);
	// NB: no `rm -rf` fallback. If `git worktree remove` refuses (e.g. the path
	// is stale and has been reused by unrelated content), blindly rm -rf'ing it
	// would destroy that data; prune the metadata instead and let the caller
	// report any directory that lingers.
	lines.push(
		`git worktree remove --force ${shQuote(worktreePath)} 2>/dev/null || git worktree prune 2>/dev/null || true`,
	);
	lines.push(
		`git branch -${hardDelete ? "D" : "d"} ${shQuote(branch)} 2>/dev/null || true`,
	);
	return lines.join("\n");
}

/** Build the shell script run (from the main repo) after pi exits to tear down
 *  a worktree during dispose: pre-remove hooks, worktree removal, then a SOFT
 *  branch-delete (an unmerged branch is kept). Executed by the detached waiter
 *  before the relaunch keys. */
export function buildDisposeScript(
	repoRoot: string,
	worktreePath: string,
	branch: string,
	preRemove?: string[],
): string {
	return buildTeardownScript(repoRoot, worktreePath, branch, preRemove, false);
}

/** Build the teardown script for `/worktree destroy`: pre-remove hooks, worktree
 *  removal, then a HARD branch-delete. All values are shQuote'd. */
export function buildDestroyScript(
	repoRoot: string,
	worktreePath: string,
	branch: string,
	preRemove?: string[],
): string {
	return buildTeardownScript(repoRoot, worktreePath, branch, preRemove, true);
}

/** Build the worktree-creation script. All values are shQuote'd. It does NOT
 *  force-delete an existing branch: `git worktree add -b` fails loudly if the
 *  branch already exists, so a real feature branch can never be clobbered. */
export function buildCreateScript(
	repoRoot: string,
	worktreePath: string,
	branch: string,
	base = "HEAD",
): string {
	return [
		`cd ${shQuote(repoRoot)}`,
		`mkdir -p ${shQuote(dirname(worktreePath))}`,
		`git worktree add -b ${shQuote(branch)} ${shQuote(worktreePath)} ${shQuote(base)}`,
	].join("\n");
}

/** Gather the handoff payload (parent branch + uncommitted count) for a
 *  relaunch. Returns undefined when there is no session to fork. */
async function buildHandoff(
	pi: ExtensionAPI,
	repoRoot: string,
	sessionFile: string | undefined,
): Promise<string | undefined> {
	if (!sessionFile) return undefined;
	let parentBranch = "";
	try {
		const b = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: repoRoot,
			timeout: 5_000,
		});
		if (b.code === 0) parentBranch = b.stdout.trim();
	} catch {
		// best-effort
	}
	let uncommitted = 0;
	try {
		const st = await pi.exec("git", ["status", "--porcelain"], {
			cwd: repoRoot,
			timeout: 5_000,
		});
		if (st.code === 0) {
			uncommitted = st.stdout
				.split("\n")
				.filter((l) => l.trim().length > 0).length;
		}
	} catch {
		// best-effort
	}
	return encodeHandoff({
		parentCwd: process.cwd(),
		parentBranch,
		uncommitted,
		kind: "enter",
	});
}

/** Read the current session file path from a context, tolerating context
 *  variants that may not type it. */
function currentSessionFile(ctx: unknown): string | undefined {
	return (
		ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }
	)?.sessionManager?.getSessionFile?.();
}

/**
 * Schedule a pi relaunch in the current terminal pane by injecting a command
 * via cmux or tmux once this pi process has exited.
 *
 * Reliability notes (these were all bugs in the original implementation):
 *  - We wait for THIS pi process to actually exit before sending keys, instead
 *    of a blind `sleep 0.3` that raced pi's TUI teardown. Keys sent while pi
 *    still owns the pane in raw mode are swallowed.
 *  - We target the originating pane explicitly ($TMUX_PANE / surface id) so the
 *    keys cannot land in some other active pane.
 *  - We send the command text with `send-keys -l` (literal) and then a SEPARATE
 *    `Enter` key, instead of relying on a trailing "\n" character.
 *  - Dynamic values are passed as positional args to `bash -c`, never
 *    interpolated into the script body, so paths with spaces/quotes are safe.
 *  - An optional preScript runs (from the detached waiter, after pi exits and
 *    before the keys are sent) to perform teardown such as removing a worktree.
 *
 * Returns true if a relaunch was scheduled, false if not in a known multiplexer.
 */
function scheduleRelaunch(opts: {
	typedCmd: string;
	preScript?: string;
}): boolean {
	const parentPid = String(process.pid);
	const pre = opts.preScript ?? "";

	const surfaceId = process.env.CMUX_SURFACE_ID;
	const inTmux = !!process.env.TMUX;

	let script: string;
	let args: string[];

	if (surfaceId) {
		// cmux: wait for pi to exit, run teardown, then type the command.
		script = `
      parent="$1"; surface="$2"; cmd="$3"; pre="$4"
      while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done
      sleep 0.15
      if [ -n "$pre" ]; then bash -c "$pre"; fi
      cmux send --surface "$surface" -- "$cmd"
      cmux send --surface "$surface" -- $'\\r'
    `;
		args = [
			"-c",
			script,
			"pi-worktree-relaunch",
			parentPid,
			surfaceId,
			opts.typedCmd,
			pre,
		];
	} else if (inTmux) {
		// tmux: target the originating pane when known; -l types literally; a
		// separate Enter submits.
		const target = process.env.TMUX_PANE ?? "";
		script = `
      parent="$1"; target="$2"; cmd="$3"; pre="$4"
      while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done
      sleep 0.15
      if [ -n "$pre" ]; then bash -c "$pre"; fi
      if [ -n "$target" ]; then
        tmux send-keys -t "$target" -l -- "$cmd"
        tmux send-keys -t "$target" Enter
      else
        tmux send-keys -l -- "$cmd"
        tmux send-keys Enter
      fi
    `;
		args = [
			"-c",
			script,
			"pi-worktree-relaunch",
			parentPid,
			target,
			opts.typedCmd,
			pre,
		];
	} else {
		return false;
	}

	// Detached + unref so the waiter outlives pi's shutdown.
	const child = spawn("bash", args, {
		detached: true,
		stdio: "ignore",
	});
	child.unref();

	return true;
}

/** Relaunch pi in a worktree, forking the parent session and passing a handoff. */
function relaunchInPlace(
	worktreePath: string,
	forkSessionFile?: string,
	handoffB64?: string,
): boolean {
	const typedCmd = buildRelaunchCommand(
		worktreePath,
		forkSessionFile,
		handoffB64,
	);
	return scheduleRelaunch({ typedCmd });
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let worktreeBranch: string | null = null;

	// --- Optional worktree-discipline guard ---
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const target = (event.input as { path?: unknown }).path;
		if (typeof target !== "string" || target.length === 0) return;
		const absPath = isAbsolute(target) ? target : resolve(ctx.cwd, target);

		// Repo root that contains the target path. Use the nearest existing parent so
		// writes to new subdirectories are still guarded.
		const gitCwd = nearestExistingDir(dirname(absPath));
		if (!gitCwd) return;
		const res = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
			cwd: gitCwd,
		});
		if (res.code !== 0) return; // not a git repo: allow
		const root = res.stdout.trim();
		if (!root) return;

		const marker = readMarker(root);
		const relPath = relative(root, absPath);
		if (
			!shouldBlock({
				toolName: event.toolName,
				mainCheckout: isMainCheckout(root),
				marker,
				relPath,
			})
		) {
			return;
		}

		return {
			block: true,
			reason:
				`worktree-discipline: this repo enforces worktree-only edits and you are in its main checkout.\n` +
				`Refused ${event.toolName} to ${relPath}. Create or enter a worktree first, e.g.\n` +
				`  /worktree <name>\n` +
				`Escape hatches: /worktree-enforce out, or add the path to allowPaths in ${MARKER_REL} from a worktree (the marker is not editable via write/edit in the enforced main checkout).`,
		};
	});

	// --- Register --worktree flags ---
	pi.registerFlag("worktree", {
		description:
			"Create or reuse a git worktree and work inside it. Optionally specify a conventional-commit branch (e.g. feat/my-feature).",
		type: "string",
	});
	pi.registerFlag("worktree-dir", {
		description:
			"Worktree base directory for this invocation (overrides the configured dir).",
		type: "string",
	});
	pi.registerFlag("worktree-branch", {
		description:
			"Exact branch name for the worktree (bypasses conventional-commit resolution).",
		type: "string",
	});
	pi.registerFlag("worktree-base", {
		description: "Base ref to branch the worktree from. Default: HEAD.",
		type: "string",
	});

	const flagString = (v: unknown): string | undefined =>
		typeof v === "string" && v.length > 0 ? v : undefined;

	// --- Auto-detect worktree from cwd, or handle --worktree flag ---
	pi.on("session_start", async (_event, ctx) => {
		const flagValue = pi.getFlag("worktree") as string | boolean | undefined;

		if (flagValue !== undefined && flagValue !== false) {
			// --worktree was passed (with or without a name)
			try {
				const repoRoot = await getRepoRoot(pi);
				const config = loadConfig(repoRoot);
				const { branch, worktreePath, base } = planCreate(repoRoot, config, {
					name: typeof flagValue === "string" ? flagValue : "",
					dir: flagString(pi.getFlag("worktree-dir")),
					branch: flagString(pi.getFlag("worktree-branch")),
					base: flagString(pi.getFlag("worktree-base")),
				});

				const exists = existsSync(worktreePath);
				if (!exists) {
					ctx.ui.setStatus("worktree", `⏳ Creating worktree "${branch}"...`);
					await createWorktree(pi, ctx, repoRoot, config, {
						branch,
						worktreePath,
						base,
					});
					ctx.ui.setStatus("worktree", `🌿 ${branch}`);
				} else {
					// The path exists: confirm it is really a worktree ON this branch
					// before treating it as "existing". An explicit --branch can slug to a
					// directory already occupied by a different branch's worktree; silently
					// relaunching there would drop the agent on the wrong branch.
					const listed = await pi.exec(
						"git",
						["worktree", "list", "--porcelain"],
						{ cwd: repoRoot, timeout: 5_000 },
					);
					const here =
						listed.code === 0
							? parseWorktreeList(listed.stdout).find(
									(w) => canonicalPath(w.path) === canonicalPath(worktreePath),
								)
							: undefined;
					if (!here || here.branch !== branch) {
						ctx.ui.setStatus("worktree", undefined);
						ctx.ui.notify(
							`${worktreePath} already exists but is ${here?.branch ? `checked out on branch "${here.branch}"` : "not a registered worktree"}, not "${branch}". Pick another name/--branch, or remove it first.`,
							"error",
						);
						return;
					}
					ctx.ui.setStatus("worktree", `🌿 ${branch} (existing)`);
				}

				const detected = await detectWorktree(pi);
				if (
					detected &&
					resolve(detected.worktreePath) === resolve(worktreePath)
				) {
					// Already running inside the worktree — nothing to do
					worktreeBranch = branch;
					pi.setSessionName(`wt:${branch}`);
				} else {
					// Tools are bound to the original cwd; relaunch pi in the worktree
					// directory so all tools resolve paths correctly. Fork the parent
					// session so history follows the hop, plus a handoff note.
					const sessionFile = currentSessionFile(ctx);
					const handoffB64 = await buildHandoff(pi, repoRoot, sessionFile);
					const relaunched = relaunchInPlace(
						worktreePath,
						sessionFile,
						handoffB64,
					);
					if (!relaunched) {
						ctx.ui.notify(
							`✅ Worktree "${branch}" ready.\n` +
								`   Path: ${worktreePath}\n` +
								`   Branch: ${branch}\n` +
								`   Start PI there: cd ${worktreePath} && pi`,
							"info",
						);
					}
					ctx.ui.setStatus("worktree", undefined);
					if (relaunched) {
						ctx.shutdown();
					}
					return;
				}
			} catch (err) {
				ctx.ui.setStatus("worktree", undefined);
				ctx.ui.notify(
					`Failed to set up worktree: ${(err as Error).message}`,
					"error",
				);
				return;
			}
		} else {
			// Auto-detect from git
			const detected = await detectWorktree(pi);
			worktreeBranch = detected?.branch ?? null;
		}

		if (worktreeBranch) {
			pi.setSessionName(`wt:${worktreeBranch}`);
			ctx.ui.setStatus("worktree", `🌿 ${worktreeBranch}`);
		}
	});

	// --- Inject worktree context (and a one-turn migration caveat) ---
	let handoffShown = false;
	pi.on("before_agent_start", async (event) => {
		let extra = "";
		if (worktreeBranch) {
			extra +=
				`\n\n## Active Worktree\n` +
				`You are working in git worktree "${worktreeBranch}".\n` +
				`The current directory is the worktree root. All tools resolve paths relative to it.\n` +
				`Branch: ${worktreeBranch}\n` +
				`Commit your work to this branch when done.`;
		}
		// One-turn orientation when this session was forked across a worktree hop.
		const handoffEnv = process.env.PI_WT_HANDOFF;
		if (!handoffShown && handoffEnv) {
			const h = decodeHandoff(handoffEnv);
			if (h) {
				handoffShown = true;
				extra += `\n\n${handoffCaveat(h, process.cwd(), worktreeBranch ?? "")}`;
			}
		}
		if (!extra) return;
		return { systemPrompt: event.systemPrompt + extra };
	});

	async function handleEnforce(
		args: string | undefined,
		ctx: ExtensionCommandContext,
	) {
		const sub = (args ?? "").trim() || "status";
		const script = fileURLToPath(
			new URL(
				"../skills/worktree-enforce/scripts/worktree-enforce.sh",
				import.meta.url,
			),
		);
		const res = await pi.exec("bash", [script, sub], { cwd: ctx.cwd });
		const out = `${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`.trim();
		ctx.ui.notify(out || "(no output)", res.code === 0 ? "info" : "error");
	}

	// --- Commands ---
	pi.registerCommand("worktree", {
		description:
			"Git worktree management. Usage: /worktree [type/name] [--dir <path>] [--branch <name>] [--base <ref>], /worktree create [type/name], /worktree dispose, /worktree destroy <branch>, /worktree list. When creating on the user's behalf, infer a conventional-commit type (feat/fix/chore/docs/refactor/...) from the conversation; it defaults to feat.",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/);
			const sub = parts[0] || "";
			const subArg = parts.slice(1).join(" ").trim();

			switch (sub) {
				case "create":
				case "new":
					return handleCreate(subArg, ctx);
				case "dispose":
				case "back":
				case "pop":
					return handleDispose(ctx);
				case "destroy":
				case "remove":
				case "rm":
					return handleDestroy(subArg, ctx);
				case "list":
				case "ls":
					return handleList(ctx);
				case "enforce":
				case "discipline":
					return handleEnforce(subArg, ctx);
				case "help":
					ctx.ui.notify(
						"Usage:\n" +
							"  /worktree [type/name]     — Create a worktree (auto-generates name if omitted)\n" +
							"  /worktree create [type/name] — Same as above\n" +
							"  /worktree dispose         — Leave this worktree, remove it, reopen pi in the main repo\n" +
							"  /worktree destroy <branch> — Destroy a worktree from the main checkout\n" +
							"  /worktree list            — List all worktrees\n" +
							"  /worktree enforce <cmd>   — in | out | status | doctor for worktree-only edit discipline\n" +
							"  /worktree help            — Show this help\n" +
							"\n" +
							"Create overrides: --dir <path> (worktree base dir), --branch <name> " +
							"(exact branch, bypasses conventional resolution), --base <ref> (branch from ref, default HEAD).\n" +
							"Branch names follow conventional commits: <type>/<identifier>, e.g. feat/use-conventional-commits.\n" +
							"Valid types: " +
							CONVENTIONAL_TYPES.join(", ") +
							" (default: feat).\n" +
							"Shortcuts: /worktree-create, /worktree-dispose, /worktree-destroy, /worktree-list, /worktree-enforce",
						"info",
					);
					return;
				default:
					// No subcommand or unrecognized word → treat as branch for create
					return handleCreate(args?.trim() || "", ctx);
			}
		},
	});

	// Shortcut commands
	pi.registerCommand("worktree-enforce", {
		description:
			"Worktree discipline: in | out | status | doctor (manages .pi/worktree-discipline.json)",
		handler: async (args, ctx) => handleEnforce(args, ctx),
	});

	pi.registerCommand("worktree-create", {
		description: "Create a new git worktree (shortcut for /worktree create)",
		handler: async (args, ctx) => handleCreate(args?.trim() || "", ctx),
	});

	pi.registerCommand("worktree-dispose", {
		description:
			"Leave and remove the current worktree, reopening pi in the main repo (shortcut for /worktree dispose)",
		handler: async (_args, ctx) => handleDispose(ctx),
	});

	pi.registerCommand("worktree-destroy", {
		description: "Destroy a git worktree (shortcut for /worktree destroy)",
		handler: async (args, ctx) => handleDestroy(args?.trim() || "", ctx),
	});

	pi.registerCommand("worktree-list", {
		description: "List all git worktrees (shortcut for /worktree list)",
		handler: async (_args, ctx) => handleList(ctx),
	});

	// --- Create handler ---
	async function handleCreate(nameArg: string, ctx: ExtensionCommandContext) {
		try {
			const repoRoot = await getRepoRoot(pi);
			const config = loadConfig(repoRoot);
			const { branch, worktreePath, base } = planCreate(
				repoRoot,
				config,
				parseCreateArgs(nameArg ?? ""),
			);

			// Never re-create over an existing worktree/dir: that would risk
			// clobbering a real branch or discarding an existing checkout.
			if (existsSync(worktreePath)) {
				ctx.ui.notify(
					`Worktree "${branch}" already exists at ${worktreePath}. Use /worktree destroy ${branch} first, or pick another name.`,
					"error",
				);
				return;
			}

			await createWorktree(pi, ctx, repoRoot, config, {
				branch,
				worktreePath,
				base,
			});

			// Fork the parent session so history follows the hop, plus a handoff note.
			const sessionFile = currentSessionFile(ctx);
			const handoffB64 = await buildHandoff(pi, repoRoot, sessionFile);
			const relaunched = relaunchInPlace(worktreePath, sessionFile, handoffB64);
			if (!relaunched) {
				ctx.ui.notify(
					`✅ Worktree "${branch}" ready\n` +
						`   Path:   ${worktreePath}\n` +
						`   Branch: ${branch}\n` +
						`   Start PI: cd ${worktreePath} && pi`,
					"info",
				);
			}
			if (relaunched) {
				ctx.shutdown();
			}
		} catch (err) {
			ctx.ui.setStatus("worktree", undefined);
			ctx.ui.notify(
				`Failed to create worktree: ${(err as Error).message}`,
				"error",
			);
		}
	}

	// --- Dispose handler (step out of the current worktree, then remove it) ---
	async function handleDispose(ctx: ExtensionCommandContext) {
		try {
			const repoRoot = await getRepoRoot(pi);
			const detected = await detectWorktree(pi);
			if (!detected || resolve(ctx.cwd) === resolve(repoRoot)) {
				ctx.ui.notify(
					"Not inside a worktree — nothing to dispose. Use /worktree destroy <branch> from the main checkout.",
					"error",
				);
				return;
			}

			const config = loadConfig(repoRoot);
			const { branch, worktreePath } = detected;

			// Refuse if the fork session file lives inside the worktree: the
			// detached teardown would delete it before `pi --fork` could read it.
			const sessionFile = currentSessionFile(ctx);
			if (sessionFile && isPathInside(sessionFile, worktreePath)) {
				ctx.ui.notify(
					`The session file (${sessionFile}) lives inside this worktree, so disposing would delete it and lose history. Move your session directory outside the worktree, or dispose manually.`,
					"error",
				);
				return;
			}

			// Count both tracked-uncommitted and gitignored files: the worktree is
			// rm -rf'd, so per-worktree .env.local / local DBs are destroyed too.
			let uncommitted = 0;
			let ignored = 0;
			const st = await pi.exec("git", ["status", "--porcelain", "--ignored"], {
				cwd: worktreePath,
				timeout: 5_000,
			});
			if (st.code === 0) {
				for (const line of st.stdout.split("\n")) {
					if (!line.trim()) continue;
					if (line.startsWith("!!")) ignored++;
					else uncommitted++;
				}
			}

			const lost: string[] = [];
			if (uncommitted > 0) lost.push(`${uncommitted} uncommitted file(s)`);
			if (ignored > 0)
				lost.push(
					`${ignored} gitignored file(s) (incl. .env.local / local DBs)`,
				);
			const warn = lost.length
				? `\n\n⚠️  ${lost.join(" and ")} will be permanently lost.`
				: "";
			const ok = await ctx.ui.confirm(
				"Dispose this worktree?",
				`This exits pi, removes ${worktreePath}, soft-deletes branch ${branch} (kept if it has unmerged commits), and reopens pi in ${repoRoot} carrying this session.${warn}`,
			);
			if (!ok) return;

			const handoffB64 = encodeHandoff({
				parentCwd: worktreePath,
				parentBranch: branch,
				uncommitted,
				ignored,
				kind: "dispose",
			});
			const typedCmd = buildRelaunchCommand(repoRoot, sessionFile, handoffB64);
			const preScript = buildDisposeScript(
				repoRoot,
				worktreePath,
				branch,
				config.preRemove,
			);
			const scheduled = scheduleRelaunch({ typedCmd, preScript });
			if (!scheduled) {
				ctx.ui.notify(
					`No tmux/cmux detected — cannot carry the session automatically.\n` +
						`Do it manually:\n` +
						`  cd ${repoRoot} && pi${sessionFile ? ` --fork ${sessionFile}` : ""}\n` +
						`  /worktree destroy ${branch}`,
					"info",
				);
				return;
			}
			ctx.shutdown();
		} catch (err) {
			ctx.ui.setStatus("worktree", undefined);
			ctx.ui.notify(
				`Failed to dispose worktree: ${(err as Error).message}`,
				"error",
			);
		}
	}

	// --- Destroy handler ---
	async function handleDestroy(nameArg: string, ctx: ExtensionCommandContext) {
		if (!nameArg) {
			ctx.ui.notify("Usage: /worktree destroy <branch>", "error");
			return;
		}

		try {
			const repoRoot = await getRepoRoot(pi);
			const config = loadConfig(repoRoot);
			// Accept both the literal branch and its conventional form so an
			// explicit `--branch` worktree (e.g. release/2.0) is destroyable too.
			const candidates = destroyCandidates(nameArg, config);

			// Resolve the target from git's authoritative worktree list rather than
			// reconstructing it from the branch slug. Looking up by exact branch
			// removes any slug ambiguity so destroy can never act on the wrong
			// checkout, and refuses the main working tree.
			const listed = await pi.exec("git", ["worktree", "list", "--porcelain"], {
				cwd: repoRoot,
				timeout: 5_000,
			});
			const entry =
				listed.code === 0
					? resolveDestroyTarget(
							parseWorktreeList(listed.stdout),
							candidates,
							repoRoot,
						)
					: { error: "Could not read the git worktree list." };
			if ("error" in entry) {
				ctx.ui.notify(entry.error, "error");
				return;
			}
			const { path: worktreePath, branch } = entry;

			// Refuse to remove the directory out from under a live session: destroy
			// does not relaunch, so doing so would leave this pi with a dead cwd.
			if (isPathInside(ctx.cwd, worktreePath)) {
				ctx.ui.notify(
					`You are inside ${worktreePath}. Use /worktree dispose to leave and remove it, or run destroy from the main checkout.`,
					"error",
				);
				return;
			}

			const ok = await ctx.ui.confirm(
				"Destroy worktree?",
				`This will remove ${worktreePath} and hard-delete branch ${branch}.`,
			);
			if (!ok) return;

			const step = (msg: string) => ctx.ui.setStatus("worktree", msg);

			// Teardown: preRemove hooks, worktree removal, hard branch-delete.
			// All paths/branch are shQuote'd inside buildDestroyScript.
			step("⏳ Tearing down worktree...");
			await pi.exec(
				"bash",
				[
					"-c",
					buildDestroyScript(repoRoot, worktreePath, branch, config.preRemove),
				],
				{ timeout: 130_000 },
			);

			step("");
			// Verify rather than trust: report the ACTUAL post-teardown state of both
			// the worktree directory and the branch.
			const wtGone = !existsSync(worktreePath);
			const branchRef = await pi.exec(
				"git",
				["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
				{ cwd: repoRoot, timeout: 5_000 },
			);
			const branchGone = branchRef.code !== 0;
			if (wtGone && branchGone) {
				ctx.ui.notify(
					`✅ Worktree "${branch}" destroyed\n` +
						`   Path:   ${worktreePath} (removed)\n` +
						`   Branch: ${branch} (hard-deleted)`,
					"info",
				);
			} else {
				const bits: string[] = [];
				if (!wtGone) bits.push(`${worktreePath} still exists`);
				if (!branchGone) bits.push(`branch ${branch} was not deleted`);
				ctx.ui.notify(
					`⚠️  Worktree "${branch}" not fully destroyed: ${bits.join("; ")}.\n` +
						`   Check \`git worktree list\` / \`git branch\` and clean up manually.`,
					"error",
				);
			}
		} catch (err) {
			ctx.ui.setStatus("worktree", undefined);
			ctx.ui.notify(
				`Failed to destroy worktree: ${(err as Error).message}`,
				"error",
			);
		}
	}

	// --- List handler ---
	async function handleList(ctx: ExtensionCommandContext) {
		const result = await pi.exec("git", ["worktree", "list"], {
			timeout: 5_000,
		});
		if (result.code !== 0) {
			ctx.ui.notify("Failed to list worktrees", "error");
			return;
		}
		ctx.ui.notify(result.stdout.trim() || "No worktrees", "info");
	}
}

// ---------------------------------------------------------------------------
// Core: create worktree
// ---------------------------------------------------------------------------

async function createWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	repoRoot: string,
	config: WorktreeConfig,
	plan: CreatePlan,
) {
	const { branch, worktreePath, base } = plan;

	const step = (msg: string) => ctx.ui.setStatus("worktree", msg);
	const run = async (cmd: string, timeout = 30_000) => {
		const r = await pi.exec("bash", ["-c", cmd], { timeout });
		if (r.code !== 0) throw new Error(r.stderr || `Command failed: ${cmd}`);
		return r;
	};

	// 1. Git worktree
	step(`⏳ Creating git worktree (${branch})...`);
	await run(buildCreateScript(repoRoot, worktreePath, branch, base));

	// 2. Link env files
	if (config.linkEnvFiles !== false) {
		step("⏳ Linking env files...");
		await run(`
      cd ${shQuote(repoRoot)}
      for f in .env*; do
        [ -f "$f" ] || continue
        [ "$f" = ".env.local" ] && continue
        git check-ignore -q "$f" 2>/dev/null || continue
        ln -sf ${shQuote(repoRoot)}/"$f" ${shQuote(worktreePath)}/"$f"
      done
    `);
	}

	// 3. Post-create hooks
	if (config.postCreate?.length) {
		for (let i = 0; i < config.postCreate.length; i++) {
			const cmd = config.postCreate[i];
			step(
				`⏳ Post-create [${i + 1}/${config.postCreate.length}]: ${cmd.slice(0, 60)}...`,
			);
			const r = await pi.exec(
				"bash",
				["-c", `cd ${shQuote(worktreePath)} && ${cmd}`],
				{
					timeout: 120_000,
				},
			);
			if (r.code !== 0) {
				throw new Error(
					`postCreate step ${i + 1} failed (${cmd}): ${(r.stderr || r.stdout || "").trim()}`,
				);
			}
		}
	}

	step("");
}
