# Task for adversary

Adversarially review a local branch diff. Repo: /Users/neil/code/pi-worktree. Diff: /tmp/wt-review.diff (git diff main...HEAD). Head SHA: 505444e48492acd4c9d8ed0a4662031f062942d1. Branch: feat/unified-worktree-transitions.

Read the FULL files, not just the diff: extensions/worktree.ts, worktree-transition.ts, worktree-receipt.ts, worktree-transport.ts, worktree-handoff.ts, worktree-shell.ts, package.json, and the test/ files. Specs: docs/specs/2026-08-02-unified-worktree-transitions.md.

This change rewrites a live agent session lifecycle: it can exit the user's pi process, relaunch it elsewhere, and delete git worktrees from a detached shell. Data loss and session loss are the failure modes that matter.

Hunt hardest at:
1. buildVerifiedTeardownScript in extensions/worktree.ts — it is generated bash run detached with no supervision. Check quoting/injection via branch names, paths, and preRemove hooks; the abort-flag control flow; whether grep matching against canonical JSON owner files can false-positive or false-negative (pid substring matches, key ordering, escaping); `$$` semantics inside bash -c; whether any path can remove data it should not; whether the report is always written; `set -u` interactions.
2. The lifecycle claim protocol in worktree-receipt.ts — mkdir as test-and-set, orphan grace reclaim, dead-PID reclaim vs PID reuse, transferClaim, releaseClaim, and whether a losing process can ever mutate a winner's receipt or worktree.
3. The pending-transition guard — does returning {block:true} from a tool_call handler actually stop execution in pi 0.83, does it cover worktree_session itself, and can pendingTransition ever be set without shutdown actually happening (stranding the session permanently refusing all tools)?
4. Error paths that throw instead of returning a structured refusal (e.g. resolveGitCommonDir, listWorktrees, getRepoRoot) and what the model sees when they do.
5. Dispose target selection: selectorless resolution, live-vs-remote detection, canonicalPath comparisons, symlinks, and whether the main checkout can ever be targeted.
6. Successor verification in worktree-handoff.ts — can a mismatch be reported as verified, or vice versa? Is any check tautological?
7. Backward compatibility: removed/renamed exports, re-exports, handoff v1 decode, existing slash-command and startup flows still working.
8. Test quality: tests that assert something weaker than they claim, or that would pass against a broken implementation.

Report concrete defects with file:line evidence and severity. Say plainly if something is fine.

---
**Output:**
Write your findings to exactly this path: /tmp/wt-adversary-glm.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Review gate: required by reviewer.

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```