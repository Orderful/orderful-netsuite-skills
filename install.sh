#!/usr/bin/env bash
# Copyright (c) 2026 Orderful, Inc.
#
# install.sh — Install Orderful NetSuite skills into ~/.claude/skills/
#
# What this does:
#   1. Symlinks each skills/<name> directory to ~/.claude/skills/<name>
#   2. Runs `npm install` to fetch deps used by samples/ and skills/netsuite-setup/test-connections.mjs
#   3. Creates ~/orderful-onboarding/ for per-customer .env files
#
# Symlinks (not copies) so a `git pull` in this repo updates your installed
# skills automatically. Re-run after pulling new skills.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="${HOME}/.claude/skills"
ONBOARDING_DIR="${HOME}/orderful-onboarding"

ok()    { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn()  { printf "  \033[33m⚠\033[0m %s\n" "$*"; }
err()   { printf "  \033[31m✗\033[0m %s\n" "$*" >&2; }
info()  { printf "  • %s\n" "$*"; }
header(){ printf "\n\033[1m%s\033[0m\n" "$*"; }

# ─── 1. Symlink skills ────────────────────────────────────────────────────────
header "Linking skills into ${SKILLS_DIR}"

mkdir -p "${SKILLS_DIR}"

linked_skills=()
for skill_dir in "${SCRIPT_DIR}/skills"/*; do
  [ -d "${skill_dir}" ] || continue
  skill_name="$(basename "${skill_dir}")"
  target="${SKILLS_DIR}/${skill_name}"

  if [ -L "${target}" ]; then
    rm "${target}"
    ln -s "${skill_dir}" "${target}"
    ok "${skill_name} (relinked)"
  elif [ -e "${target}" ]; then
    warn "${skill_name} skipped: ${target} exists and is not a symlink"
    info "  remove or rename it manually, then re-run ./install.sh"
    continue
  else
    ln -s "${skill_dir}" "${target}"
    ok "${skill_name} (linked)"
  fi
  linked_skills+=("${skill_name}")
done

if [ "${#linked_skills[@]}" -eq 0 ]; then
  warn "No skills linked. Is skills/ empty?"
  exit 1
fi

# ─── 2. Install npm dependencies ──────────────────────────────────────────────
header "Installing npm dependencies (oauth-1.0a, dotenv)"

if ! command -v npm >/dev/null 2>&1; then
  err "npm not found — install Node.js 20+ from https://nodejs.org and re-run"
  info "  Skills are linked but samples/ and the setup validation script won't work without npm install"
  exit 1
fi

if [ ! -d "${SCRIPT_DIR}/node_modules" ] || [ "${SCRIPT_DIR}/package.json" -nt "${SCRIPT_DIR}/node_modules" ]; then
  if (cd "${SCRIPT_DIR}" && npm install --silent --no-audit --no-fund >/dev/null 2>&1); then
    ok "deps installed"
  else
    err "npm install failed. Run it manually to see the error:"
    info "  cd ${SCRIPT_DIR} && npm install"
    exit 1
  fi
else
  ok "deps up-to-date"
fi

# ─── 3. Onboarding directory for per-customer .env files ──────────────────────
header "Per-customer credentials directory"

mkdir -p "${ONBOARDING_DIR}"
ok "${ONBOARDING_DIR} ready"
info "  Each customer's .env will live at ${ONBOARDING_DIR}/<customer-slug>/.env"
info "  The netsuite-setup skill scaffolds these for you — don't pre-create anything."

# ─── Done ─────────────────────────────────────────────────────────────────────
header "Done"
info "${#linked_skills[@]} skill(s) installed:"
for skill in "${linked_skills[@]}"; do
  info "  /${skill}"
done
echo ""
info "Next: open Claude Code in any directory and run /netsuite-setup to onboard your first customer."
echo ""
