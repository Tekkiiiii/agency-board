#!/usr/bin/env bash
# Rename the project: replace every occurrence of the project name with your own name.
#
# Usage:  scripts/rename.sh <new-name> [--dry-run]
#   <new-name>  lowercase letters, digits and hyphens; starts with a letter; 2 to 39 characters.
#   --dry-run   list the files and counts that would change. Nothing is modified.
#
# What it does:
#   1. Replaces the project name in every text file that git tracks or would track
#      (the list honours .gitignore, so node_modules, .next and .env.local are never touched).
#   2. Renames the directory app/.well-known/<current-name>.json to the new name.
# The operator env prefix AGENCY_BOARD_* is NOT renamed: it stays valid and consistent in code, docs and .env.example.
# Run it once, right after you clone, and commit the result. A second run finds nothing to change.
# Portable: works with the bash 3.2 that ships with macOS. Needs git and perl.
set -euo pipefail

# The old name is built from two parts so this script does not contain the literal itself.
OLD="agency""-board"

usage() {
  echo "Usage: scripts/rename.sh <new-name> [--dry-run]" >&2
  echo "  <new-name>: ^[a-z][a-z0-9-]{1,38}\$ and different from the current name ($OLD)." >&2
}

NEW=""
DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "error: unknown option: $arg" >&2; usage; exit 2 ;;
    *)
      if [ -n "$NEW" ]; then echo "error: more than one name given" >&2; usage; exit 2; fi
      NEW="$arg" ;;
  esac
done

if [ -z "$NEW" ]; then echo "error: missing <new-name>" >&2; usage; exit 2; fi
if ! printf '%s' "$NEW" | grep -Eq '^[a-z][a-z0-9-]{1,38}$'; then
  echo "error: invalid name '$NEW' (allowed: ^[a-z][a-z0-9-]{1,38}\$)" >&2; exit 2
fi
if [ "$NEW" = "$OLD" ]; then echo "error: new name equals the current name" >&2; exit 2; fi
command -v perl >/dev/null 2>&1 || { echo "error: perl is required" >&2; exit 3; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
SELF="scripts/rename.sh"

# File list: git's view (tracked + untracked, minus ignored). Fallback for a tree without git.
LIST="$(mktemp "${TMPDIR:-/tmp}/rename-list.XXXXXX")"
trap 'rm -f "$LIST"' EXIT
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  USE_GIT=1
  git ls-files --cached --others --exclude-standard | sort -u > "$LIST"
else
  USE_GIT=0
  find . -type f -not -path './.git/*' -not -path '*/node_modules/*' -not -path './.next/*' \
    -not -name '.env.local' -not -name '.env' | sed 's|^\./||' | sort > "$LIST"
fi

export OLD NEW
TOUCHED=0
OCCURRENCES=0
WARN=0

while IFS= read -r f; do
  [ -f "$f" ] || continue            # tracked-but-deleted entries
  [ "$f" = "$SELF" ] && continue
  grep -Iq . "$f" 2>/dev/null || continue   # skip binary and empty files
  n="$({ grep -oF -- "$OLD" "$f" || true; } | wc -l | tr -d ' ')"
  [ "$n" -gt 0 ] || continue
  TOUCHED=$((TOUCHED + 1))
  OCCURRENCES=$((OCCURRENCES + n))
  printf '%6s  %s\n' "$n" "$f"
  if [ "$DRY" -eq 0 ]; then
    perl -pi -e 's/\Q$ENV{OLD}\E/$ENV{NEW}/g' "$f"
  fi
done < "$LIST"

# Directory rename (a route folder, so Next.js serves /.well-known/<new-name>.json).
OLD_DIR="app/.well-known/$OLD.json"
NEW_DIR="app/.well-known/$NEW.json"
DIR_MSG="none"
if [ -d "$OLD_DIR" ]; then
  if [ -e "$NEW_DIR" ]; then
    echo "error: $NEW_DIR already exists" >&2; exit 4
  fi
  DIR_MSG="$OLD_DIR -> $NEW_DIR"
  if [ "$DRY" -eq 0 ]; then
    if [ "$USE_GIT" -eq 1 ] && git ls-files --error-unmatch "$OLD_DIR" >/dev/null 2>&1; then
      git mv "$OLD_DIR" "$NEW_DIR"
    else
      mv "$OLD_DIR" "$NEW_DIR"
    fi
  fi
fi

# Report other paths that still carry the old name (none expected).
OTHER="$(grep -F -- "$OLD" "$LIST" | grep -vF -- "$OLD_DIR/" || true)"
if [ -n "$OTHER" ]; then
  WARN=1
  echo "warning: these paths contain the old name and were not renamed:" >&2
  printf '%s\n' "$OTHER" >&2
fi

# Report derived spellings the script does not rewrite (none expected).
DERIVED=0
while IFS= read -r f; do
  [ -f "$f" ] && [ "$f" != "$SELF" ] || continue
  grep -Iq . "$f" 2>/dev/null || continue
  if grep -qE 'agency_board|AgencyBoard|Agency Board' "$f"; then
    echo "warning: derived spelling of the old name left in $f" >&2
    DERIVED=1
  fi
done < "$LIST"

echo "---"
if [ "$DRY" -eq 1 ]; then
  echo "dry run: $TOUCHED file(s), $OCCURRENCES occurrence(s) would change; directory rename: $DIR_MSG"
else
  echo "done: $TOUCHED file(s), $OCCURRENCES occurrence(s) replaced; directory rename: $DIR_MSG"
  echo "next: review with 'git diff', run 'npm install' to refresh package-lock.json if needed, then commit."
fi
[ "$WARN" -eq 0 ] && [ "$DERIVED" -eq 0 ] || exit 5
exit 0
