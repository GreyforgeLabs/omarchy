echo "Expose the Elgato Cam Link 4K as a 16:9 virtual camera"

if omarchy-hw-elgato-camlink-4k; then
  source "$OMARCHY_PATH/install/hardware/fix-elgato-camlink-4k.sh"

  sudo systemctl daemon-reload
  sudo udevadm control --reload

  # Re-run the rules for the Cam Link that is plugged in now so it gets hidden
  # and relayed right away. The user ACL from its first plug survives a
  # re-trigger, so drop it here; a replug or reboot does the same on its own.
  sudo udevadm trigger --action=add --subsystem-match=video4linux
  sudo udevadm settle
  [[ -e /dev/camlink4k ]] && sudo setfacl -b /dev/camlink4k
fi
