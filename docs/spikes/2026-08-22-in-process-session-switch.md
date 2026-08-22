# In-process session switching

**Question.** Can a live pi session change its working directory without the
process restarting, and does that deliver everything a relaunch delivers?

**Answer.** Yes, with two constraints that change the design of the work that
follows.

## What was measured

A real `AgentSessionRuntime` was stood up against a temp `agentDir`, so the
ambient pi installation could not influence a result, in a temp repo with one
linked worktree. Each checkout carries a distinguishable `AGENTS.md`. The
runtime is switched from the main checkout into the worktree with
`SessionManager.forkFrom` plus `ctx.switchSession`.

`test/session-switch.test.ts` pins the results that are expressible through
public API. Two further observations are recorded here because pinning them
would mean asserting against pi internals.

## Results

| Property | Result | Where |
| --- | --- | --- |
| Runtime rebinds to the target cwd | pass | test |
| `withSession` context is bound to the target cwd | pass | test |
| Context files re-resolve from the new cwd | pass | test |
| Conversation history carries across | pass | test |
| `process.cwd()` is left where it was | pass (see below) | test |
| `forkFrom` refuses an unflushed session | pass (see below) | test |
| In-memory entries can carry an unflushed conversation | pass | test |
| A session with no entries yields a valid target | pass | test |
| `bash` executes in the new cwd | pass | manual, below |
| Built-in tools are constructed from the session cwd | pass | source, below |

### Tools follow the switch

Executing the built-in `bash` tool with `pwd` before and after a switch reports
the main checkout and then the worktree. This was run manually rather than
committed, because reaching the tool means reading private session state.

The durable evidence is structural. `AgentSession._buildRuntime` constructs
every built-in tool from the session's own cwd:

```js
: createAllToolDefinitions(this._cwd, {
    read: { autoResizeImages },
    bash: { commandPrefix: shellCommandPrefix, shellPath },
  });
```

`switchSession` rebuilds the runtime with `cwd: sessionManager.getCwd()`, so
the tools of the replacement are built against the target directory. Nothing
about a tool's binding survives the switch.

### Context, settings and extensions re-resolve

`createAgentSessionServices({ cwd })` builds a fresh `SettingsManager` and
`DefaultResourceLoader` for the target. The worktree's `AGENTS.md` replaces the
main checkout's after the switch, which means project settings, skills and
project-level extensions resolve from the worktree too. This is the property
that makes an in-process switch equivalent to a restart rather than merely a
cwd change.

## The two constraints

### A session file is not written until an assistant message exists

`SessionManager._persist` holds every entry in memory until the session
contains an assistant message, then flushes the whole document at once. Until
that point the file on disk is empty, and `forkFrom` rejects it:

```text
Cannot fork: source session file is empty or invalid
```

So a session where the user has typed but the model has not yet replied cannot
be forked from its file, even though it has content. Two cases hit this: a
brand-new session, and a turn still in flight.

The in-memory entries are the reliable source. Building the target document
from `getEntries()` and writing it to a session created at the target cwd
preserves the cwd, the active leaf and the conversation. Verified for both the
unflushed and zero-entry cases.

This supersedes the existing shell-level guard, which tests the source file for
non-emptiness and starts a fresh session when it is empty — discarding a
conversation that was recoverable all along.

### The OS working directory of the process never moves

Pi calls `process.chdir` nowhere. After a switch, `runtime.cwd` is the target
while `process.cwd()` is still wherever the process was launched.

Tools are unaffected: they receive an explicit cwd. The exposure is anything
that resolves a relative path against the process, and it becomes material only
when the original directory is *deleted* — the dispose case, where the process
would be left with a working directory that no longer exists. Enumerate the
callers that read `process.cwd()` before relying on an in-process dispose.

## Verdict

Green. The mechanism does what a relaunch does, in-process, and is available
across interactive, print and rpc modes.

Two adjustments to the work that follows:

- every transition must build its target session from in-memory entries, not
  from the source file, and must not assume a source file exists;
- the dispose path needs the `process.cwd()` exposure enumerated before it can
  drop the relaunch fallback.
