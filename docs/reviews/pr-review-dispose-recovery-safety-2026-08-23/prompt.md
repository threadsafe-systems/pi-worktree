# Adversarial review prompt

- **Track:** Reversible
- **Branch:** `feat/dispose-recovery-safety`
- **Base:** `main`
- **Governing documents:**

- `docs/plans/2026-08-23-dispose-recovery-safety.md`
- `docs/plans/2026-08-23-dispose-recovery-safety-build.md`

Two independent reviewers received the same read-only brief through the shared `adversary` agent:

- `amazon-bedrock/eu.anthropic.claude-opus-5:high`
- `deepseek/deepseek-v4-pro:high`

They were instructed to read the complete frozen diff, both governing documents, and complete changed files; verify surprising claims with code, tests, and real Git probes; report only correctness, data-loss, security, lifecycle, packaging, and material test defects; cite exact anchors; and make no repository changes.

## Rounds

| Round | Commit | Frozen diff SHA-256 | Purpose |
| --- | --- | --- | --- |
| 1 | `1bae72e4819b39ca07acdaee3f9117da9215f551` | `16ff22efd2dd1bccc4ab62c7f76ae82ff32fbc47671cdc978659b71fa72db9e1` | Initial adversarial review |
| 2 | `01210dfe2c2b1fd0745e12eccabd105ee4028d58` | `65f54f682b130bca53be378a6574c20c1839e0a014b0c0d3c6d243e3a0487c5d` | Verify wave-one fixes and adjudicate deferrals |
| 3 | `6a110c3f7441b7fa9ed42f325fc50e37f021a3df` | `f4e94f07b81d8269fe801522650839a0b05db551740f5a557c52e6ebd4e80560` | Verify stale-registration guidance and absent-branch prose |

Verification rounds required a verdict for every prior finding (`RESOLVED`, `PARTIAL`, `NOT-RESOLVED`, `DEFERRED-OK`, or `DEFERRED-RISKY`), a new-defects pass, and a final gate that could pass only with no surviving high or medium finding.
