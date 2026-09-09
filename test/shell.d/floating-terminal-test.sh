#!/bin/bash

set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/base-test.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cat >"$tmp_dir/setsid" <<'SCRIPT'
#!/bin/bash
printf 'setsid\t%s\n' "$*" >>"$TEST_LOG"
SCRIPT
chmod +x "$tmp_dir/setsid"

export TEST_LOG="$tmp_dir/log"
export PATH="$tmp_dir:$ROOT/bin:$PATH"

OMARCHY_PATH="$ROOT" "$ROOT/bin/omarchy-launch-floating-terminal-with-presentation" "echo hello"

launch=$(tail -n 1 "$TEST_LOG")
[[ $launch == *"xdg-terminal-exec --app-id=org.omarchy.terminal"* ]] || fail "floating terminal launches Omarchy terminal" "$launch"
pass "floating terminal launches Omarchy terminal"

[[ $launch == *"$ROOT/bin/omarchy-show-logo; echo hello;"* ]] ||
  fail "floating terminal fixes the logo callback to the Omarchy tree" "$launch"
[[ $launch == *"then $ROOT/bin/omarchy-show-done; fi"* ]] ||
  fail "floating terminal fixes the completion callback to the Omarchy tree" "$launch"
pass "floating terminal presentation callbacks bypass the user PATH"

launcher="$ROOT/bin/omarchy-launch-floating-terminal-with-presentation"
launcher_copy="$tmp_dir/launcher"
cold_root="$tmp_dir/omarchy"
sudo_invalidated="$tmp_dir/sudo-invalidated"
mkdir -p "$cold_root/bin"

occurrences=$(grep -Foc '/usr/bin/sudo' "$launcher") || occurrences=0
(( occurrences == 1 )) || fail "floating terminal names fixed sudo exactly once" "found $occurrences occurrences"
sed "s|/usr/bin/sudo|$tmp_dir/sudo|" "$launcher" >"$launcher_copy"

cat >"$tmp_dir/sudo" <<'SCRIPT'
#!/bin/bash
printf 'sudo\t%s\n' "$*" >>"$TEST_LOG"
: >"$TEST_SUDO_INVALIDATED"
SCRIPT

cat >"$cold_root/bin/omarchy-restart-gum" <<'SCRIPT'
#!/bin/bash
if [[ ! -e $TEST_SUDO_INVALIDATED ]]; then
  printf 'restart-gum-before-sudo\n' >>"$TEST_LOG"
else
  printf 'restart-gum\n' >>"$TEST_LOG"
fi
SCRIPT

for command in omarchy-show-logo omarchy-show-done; do
  printf '#!/bin/bash\nexit 0\n' >"$cold_root/bin/$command"
done

chmod +x "$launcher_copy" "$tmp_dir/sudo" "$cold_root/bin"/*
: >"$TEST_LOG"
TEST_SUDO_INVALIDATED="$sudo_invalidated" OMARCHY_PATH="$cold_root" "$launcher_copy" --cold-sudo "echo hello"

mapfile -t calls <"$TEST_LOG"
[[ ${calls[0]:-} == $'sudo\t-k' ]] || fail "cold presentation launch invalidates sudo first" "$(<"$TEST_LOG")"
[[ ${calls[1]:-} == "restart-gum" ]] || fail "cold presentation launch invalidates sudo before theming" "$(<"$TEST_LOG")"
[[ ${calls[2]:-} == $'setsid\t'* ]] || fail "cold presentation launch invalidates sudo before terminal launch" "$(<"$TEST_LOG")"
pass "cold presentation launch revokes sudo before pre-entry callbacks"
