#!/bin/bash
set -uo pipefail

# Refuse to source the host unless every writable root is the test sandbox.
[[ -n ${TEST_ROOT:-} && $HOME == "$TEST_ROOT/home" &&
  $XDG_RUNTIME_DIR == "$TEST_ROOT/runtime" && $TMPDIR == "$TEST_ROOT/tmp" &&
  $OMARCHY_PATH == "$TEST_ROOT/omarchy" && -d $OMARCHY_PATH/themes ]] || exit 90

source "${BASH_SOURCE[0]%/*}/../../../../bin/omarchy-browser-theme-host"
[[ $SYSTEM_ICONS_DIR == /usr/share/icons ]] || exit 91
SYSTEM_ICONS_DIR="$TEST_ROOT/icons"

setsid() {
  [[ ! -e /proc/$BASHPID/fd/8 ]] || printf 'inherited install lock\n' >>"$TEST_ROOT/lock-leak"
  printf '%s\n' "$*" >>"$TEST_ROOT/setter-calls"
}
omarchy-theme-set() { return 99; }
date() { printf '%s\n' "$TEST_NOW"; }
omarchy-theme-list() {
  local entry
  for entry in "$USER_THEMES_DIR"/* "$OMARCHY_PATH/themes"/*; do
    [[ -d $entry || -L $entry ]] && printf '%s\n' "${entry##*/}"
  done
  return 0
}
mv() {
  if [[ ${@: -1} == "$INSTALL_STATE_DIR/last-install" ]]; then
    case ${TEST_TIMESTAMP_FAILURE:-} in
      1) return 1 ;;
      skip) return 0 ;;
    esac
  fi
  if [[ ${1:-} == --no-copy && ${2:-} == -nT ]]; then
    local dest=${@: -1} record
    record="$INSTALL_STATE_DIR/themes/${dest##*/}"
    [[ -f $record && ! -L $record && $(stat -c%s -- "$record") == 2 && $(<"$record") == 1 ]] || {
      printf 'missing membership before publication\n' >"$TEST_ROOT/reservation-missing"
      return 1
    }
    printf 'reserved\n' >"$TEST_ROOT/reserved-before-publication"
    case ${TEST_PUBLICATION:-} in
      fail) return 1 ;;
      skip) return 0 ;;
      interrupt) kill -TERM "$BASHPID" ;;
      crash-before) kill -KILL "$BASHPID" ;;
      fail-after | interrupt-after | crash-after)
        command mv "$@" || return
        case $TEST_PUBLICATION in
          fail-after) return 1 ;;
          interrupt-after) kill -TERM "$BASHPID" ;;
          crash-after) kill -KILL "$BASHPID" ;;
        esac
        ;;
      uncertain)
        command rm -rf -- "${@: -2:1}"
        return 1
        ;;
      directory)
        mkdir -- "$dest"
        printf 'competing creator\n' >"$dest/sentinel"
        ;;
      symlink) ln -s -- "$TEST_ROOT/victim" "$dest" ;;
      hold)
        printf 'ready\n' >"$TEST_ROOT/publishing"
        sleep 1
        ;;
    esac
  fi
  if [[ ${1:-} == -T && ${@: -2:1} == */.image ]]; then
    image_moves=$(( ${image_moves:-0} + 1 ))
    [[ $image_moves != "${TEST_IMAGE_MOVE_FAILURE:-}" ]] || return 1
    [[ $image_moves != "${TEST_IMAGE_MOVE_SKIP:-}" ]] || return 0
  fi
  command mv "$@"
}
ln() {
  if [[ ${@: -2:1} == "$INSTALL_STATE_DIR/.theme-record.tmp" ]]; then
    case ${TEST_RESERVATION:-} in
      fail) return 1 ;;
      skip) return 0 ;;
      competing)
        printf '1\n' >"${@: -1}"
        return 1
        ;;
      symlink) command ln -s -- "$TEST_ROOT/victim" "${@: -1}" ;;
      directory) mkdir -- "${@: -1}" ;;
      fail-after | interrupt-after | crash-after)
        command ln "$@" || return
        case $TEST_RESERVATION in
          fail-after) return 1 ;;
          interrupt-after) kill -TERM "$BASHPID" ;;
          crash-after) kill -KILL "$BASHPID" ;;
        esac
        ;;
    esac
  fi
  command ln "$@"
}
base64() {
  printf 'decode\n' >>"$TEST_ROOT/decoder-calls"
  command base64 "$@"
}
du() {
  [[ ${TEST_QUOTA_FAILURE:-} != 1 ]] || return 1
  command du "$@"
}

emit_palette
read_requests
