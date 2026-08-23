# Claude Opus 5 review record

**Model:** `amazon-bedrock/eu.anthropic.claude-opus-5:high`

## Round 1

Opus reported:

1. **High:** destroy treated the branch it would hard-delete as a durable containing ref, so the confirmation could claim no recovery risk before orphaning unique commits.
2. **Medium:** a valid administrative OID whose object had already been pruned made `for-each-ref --contains` fail and blocked every removal path.
3. **Medium:** stale/prunable registrations could no longer be cleaned through the extension because worktree inspection stopped at the missing path.
4. **Medium:** detached teardown invoked ambient `node` rather than the interpreter running Pi.
5. **Low:** a pre-mutation refusal was rendered as branch deletion failure.
6. **Low:** exact inventory rendering could produce a very large UI/model message.

The reviewer reproduced the first four findings with temporary repositories and confirmed the committed suite, typecheck, and lint were otherwise green.

## Round 2

Verdicts after `01210df`:

- Target-branch durability: **RESOLVED**.
- Pruned administrative object: **RESOLVED**.
- Ambient Node executable: **RESOLVED**.
- Misleading `delete-failed`: **RESOLVED**.
- Exact inventory size: **DEFERRED-OK**, because exact entries are a governing requirement and inspection fails closed above the subprocess bound.
- Hook-output persistence raised independently by DeepSeek: **RESOLVED** for the detached report.
- Stale/prunable registration: **DEFERRED-RISKY**, narrowed to refusal quality rather than automatic cleanup. Automatic prune remained unsafe because the administrative reflog could be the only pointer to recoverable commits, but the raw ENOENT message gave no preservation guidance.

Opus also found one new low defect: a complete disposal with an already-absent branch used failure prose while its structured result recorded success.

## Round 3

After `6a110c3`:

- Stale/prunable registration: **DEFERRED-OK**. Opus reproduced a stale registration and verified that the new refusal accurately explains the surviving branch and per-worktree reflog, requires preservation before manual prune, reaches all adapters, and performs no mutation.
- Absent-branch prose: **PARTIAL**. The in-process summary is fixed and tested, but the model-facing remote-dispose success message still collapses `absent` to `deleted`.
- **No high or medium finding survives. Final gate: PASS.**

Residual low findings recorded for adjudication:

- model-facing remote-dispose prose can call an already-absent branch deleted;
- configured hook stderr can still enter the durable in-process session transcript;
- a present non-commit administrative OID fails closed with an opaque Git error.
