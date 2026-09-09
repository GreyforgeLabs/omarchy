#!/bin/bash

set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/base-test.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cat >"$tmp_dir/setsid" <<'SCRIPT'
#!/bin/bash
printf '%s\n' "$*" >"$TEST_LOG"
SCRIPT
chmod +x "$tmp_dir/setsid"

export TEST_LOG="$tmp_dir/log"
export PATH="$tmp_dir:$ROOT/bin:$PATH"

OMARCHY_PATH="$ROOT" "$ROOT/bin/omarchy-launch-floating-terminal-with-presentation" "echo hello"

launch=$(<"$TEST_LOG")
[[ $launch == *"xdg-terminal-exec --app-id=org.omarchy.terminal"* ]] || fail "floating terminal launches Omarchy terminal" "$launch"
pass "floating terminal launches Omarchy terminal"

[[ $launch == *"$ROOT/bin/omarchy-show-logo; echo hello;"* ]] ||
  fail "floating terminal fixes the logo callback to the Omarchy tree" "$launch"
[[ $launch == *"then $ROOT/bin/omarchy-show-done; fi"* ]] ||
  fail "floating terminal fixes the completion callback to the Omarchy tree" "$launch"
pass "floating terminal presentation callbacks bypass the user PATH"
