import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  // git rev-parse --git-common-dir gives .git for main, ../../.git/worktrees/<name> for worktree
  const r = await pi.exec(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { timeout: 5_000 },
  );
  if (r.code !== 0) throw new Error("Not inside a git repository");
  // commonDir is e.g. /repo/.git — parent is repo root
  const commonDir = r.stdout.trim();
  return dirname(commonDir);
}

/** Detect if cwd is a worktree under .worktrees/<name>. */
export function detectWorktreeName(cwd: string): string | null {
  const m = cwd.match(/\/\.worktrees\/([^/]+)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Config: project-level hooks
// ---------------------------------------------------------------------------

export interface WorktreeConfig {
  /** Directory to create worktrees in, relative to repo root. Default: ".worktrees" */
  dir?: string;
  /** Branch prefix. Default: "worktree/" */
  branchPrefix?: string;
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
): string {
  const dir = config.dir ?? ".worktrees";
  return resolve(repoRoot, expandHome(dir));
}

export function getBranchPrefix(config: WorktreeConfig): string {
  return config.branchPrefix ?? "worktree/";
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Relaunch helper
// ---------------------------------------------------------------------------

/** Single-quote a string for safe literal use inside a POSIX shell command. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Handoff payload carried across a worktree relaunch, decoded by the new
 *  session to orient the agent (approach D). */
export interface WtHandoff {
  parentCwd: string;
  parentBranch: string;
  uncommitted: number;
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
      return h as WtHandoff;
    }
  } catch {
    // fall through to null
  }
  return null;
}

/** The one-turn orientation note injected into the forked worktree session. */
export function handoffCaveat(
  h: WtHandoff,
  worktreePath: string,
  worktreeBranch: string,
): string {
  const wip =
    h.uncommitted > 0
      ? `- WARNING: ${h.uncommitted} file(s) had uncommitted changes in ${h.parentCwd}. A worktree is a fresh checkout, so those changes are NOT present here — retrieve them from ${h.parentCwd} if this work depends on them.`
      : `- The previous checkout had no uncommitted changes.`;
  return (
    `## Session migrated into a worktree\n` +
    `This session was forked from ${h.parentCwd} (branch ${h.parentBranch}) into this git worktree at ${worktreePath} (branch ${worktreeBranch}).\n` +
    `- Repo-relative paths are unchanged (\`src/foo.ts\` is still \`src/foo.ts\`).\n` +
    `- Absolute paths, and any path relative to the previous working directory, now resolve under this worktree.\n` +
    `${wip}\n` +
    `Continue the task here and commit to ${worktreeBranch}.`
  );
}

/** Build the shell command typed into the pane to relaunch pi in the worktree.
 *  Optionally forks the parent session (to carry history) and passes a base64
 *  handoff payload via PI_WT_HANDOFF for the new session to decode. */
export function buildRelaunchCommand(
  worktreePath: string,
  forkSessionFile?: string,
  handoffB64?: string,
): string {
  const envPrefix = handoffB64 ? `PI_WT_HANDOFF=${shQuote(handoffB64)} ` : "";
  const forkArg = forkSessionFile ? ` --fork ${shQuote(forkSessionFile)}` : "";
  return `cd ${shQuote(worktreePath)} && ${envPrefix}pi${forkArg}`;
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
      uncommitted = st.stdout.split("\n").filter((l) => l.trim().length > 0).length;
    }
  } catch {
    // best-effort
  }
  return encodeHandoff({ parentCwd: process.cwd(), parentBranch, uncommitted });
}

/** Read the current session file path from a context, tolerating context
 *  variants that may not type it. */
function currentSessionFile(ctx: unknown): string | undefined {
  return (
    ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }
  )?.sessionManager?.getSessionFile?.();
}

/**
 * Relaunch pi in the given directory by injecting `cd <path> && pi` into the
 * current terminal pane via cmux or tmux.
 *
 * Reliability notes (these were all bugs in the original implementation):
 *  - We wait for THIS pi process to actually exit before sending keys, instead
 *    of a blind `sleep 0.3` that raced pi's TUI teardown. Keys sent while pi
 *    still owns the pane in raw mode are swallowed.
 *  - We target the originating pane explicitly ($TMUX_PANE / surface id) so the
 *    keys cannot land in some other active pane.
 *  - We send the command text with `send-keys -l` (literal) and then a SEPARATE
 *    `Enter` key, instead of relying on a trailing "\n" character to submit.
 *    A literal line-feed is not a reliable Enter and frequently leaves the
 *    command typed-but-unsubmitted.
 *  - Dynamic values are passed as positional args ($1..$3) to `bash -c`, never
 *    interpolated into the script body, so paths with spaces/quotes are safe.
 *
 * Returns true if a relaunch was scheduled, false if not in a known multiplexer.
 */
function relaunchInPlace(
  _pi: ExtensionAPI,
  worktreePath: string,
  forkSessionFile?: string,
  handoffB64?: string,
): boolean {
  const typedCmd = buildRelaunchCommand(worktreePath, forkSessionFile, handoffB64);
  const parentPid = String(process.pid);

  const surfaceId = process.env.CMUX_SURFACE_ID;
  const inTmux = !!process.env.TMUX;

  let script: string;
  let args: string[];

  if (surfaceId) {
    // cmux: wait for pi to exit, then type the command and submit it.
    script = `
      parent="$1"; surface="$2"; cmd="$3"
      while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done
      sleep 0.15
      cmux send --surface "$surface" -- "$cmd"
      cmux send --surface "$surface" -- $'\\r'
    `;
    args = ["-c", script, "pi-worktree-relaunch", parentPid, surfaceId, typedCmd];
  } else if (inTmux) {
    // tmux: target the originating pane when known; -l types literally; a
    // separate Enter submits.
    const target = process.env.TMUX_PANE ?? "";
    script = `
      parent="$1"; target="$2"; cmd="$3"
      while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done
      sleep 0.15
      if [ -n "$target" ]; then
        tmux send-keys -t "$target" -l -- "$cmd"
        tmux send-keys -t "$target" Enter
      else
        tmux send-keys -l -- "$cmd"
        tmux send-keys Enter
      fi
    `;
    args = ["-c", script, "pi-worktree-relaunch", parentPid, target, typedCmd];
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

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let worktreeName: string | null = null;

  // --- Register --worktree flag ---
  pi.registerFlag("worktree", {
    description:
      "Create or reuse a git worktree and work inside it. Optionally specify a name.",
    type: "string",
  });

  // --- Auto-detect worktree from cwd, or handle --worktree flag ---
  pi.on("session_start", async (_event, ctx) => {
    // Check --worktree flag first
    const flagValue = pi.getFlag("worktree") as string | boolean | undefined;

    if (flagValue !== undefined && flagValue !== false) {
      // --worktree was passed (with or without a name)
      const name =
        typeof flagValue === "string" && flagValue.length > 0
          ? flagValue
          : generateName();

      try {
        const repoRoot = await getRepoRoot(pi);
        const config = loadConfig(repoRoot);
        const wtDir = getWorktreeDir(repoRoot, config);
        const worktreePath = join(wtDir, name);
        const branch = `${getBranchPrefix(config)}${name}`;

        // Check if worktree already exists
        const exists = existsSync(worktreePath);
        if (!exists) {
          // Create the worktree
          ctx.ui.setStatus("worktree", `⏳ Creating worktree "${name}"...`);
          await createWorktree(pi, ctx, repoRoot, config, name);
          ctx.ui.setStatus("worktree", `🌿 ${name}`);
        } else {
          ctx.ui.setStatus("worktree", `🌿 ${name} (existing)`);
        }

        const detected = detectWorktreeName(ctx.cwd);
        if (detected === name) {
          // Already running inside the worktree — nothing to do
          worktreeName = name;
          pi.setSessionName(`wt:${name}`);
        } else {
          // Tools are bound to the original cwd; must relaunch pi in the
          // worktree directory so all tools resolve paths correctly. Fork the
          // parent session so history follows the hop, plus a handoff note.
          const sessionFile = currentSessionFile(ctx);
          const handoffB64 = await buildHandoff(pi, repoRoot, sessionFile);
          const relaunched = relaunchInPlace(pi, worktreePath, sessionFile, handoffB64);
          if (!relaunched) {
            ctx.ui.notify(
              `✅ Worktree "${name}" ready.\n` +
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
      // Auto-detect from cwd
      worktreeName = detectWorktreeName(ctx.cwd);
    }

    if (worktreeName) {
      pi.setSessionName(`wt:${worktreeName}`);
      ctx.ui.setStatus("worktree", `🌿 ${worktreeName}`);
    }
  });

  // --- Inject worktree context (and a one-turn migration caveat) ---
  let handoffShown = false;
  pi.on("before_agent_start", async (event) => {
    let extra = "";
    if (worktreeName) {
      extra +=
        `\n\n## Active Worktree\n` +
        `You are working in git worktree "${worktreeName}".\n` +
        `The current directory is the worktree root. All tools resolve paths relative to it.\n` +
        `Branch: worktree/${worktreeName}\n` +
        `Commit your work to this branch when done.`;
    }
    // One-turn orientation when this session was forked into the worktree.
    const handoffEnv = process.env.PI_WT_HANDOFF;
    if (!handoffShown && handoffEnv) {
      const h = decodeHandoff(handoffEnv);
      if (h) {
        handoffShown = true;
        const wtBranch = worktreeName ? `worktree/${worktreeName}` : "this worktree";
        extra += `\n\n${handoffCaveat(h, process.cwd(), wtBranch)}`;
      }
    }
    if (!extra) return;
    return { systemPrompt: event.systemPrompt + extra };
  });

  // --- Commands ---
  // Main command with subcommands
  pi.registerCommand("worktree", {
    description:
      "Git worktree management. Usage: /worktree [name], /worktree create [name], /worktree destroy <name>, /worktree list",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0] || "";
      const subArg = parts.slice(1).join(" ").trim();

      switch (sub) {
        case "create":
        case "new":
          return handleCreate(subArg, ctx);
        case "destroy":
        case "remove":
        case "rm":
          return handleDestroy(subArg, ctx);
        case "list":
        case "ls":
          return handleList(ctx);
        case "help":
          ctx.ui.notify(
            "Usage:\n" +
              "  /worktree [name]         — Create a new worktree (auto-generates name if omitted)\n" +
              "  /worktree create [name]  — Same as above\n" +
              "  /worktree destroy <name> — Destroy a worktree\n" +
              "  /worktree list           — List all worktrees\n" +
              "  /worktree help           — Show this help\n" +
              "\n" +
              "Shortcuts: /worktree-create, /worktree-destroy, /worktree-list",
            "info",
          );
          return;
        default:
          // No subcommand or unrecognized word → treat as name for create
          return handleCreate(args?.trim() || "", ctx);
      }
    },
  });

  // Shortcut commands
  pi.registerCommand("worktree-create", {
    description: "Create a new git worktree (shortcut for /worktree create)",
    handler: async (args, ctx) => handleCreate(args?.trim() || "", ctx),
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
    const name = nameArg || generateName();
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      ctx.ui.notify(
        "Name must be alphanumeric with hyphens/underscores only",
        "error",
      );
      return;
    }

    try {
      const repoRoot = await getRepoRoot(pi);
      const config = loadConfig(repoRoot);
      const wtDir = getWorktreeDir(repoRoot, config);
      const worktreePath = join(wtDir, name);
      const branch = `${getBranchPrefix(config)}${name}`;

      await createWorktree(pi, ctx, repoRoot, config, name);

      // Tools are bound to the original cwd; must relaunch pi in the
      // worktree directory so all tools resolve paths correctly. Fork the
      // parent session so history follows the hop, plus a handoff note.
      const sessionFile = currentSessionFile(ctx);
      const handoffB64 = await buildHandoff(pi, repoRoot, sessionFile);
      const relaunched = relaunchInPlace(pi, worktreePath, sessionFile, handoffB64);
      if (!relaunched) {
        ctx.ui.notify(
          `✅ Worktree "${name}" ready\n` +
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

  // --- Destroy handler ---
  async function handleDestroy(name: string, ctx: ExtensionCommandContext) {
    if (!name) {
      ctx.ui.notify("Usage: /worktree destroy <name>", "error");
      return;
    }

    try {
      const repoRoot = await getRepoRoot(pi);
      const config = loadConfig(repoRoot);
      const wtDir = getWorktreeDir(repoRoot, config);
      const worktreePath = join(wtDir, name);
      const branch = `${getBranchPrefix(config)}${name}`;

      if (!existsSync(worktreePath)) {
        ctx.ui.notify(
          `Worktree "${name}" does not exist at ${worktreePath}`,
          "error",
        );
        return;
      }

      const ok = await ctx.ui.confirm(
        "Destroy worktree?",
        `This will remove ${worktreePath} and delete branch ${branch}.`,
      );
      if (!ok) return;

      const step = (msg: string) => ctx.ui.setStatus("worktree", msg);

      // Pre-remove hooks
      if (config.preRemove?.length) {
        step("⏳ Running pre-remove hooks...");
        for (const cmd of config.preRemove) {
          await pi.exec("bash", ["-c", cmd], { timeout: 30_000 });
        }
      }

      // Remove worktree
      step("⏳ Removing git worktree...");
      const _rmResult = await pi.exec(
        "bash",
        [
          "-c",
          `
        cd "${repoRoot}"
        git worktree remove --force "${worktreePath}" 2>&1 || {
          rm -rf "${worktreePath}" 2>&1 || true
          git worktree prune 2>&1 || true
        }
      `,
        ],
        { timeout: 10_000 },
      );

      // Delete branch
      step("⏳ Deleting branch...");
      await pi.exec(
        "bash",
        [
          "-c",
          `cd "${repoRoot}" && git branch -D "${branch}" 2>/dev/null || true`,
        ],
        { timeout: 5_000 },
      );

      step("");
      ctx.ui.notify(
        `✅ Worktree "${name}" destroyed\n` +
          `   Path:   ${worktreePath} (removed)\n` +
          `   Branch: ${branch} (deleted)`,
        "info",
      );
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
  name: string,
) {
  const wtDir = getWorktreeDir(repoRoot, config);
  const worktreePath = join(wtDir, name);
  const branch = `${getBranchPrefix(config)}${name}`;

  const step = (msg: string) => ctx.ui.setStatus("worktree", msg);
  const run = async (cmd: string, timeout = 30_000) => {
    const r = await pi.exec("bash", ["-c", cmd], { timeout });
    if (r.code !== 0) throw new Error(r.stderr || `Command failed: ${cmd}`);
    return r;
  };

  // 1. Git worktree
  step(`⏳ Creating git worktree (${branch})...`);
  await run(`
    cd "${repoRoot}"
    [ -d "${worktreePath}" ] && git worktree remove --force "${worktreePath}" 2>/dev/null || true
    git show-ref --verify --quiet "refs/heads/${branch}" 2>/dev/null && git branch -D "${branch}" 2>/dev/null || true
    git worktree add -b "${branch}" "${worktreePath}" HEAD
  `);

  // 2. Link env files
  if (config.linkEnvFiles !== false) {
    step("⏳ Linking env files...");
    await run(`
      cd "${repoRoot}"
      for f in .env*; do
        [ -f "$f" ] || continue
        [ "$f" = ".env.local" ] && continue
        git check-ignore -q "$f" 2>/dev/null || continue
        ln -sf "${repoRoot}/$f" "${worktreePath}/$f"
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
      await pi.exec("bash", ["-c", `cd "${worktreePath}" && ${cmd}`], {
        timeout: 120_000,
      });
    }
  }

  step("");
}
