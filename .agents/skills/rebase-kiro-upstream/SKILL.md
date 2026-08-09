---
name: rebase-kiro-upstream
description: >-
  Rebase the fork's feat/kiro-acp branch onto latest upstream/main (pingdotgg/t3code),
  resolve conflicts, and force-push to origin. Use when the user asks to rebase Kiro,
  sync upstream into feat/kiro-acp, pull upstream main onto the Kiro branch, or update
  the fork with latest T3 Code.
---

# Rebase Kiro onto upstream main

Keep `feat/kiro-acp` (Kiro ACP provider) one commit ahead of `upstream/main`.

## Remotes / branches

| Name | Remote | Role |
|------|--------|------|
| `upstream` | `https://github.com/pingdotgg/t3code.git` | Canonical T3 Code |
| `origin` | `https://github.com/arpitdalal/t3code.git` | This fork |
| `feat/kiro-acp` | fork branch | Kiro work lives here |
| `main` | local mirror of upstream | Prefer reset to `upstream/main`; do not pile Kiro onto it |

## Preconditions

1. Working tree clean, or only intentional WIP. If dirty: commit on `feat/kiro-acp` first (preferred) or stash including untracked (`git stash -u`).
2. Confirm remotes: `git remote -v` must show `upstream` + `origin` as above.

## Steps (do these)

```bash
git fetch upstream
git checkout feat/kiro-acp
git rebase upstream/main
```

### Conflicts

1. Fix files, `git add` them.
2. `git rebase --continue` (repeat until done).
3. Abort only if user asks: `git rebase --abort`.

Prefer keeping **upstream** behavior for shared code and **ours (Kiro)** for Kiro-only files (`Kiro*`, `kiro` settings/driver registration).

### After clean rebase

```bash
# optional: keep local main = upstream tip
git branch -f main upstream/main

# update fork branch (history rewritten)
git push --force-with-lease origin feat/kiro-acp
```

Do **not** force-push `main` unless the user explicitly asks.

## Uncommitted Kiro work

Do **not** leave large Kiro WIP uncommitted across rebases. Commit on `feat/kiro-acp` first, then rebase. Stash is a last resort (`git stash push -u -m "kiro wip"` → rebase → `git stash pop`).

## Done when

- `git rev-list --count upstream/main..feat/kiro-acp` is small (usually 1+ Kiro commits).
- `git log --oneline -3` shows Kiro commit(s) on top of latest `upstream/main`.
- `origin/feat/kiro-acp` matches local after `--force-with-lease` (if push requested / part of this run).

Report: upstream tip SHA, Kiro tip SHA, conflict summary (if any), whether push succeeded.
