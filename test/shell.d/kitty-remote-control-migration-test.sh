#!/bin/bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/base-test.sh"

migration="$ROOT/migrations/1788707260.sh"
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT

test_home="$test_dir/home"
kitty_config="$test_home/.config/kitty/kitty.conf"
mkdir -p "$(dirname "$kitty_config")"

run_migration() {
  env HOME="$test_home" bash -euo pipefail "$migration"
}

grep -qx 'allow_remote_control no' "$ROOT/config/kitty/kitty.conf" ||
  fail "new installs disable Kitty remote control"
pass "new installs disable Kitty remote control"

cp "$ROOT/config/kitty/kitty.conf" "$kitty_config"
sed -i 's/^allow_remote_control no$/allow_remote_control yes/' "$kitty_config"
output=$(run_migration)
cmp -s "$ROOT/config/kitty/kitty.conf" "$kitty_config" ||
  fail "migration disables remote control without changing other defaults"
[[ $output == *"Close and reopen all Kitty windows"* ]] ||
  fail "migration explains that running Kitty processes need restarting"
pass "migration disables the shipped yes setting and explains how to apply it"

cp "$kitty_config" "$test_dir/expected"
output=$(run_migration)
cmp -s "$test_dir/expected" "$kitty_config" || fail "migration is idempotent"
[[ $output != *"Close and reopen"* ]] || fail "unchanged config needs no restart reminder"
pass "migration is idempotent"

cat >"$kitty_config" <<'EOF'
# allow_remote_control yes
font_size 14
  allow_remote_control   yes
allow_remote_control yes
listen_on unix:/tmp/custom-kitty
map ctrl+insert copy_to_clipboard
EOF
cat >"$test_dir/expected" <<'EOF'
# allow_remote_control yes
font_size 14
  allow_remote_control   no
allow_remote_control no
listen_on unix:/tmp/custom-kitty
map ctrl+insert copy_to_clipboard
EOF
printf 'allow_remote_control yes  \n' >>"$kitty_config"
printf 'allow_remote_control no  \n' >>"$test_dir/expected"
run_migration >/dev/null
cmp -s "$test_dir/expected" "$kitty_config" ||
  fail "migration handles whitespace and duplicate settings while preserving customizations"
pass "migration handles whitespace and duplicate settings while preserving customizations"

for setting in no socket-only socket password; do
  printf 'allow_remote_control %s\nfont_size 14\n' "$setting" >"$kitty_config"
  cp "$kitty_config" "$test_dir/expected"
  run_migration >/dev/null
  cmp -s "$test_dir/expected" "$kitty_config" || fail "migration preserves $setting"
done
pass "migration preserves settings other than unrestricted yes"

printf '# allow_remote_control yes\nfont_size 14\n' >"$kitty_config"
cp "$kitty_config" "$test_dir/expected"
run_migration >/dev/null
cmp -s "$test_dir/expected" "$kitty_config" || fail "migration leaves an omitted setting alone"
pass "migration leaves an omitted setting alone"

test_home="$test_dir/empty-home"
mkdir -p "$test_home"
run_migration >/dev/null
[[ ! -e $test_home/.config/kitty ]] || fail "migration does not create a missing Kitty config"
pass "migration succeeds without a Kitty config"
