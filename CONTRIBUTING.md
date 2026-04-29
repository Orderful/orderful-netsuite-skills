# Contributing to PROJECT_NAME

<!-- TODO: Replace PROJECT_NAME throughout this file -->

Thank you for your interest in contributing! This document explains how to get involved.

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO) to ensure that contributors have the right to submit their work. Every commit must be signed off:

```bash
git commit -s -m "Your commit message"
```

This adds a `Signed-off-by: Your Name <your.email@example.com>` trailer to your commit message, certifying that you wrote the code or have the right to submit it under the project's license. Unsigned commits will be blocked by CI.

If you forget to sign off, you can amend:

```bash
git commit --amend -s --no-edit
```

## How to Contribute

### Reporting Bugs

1. Check [existing issues](https://github.com/orderful/PROJECT_NAME/issues) to avoid duplicates.
2. Open a new issue using the **Bug Report** template.
3. Include steps to reproduce, expected behavior, actual behavior, and environment details.

### Suggesting Features

1. Open a new issue using the **Feature Request** template.
2. Describe the use case, not just the solution.

### Submitting Code

1. Fork the repository and create your branch from `main`.
2. Write clear, focused commits — one logical change per commit.
3. Add or update tests for your changes.
4. Ensure all checks pass locally before pushing:
   ```bash
   # TODO: Add lint/test/build commands specific to this project
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

<!-- TODO: Document code style expectations, linters, formatters used -->

## Getting Help

- Open a [Discussion](https://github.com/orderful/PROJECT_NAME/discussions) for questions (if enabled).
- For security issues, see [SECURITY.md](SECURITY.md).
