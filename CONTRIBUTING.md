# Contributing to orderful-netsuite-skills

Thank you for your interest in contributing! This document explains how to get involved.

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

1. Fork the repository and create your branch from `main`.
2. Write clear, focused commits — one logical change per commit.
3. Add or update tests for your changes if applicable.
4. Ensure all checks pass locally before pushing:
   ```bash
   npm install && npm run lint
   ```
5. Open a pull request against `main`.
6. Fill out the PR template completely.

### Pull Request Expectations

- PRs require at least 1 approval from a CODEOWNERS reviewer (2 for external contributors).
- Keep PRs focused — avoid unrelated changes in the same PR.
- Respond to review feedback promptly.
- Squash merging is used by default; write a clear PR title (it becomes the commit message).

## Branching Model

- `main` is the primary branch. All PRs target `main`.
- Use descriptive branch names: `fix/issue-123-null-check`, `feat/add-retry-logic`, etc.

## Code Style
ESLint enforces style; run npm run lint before pushing.

## Getting Help

- Open a [Discussion](https://github.com/orderful/orderful-netsuite-skills/discussions) for questions (if enabled).
- For security issues, see [SECURITY.md](SECURITY.md).
