#!/bin/bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/base-test.sh"

test_home=$(mktemp -d)
trap 'rm -rf "$test_home"' EXIT
provider="$test_home/.config/nvim/lua/config/remote_clipboard.lua"
mkdir -p "$(dirname "$provider")" "$test_home/bin"
# Redirect only the packaged source path; run the actual migration logic.
sed "s@/usr/share/omarchy-nvim/config/lua/config/remote_clipboard.lua@$test_home/package.lua@" \
  "$ROOT/migrations/1788996284.sh" >"$test_home/migration.sh"
printf '%s\n' '-- corrected packaged provider' >"$test_home/package.lua"
cat >"$test_home/bin/pacman" <<'STUB'
#!/bin/bash
[[ $* == '-Q omarchy-nvim' ]] || exit 1
printf 'omarchy-nvim %s\n' "${TEST_NVIM_VERSION:-2026.8.13-2}"
STUB
chmod +x "$test_home/bin/pacman"
run_migration() {
  env HOME="$test_home" PATH="$test_home/bin:$PATH" bash -euo pipefail "$test_home/migration.sh"
}

run_migration
[[ ! -e $provider ]] || fail "missing provider is left alone"
pass "missing provider is left alone"

for fixture in "$SHELL_TEST_DIR/fixtures/neovim-clipboard/"*.lua; do
  cp "$fixture" "$provider"
  run_migration
  cmp "$provider" "$test_home/package.lua" || fail "known provider is upgraded: $fixture"
  backup=$(ls -t "$provider".bak.* | head -n1)
  cmp "$backup" "$fixture" || fail "known provider is backed up: $fixture"
  [[ $(stat -c %a "$provider") == "644" ]] || fail "provider is mode 0644"
  before=$(ls "$provider".bak.*)
  run_migration
  [[ $(ls "$provider".bak.*) == "$before" ]] || fail "repeat migration does not create backups"
  pass "known provider is backed up and upgraded idempotently: ${fixture##*/}"
done

cp "$SHELL_TEST_DIR/fixtures/neovim-clipboard/july.lua" "$provider"
printf '%s\n' '-- user customization' >>"$provider"
cp "$provider" "$test_home/custom.lua"
run_migration >"$test_home/output"
cmp "$provider" "$test_home/custom.lua" || fail "customized provider is preserved"
grep -q 'Preserving customized' "$test_home/output" || fail "customized provider receives guidance"
printf '%s\n' '-- unrelated provider' >"$provider"
cp "$provider" "$test_home/custom.lua"
run_migration
cmp "$provider" "$test_home/custom.lua" || fail "unrelated provider is preserved"
pass "customized and unrelated providers are preserved"

cp "$SHELL_TEST_DIR/fixtures/neovim-clipboard/june.lua" "$provider"
export TEST_NVIM_VERSION=2026.8.13-1
if run_migration; then fail "old package leaves migration pending"; fi
cmp "$provider" "$SHELL_TEST_DIR/fixtures/neovim-clipboard/june.lua" || fail "old package leaves provider unchanged"
unset TEST_NVIM_VERSION
mv "$test_home/package.lua" "$test_home/package.saved"
if run_migration; then fail "missing package source leaves migration pending"; fi
cmp "$provider" "$SHELL_TEST_DIR/fixtures/neovim-clipboard/june.lua" || fail "missing source leaves provider unchanged"
pass "old or missing package cannot mark an unrepaired provider complete"
