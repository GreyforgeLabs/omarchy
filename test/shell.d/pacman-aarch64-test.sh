#!/bin/bash

# Each invocation has an isolated environment; exported stubs run in the child bash.
# shellcheck disable=SC2030,SC2031,SC2329

set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/base-test.sh"

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/source/default" "$scratch/source/install/helpers" "$scratch/install/hardware"
cp -r "$ROOT/default/pacman" "$scratch/source/default/"
cp "$ROOT/install/helpers/pacman.sh" "$scratch/source/install/helpers/"
printf ':\n' >"$scratch/install/hardware/pacman.sh"

run_setup() (
  architecture=$1
  export OMARCHY_MIRROR=$2
  export OMARCHY_PATH="$scratch/source" OMARCHY_INSTALL="$scratch/install"
  export OMARCHY_PACMAN_CONFIG="$scratch/pacman.conf" OMARCHY_MIRRORLIST="$scratch/mirrorlist"
  uname() { printf '%s\n' "$architecture"; }
  omarchy-pkg-add() { printf 'add %s\n' "$*" >>"$scratch/keys"; }
  pacman-key() { printf 'key %s\n' "$*" >>"$scratch/keys"; }
  source "$ROOT/install/post-install/pacman.sh"
)

run_setup aarch64 edge
grep -Fxq "Server = https://pkgs.omarchy.org/edge/\$arch" "$scratch/pacman.conf" ||
  fail "ARM edge installations retain the published Omarchy repository"
grep -Fxq '[alarm]' "$scratch/pacman.conf" || fail "ARM installations retain ALARM repositories"
if grep -Fxq '[multilib]' "$scratch/pacman.conf"; then
  fail "ARM installations do not inherit x86 multilib"
fi
grep -Fxq 'add archlinuxarm-keyring' "$scratch/keys" || fail "ALARM keyring is installed"
grep -Fxq 'key --populate' "$scratch/keys" || fail "installed keyrings are trusted"

for mirror in stable rc; do
  run_setup aarch64 "$mirror"
  if grep -Fxq '[omarchy]' "$scratch/pacman.conf"; then
    fail "ARM $mirror does not select an unpublished repository or switch to edge"
  fi
done

run_setup x86_64 stable
cmp "$ROOT/default/pacman/pacman-stable.conf" "$scratch/pacman.conf" ||
  fail "x86 repository configuration remains unchanged"

pass "ARM edge retains Omarchy packages without switching other channels"

run_refresh() (
  export OMARCHY_TEST_ARCH=$1
  shift
  export OMARCHY_PATH="$scratch/source"
  export OMARCHY_PACMAN_CONFIG="$scratch/pacman.conf" OMARCHY_MIRRORLIST="$scratch/mirrorlist"
  export OMARCHY_TEST_LOG="$scratch/refresh.log"
  : >"$OMARCHY_TEST_LOG"

  uname() { printf '%s\n' "$OMARCHY_TEST_ARCH"; }
  sudo() {
    printf '%s\n' "$*" >>"$OMARCHY_TEST_LOG"
    if [[ $1 == "cp" ]]; then
      [[ ${OMARCHY_TEST_COPY_FAIL:-0} != "1" ]] || return 1
      command "$@"
    elif [[ $* == "env OMARCHY_UPDATE_PACMAN=1 pacman -Syyuu --noconfirm" ]]; then
      # Deliberately never invoke pacman from this test.
      grep -Fxq 'hook pre-refresh-pacman' "$OMARCHY_TEST_LOG" || return 1
    else
      return 1
    fi
  }
  omarchy-hook() { printf 'hook %s\n' "$*" >>"$OMARCHY_TEST_LOG"; }
  export -f uname sudo omarchy-hook
  bash "$ROOT/bin/omarchy-refresh-pacman" "$@"
)

run_setup aarch64 edge
cp "$scratch/pacman.conf" "$scratch/expected-arm.conf"
cp "$scratch/mirrorlist" "$scratch/expected-arm-mirrorlist"
printf 'original config\n' >"$scratch/pacman.conf"
printf 'original mirrors\n' >"$scratch/mirrorlist"
run_refresh aarch64 edge
cmp "$scratch/expected-arm.conf" "$scratch/pacman.conf" || fail "ARM refresh matches installer repositories"
cmp "$scratch/expected-arm-mirrorlist" "$scratch/mirrorlist" || fail "ARM refresh preserves ALARM mirror layout"
grep -Fxq 'original config' "$scratch/pacman.conf.bak" || fail "refresh backs up the previous configuration"
grep -Fxq 'original mirrors' "$scratch/mirrorlist.bak" || fail "refresh backs up the previous mirrors"
grep -Fxq 'env OMARCHY_UPDATE_PACMAN=1 pacman -Syyuu --noconfirm' "$scratch/refresh.log" ||
  fail "refresh retains the guarded upgrade after its customization hook"
run_refresh aarch64 edge
[[ $(grep -Fxc '[omarchy]' "$scratch/pacman.conf") == "1" ]] || fail "repeated refresh does not duplicate repositories"
pass "ARM refresh shares installer selection, backs up files and remains idempotent"

for channel in stable rc invalid ''; do
  args=()
  [[ -z $channel ]] || args+=("$channel")
  if run_refresh aarch64 "${args[@]}" >"$scratch/error.out" 2>&1; then
    fail "ARM refresh rejects unpublished or invalid channels"
  fi
  [[ ! -s $scratch/refresh.log ]] || fail "rejected refresh does not invoke sudo, hooks or upgrades"
  cmp "$scratch/expected-arm.conf" "$scratch/pacman.conf" || fail "rejected refresh keeps the current repository"
  cmp "$scratch/expected-arm-mirrorlist" "$scratch/mirrorlist" || fail "rejected refresh keeps the current mirrors"
  if [[ $channel != "invalid" ]]; then
    grep -Fq 'No repository configuration changed' "$scratch/error.out" || fail "unpublished channel has an actionable error"
  fi
done
pass "unpublished ARM channels never remove a working repository or silently select edge"

for channel in stable rc edge; do
  run_refresh x86_64 "$channel"
  cmp "$ROOT/default/pacman/pacman-$channel.conf" "$scratch/pacman.conf" || fail "x86 $channel configuration is unchanged"
  cmp "$ROOT/default/pacman/mirrorlist-$channel" "$scratch/mirrorlist" || fail "x86 $channel mirrors are unchanged"
done
pass "all x86 channel templates are preserved"

cp "$scratch/pacman.conf" "$scratch/before-error.conf"
cp "$scratch/mirrorlist" "$scratch/before-error-mirrorlist"
mv "$scratch/source/default/pacman/mirrorlist-aarch64" "$scratch/source/default/pacman/mirrorlist-aarch64.saved"
if run_refresh aarch64 edge >"$scratch/error.out" 2>&1; then
  fail "refresh stops when a template cannot be staged"
fi
[[ ! -s $scratch/refresh.log ]] || fail "missing templates never reach privileged writes or an upgrade"
cmp "$scratch/before-error.conf" "$scratch/pacman.conf" || fail "staging failure preserves configuration"
cmp "$scratch/before-error-mirrorlist" "$scratch/mirrorlist" || fail "staging failure preserves mirrors"
mv "$scratch/source/default/pacman/mirrorlist-aarch64.saved" "$scratch/source/default/pacman/mirrorlist-aarch64"

if OMARCHY_TEST_COPY_FAIL=1 run_refresh aarch64 edge >"$scratch/error.out" 2>&1; then
  fail "refresh stops when a privileged copy fails"
fi
if grep -Eq 'hook|pacman -S' "$scratch/refresh.log"; then
  fail "failed privileged copies never reach hooks or upgrades"
fi
pass "failed staging or privileged copies stop before a system upgrade"
