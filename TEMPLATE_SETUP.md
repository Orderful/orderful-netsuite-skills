# Template Setup Guide

> **Delete this file after completing setup.** It is not intended for the published repository.

This repository was created from `orderful/public-repo-template`. Follow the steps below to configure it for your project, in accordance with the [Publishing a Public Repo in Github](https://orderful.atlassian.net/wiki/spaces/EN/pages/4162519057/Publishing+a+Public+Repo+in+Github) runbook.

---

## Prerequisites (Runbook §2)

Before any technical work, confirm these approvals are recorded:

- [ ] Engineering sponsor identified (owning team's tech lead)
- [ ] CTO sign-off (Piers MacDonald)
- [ ] Legal review (Piers MacDonald) — license selection, third-party code, trademark
- [ ] Security review (Cybersecurity)
- [ ] Finance/Product awareness (if commercially relevant)

## Step 1: Find-and-Replace Placeholders

Search for these placeholders across all files and replace them:

| Placeholder | Replace With | Files |
|---|---|---|
| `PROJECT_NAME` | Your project name | `README.md`, `NOTICE`, `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/config.yml` |
| `REPO_NAME` | GitHub repo name (e.g., `my-tool`) | `CODEOWNERS` |
| `REPO_NAME-maintainers` | Your maintainer team slug | `CODEOWNERS` |

## Step 2: Configure Project-Specific Files

- [ ] **README.md** — Fill in all `<!-- TODO -->` sections. Write for an external audience: no Slack links, no Confluence links, no internal jargon.
- [ ] **NOTICE** — Update the project name.
- [ ] **CODEOWNERS** — Add at least 2 human reviewers. Create the `@orderful/<repo>-maintainers` team in GitHub if it doesn't exist.
- [ ] **CHANGELOG.md** — Update with your initial release notes.
- [ ] **SECURITY.md** — Update the supported versions table.
- [ ] **LICENSE** — Confirm Apache 2.0 is appropriate (default). If not, get Legal sign-off and replace.

## Step 3: Configure CI Workflows

All workflows are in `.github/workflows/`. Each has `TODO` comments marking what to customize.

- [ ] **ci.yml** — Uncomment and configure lint/test/build steps for your language and runtime.
- [ ] **codeql.yml** — Update the `language` matrix for your project's languages.
- [ ] **dependency-review.yml** — Review the denied license list; adjust if your license is copyleft.
- [ ] **dco.yml** — No changes needed (unless switching to CLA per §3.3.1).
- [ ] **dependabot.yml** — Uncomment and configure the package ecosystem(s) for your project.

## Step 4: Verify Action SHAs (§4.4)

All actions are pinned to commit SHAs. Before publishing, verify they're current:

```bash
# For each action, check the latest SHA for the pinned version tag:
gh api repos/actions/checkout/git/ref/tags/v4 --jq '.object.sha'
gh api repos/actions/setup-node/git/ref/tags/v4 --jq '.object.sha'
gh api repos/github/codeql-action/git/ref/tags/v3 --jq '.object.sha'
gh api repos/actions/dependency-review-action/git/ref/tags/v4 --jq '.object.sha'
```

Update any SHAs that have drifted. Keep the version comment next to each SHA for readability.

## Step 5: Source Content Audit (§3.1)

If copying code from an existing private repo into this template:

- [ ] Grep for secrets: API keys, tokens, passwords, JWT blobs, AWS access keys, private keys
- [ ] Grep for PII: emails, phone numbers, customer IDs, EDI sender/receiver IDs, internal hostnames, AWS account IDs, internal Slack channel names
- [ ] Grep for internal references: `orderful-internal`, `prod`, `staging`, internal vendor names, customer names, dollar amounts, employee names
- [ ] Confirm no dependencies on private Orderful packages, internal registries, or internal Git URLs (§3.2)
- [ ] Run license compatibility check on all transitive dependencies (§3.2)
- [ ] Commit lockfiles

## Step 6: Repository Settings (manual — not carried by template)

These must be configured in GitHub after creating the repo:

### General Settings (§4.1)
- [ ] Disable Wikis, Projects, and Discussions (unless team commits to triaging)
- [ ] Keep Issues enabled
- [ ] Allow forking
- [ ] PR merge: allow squash (default), disallow merge commits, allow rebase selectively
- [ ] Enable "Automatically delete head branches"

### Branch Protection / Rulesets (§4.2)
> Note: If org-level rulesets are configured for all public repos, these are inherited automatically.

- [ ] Require pull request before merging
- [ ] Require CODEOWNERS review (2 approvals for external contributors)
- [ ] Dismiss stale approvals on new commits
- [ ] Require status checks: lint, test, build, CodeQL, DCO
- [ ] Require branches to be up to date
- [ ] Require signed commits
- [ ] Require linear history
- [ ] Block force pushes and deletions
- [ ] No bypass for anyone including admins

### Security Features (§4.3)
- [ ] Secret scanning — enabled (enforced for public repos)
- [ ] Push protection — enabled
- [ ] Dependabot alerts — enabled
- [ ] Dependabot security updates — enabled
- [ ] CodeQL default setup — enabled
- [ ] Private vulnerability reporting — enabled

### Actions Hardening (§4.4)
- [ ] Fork PR workflows: require approval for all outside collaborators

## Step 7: Pre-Publication Final Checks (§5)

- [ ] Final manual secret/PII grep within 24 hours of going public
- [ ] All §3 and §4 checklist items complete and recorded
- [ ] Maintainer team created with at least 2 humans
- [ ] Internal Slack announcement drafted
- [ ] External announcement approved by Marketing (if applicable)

## Step 8: Go Public (§5)

1. **Settings → General → Danger Zone → Change visibility → Make public**
2. Immediately verify: secret scanning active, CodeQL running, Dependabot reporting, branch protection intact
3. Post announcements

## Step 9: Delete This File

```bash
git rm TEMPLATE_SETUP.md
git commit -s -m "chore: remove template setup guide"
```
