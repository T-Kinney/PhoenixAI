#!/bin/sh
# Blocks a commit that would publish credentials.
#
# .gitignore already covers .env, but it does not protect against `git add -f`,
# a key pasted into a source file, or a new secret-bearing filename nobody
# thought to ignore. This repo is going public, so the cost of a miss is a live
# key in a public history — cheap check, expensive failure.
#
# Installed to .git/hooks/pre-commit by scripts/install-hooks.sh.

fail=0

# 1. Filenames that should never be committed.
blocked=$(git diff --cached --name-only --diff-filter=ACM \
  | grep -iE '(^|/)\.env($|\.)|(^|/)secrets?\.(json|ya?ml|txt)$|\.pem$|\.p12$|id_rsa' \
  | grep -v '\.env\.example$')

if [ -n "$blocked" ]; then
  echo "BLOCKED: these files look like they hold credentials:"
  echo "$blocked" | sed 's/^/  /'
  fail=1
fi

# 2. Key-shaped strings in staged content. Prefix-anchored to keep false
#    positives low — these are the formats the providers actually issue.
#    Checked against the staged blob, not the working tree, so a staged key
#    cannot hide behind a cleaned-up file on disk.
for file in $(git diff --cached --name-only --diff-filter=ACM); do
  case "$file" in
    *.lock|package-lock.json|*.min.js|*.map) continue ;;
  esac
  # Skip binaries.
  git diff --cached -- "$file" | head -1 | grep -q "Binary" && continue

  found=$(git show ":$file" 2>/dev/null | grep -nEo \
    'sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|rk_live_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}' \
    | head -3)

  if [ -n "$found" ]; then
    echo "BLOCKED: $file contains something shaped like a live API key:"
    # Print the issuer prefix only. Anchoring on the prefix and replacing the
    # entire body is the only safe form: key bodies contain '-' and '_', so
    # truncating at the first separator still emits part of the secret.
    # Longest prefixes first, or 'sk-' would match ahead of 'sk-ant-'.
    echo "$found" | sed -E 's/(sk-ant-|sk-proj-|rk_live_|whsec_|nvapi-|xai-|sk-|gh[pousr]_|AKIA|AIza)[A-Za-z0-9_-]+/\1<redacted>/g' \
      | sed 's/^/  line /'
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Nothing was committed. Move the value into .env (already gitignored)"
  echo "and read it with process.env at runtime."
  echo "If this is a false positive: git commit --no-verify"
  exit 1
fi

exit 0
