---
name: update-skills
description: Capture learnings from a NetSuite EDI session as new or updated skills/reference docs in the orderful-netsuite-skills repo via a PR. Use proactively at the end of any productive session — when the user corrected a previous assumption, a working SuiteQL/JSONata pattern was discovered, a manual NetSuite workflow nobody had captured was walked through, or a customer-specific pattern was solved that other contractors will hit. Also use when the user explicitly says "/update-skills", "save this as a skill", "let's capture this", "submit a PR with what we learned", "generate a PR", or "remember this for next time".
---

# Update Skills — turn session learnings into PRs

The [orderful-netsuite-skills](https://github.com/Orderful/orderful-netsuite-skills) library is the **single source of truth** for how Orderful contractors and operations teams work with NetSuite. Every contractor pulls from the same `main` branch. The deal in exchange for using these skills is: every session that produces something useful — a new SuiteQL pattern, a corrected assumption, a workflow nobody has captured yet — gets pushed back as a PR so the next contractor doesn't have to rediscover it.

This skill is the mechanism. Trigger it explicitly OR proactively when you notice the user has done something worth persisting.

## When to trigger PROACTIVELY

You should *offer* to capture (don't just do it silently) when these moments come up in the session:

- **The user corrected you on something domain-specific.** A SuiteQL field name, a NetSuite record-type quirk, a JSONata transform that didn't match reality, an EDI segment Orderful handles non-obviously. Capture as a `reference/*.md` entry or skill update.
- **You found a working pattern after iteration.** After 3+ tries, you got the right way to set up enabled transactions, fix a stuck 850, configure a sub-customer's ISA IDs, or handle a kit/SLN item. Capture it before the session context is gone.
- **The user walked you through a manual workflow no skill covers.** They guided you step-by-step through something tedious. That's a candidate for a new skill.
- **You confirmed a non-obvious behavior of the SuiteApp.** ("Oh — this MapReduce only triggers when X is set, not Y." "The poller skips transactions older than 30 days.") Reference doc material.
- **End of a productive session.** Before the user wraps up, briefly recap and ask: *"We covered X, Y, and Z today. Want me to capture any of that as a skill update before we close out?"*

**Don't be obsequious** — only offer if there's something concrete and reusable. Trivial sessions, one-off customer-specific debugging, or anything you're not sure about does NOT need a PR.

## When to trigger EXPLICITLY (user asks)

The user says things like:
- "/update-skills"
- "save this as a skill"
- "let's capture this"
- "submit a PR with what we learned"
- "generate a PR for this"
- "remember this for next time"

## Inputs the skill needs

Before doing anything, get clarity on:

1. **What to capture?** Walk through candidates from the session and let the user pick. Sometimes the answer is "all of it as one skill"; sometimes it's "just the SuiteQL pattern as a reference doc."
2. **Which type?**
   - **New skill** (`skills/<name>/SKILL.md`) — a procedure with steps, behaviour rules, when to use it
   - **Update to an existing skill** — a new behaviour rule, troubleshooting entry, or recipe step in an existing `SKILL.md`
   - **Reference doc** (`reference/<topic>.md`) — factual lookup material (schemas, query patterns, field names)
3. **Ready to commit, or still iterating?** If still in flux, propose a draft and ask the user to refine before opening the PR.

## The recipe

### Step 1 — Find the local clone

The skills repo is at `~/Documents/GitHub/orderful-netsuite-skills/` for most users. Verify:

```sh
ls -la ~/.claude/skills/update-skills
# Should be a symlink. Follow it to find the repo root.
readlink ~/.claude/skills/update-skills
```

If the repo isn't cloned anywhere, stop and direct the user to `git clone git@github.com:Orderful/orderful-netsuite-skills.git` + `./install.sh` first.

### Step 2 — Make sure your fork is set up, then branch from upstream/main

Every PR should be authored by the contributor's own GitHub account, even for org members. That means working from a fork — not pushing directly to `Orderful/orderful-netsuite-skills`. This keeps the contribution flow identical for everyone (org members, contractors, external collaborators) and avoids the 403 wall that anyone outside the org would otherwise hit.

This is a one-time setup per machine. Verify your remotes:

```sh
cd <repo-path>
git remote -v
# origin    https://github.com/<your-username>/orderful-netsuite-skills.git
# upstream  https://github.com/Orderful/orderful-netsuite-skills.git
```

If `origin` still points to `Orderful/...`, run this once on this machine:

```sh
gh repo fork --remote=true
```

That forks the repo on GitHub (no-op if your fork already exists), renames the existing `origin` to `upstream`, and points `origin` at your fork.

Then branch from upstream:

```sh
git fetch upstream
git switch -c <github-username>/feat/<short-description> upstream/main
```

Branch naming:
- New skill: `<user>/feat/<kebab-case-name>` (e.g., `isaiah/feat/sub-customer-isa-mapping`)
- Refinement to existing skill: `<user>/fix/<short-description>`
- Reference doc: `<user>/docs/<topic>`

### Step 3 — Make the change

**For a NEW skill:**

```sh
mkdir -p skills/<skill-name>
```

Write `skills/<skill-name>/SKILL.md` following the format in [`CONTRIBUTING.md`](../../CONTRIBUTING.md):

```markdown
---
name: <skill-name>
description: One paragraph that includes specific trigger phrases the user might say. Used by Claude to decide when to load.
---

# <Skill Title>

## When to use this skill
- Concrete user prompts (3-5 examples)

## Inputs the skill needs
- What to ask the user up-front

## The recipe
### Step 1 — <load context>
### Step 2 — <intermediate reasoning>
### Step 3 — <propose action / output>

## Behaviour rules
1. **Numbered must / must-not list.** Include rejection cases — when NOT to act.
2. ...

## Reference material
- Links to relevant `reference/*.md` files
```

If the skill needs a script (e.g., a TBA-signed REST call), add `<skill-name>.mjs` and model it after `skills/netsuite-setup/test-connections.mjs` or `skills/run-poller/run-poller.mjs`.

**For an UPDATE to an existing skill:**

Open the existing `SKILL.md` and make a surgical edit — add the new behaviour rule, troubleshooting row, or step in the right place. Don't rewrite the whole file.

**For a REFERENCE doc:**

Either edit `reference/<existing>.md` or create `reference/<topic>.md`. Keep it factual — schemas, query patterns, field names. Procedure goes in skills, not reference.

### Step 4 — Strip customer data ruthlessly

CRITICAL: scan everything you wrote (and any code snippets, comments, or examples) for real customer/partner data. Replace with the placeholders documented in `CONTRIBUTING.md`:

| What to scrub | Replace with |
|---|---|
| Customer slug (real partner identifier, lowercase-hyphenated) | `acme-foods`, `widgetco`, `northwind-retail-inc` |
| Customer display name (real partner company name) | "Acme Foods", "Widget Co", "Northwind Retail Inc." |
| NetSuite account ID (production or sandbox) | `1234567`, `1234567_SB1`, `TDxxxxxxx` |
| ISA ID (real trading partner identifier) | `ZZ0123456789ABC`, `<sender-isa-id>` |
| API key, TBA token, consumer secret | `<orderful-api-key>`, `<PASTE HERE>` |

If a snippet can't be fully sanitized, **abstract it** instead of leaving it: "for any sandbox customer with split-by-shipto enabled" beats "for the X customer where we set splitByShipTo=true on account 1234567_SB1".

The auto-review pipeline runs a deterministic regex pre-scan PLUS a Claude review on every PR. Customer-data leaks block auto-merge, so it's faster to scrub now than to fix on PR feedback.

### Step 5 — Run install.sh and verify

```sh
./install.sh
```

This re-symlinks any new skill folder into `~/.claude/skills/`. Confirm the new skill appears in the output.

### Step 6 — Commit

```sh
git add <only-the-files-you-changed>
git commit -m "feat: <short imperative description>"
```

Use conventional-commit prefixes: `feat:` for new skills, `fix:` for refinements, `docs:` for reference-only changes. Don't `git add -A` or `git add .` — only the files relevant to this learning.

### Step 7 — Push to your fork and open the PR

```sh
git push -u origin HEAD

gh pr create --base main --title "<imperative title>" --body "$(cat <<'EOF'
## Summary

<what this skill does or fixes>

## Where it came from

<one or two sentences on the session context that surfaced this — anonymized, no customer names/IDs>

## Sample triggers

The user says:
- "..."
- "..."

## Tested

- [x] \`./install.sh\` re-symlinks cleanly
- [x] No customer data, account IDs, ISA IDs, or credentials in the diff
- [x] Format matches CONTRIBUTING.md skill spec

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

`origin` is your fork (set up in Step 2), so the push lands there. `gh pr create --base main` auto-detects the cross-repo setup and opens the PR against `Orderful/orderful-netsuite-skills:main`, authored by your GitHub account.

Surface the PR URL to the user.

### Step 8 — Watch for the auto-review verdict

The `.github/workflows/ai-review.yml` runs on every PR. Within a minute or two it will post a comment OR approve + enable auto-merge. Watch for it:

- **Approved** — auto-merge will land it as soon as required checks pass. Done.
- **Commented with concerns** — read the verdict, address each `false` criterion in a follow-up commit on the same branch. The workflow re-runs on push.
- **Path gate / leak scan blocked** — usually means something snuck through Step 4. Fix and re-push.

## Behaviour rules

1. **Always work from a fork; never push to upstream directly.** Push your feature branch to your fork's `origin`, never to `Orderful/orderful-netsuite-skills` — even if you're an org member with write access. PRs must be authored by the contributor's own GitHub account so review attribution stays clean and the contribution flow is identical for everyone (org members, contractors, external collaborators). And never commit to `main` on any remote — always branch + PR.
2. **One change per PR.** New skill = one PR. Update to an existing skill = another PR. Don't bundle unrelated changes.
3. **Preserve the user's correction in the skill, not your wrong assumption.** If the user said "actually, on this customer, X" — capture X, not your prior wrong answer. The whole point is the next contractor benefits from this lesson.
4. **Strip customer data ruthlessly.** When in doubt, abstract.
5. **Don't auto-create skills the user wasn't sure about.** If they said something useful in passing but didn't ask to save it, *ask first* before opening a PR.
6. **Refusing PRs is fine.** If the user says "don't bother, this is one-off" or "this is too customer-specific to generalize", drop it. Not every session warrants a PR.
7. **Don't include this conversation as evidence in the PR body.** Anonymize the context — say "while debugging an inbound 850 with non-standard ship-to handling" rather than transcribing the actual thread.
8. **If the auto-review flags real findings, fix them — don't argue.** The reviewer is calibrated to err toward false positives. If you genuinely think it's wrong, comment on the PR and ping a maintainer.

## Reference material

- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — required skill format and contributor norms
- [`.github/ai-review/criteria.md`](../../.github/ai-review/criteria.md) — what the auto-reviewer checks for (read this before writing a new skill — it tells you exactly what the reviewer rejects)
- Existing skills as examples of well-formed structure: [`netsuite-setup`](../netsuite-setup/SKILL.md), [`enable-customer`](../enable-customer/SKILL.md), [`item-lookup`](../item-lookup/SKILL.md), [`run-poller`](../run-poller/SKILL.md)
