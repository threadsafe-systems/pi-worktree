# In-process session switching

**Question.** Can a live pi session change its working directory without the
process restarting, and does that deliver everything a relaunch delivers?

**Answer.** Yes, but a runtime switch is only the transport. The replacement
also needs orientation persisted in its own session before the source runtime
is torn down.

## What was measured

The first mechanism probe stood a real `AgentSessionRuntime` up against a temp
`agentDir` and switched it between a temp repo and linked worktree. It proved
cwd and resource rebinding, but the first product integration did not carry the
relaunch handoff across the processless boundary. Two host attempts therefore
arrived in a target session with no instruction and were abandoned. That is a
failed product spike, not a failed `switchSession` mechanism.

Live switching no longer runs in the normal test suite or directly on a
developer host. `test/container/enter-switch.e2e.ts` loads the real extension,
invokes its registered enter and dispose commands, and replaces a real runtime
inside a disposable Docker container. Each target session contains its visible
transition orientation before switching begins.

## Results

| Property | Result | Where |
| --- | --- | --- |
| Runtime rebinds to the target cwd | pass | container |
| Services re-resolve from the new cwd | pass | container |
| Conversation history carries across | pass | pure + container |
| Orientation exists before replacement | pass | pure + container |
| Orientation participates in the next model context | pass | container |
| Idle enter triggers no synthetic model turn | pass | container |
| Enter leaves `process.cwd()` unchanged | pass (see below) | mechanism probe |
| Dispose aligns `process.cwd()` before removing the launch directory | pass | container |
| Dispose removes the path, Git registration and merged branch | pass | container |
| Dispose persists the observed teardown result | pass | container |
| `forkFrom` refuses an unflushed session | pass (see below) | pure |
| In-memory entries can carry an unflushed conversation | pass | pure |
| A session with no entries yields a valid target | pass | pure |
| `bash` executes in the new cwd | pass | mechanism probe |
| Relaunch handoff is consumed once | pass | container |

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

### Pi does not move the OS working directory

Pi calls `process.chdir` nowhere. After an ordinary switch, `runtime.cwd` is the
target while `process.cwd()` is still wherever the process was launched.

Tools are unaffected: they receive an explicit cwd. `pi.exec` also defaults to
the extension instance's session cwd (`options?.cwd ?? cwd`), not the process
cwd. Direct-reader inventory found material post-switch paths, including session
export, which still resolve against `process.cwd()`. `/worktree dispose`
therefore changes the OS cwd to the main checkout after the replacement runtime
is established and before deleting the launch directory. Enter leaves it
untouched because its source checkout remains present.

## Verdict

Green in the disposable container. `/worktree enter` and the slash-command
dispose path can switch in-process without abandoning the replacement, and Pi
wires the same replacement API in interactive, print and rpc modes.

Three rules follow:

- every transition builds from in-memory entries and never assumes a source
  file exists;
- orientation is a persisted custom message in the target document, not a
  process environment variable or a callback that runs after teardown;
- a dispose replacement must align `process.cwd()` with the main checkout before
  removing the directory in which the process started.
