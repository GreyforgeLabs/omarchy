echo "Disable unrestricted Kitty remote control"

kitty_config="$HOME/.config/kitty/kitty.conf"

if [[ -f $kitty_config ]] && grep -qE '^[[:space:]]*allow_remote_control[[:space:]]+yes[[:space:]]*$' "$kitty_config"; then
  sed -i -E 's/^([[:space:]]*allow_remote_control[[:space:]]+)yes([[:space:]]*)$/\1no\2/' "$kitty_config"

  # Kitty reads allow_remote_control only at startup; reloading is insufficient.
  echo "Close and reopen all Kitty windows to disable remote control in running terminals."
fi
