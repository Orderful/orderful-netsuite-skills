# Orderful NetSuite Skills

AI-powered skills for NetSuite integration work, designed for Orderful contractors, OAs, and tech-savvy NS admins working through Claude Code.

## Overview

A growing library of markdown skills that teach Claude Code how to:

- Onboard a new NetSuite customer end-to-end (credentials, validation, enabling transactions)
- Diagnose and fix common EDI failures (missing item lookups, stuck 850s)
- Query NetSuite records using domain-appropriate conventions
- Cross-reference Orderful-side transaction context with NetSuite state
- Propose well-scoped fixes that you approve before they run

Skills cite shared reference material (record types, common queries, REST patterns) so Claude has the right context without you having to paste it on every session.

## Getting Started

### Prerequisites

1. Install [Claude Code](https://www.anthropic.com/claude-code) and sign in with your work account.
2. Install **Node.js 24 LTS or newer** — required by the validation script and `samples/`.
   - macOS (Homebrew): `brew install node`
   - macOS / Linux (nvm): `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && nvm install --lts`
   - Windows: download the LTS installer from [nodejs.org](https://nodejs.org/)
   - Verify with `node --version` (should print `v24.x` or higher).
3. Install **pnpm 11** — used to install the validation script's dependencies.
   - Easiest path (ships with Node 24): `corepack enable pnpm`
   - See [pnpm.io/installation](https://pnpm.io/installation) for alternatives.
   - Verify with `pnpm --version` (should print `11.x`).
4. **Git** — to clone this repo.

### Quick Start

1. Clone this repo:
   ```bash
   git clone git@github.com:Orderful/orderful-netsuite-skills.git 
   cd orderful-netsuite-skills
   ```
2. Run the installer:
   ```bash
   ./install.sh
   ```
   This:
   - symlinks each skill into `~/.claude/skills/` (Claude Code auto-discovers them via frontmatter)
   - runs `pnpm install` for the validation script + `samples/`
   - creates `~/orderful-onboarding/` for per-customer credentials
3. Open Claude Code anywhere and run `/netsuite-setup`. The skill walks you through scaffolding `~/orderful-onboarding/<customer-slug>/.env` and validating both NetSuite and Orderful credentials. Repeat per customer.


## Development

### How to add a new skill

1. Create a folder under `skills/`:
   ```bash
   mkdir skills/your-skill-name
   ```
2. Add a `SKILL.md` (see structure below).
3. (Optional) Add `examples.md` with annotated worked examples.
4. Run `./install.sh` — symlinks pick up the new skill.
5. Test it in a real Claude Code session against a real customer (or the sandbox).
6. Open a PR with:
   - The skill files
   - A short PR description: what problem the skill solves, where you tested it, sample triggers ("the user says X")

### Skill structure

A `SKILL.md` is a markdown file with frontmatter + procedure + behaviour rules:

```markdown
---
name: your-skill-name
description: One-line description of what this skill does.
  Used by Claude Code to decide when to load it.
---

# Skill Title

## When to use this skill

Concrete user prompts or situations that should trigger this skill:

- "my 850 failed with X"
- "help me fix Y"
- "I need to <thing>"

## Inputs the skill needs

What you should ask the user for up-front. E.g.:
- The failing transaction ID
- The customer entity
- A sample 850 file

## The recipe

### Step 1 — <load context>
What to do, what to query, what to read.
SuiteQL snippets where relevant.

### Step 2 — <intermediate reasoning>
How to combine signals.

### Step 3 — <propose action / output>
What the skill produces. For destructive actions, propose first; never act without approval.

## Behaviour rules

Numbered list of "musts" and "must nots". Examples:

1. **Never create a record without explicit user approval.** Always propose first.
2. **Reject ambiguous matches.** If no candidate has high confidence, escalate — don't guess.
3. **Never invent inputs.** If you can't find what you need in the data, say so.
4. **Don't bundle unrelated fixes.** One skill run, one scoped change.
5. **Show your reasoning.** Always explain which signals led to the proposal.
6. **Reprocessing is NOT automated.** After creating a fix, tell the user to manually reprocess in NS.

## Reference material

Link to relevant `reference/*.md` files Claude should consult.
```

## What makes a good skill

- **Specific trigger prompts.** "User says X, Y, or Z" — concrete language Claude can pattern-match against.
- **Explicit recipe.** Numbered steps with actual queries / actions, not vague guidance.
- **Strong rejection rules.** Knowing when *not* to act is half the value. List the cases the skill should escalate or refuse.
- **Cite the right reference docs.** Link to `reference/record-types.md` etc. instead of duplicating schema info inline.
- **Include real example sessions** in `examples.md` — annotated Claude transcripts where the skill worked well.

## What not to put in a skill

- **Customer-specific data.** No customer names, account IDs, SKUs, or actual EDI content checked into this repo. Use placeholders (`<customer-id>`, `ABC-123`).
- **Credentials.** The repo is gitignored against `.env*` for a reason. If you accidentally commit a token, treat it as compromised — rotate immediately.
- **One-off fixes for a single customer.** Skills are reusable procedures. If something is uniquely a one-customer problem, document it in your own notes, not here.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

> **First-time contributors:** before your first commit, complete the [signed-commits setup](CONTRIBUTING.md#one-time-setup-signed-commits) — `main` requires every commit to be cryptographically verified, and unsigned commits will block your PR from merging.

## Security

If you discover a security vulnerability, please follow the process outlined in [SECURITY.md](SECURITY.md). **Do not open a public issue for security vulnerabilities.**

## License

This project is licensed under the Apache License 2.0 — see the [LICENSE](LICENSE) file for details.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.
