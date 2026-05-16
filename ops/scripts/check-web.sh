#!/usr/bin/env bash
# check-web.sh — pre-deploy parse gate for the web/ assets.
#
# Catches the class of bug that took out the entire PWA on 2026-05-16:
# a duplicate `function clearChildren` at module scope in app.js threw
# `Identifier 'clearChildren' has already been declared` at browser
# parse time, halting module init. Every UI element regressed at once
# (palace tab, sessions list, voice picker, hamburger menu, chat send).
# Bun's typecheck didn't flag it; only the actual browser did.
#
# Two checks:
#   1. Duplicate top-level function/const/let declarations in web/*.js
#   2. Node ESM parse via acorn-equivalent fallback (node --check is
#      too lax — accepts duplicate function declarations even in module
#      mode — so we use the in-process duplicate scan as the primary
#      gate. Per-file syntax errors still surface via `node --check`.)
#
# Run from the repo root. Exits non-zero if any check fails.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

failed=0

# ── Per-file syntax check ────────────────────────────────────────────
for f in web/*.js; do
    [ -e "$f" ] || continue
    if ! node --check "$f" >/dev/null 2>&1; then
        echo "✗ $f: syntax error"
        node --check "$f" 2>&1 | head -5
        failed=1
    fi
done

# ── Duplicate top-level declarations ─────────────────────────────────
# Module scripts (`<script type="module">`) reject duplicate `let`/
# `const` at parse time. Browsers ALSO reject duplicate `function`
# declarations in modules (V8 enforces — node + bun don't, which is
# how today's bug slipped through every local check). Pattern-match
# top-level declarations and fail if any name appears twice in the
# same file.
for f in web/*.js; do
    [ -e "$f" ] || continue
    # Skip minified bundles — they're on one line with reused short
    # identifiers inside IIFEs that match the top-level pattern but
    # aren't actually top-level. Our author-written files don't end
    # in .min.js or contain "minified" markers.
    case "$f" in
        *.min.js|*-min.js) continue ;;
    esac
    # `|| true` so set -e doesn't bail when the pipeline reports
    # exit 1 (grep finding nothing in a file with no declarations,
    # or uniq -d having no duplicates).
    dupes=$(grep -nE "^(function|const|let|var) [a-zA-Z_][a-zA-Z0-9_]*" "$f" \
              | awk -F'[ (]' '{print $2}' \
              | awk -F'=' '{print $1}' \
              | sort \
              | uniq -d \
              | head -10 \
              || true)
    if [ -n "$dupes" ]; then
        echo "✗ $f: duplicate top-level declaration(s):"
        echo "$dupes" | sed 's/^/    /'
        # Show line numbers of each duplicate so the diagnostic points
        # at the actual collision instead of just the name.
        for name in $dupes; do
            echo "   declarations of '$name':"
            grep -nE "^(function|const|let|var) ${name}([ (]|$)" "$f" | sed 's/^/    /'
        done
        failed=1
    fi
done

if [ $failed -eq 0 ]; then
    echo "✓ web/ assets clean ($(ls web/*.js 2>/dev/null | wc -l) JS files)"
fi
exit $failed
