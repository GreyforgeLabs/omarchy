#!/bin/bash

set -euo pipefail
source "$(dirname "$0")/base-test.sh"

run_node_test <<'JS'
const fs = require('fs')
const text = fs.readFileSync(path.join(root, 'default/omarchy/omarchy-menu.jsonc'), 'utf8')
const rows = Object.fromEntries(text.split('\n').filter(line => /^  "/.test(line)).map(line => {
  const object = JSON.parse('{' + line.trim().replace(/,$/, '') + '}')
  return Object.entries(object)[0]
}))
assert(rows['remove.ai'] && !rows['remove.ai'].action, 'selected AI removers have a reachable parent')
assert(rows['remove.dictation'] && !rows['remove.ai.dictation'], 'Dictation retains its baseline location')
const selected = {'t3-code': ['t3code-bin', '\ue908'], hermes: ['hermes-desktop', '\ue90a'], openclaw: ['openclaw', '\ue90c'], perplexity: ['perplexity', '\ue90b']}
for (const [id, [pkg, glyph]] of Object.entries(selected)) {
  const install = rows[`install.ai.${id}`], remove = rows[`remove.ai.${id}`]
  assert(install && remove, `${id} has install and remove entries`)
  assertEqual(install.when, `! omarchy-pkg-present ${pkg}`, `${id} preserves baseline install visibility`)
  assertEqual(remove.when, `omarchy-pkg-present ${pkg}`, `${id} removal follows package presence`)
  assertEqual(install.icon, glyph, `${id} install uses selected glyph`)
  assertEqual(remove.icon, glyph, `${id} remove uses selected glyph`)
  assertEqual(install.iconFont, 'omarchy', `${id} uses the packaged icon font`)
  assert(fs.existsSync(path.join(root, `bin/omarchy-remove-ai-${id}`)), `${id} remover exists`)
}
assertDeepEqual(Object.keys(rows).filter(k => k.startsWith('remove.ai.')).sort(), Object.keys(selected).map(k => `remove.ai.${k}`).sort(), 'removal prerequisite imports no unselected apps')
assertDeepEqual(Object.keys(rows).filter(k => k.startsWith('setup.default.agent.')).map(k => k.split('.').pop()).sort(), ['claude', 'codex', 'copilot', 'crush', 'gemini', 'grok', 'hermes', 'omp', 'openclaw', 'opencode', 'pi'], 'baseline agent choices survive with only Hermes and OpenClaw added')
assert(!fs.existsSync(path.join(root, 'bin/omarchy-theme-set-openclaw')), 'deferred OpenClaw theming is absent')
JS

test_tmp=$(mktemp -d)
trap 'rm -rf "$test_tmp"' EXIT
mkdir -p "$test_tmp/bin"
export TEST_CALLS="$test_tmp/calls"
cat >"$test_tmp/bin/mise" <<'SH'
#!/bin/bash
printf 'mise:%s\n' "$*" >>"$TEST_CALLS"
SH
cat >"$test_tmp/bin/omarchy-mise-install" <<'SH'
#!/bin/bash
printf 'stub:%s\n' "$*" >>"$TEST_CALLS"
SH
cat >"$test_tmp/bin/omarchy-install-hermes-cli" <<'SH'
#!/bin/bash
printf 'hermes:%s\n' "$*" >>"$TEST_CALLS"
exit 1
SH
chmod +x "$test_tmp/bin"/*
PATH="$test_tmp/bin:$PATH" bash -eE "$ROOT/install/user/mise.sh"
grep -qx 'mise:settings set upgrade.auto_prune false' "$TEST_CALLS" || fail "new users retain running mise versions"
grep -qx 'hermes:' "$TEST_CALLS" || fail "new users receive the Hermes CLI stub"
! grep -Eq 'stub:.*(ori|antigravity|hey-cli)' "$TEST_CALLS" || fail "mise setup avoids unrelated prerequisites"
pass "baseline mise setup tolerates an unfinished Hermes Desktop and disables pruning"
: >"$TEST_CALLS"
PATH="$test_tmp/bin:$PATH" bash -euo pipefail "$ROOT/migrations/1787215483.sh" >/dev/null
grep -qx 'mise:settings set upgrade.auto_prune false' "$TEST_CALLS" || fail "existing users retain running mise versions"
pass "mise migration applies the same no-pruning setting"
