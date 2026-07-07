---
name: worktree-setup
description: Configure pi-worktree for your project — set up post-create hooks (install deps, create DB, etc.) and pre-remove hooks (drop DB, cleanup).
---

# Worktree Setup

Configure the `pi-worktree` extension for this project by creating `.pi/worktree.json`.

## Interview

Ask the user these questions (propose answers first by inspecting the project):

1. **Worktree directory** — Where to store worktrees? *(default: sibling `<repoRoot>.worktrees`, never nested; set `dir` to override, resolved relative to the repo root)*
2. **Default branch type** — Conventional-commit type used when no `type/` prefix is given? *(default: `feat`)*
3. **Post-create steps** — What needs to happen after creating a worktree? Examples:
   - `bun install` / `npm install`
   - Create a database
   - Generate `.env.local`
   - Run migrations / schema push
   - Link env files
4. **Pre-remove steps** — What cleanup before destroying? Examples:
   - Drop database
   - Remove temp files
5. **Link env files?** — Auto-symlink gitignored `.env*` files (except `.env.local`) from main repo? *(default: yes)*

Before asking, inspect the project to propose smart defaults:

- Check for `package.json` (detect package manager)
- Check for `prisma/`, `drizzle/`, or migration directories
- Check for `.env.example` or `.env*` patterns
- Check for `docker-compose.yml`
- Check for `Makefile`, `Taskfile`, `mise.toml`

## Create Config

After collecting answers, create `$GIT_ROOT/.pi/worktree.json`:

```json
{
  "defaultType": "feat",
  "linkEnvFiles": true,
  "postCreate": [
    "printf 'DATABASE_URL=postgres://localhost:5432/myapp_'$(basename $PWD) > .env.local",
    "createdb myapp_$(basename $PWD) 2>/dev/null || true",
    "npm install",
    "npx prisma db push"
  ],
  "preRemove": [
    "dropdb --if-exists myapp_$(basename $PWD) 2>/dev/null || true"
  ]
}
```

Branches follow conventional commits: `<type>/<identifier>` (e.g.
`feat/use-conventional-commits`). Valid types: `feat`, `fix`, `chore`, `docs`,
`refactor`, `test`, `perf`, `build`, `ci`, `style`, `revert`. Only set `dir`
when you want to override the sibling default.

Adapt the commands to match the actual project setup.

## No .gitignore entry needed

Worktrees live in a sibling directory next to the repo
(`<repoRoot>.worktrees/<branch-slug>`), outside the repo tree, so there is
nothing to add to `.gitignore`.

## Report

Tell the user:

- Which config file was created
- How to create a worktree: `/worktree create [type/name]` or `pi --worktree [type/name]`
- How to leave + remove the current worktree: `/worktree dispose`
- How to destroy from the main checkout: `/worktree destroy <branch>`
- How to list: `/worktree list`
