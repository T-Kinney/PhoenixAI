#!/bin/sh
# Git hooks are not versioned, so a fresh clone starts unprotected.
# Run this once after cloning: sh scripts/install-hooks.sh
root=$(git rev-parse --show-toplevel)
cp "$root/scripts/pre-commit-secret-guard.sh" "$root/.git/hooks/pre-commit"
chmod +x "$root/.git/hooks/pre-commit"
echo "installed: .git/hooks/pre-commit"
