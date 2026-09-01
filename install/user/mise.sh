omarchy-mise-install codex
omarchy-mise-install claude
omarchy-mise-install crush
omarchy-mise-install gemini
omarchy-mise-install gh
omarchy-mise-install copilot
omarchy-mise-install opencode
omarchy-mise-install npm:playwright playwright
omarchy-mise-install pi
omarchy-mise-install github:can1357/oh-my-pi omp
omarchy-mise-install npm:@xai-official/grok grok
omarchy-mise-install npm:@kitlangton/ghui ghui
omarchy-mise-install aqua:modem-dev/hunk hunk
# Every line above writes a stub and cannot fail. This one can: it exits
# non-zero when Hermes Desktop owns Hermes but has not finished setting it up,
# and this leaf is sourced under `bash -eE`, so that would abort the rest of
# omarchy-provision-user -- the default browser, the mailto handler and the
# finalize-user marker all come after it.
omarchy-install-hermes-cli || true
