import { spawnSync } from "node:child_process";
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
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ClaimOwner, ReceiptStore } from "./worktree-receipt.ts";
import {
	acquireClaim,
	advanceReceipt,
	classifyProvisioning,
	configDigest,
	createStore,
	failedReceipt,
	newReceipt,
	readReceipt,
	readyReceipt,
	releaseClaim,
	removeReceipt,
	writeReceipt,
} from "./worktree-receipt.ts";
import type {
	CheckoutState,
	ExecutionPreference,
	ProvisioningState,
	PendingTransition,
	TransitionCode,
	TransitionDetails,
	TransitionIntent,
} from "./worktree-transition.ts";
import {
	buildDetails,
	decidePendingToolCall,
	orderedBranchCandidates,
	refusedDetails,
	selectExecution,
	sessionCarryFor,
	validateTransitionRequest,
} from "./worktree-transition.ts";
import type { ProbeDeps, RecampTarget } from "./worktree-transport.ts";
import {
	buildWaiterInvocation,
	scheduleWaiter,
	selectTransport,
} from "./worktree-transport.ts";

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
	if (marker?.enforce !== true) return false; // default off / not opted in
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

/** Human-facing default location hint for created worktrees. The branch part is
 *  deliberately a placeholder because exact branch resolution depends on the
 *  requested name and optional --branch override. */
export function worktreeLocationHint(
	repoRoot: string,
	config: WorktreeConfig,
): string {
	return join(getWorktreeDir(repoRoot, config), "<branch-slug>");
}

/** System-prompt note injected only when a repo opted in and the current
 *  session is still in the primary checkout. This keeps worktree discipline a
 *  per-repo/private choice without requiring AGENTS.md or global prompt text. */
export function worktreeDisciplinePrompt(
	repoRoot: string,
	config: WorktreeConfig,
): string {
	const location = worktreeLocationHint(repoRoot, config);
	return (
		`## Worktree Discipline\n` +
		`This repo enforces worktree-only edits in its main checkout. The write/edit tools will be refused here until the session is in a linked git worktree.\n` +
		`Default worktree location: ${location}\n` +
		`Use \`/worktree <type/name>\` to create a worktree and relaunch pi there in one step. If a worktree already exists, use \`/worktree enter <type/name>\` to re-camp this session into it.\n` +
		`Manually running \`git worktree add\` creates a checkout but does not move this pi session; tools will still resolve relative paths from the main checkout until pi is relaunched in the worktree.`
	);
}

/** Reactive block reason for write/edit attempts in an enforced main checkout. */
export function worktreeDisciplineBlockReason(opts: {
	toolName: string;
	relPath: string;
	repoRoot: string;
	config: WorktreeConfig;
	detail?: string;
}): string {
	const location = worktreeLocationHint(opts.repoRoot, opts.config);
	return (
		`worktree-discipline: this repo enforces worktree-only edits and you are in its main checkout.\n` +
		`Refused ${opts.toolName} to ${opts.relPath}. Create or enter a worktree first.\n` +
		(opts.detail ? `${opts.detail}\n` : "") +
		`Preferred: /worktree <type/name>  (creates and relaunches pi there)\n` +
		`Existing checkout: /worktree enter <type/name>  (re-camps this session into it)\n` +
		`Default location: ${location}\n` +
		`Manual fallback: git worktree add ${location} -b <branch-name>, then restart pi from that worktree. Running git worktree add alone does not move this session.\n` +
		`Do not write files directly under the worktree base before git has created the linked worktree; that pre-creates the directory and makes git worktree add fail.\n` +
		`Escape hatches: /worktree-enforce out, or add the path to allowPaths in ${MARKER_REL} from a worktree (the marker is not editable via write/edit in the enforced main checkout).`
	);
}

/** Writes under a configured worktree base are safe only after git has created
 *  an actual linked worktree there. This catches both the no-repo case and the
 *  nested-outer-repo case where rev-parse succeeds against an unrelated repo. */
export function shouldBlockWorktreeBaseWrite(opts: {
	absPath: string;
	worktreeBase: string;
	targetRoot?: string;
	targetMainCheckout?: boolean;
}): boolean {
	if (!isPathInside(opts.absPath, opts.worktreeBase)) return false;
	if (!opts.targetRoot) return true;
	return !(
		isPathInside(opts.targetRoot, opts.worktreeBase) &&
		isPathInside(opts.absPath, opts.targetRoot) &&
		opts.targetMainCheckout === false
	);
}

export function summarizeWorktreeStatus(porcelainWithIgnored: string): {
	uncommitted: number;
	ignored: number;
} {
	let uncommitted = 0;
	let ignored = 0;
	for (const line of porcelainWithIgnored.split("\n")) {
		if (!line.trim()) continue;
		if (line.startsWith("!!")) ignored++;
		else uncommitted++;
	}
	return { uncommitted, ignored };
}

export function unsafeDisposeReason(opts: {
	cwd: string;
	sessionFile?: string;
	worktreePath: string;
	porcelainWithIgnored: string;
}): string | null {
	if (isPathInside(opts.cwd, opts.worktreePath)) {
		return `Refusing to dispose ${opts.worktreePath} because the current pi session is running inside that worktree.`;
	}
	if (opts.sessionFile && isPathInside(opts.sessionFile, opts.worktreePath)) {
		return `Refusing to dispose ${opts.worktreePath} because the session file (${opts.sessionFile}) is inside that worktree.`;
	}
	const { uncommitted, ignored } = summarizeWorktreeStatus(
		opts.porcelainWithIgnored,
	);
	const dirty: string[] = [];
	if (uncommitted > 0)
		dirty.push(`${uncommitted} uncommitted/untracked file(s)`);
	if (ignored > 0) dirty.push(`${ignored} ignored file(s)`);
	return dirty.length
		? `Refusing to dispose dirty worktree ${opts.worktreePath}: ${dirty.join(" and ")}. Commit, remove, or move those files first.`
		: null;
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

/** Choose an existing linked worktree to enter/re-camp into for a branch. */
export function resolveEnterTarget(
	worktrees: { path: string; branch: string | null }[],
	branches: string[],
	repoRoot: string,
): { path: string; branch: string } | { error: string } {
	const entry = branches
		.map((b) => worktrees.find((w) => w.branch === b))
		.find((w): w is { path: string; branch: string } => w !== undefined);
	if (!entry || entry.branch === null) {
		const names = branches.map((b) => `"${b}"`).join(" or ") || "(none)";
		return {
			error: `No linked worktree is checked out on branch ${names}. Run /worktree list to see existing worktrees, or /worktree <type/name> to create one.`,
		};
	}
	if (canonicalPath(entry.path) === canonicalPath(repoRoot)) {
		return {
			error: `Branch "${entry.branch}" is checked out in the main working tree. Create a linked worktree first with /worktree <type/name>.`,
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
 *  handoff payload via PI_WT_HANDOFF for the new session to decode.
 *
 *  `continuation` is passed as pi's positional initial message. A forked
 *  session otherwise loads history and waits at the editor, so this is the
 *  only thing that makes an interrupted task resume without a human nudge. */
export function buildRelaunchCommand(
	targetDir: string,
	forkSessionFile?: string,
	handoffB64?: string,
	continuation?: string,
): string {
	const envPrefix = handoffB64 ? `PI_WT_HANDOFF=${shQuote(handoffB64)} ` : "";
	const forkArg = forkSessionFile ? ` --fork ${shQuote(forkSessionFile)}` : "";
	const msgArg = continuation?.trim() ? ` ${shQuote(continuation.trim())}` : "";
	return `cd ${shQuote(targetDir)} && ${envPrefix}pi${forkArg}${msgArg}`;
}

/** Initial message for a session that hopped while the agent was mid-task.
 *
 *  `ctx.shutdown()` aborts the turn in flight, so the carried history can end
 *  on an unanswered tool call or a side effect whose result was never seen.
 *  The message therefore tells the agent to re-establish state before acting:
 *  a bare "continue" invites it to redo work that already succeeded. */
export function buildContinuationMessage(
	kind: WtHandoff["kind"],
	targetCwd: string,
): string {
	const where =
		kind === "dispose"
			? `back to the main checkout at ${targetCwd}, and the worktree you were in has been removed`
			: `into the worktree at ${targetCwd}`;
	return (
		`[automatic] Your session was moved ${where}. The turn you were running ` +
		`was interrupted by that hop, so work may be half-finished.\n\n` +
		`Re-establish where you actually got to before doing anything: check ` +
		`git status and the files you were editing. Do not redo steps that ` +
		`already completed. Then carry on with the task you were working on.`
	);
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
	sourceCwd: string,
	sessionFile: string | undefined,
	parentCwd = sourceCwd,
): Promise<string | undefined> {
	if (!sessionFile) return undefined;
	let parentBranch = "";
	try {
		const b = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: sourceCwd,
			timeout: 5_000,
		});
		if (b.code === 0) parentBranch = b.stdout.trim();
	} catch {
		// best-effort
	}
	let uncommitted = 0;
	try {
		const st = await pi.exec("git", ["status", "--porcelain"], {
			cwd: sourceCwd,
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
		parentCwd,
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
 * Transport detection and the detached waiter live in the transport module so
 * ownership rules and script construction have one implementation. Re-exported
 * because they are part of this extension's tested public surface.
 */
export type { MuxEnv, RecampTarget } from "./worktree-transport.ts";
export { pickRelaunchMux } from "./worktree-transport.ts";

/** Probe backend for the running process: read-only queries, bounded, no shell. */
const liveProbeDeps: ProbeDeps = {
	hasExecutable(name) {
		// Presence is decided by whether the binary can be executed at all, not by
		// its exit code: a transport that rejects `--version` is still installed.
		// Avoids a shell, so nothing here can be word-split or expanded.
		const r = spawnSync(name, ["--version"], { timeout: 3_000 });
		return (r.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT";
	},
	run(command, args, timeoutMs) {
		const r = spawnSync(command, args, {
			encoding: "utf-8",
			timeout: timeoutMs,
		});
		return {
			code: r.status ?? 1,
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? "",
		};
	},
};

/**
 * Schedule a pi relaunch in the current terminal pane, once this pi process has
 * exited, via the multiplexer that owns the pane.
 *
 * Resolves only when the OS confirms the waiter process started. Scheduling is
 * still weaker than delivery: an acknowledged waiter proves something is there
 * to run the relaunch, not that the multiplexer accepted the keys.
 */
async function scheduleRelaunch(opts: {
	typedCmd: string;
	preScript?: string;
	recamp?: RecampTarget;
}): Promise<boolean> {
	const selection = selectTransport(process.env, liveProbeDeps);
	if (!selection.available) return false;

	const result = await scheduleWaiter(
		buildWaiterInvocation({
			candidate: selection.candidate,
			parentPid: process.pid,
			typedCmd: opts.typedCmd,
			...(opts.preScript ? { preScript: opts.preScript } : {}),
			...(opts.recamp ? { recamp: opts.recamp } : {}),
		}),
	);
	if (!result.ok) return false;
	// Nothing else needs to hold this waiter: create/enter has no claim to hand
	// over, so it is released as soon as the OS confirms it exists.
	result.handle.commitDetach();
	return true;
}

/** Continuation message for a hop, or undefined when the agent was idle.
 *
 *  Gating on `isIdle()` matters: hopping from an idle prompt (the usual
 *  `/worktree feat/x` case) must NOT submit a message, or the new session
 *  opens by burning a turn asking what task it is supposed to resume. */
function continuationFor(
	ctx: ExtensionContext,
	kind: WtHandoff["kind"],
	targetCwd: string,
): string | undefined {
	return ctx.isIdle() ? undefined : buildContinuationMessage(kind, targetCwd);
}

/** Relaunch pi in a worktree, forking the parent session and passing a handoff.
 *  Under herdr this re-camps into a new tab named after `branch`. */
async function relaunchInPlace(
	worktreePath: string,
	branch: string,
	forkSessionFile?: string,
	handoffB64?: string,
	continuation?: string,
): Promise<boolean> {
	const typedCmd = buildRelaunchCommand(
		worktreePath,
		forkSessionFile,
		handoffB64,
		continuation,
	);
	return scheduleRelaunch({
		typedCmd,
		recamp: { targetCwd: worktreePath, tabLabel: branch },
	});
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let worktreeBranch: string | null = null;
	let agentWorktree: { repoRoot: string; branch: string; path: string } | null =
		null;
	/**
	 * Set once a hand-off is armed and shutdown has been requested. Every later
	 * side effect belongs to the replacement session, not this one.
	 */
	let pendingTransition: PendingTransition | null = null;

	// --- Model-callable worktree session helper ---
	pi.registerTool({
		name: "worktree_session",
		label: "Worktree Session",
		description:
			"Create, enter, inspect, or dispose git worktrees using this repo's pi-worktree conventions. On a capable interactive runtime, create/enter move this session into the worktree by restarting pi there.",
		promptSnippet:
			"Manage git worktree discipline: create/enter a linked worktree, then dispose it after committing.",
		promptGuidelines: [
			"Use worktree_session when a repo enforces worktree discipline and you need to write/edit from the main checkout.",
			"Call worktree_session create or enter as the ONLY tool call in that response: it may end this session and resume it inside the worktree.",
			"Read the worktree_session outcome field: relaunch-scheduled means this session is ending and a replacement resumes the task; path-target means the process did NOT move, so use absolute paths under worktreePath and prefix bash with `cd <worktreePath> &&`; manual-restart means nothing moved and the user must run the supplied command.",
			'Pass execution:"paths" to worktree_session when you deliberately want to keep this process where it is and work through absolute paths instead of restarting.',
			"Call worktree_session dispose after committing when the task asks you to step back out to the main git directory; it refuses to remove a dirty worktree.",
		],
		// Sequential execution makes the whole sibling batch ordered, so tool calls
		// the model issued alongside a transition finish and are recorded before
		// this session is allowed to shut down.
		executionMode: "sequential",
		parameters: Type.Object({
			action: StringEnum(["status", "create", "enter", "dispose"] as const, {
				description: "Worktree lifecycle action.",
			}),
			execution: Type.Optional(
				StringEnum(["auto", "recamp", "paths"] as const, {
					description:
						"auto (default): move this session into the worktree when the runtime supports it, otherwise fall back truthfully. recamp: require a real session move. paths: stay here and use absolute paths.",
				}),
			),
			name: Type.Optional(
				Type.String({
					description:
						"Conventional worktree name such as feat/my-feature or my-feature.",
				}),
			),
			branch: Type.Optional(
				Type.String({
					description: "Exact branch name, bypassing name resolution.",
				}),
			),
			base: Type.Optional(
				Type.String({ description: "Base ref for create. Defaults to HEAD." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return handleWorktreeSessionTool(params, ctx);
		},
	});

	// --- Optional worktree-discipline guard ---
	pi.on("tool_call", async (event, ctx) => {
		// A pending transition means this process is on its way out. Running any
		// further tool here would act on the wrong working directory and its
		// result would never reach the session that continues the task.
		const pendingDecision = decidePendingToolCall({
			toolName: event.toolName,
			action: (event.input as { action?: string } | undefined)?.action,
			pending: pendingTransition !== null,
		});
		if (!pendingDecision.allow) {
			return { block: true, reason: pendingDecision.reason };
		}

		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const target = (event.input as { path?: unknown }).path;
		if (typeof target !== "string" || target.length === 0) return;
		const absPath = isAbsolute(target) ? target : resolve(ctx.cwd, target);

		const session = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
			cwd: ctx.cwd,
		});
		const sessionRoot = session.code === 0 ? session.stdout.trim() : "";
		const sessionMarker = sessionRoot ? readMarker(sessionRoot) : null;
		const sessionConfig = sessionRoot ? loadConfig(sessionRoot) : {};
		const sessionWorktreeBase = sessionRoot
			? getWorktreeDir(sessionRoot, sessionConfig)
			: "";
		const enforcedMainSession =
			sessionRoot &&
			sessionMarker?.enforce === true &&
			isMainCheckout(sessionRoot);

		// Repo root that contains the target path. Use the nearest existing parent so
		// writes to new subdirectories are still guarded.
		const gitCwd = nearestExistingDir(dirname(absPath));
		if (!gitCwd) return;
		const res = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
			cwd: gitCwd,
		});
		const root = res.code === 0 ? res.stdout.trim() : "";
		if (
			enforcedMainSession &&
			shouldBlockWorktreeBaseWrite({
				absPath,
				worktreeBase: sessionWorktreeBase,
				targetRoot: root || undefined,
				targetMainCheckout: root ? isMainCheckout(root) : undefined,
			})
		) {
			return {
				block: true,
				reason: worktreeDisciplineBlockReason({
					toolName: event.toolName,
					relPath: relative(sessionRoot, absPath),
					repoRoot: sessionRoot,
					config: sessionConfig,
					detail:
						"The target is under the configured worktree base, but it is not inside an existing linked git worktree yet.",
				}),
			};
		}
		if (res.code !== 0) return; // not a git repo and not the configured worktree base: allow
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
			reason: worktreeDisciplineBlockReason({
				toolName: event.toolName,
				relPath,
				repoRoot: root,
				config: loadConfig(root),
			}),
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
					const relaunched = await relaunchInPlace(
						worktreePath,
						branch,
						sessionFile,
						handoffB64,
						continuationFor(ctx, "enter", worktreePath),
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
		} else {
			// If this repo has opted in while we are still in the main checkout, tell
			// the agent before it attempts a blocked write. This is intentionally
			// dynamic per repo/session rather than shared AGENTS.md prompt text.
			const currentRoot = await pi.exec(
				"git",
				["rev-parse", "--path-format=absolute", "--show-toplevel"],
				{ timeout: 5_000 },
			);
			if (currentRoot.code === 0) {
				const root = currentRoot.stdout.trim();
				const marker = root ? readMarker(root) : null;
				if (root && marker?.enforce === true && isMainCheckout(root)) {
					extra += `\n\n${worktreeDisciplinePrompt(root, loadConfig(root))}`;
				}
			}
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

	/** Canonical description of the checkout this process is standing in. */
	async function currentCheckoutState(
		repoRoot: string,
	): Promise<CheckoutState> {
		const detected = await detectWorktree(pi);
		const path = canonicalPath(detected?.worktreePath ?? repoRoot);
		let branch = detected?.branch ?? null;
		if (!branch) {
			const head = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
				cwd: path,
				timeout: 5_000,
			});
			branch =
				head.code === 0 && head.stdout.trim() !== "HEAD"
					? head.stdout.trim()
					: null;
		}
		return { path, branch, kind: detected ? "linked" : "main" };
	}

	/**
	 * The repository's common git directory, where lifecycle evidence lives.
	 *
	 * `--path-format` needs git 2.31; older git still answers the plain form,
	 * which is relative to the repository it was asked from.
	 */
	async function resolveGitCommonDir(repoRoot: string): Promise<string> {
		const absolute = await pi.exec(
			"git",
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ cwd: repoRoot, timeout: 5_000 },
		);
		if (absolute.code === 0 && absolute.stdout.trim())
			return absolute.stdout.trim();
		const legacy = await pi.exec("git", ["rev-parse", "--git-common-dir"], {
			cwd: repoRoot,
			timeout: 5_000,
		});
		if (legacy.code === 0 && legacy.stdout.trim()) {
			return resolve(repoRoot, legacy.stdout.trim());
		}
		throw new Error("Could not resolve the repository's common git directory.");
	}

	function newOperationId(): string {
		return `wt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	/** Whether this pi provides the lifecycle guarantees a re-camp depends on. */
	function piSupportsRecamp(ctx: ExtensionContext): boolean {
		// Deferred shutdown and sequential/terminating tool results are 0.83
		// contracts. `mode` is the observable proof they are present, since older
		// contexts did not expose it at all.
		return typeof ctx.mode === "string";
	}

	async function listWorktrees(repoRoot: string) {
		const listed = await pi.exec("git", ["worktree", "list", "--porcelain"], {
			cwd: repoRoot,
			timeout: 5_000,
		});
		if (listed.code !== 0)
			throw new Error("Could not read the git worktree list.");
		return parseWorktreeList(listed.stdout);
	}

	/**
	 * Start a session hand-off to `target` and report whether a waiter is armed.
	 *
	 * Returns only after the OS confirms the waiter exists, so a caller that goes
	 * on to request shutdown knows something is there to bring the session back.
	 */
	async function startRecamp(opts: {
		targetCwd: string;
		tabLabel: string;
		typedCmd: string;
		preScript?: string;
	}): Promise<
		| { ok: true; transport: "cmux" | "herdr" | "tmux" }
		| { ok: false; code: TransitionCode; reason: string }
	> {
		const selection = selectTransport(process.env, liveProbeDeps);
		if (!selection.available) {
			return {
				ok: false,
				code: "transport-preflight-failed",
				reason: selection.reason,
			};
		}
		const result = await scheduleWaiter(
			buildWaiterInvocation({
				candidate: selection.candidate,
				parentPid: process.pid,
				typedCmd: opts.typedCmd,
				...(opts.preScript ? { preScript: opts.preScript } : {}),
				recamp: { targetCwd: opts.targetCwd, tabLabel: opts.tabLabel },
			}),
		);
		if (!result.ok)
			return { ok: false, code: "schedule-failed", reason: result.reason };
		result.handle.commitDetach();
		return { ok: true, transport: selection.candidate.kind };
	}

	/** Provisioning classification for a target, fail-closed on damaged evidence. */
	function provisioningFor(
		store: ReceiptStore,
		targetPath: string,
		branch: string,
	) {
		return classifyProvisioning(readReceipt(store, targetPath), {
			worktreePath: targetPath,
			branch,
		});
	}

	function toolResult(
		details: TransitionDetails,
		message: string,
		terminate?: boolean,
	) {
		return {
			content: [{ type: "text" as const, text: message }],
			details: details as unknown as Record<string, unknown>,
			...(terminate ? { terminate: true } : {}),
		};
	}

	/**
	 * Model-callable worktree lifecycle.
	 *
	 * Every outcome states where the process actually is. Refusals are returned
	 * as structured results rather than thrown, so the model keeps the evidence
	 * (code, target, recovery) instead of a bare error string.
	 */
	async function handleWorktreeSessionTool(
		params: {
			action: "status" | "create" | "enter" | "dispose";
			execution?: ExecutionPreference;
			name?: string;
			branch?: string;
			base?: string;
		},
		ctx: ExtensionContext,
	) {
		const repoRoot = await getRepoRoot(pi);
		const config = loadConfig(repoRoot);
		const processState = await currentCheckoutState(repoRoot);

		const validated = validateTransitionRequest({
			origin: "model",
			intent: params.action as TransitionIntent,
			...(params.execution ? { execution: params.execution } : {}),
			...(params.name ? { name: params.name } : {}),
			...(params.branch ? { branch: params.branch } : {}),
			...(params.base ? { base: params.base } : {}),
		});
		if (!validated.ok) {
			return toolResult(
				refusedDetails(
					params.action,
					processState,
					"invalid-request",
					params.execution,
				),
				`Refused: ${validated.error.reason}`,
			);
		}
		const request = validated.request;
		const store = createStore(await resolveGitCommonDir(repoRoot));

		if (request.intent === "status") {
			const marker = readMarker(repoRoot);
			const details = buildDetails({
				action: "status",
				outcome: "status",
				process: processState,
				sessionMode: pendingTransition
					? "relaunch-pending"
					: agentWorktree
						? "path-target"
						: "process",
				...(agentWorktree
					? {
							target: {
								path: agentWorktree.path,
								branch: agentWorktree.branch,
								kind: "linked" as const,
							},
						}
					: {}),
			});
			const status = {
				...details,
				...(agentWorktree
					? {
							pathTarget: {
								path: agentWorktree.path,
								branch: agentWorktree.branch,
								kind: "linked" as const,
							},
						}
					: {}),
				...(pendingTransition ? { pending: pendingTransition } : {}),
				discipline: marker?.enforce === true ? "on" : "off",
				defaultWorktreeBase: getWorktreeDir(repoRoot, config),
			};
			return toolResult(
				status as unknown as TransitionDetails,
				`repoRoot: ${repoRoot}\n` +
					`discipline: ${marker?.enforce === true ? "on" : "off"}\n` +
					`defaultWorktreeBase: ${getWorktreeDir(repoRoot, config)}\n` +
					`processCheckout: ${processState.branch ?? "(detached)"} at ${processState.path} (${processState.kind})\n` +
					`sessionMode: ${status.sessionMode}\n` +
					`requiresAbsolutePaths: ${status.requiresAbsolutePaths}\n` +
					`pathTarget: ${agentWorktree ? `${agentWorktree.branch} at ${agentWorktree.path}` : "none"}\n` +
					`pendingTransition: ${pendingTransition ? `${pendingTransition.action} -> ${pendingTransition.target.path}` : "none"}`,
			);
		}

		if (request.intent === "dispose") {
			return handleModelDispose(request, processState, repoRoot, config, ctx);
		}

		// --- create / enter -------------------------------------------------
		const resolved = await resolveTransitionTarget(
			request,
			repoRoot,
			config,
			store,
		);
		if ("details" in resolved)
			return toolResult(resolved.details, resolved.message);

		const { target, provisioning } = resolved;
		const alreadyAtTarget =
			canonicalPath(processState.path) === canonicalPath(target.path) &&
			processState.branch === target.branch;

		const sessionFile = currentSessionFile(ctx);
		const decision = selectExecution({
			execution: request.execution,
			mode: ctx.mode,
			piCompatible: piSupportsRecamp(ctx),
			transportAvailable: selectTransport(process.env, liveProbeDeps).available,
			alreadyAtTarget,
			activeTurn: !ctx.isIdle(),
			sessionFileReadable: Boolean(sessionFile),
		});

		const unmanagedNote =
			provisioning === "unmanaged"
				? "\nNote: this checkout has no provisioning record, so its project hooks were never observed to run."
				: "";

		if (decision.kind === "already-active") {
			if (agentWorktree?.path === target.path) agentWorktree = null;
			return toolResult(
				buildDetails({
					action: request.intent === "enter" ? "enter" : "create",
					outcome: "already-active",
					process: processState,
					target,
					provisioning,
					requestedExecution: request.execution,
				}),
				`Already working in ${target.branch} at ${target.path}. Repo-relative paths resolve here.${unmanagedNote}`,
			);
		}

		const action = request.intent === "enter" ? "enter" : "create";
		const handoffB64 = await buildHandoff(
			pi,
			processState.path,
			sessionFile,
			processState.path,
		);
		const continuation = continuationFor(ctx, "enter", target.path);
		const recoveryCommand = buildRelaunchCommand(
			target.path,
			sessionFile,
			handoffB64,
			continuation,
		);

		if (decision.kind === "recamp") {
			const operationId = newOperationId();
			const started = await startRecamp({
				targetCwd: target.path,
				tabLabel: target.branch ?? basename(target.path),
				typedCmd: recoveryCommand,
			});
			if (!started.ok) {
				return toolResult(
					buildDetails({
						action,
						outcome: "manual-restart",
						process: processState,
						target,
						provisioning,
						code: started.code,
						requestedExecution: request.execution,
						recovery: {
							command: recoveryCommand,
							instructions: [
								"This session did not move and nothing was lost.",
								`Run the command above from ${processState.path} to continue in ${target.path}.`,
							],
						},
					}),
					`Could not hand this session over automatically (${started.reason}). The worktree is ready at ${target.path}; run:\n  ${recoveryCommand}`,
				);
			}

			pendingTransition = {
				operationId,
				action,
				target,
				transport: started.transport,
				scheduledAt: new Date().toISOString(),
				recoveryCommand,
			};
			ctx.shutdown();
			return toolResult(
				buildDetails({
					action,
					outcome: "relaunch-scheduled",
					process: processState,
					target,
					provisioning,
					operationId,
					transport: started.transport,
					sessionCarry: sessionCarryFor(decision, {
						execution: request.execution,
						mode: ctx.mode,
						piCompatible: true,
						transportAvailable: true,
						alreadyAtTarget: false,
						activeTurn: !ctx.isIdle(),
						sessionFileReadable: Boolean(sessionFile),
					}),
					requestedExecution: request.execution,
					recovery: {
						command: recoveryCommand,
						instructions: [
							"If the replacement session does not appear, run the command above manually.",
						],
					},
				}),
				`This session is moving into ${target.branch} at ${target.path} and will resume there; stop issuing tool calls now.${unmanagedNote}`,
				true,
			);
		}

		if (decision.kind === "manual-restart") {
			return toolResult(
				buildDetails({
					action,
					outcome: "manual-restart",
					process: processState,
					target,
					provisioning,
					code: decision.code,
					requestedExecution: request.execution,
					recovery: {
						command: recoveryCommand,
						instructions: [
							`This session is still in ${processState.path}.`,
							"Run the command above to continue inside the worktree.",
						],
					},
				}),
				`The worktree is ready at ${target.path}, but this session cannot move itself here (${decision.code}). Run:\n  ${recoveryCommand}${unmanagedNote}`,
			);
		}

		agentWorktree = {
			repoRoot,
			branch: target.branch ?? "",
			path: target.path,
		};
		return toolResult(
			buildDetails({
				action,
				outcome: "path-target",
				process: processState,
				target,
				provisioning,
				requestedExecution: request.execution,
			}),
			`Worktree ready, but this process is still in ${processState.path}.\n` +
				`branch: ${target.branch}\n` +
				`worktreePath: ${target.path}\n` +
				`Use absolute paths under worktreePath and run bash commands as: cd ${target.path} && <command>.${unmanagedNote}`,
		);
	}

	/**
	 * Resolve create/enter to an exact target, provisioning it when asked to.
	 *
	 * Strict create never adopts an existing checkout: a caller asking to create
	 * has not agreed to inherit whatever state is already on disk.
	 */
	async function resolveTransitionTarget(
		request: {
			intent: TransitionIntent;
			execution: ExecutionPreference;
			name?: string;
			branch?: string;
			base?: string;
		},
		repoRoot: string,
		config: WorktreeConfig,
		store: ReceiptStore,
	): Promise<
		| { target: CheckoutState; provisioning: ProvisioningState }
		| { details: TransitionDetails; message: string }
	> {
		const processState = await currentCheckoutState(repoRoot);
		const refuse = (code: TransitionCode, message: string) => ({
			details: refusedDetails(
				request.intent === "enter" ? "enter" : "create",
				processState,
				code,
				request.execution,
			),
			message: `Refused: ${message}`,
		});

		if (request.intent === "enter") {
			const candidates = orderedBranchCandidates(request as never, {
				resolve: (input) => resolveBranch(input, config),
				isValidExplicit: isValidExplicitBranch,
			});
			if (candidates.length === 0) {
				return refuse(
					"invalid-request",
					"no valid branch candidate was supplied.",
				);
			}
			const entry = resolveEnterTarget(
				await listWorktrees(repoRoot),
				candidates,
				repoRoot,
			);
			if ("error" in entry) return refuse("target-not-found", entry.error);

			const targetPath = canonicalPath(entry.path);
			const provisioning = provisioningFor(store, targetPath, entry.branch);
			if (provisioning === "corrupt") {
				return refuse(
					"receipt-corrupt",
					`the provisioning record for ${targetPath} does not describe this checkout. Inspect it before using this worktree.`,
				);
			}
			if (provisioning === "provisioning" || provisioning === "failed") {
				return refuse(
					"target-not-ready",
					`${targetPath} was never fully provisioned (${provisioning}). Dispose it and create it again rather than working in a half-built checkout.`,
				);
			}
			return {
				target: { path: targetPath, branch: entry.branch, kind: "linked" },
				provisioning,
			};
		}

		// create
		let plan: CreatePlan;
		try {
			plan = planCreate(repoRoot, config, {
				name: request.name ?? "",
				...(request.branch ? { branch: request.branch } : {}),
				...(request.base ? { base: request.base } : {}),
			});
		} catch (err) {
			return refuse("invalid-request", (err as Error).message);
		}

		const targetPath = canonicalPath(plan.worktreePath);
		const registered = (await listWorktrees(repoRoot)).find(
			(w) => canonicalPath(w.path) === targetPath,
		);
		if (existsSync(plan.worktreePath) || registered) {
			return refuse(
				registered && registered.branch === plan.branch
					? "target-exists"
					: "target-conflict",
				registered && registered.branch === plan.branch
					? `${plan.worktreePath} already exists on branch "${plan.branch}". Use enter to work in it.`
					: `${plan.worktreePath} already exists but is ${registered?.branch ? `checked out on branch "${registered.branch}"` : "not a registered worktree"}, not "${plan.branch}".`,
			);
		}

		const owner: ClaimOwner = {
			operationId: newOperationId(),
			pid: process.pid,
			role: "origin",
		};
		const claim = acquireClaim(store, targetPath, owner);
		if (!claim.ok) return refuse("target-busy", claim.reason);

		try {
			const provisioned = await provisionWorktree(
				store,
				owner,
				repoRoot,
				config,
				{
					...plan,
					worktreePath: targetPath,
				},
			);
			if (!provisioned.ok) return refuse(provisioned.code, provisioned.message);
			return {
				target: { path: targetPath, branch: plan.branch, kind: "linked" },
				provisioning: "ready",
			};
		} finally {
			releaseClaim(store, targetPath, owner);
		}
	}

	/**
	 * Create a worktree and record how far provisioning actually got.
	 *
	 * The receipt is written before git mutates anything, so a process that dies
	 * mid-hook leaves durable evidence that the checkout on disk is not ready.
	 */
	async function provisionWorktree(
		store: ReceiptStore,
		owner: ClaimOwner,
		repoRoot: string,
		config: WorktreeConfig,
		plan: CreatePlan,
	): Promise<
		{ ok: true } | { ok: false; code: TransitionCode; message: string }
	> {
		let receipt = newReceipt({
			operationId: owner.operationId,
			branch: plan.branch,
			worktreePath: plan.worktreePath,
			base: plan.base,
			configDigest: configDigest(config),
		});
		const initial = writeReceipt(store, owner, receipt);
		if (!initial.ok) {
			return {
				ok: false,
				code: "receipt-write-failed",
				message: `could not record provisioning intent (${initial.reason}); nothing was created.`,
			};
		}

		const record = (next: typeof receipt) => {
			receipt = next;
			writeReceipt(store, owner, receipt);
		};

		try {
			await runProvisioningSteps(pi, repoRoot, config, plan, (stage, index) =>
				record(advanceReceipt(receipt, stage, index)),
			);
		} catch (err) {
			const failure = err as ProvisioningFailure;
			record(
				failedReceipt(receipt, {
					code: failure.hook ? "hook-failed" : "git-failed",
					...(failure.exitCode === undefined
						? {}
						: { exitCode: failure.exitCode }),
				}),
			);
			return {
				ok: false,
				code: failure.hook ? "hook-failed" : "git-failed",
				message:
					`${failure.message}\n` +
					`The checkout at ${plan.worktreePath} exists but is NOT provisioned; it is recorded as failed and cannot be entered. ` +
					"Inspect it, then dispose it and create it again.",
			};
		}

		record(readyReceipt(receipt));
		return { ok: true };
	}
	/**
	 * Model-triggered disposal.
	 *
	 * The model can never authorise data loss, so any dirty state refuses. Live
	 * disposal is left to the interactive path until the waiter-owned teardown
	 * lands; the model is told plainly rather than being handed a half-measure.
	 */
	async function handleModelDispose(
		request: {
			execution: ExecutionPreference;
			name?: string;
			branch?: string;
			selectorless: boolean;
		},
		processState: CheckoutState,
		repoRoot: string,
		config: WorktreeConfig,
		ctx: ExtensionContext,
	) {
		const refuse = (code: TransitionCode, message: string) =>
			toolResult(
				refusedDetails("dispose", processState, code, request.execution),
				`Refused: ${message}`,
			);

		let entry: { path: string; branch: string };
		if (request.selectorless) {
			if (processState.kind === "linked" && processState.branch) {
				entry = { path: processState.path, branch: processState.branch };
			} else if (agentWorktree) {
				entry = { path: agentWorktree.path, branch: agentWorktree.branch };
			} else {
				return refuse(
					"target-not-found",
					"dispose needs an active worktree, a path target, or an explicit name/branch.",
				);
			}
		} else {
			const candidates = orderedBranchCandidates(request as never, {
				resolve: (input) => resolveBranch(input, config),
				isValidExplicit: isValidExplicitBranch,
			});
			if (candidates.length === 0) {
				return refuse(
					"invalid-request",
					"no valid branch candidate was supplied.",
				);
			}
			const resolved = resolveEnterTarget(
				await listWorktrees(repoRoot),
				candidates,
				repoRoot,
			);
			if ("error" in resolved)
				return refuse("target-not-found", resolved.error);
			entry = { path: canonicalPath(resolved.path), branch: resolved.branch };
		}

		const live = canonicalPath(entry.path) === canonicalPath(processState.path);
		const target: CheckoutState = {
			path: entry.path,
			branch: entry.branch,
			kind: "linked",
		};

		const dirty = await pi.exec("git", ["status", "--porcelain", "--ignored"], {
			cwd: entry.path,
			timeout: 5_000,
		});
		if (dirty.code !== 0)
			return refuse("git-failed", "could not read the worktree status.");
		const unsafeReason = unsafeDisposeReason({
			cwd: ctx.cwd,
			...(currentSessionFile(ctx)
				? { sessionFile: currentSessionFile(ctx) }
				: {}),
			worktreePath: entry.path,
			porcelainWithIgnored: dirty.stdout,
		});
		if (unsafeReason) {
			return refuse(live ? "live-cwd-unsafe" : "dirty-worktree", unsafeReason);
		}

		if (live) {
			// Removing the directory this process is standing in has to happen after
			// it exits, which is the interactive dispose flow.
			return toolResult(
				buildDetails({
					action: "dispose",
					outcome: "manual-restart",
					process: processState,
					target,
					code: "live-cwd-unsafe",
					requestedExecution: request.execution,
					recovery: {
						instructions: [
							"This session is inside the worktree being disposed.",
							"Run /worktree dispose so teardown happens after pi exits, then continue in the main checkout.",
						],
					},
				}),
				`This session is inside ${entry.path}, so it cannot remove it from under itself. Run /worktree dispose instead.`,
			);
		}

		const dispose = await pi.exec(
			"bash",
			[
				"-c",
				buildDisposeScript(
					repoRoot,
					entry.path,
					entry.branch,
					config.preRemove,
				),
			],
			{ timeout: 130_000 },
		);
		const registrationGone = !(await listWorktrees(repoRoot)).some(
			(w) => canonicalPath(w.path) === canonicalPath(entry.path),
		);
		const pathGone = !existsSync(entry.path);
		const branchRef = await pi.exec(
			"git",
			["show-ref", "--verify", "--quiet", `refs/heads/${entry.branch}`],
			{ cwd: repoRoot, timeout: 5_000 },
		);
		const branchKept = branchRef.code === 0;

		if (agentWorktree?.path === entry.path) agentWorktree = null;
		if (pathGone && registrationGone) {
			removeReceipt(
				createStore(await resolveGitCommonDir(repoRoot)),
				canonicalPath(entry.path),
			);
		}

		const complete = pathGone && registrationGone && dispose.code === 0;
		return toolResult(
			buildDetails({
				action: "dispose",
				outcome: complete ? "disposed" : "dispose-partial",
				process: processState,
				target,
				remoteProcessLiveness: "unknown",
				requestedExecution: request.execution,
				...(complete ? {} : { code: "dispose-partial" as const }),
				...(complete
					? {}
					: {
							partialEffects: [
								...(pathGone ? [] : [`${entry.path} still exists`]),
								...(registrationGone
									? []
									: ["the worktree is still registered with git"]),
							],
							recovery: {
								instructions: [
									"Check `git worktree list` and the path above, then clean up manually.",
								],
							},
						}),
			}),
			complete
				? `Disposed ${entry.branch}.\nremovedPath: ${entry.path}\nbranch: ${entry.branch} (${branchKept ? "kept: unmerged commits" : "deleted"})\nThis process stayed in ${processState.path}.\nNote: whether another pi session was using that checkout could not be determined.`
				: `Teardown of ${entry.path} did not complete. ${(dispose.stderr || dispose.stdout || "").trim()}`.trim(),
		);
	}

	// --- Commands ---
	pi.registerCommand("worktree", {
		description:
			"Git worktree management. Usage: /worktree [type/name] [--dir <path>] [--branch <name>] [--base <ref>], /worktree create [type/name], /worktree enter <type/name>, /worktree dispose, /worktree destroy <branch>, /worktree list. When creating on the user's behalf, infer a conventional-commit type (feat/fix/chore/docs/refactor/...) from the conversation; it defaults to feat.",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/);
			const sub = parts[0] || "";
			const subArg = parts.slice(1).join(" ").trim();

			switch (sub) {
				case "create":
				case "new":
					return handleCreate(subArg, ctx);
				case "enter":
				case "resume":
				case "camp":
					return handleEnter(subArg, ctx);
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
							"  /worktree enter <type/name> — Reopen pi inside an existing linked worktree\n" +
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
							"Shortcuts: /worktree-create, /worktree-enter, /worktree-dispose, /worktree-destroy, /worktree-list, /worktree-enforce",
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

	pi.registerCommand("worktree-enter", {
		description:
			"Enter an existing linked git worktree, reopening pi there (shortcut for /worktree enter)",
		handler: async (args, ctx) => handleEnter(args?.trim() || "", ctx),
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

	// --- Enter handler (re-camp into an existing linked worktree) ---
	async function handleEnter(nameArg: string, ctx: ExtensionCommandContext) {
		if (!nameArg) {
			ctx.ui.notify("Usage: /worktree enter <type/name>", "error");
			return;
		}

		try {
			const repoRoot = await getRepoRoot(pi);
			const config = loadConfig(repoRoot);
			const opts = parseCreateArgs(nameArg ?? "");
			let branches: string[];
			if (opts.branch) {
				const branch = opts.branch.trim();
				if (!isValidExplicitBranch(branch)) {
					throw new Error(
						`Invalid --branch "${branch}". Use a git-ref-safe name (letters, digits, ., _, -, /); no shell metacharacters, "..", "//", or trailing "/"/".lock".`,
					);
				}
				branches = [branch];
			} else {
				branches = destroyCandidates(opts.name ?? "", config);
			}
			if (branches.length === 0) {
				ctx.ui.notify("Usage: /worktree enter <type/name>", "error");
				return;
			}

			const listed = await pi.exec("git", ["worktree", "list", "--porcelain"], {
				cwd: repoRoot,
				timeout: 5_000,
			});
			const entry =
				listed.code === 0
					? resolveEnterTarget(
							parseWorktreeList(listed.stdout),
							branches,
							repoRoot,
						)
					: { error: "Could not read the git worktree list." };
			if ("error" in entry) {
				ctx.ui.notify(entry.error, "error");
				return;
			}

			const detected = await detectWorktree(pi);
			if (detected && resolve(detected.worktreePath) === resolve(entry.path)) {
				worktreeBranch = entry.branch;
				pi.setSessionName(`wt:${entry.branch}`);
				ctx.ui.setStatus("worktree", `🌿 ${entry.branch}`);
				ctx.ui.notify(
					`Already inside worktree "${entry.branch}" at ${entry.path}`,
					"info",
				);
				return;
			}

			const sessionFile = currentSessionFile(ctx);
			const current = await detectWorktree(pi);
			const handoffSource = current?.worktreePath ?? ctx.cwd;
			const handoffB64 = await buildHandoff(
				pi,
				handoffSource,
				sessionFile,
				handoffSource,
			);
			const relaunched = await relaunchInPlace(
				entry.path,
				entry.branch,
				sessionFile,
				handoffB64,
				continuationFor(ctx, "enter", entry.path),
			);
			if (!relaunched) {
				ctx.ui.notify(
					`✅ Worktree "${entry.branch}" found.\n` +
						`   Path:   ${entry.path}\n` +
						`   Branch: ${entry.branch}\n` +
						`   Start PI: cd ${entry.path} && pi`,
					"info",
				);
				return;
			}
			ctx.shutdown();
		} catch (err) {
			ctx.ui.setStatus("worktree", undefined);
			ctx.ui.notify(
				`Failed to enter worktree: ${(err as Error).message}`,
				"error",
			);
		}
	}

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
					`Worktree "${branch}" already exists at ${worktreePath}. Use /worktree enter ${branch} to re-camp this session there, /worktree destroy ${branch} first, or pick another name.`,
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
			const relaunched = await relaunchInPlace(
				worktreePath,
				branch,
				sessionFile,
				handoffB64,
				continuationFor(ctx, "enter", worktreePath),
			);
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
			const typedCmd = buildRelaunchCommand(
				repoRoot,
				sessionFile,
				handoffB64,
				continuationFor(ctx, "dispose", repoRoot),
			);
			const preScript = buildDisposeScript(
				repoRoot,
				worktreePath,
				branch,
				config.preRemove,
			);
			// Dispose lands back in the main checkout, so the new tab is named
			// after the branch checked out THERE, not the worktree being removed.
			const destBranch = await pi.exec(
				"git",
				["rev-parse", "--abbrev-ref", "HEAD"],
				{ cwd: repoRoot, timeout: 5_000 },
			);
			const scheduled = await scheduleRelaunch({
				typedCmd,
				preScript,
				recamp: {
					targetCwd: repoRoot,
					tabLabel:
						destBranch.code === 0 && destBranch.stdout.trim()
							? destBranch.stdout.trim()
							: basename(repoRoot),
				},
			});
			if (!scheduled) {
				ctx.ui.notify(
					`No cmux/herdr/tmux detected — cannot carry the session automatically.\n` +
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

/** Raised when a provisioning step fails, carrying enough to record a receipt. */
interface ProvisioningFailure extends Error {
	hook?: boolean;
	exitCode?: number;
}

function provisioningFailure(
	message: string,
	opts: { hook?: boolean; exitCode?: number } = {},
): ProvisioningFailure {
	return Object.assign(new Error(message), opts);
}

/**
 * Run the provisioning steps for a new worktree, reporting each stage.
 *
 * `onStage` fires BEFORE the step it names, so a caller recording durable
 * evidence knows which step was in flight if this process dies inside it.
 */
export async function runProvisioningSteps(
	pi: ExtensionAPI,
	repoRoot: string,
	config: WorktreeConfig,
	plan: CreatePlan,
	onStage: (
		stage: "git-worktree-add" | "link-env" | "post-create",
		postCreateIndex?: number,
	) => void,
	onProgress?: (message: string) => void,
): Promise<void> {
	const { branch, worktreePath, base } = plan;
	const run = async (cmd: string, timeout = 30_000) => {
		const r = await pi.exec("bash", ["-c", cmd], { timeout });
		if (r.code !== 0) {
			throw provisioningFailure(r.stderr?.trim() || `Command failed: ${cmd}`, {
				...(r.code === null ? {} : { exitCode: r.code }),
			});
		}
		return r;
	};

	onStage("git-worktree-add");
	onProgress?.(`⏳ Creating git worktree (${branch})...`);
	await run(buildCreateScript(repoRoot, worktreePath, branch, base));

	if (config.linkEnvFiles !== false) {
		onStage("link-env");
		onProgress?.("⏳ Linking env files...");
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

	for (let i = 0; i < (config.postCreate?.length ?? 0); i++) {
		const cmd = (config.postCreate as string[])[i];
		onStage("post-create", i);
		onProgress?.(
			`⏳ Post-create [${i + 1}/${config.postCreate?.length}]: ${cmd.slice(0, 60)}...`,
		);
		const r = await pi.exec(
			"bash",
			["-c", `cd ${shQuote(worktreePath)} && ${cmd}`],
			{
				timeout: 120_000,
			},
		);
		if (r.code !== 0) {
			throw provisioningFailure(
				`postCreate step ${i + 1} failed (${cmd}): ${(r.stderr || r.stdout || "").trim()}`,
				{ hook: true, ...(r.code === null ? {} : { exitCode: r.code }) },
			);
		}
	}
}

async function createWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	repoRoot: string,
	config: WorktreeConfig,
	plan: CreatePlan,
) {
	await runProvisioningSteps(
		pi,
		repoRoot,
		config,
		plan,
		() => {},
		(message) => ctx.ui.setStatus("worktree", message),
	);
	ctx.ui.setStatus("worktree", "");
}
