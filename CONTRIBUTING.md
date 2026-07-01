# Contributing to orderful-netsuite-skills

Thank you for your interest in contributing! This document explains how to get involved.

## One-time setup: signed commits

This repo requires every commit on `main` to be cryptographically signed. GitHub displays a green "Verified" badge next to signed commits and will block any merge that introduces unsigned ones. Set this up before you make your first commit.

**SSH signing (recommended — reuses your existing SSH key):**

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
```

Then add the contents of `~/.ssh/id_ed25519.pub` as a **Signing Key** at https://github.com/settings/ssh/new — select "Signing Key" in the type dropdown. (If you already have the same public key registered as an Authentication Key, you still need to add it again as a separate Signing Key entry.)

After this, `git commit` automatically signs every commit you make.

For GPG signing instead, see [GitHub's commit signature verification docs](https://docs.github.com/en/authentication/managing-commit-signature-verification).

### My PR has unsigned commits — how do I fix it?

Rebase the branch to re-sign the existing commits in place:

```bash
git rebase --exec 'git commit --amend --no-edit -S' origin/main
git push --force-with-lease origin <your-branch-name>
```

Force-pushing dismisses prior PR approvals — ask reviewers to re-approve after.

## When to contribute

- **You used a skill, it almost worked but had a gap** → open a PR with your refinement (a clearer step, a better SuiteQL, a missing edge case in the behaviour rules)
- **You handled a recurring task that nobody had a skill for yet** → open a PR with a new skill folder
- **Reference material is wrong or stale** → edit `reference/*.md`
- **Setup instructions tripped you up** → fix `README.md` so the next person doesn't hit the same thing

## How to Contribute

### Reporting Bugs

1. Check [existing issues](https://github.com/orderful/orderful-netsuite-skills/issues) to avoid duplicates.
2. Open a new issue using the **Bug Report** template.
3. Include steps to reproduce, expected behavior, actual behavior, and environment details.

### Suggesting Features

1. Open a new issue using the **Feature Request** template.
2. Describe the use case, not just the solution.

### Submitting Code

1. Confirm commit signing is set up (see [One-time setup](#one-time-setup-signed-commits) above) — unsigned commits will block your PR from merging.
2. Fork the repository and create your branch from `main`.
3. Write clear, focused commits — one logical change per commit.
4. Add or update tests for your changes if applicable.
5. Ensure all checks pass locally before pushing:
   ```bash
   pnpm install && pnpm lint
   ```
6. Open a pull request against `main`.
7. Fill out the PR template completely.

### Pull Request Expectations

- PRs require at least 1 approval from a CODEOWNERS reviewer (2 for external contributors).
- Keep PRs focused — avoid unrelated changes in the same PR.
- Respond to review feedback promptly.
- Squash merging is used by default; write a clear PR title (it becomes the commit message).

### Automated review

Maintainers can request an automated Claude review by applying the `claude-review` label to your PR. The bot reads the diff, applies the rubric in [`.claude/skills/code-review/SKILL.md`](.claude/skills/code-review/SKILL.md), and posts a review. Re-apply the label after pushing fixes to trigger another pass.

## Branching Model

- `main` is the primary branch. All PRs target `main`.
- Use descriptive branch names: `fix/issue-123-null-check`, `feat/add-retry-logic`, etc.

## Code Style

ESLint enforces style; run `pnpm lint` before pushing.

## Getting Help

- Open a [Discussion](https://github.com/orderful/orderful-netsuite-skills/discussions) for questions (if enabled).
- For security issues, see [SECURITY.md](SECURITY.md).
