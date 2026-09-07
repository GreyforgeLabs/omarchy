#!/bin/bash

set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/base-test.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$tmp_dir/bin"

cat >"$tmp_dir/bin/omarchy-pkg-drop" <<'SCRIPT'
#!/bin/bash
printf 'drop:%s\n' "$*" >>"$TEST_LOG"
SCRIPT
chmod +x "$tmp_dir/bin/omarchy-pkg-drop"

export TEST_LOG="$tmp_dir/log"
export PATH="$tmp_dir/bin:$PATH"

fresh_home() {
  rm -rf "$tmp_dir/home"
  mkdir -p "$tmp_dir/home"
  export HOME="$tmp_dir/home"
}

# T3 Code bootstraps the agents it drives; their state outlives it.
fresh_home
mkdir -p "$HOME/.config/t3code" "$HOME/.t3" "$HOME/.grok" "$HOME/.local/share/opencode" "$HOME/.npm"
touch "$HOME/.claude.json"
"$ROOT/bin/omarchy-remove-ai-t3-code" >/dev/null

[[ ! -e $HOME/.t3 ]] || fail "T3 Code removal deletes its own data"
pass "T3 Code removal deletes its own data"

for kept in .grok .claude.json .npm .local/share/opencode; do
  [[ -e $HOME/$kept ]] || fail "T3 Code removal keeps the agent state it bootstrapped" "$kept"
done
pass "T3 Code removal keeps the agent state it bootstrapped"

