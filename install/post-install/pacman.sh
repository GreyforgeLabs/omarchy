# Configure pacman after package installation completes. Offline target package
# installs use the live ISO's offline pacman.conf until this final restore.
# Omarchy's channel configs describe an x86_64 machine, so aarch64 is restored
# to Arch Linux ARM's repositories instead; leaving the ISO's offline config in
# place there would end the install with no package sources at all.
if [[ $(uname -m) == aarch64 ]]; then
  # Still on the offline pacman.conf at this point, which is the only reachable
  # source during an offline install -- so take the keyring package now, before
  # the repositories below replace it. Arch's `base` pulls in archlinux-keyring
  # and nothing pulls in this one; the ISO carries it for exactly this step.
  omarchy-pkg-add archlinuxarm-keyring

  cp -f "$OMARCHY_PATH/default/pacman/pacman-aarch64.conf" /etc/pacman.conf
  cp -f "$OMARCHY_PATH/default/pacman/mirrorlist-aarch64" /etc/pacman.d/mirrorlist

  # Arch Linux ARM signs its repositories with its own key, and the install
  # leaves that key untrusted on the target: the first signed sync fails with
  # "Arch Linux ARM Build System <builder@archlinuxarm.org> is unknown trust".
  # --init is a no-op on an initialised keyring, and --populate without an
  # argument locally signs every keyring installed -- archlinux for the `any`
  # packages Arch builds, archlinuxarm for the rest.
  pacman-key --init
  pacman-key --populate
else
  cp -f "$OMARCHY_PATH/default/pacman/pacman-${OMARCHY_MIRROR:-stable}.conf" /etc/pacman.conf
  cp -f "$OMARCHY_PATH/default/pacman/mirrorlist-${OMARCHY_MIRROR:-stable}" /etc/pacman.d/mirrorlist
fi

# Wait for CUPS to own the file, the way omarchy-settings does, so pacman does
# not turn the override into a .pacnew during ISO package installation.
if [[ -f $OMARCHY_PATH/etc-overrides/cups-cups-files.conf && -f /etc/cups/cups-files.conf ]]; then
  install -m 0640 -o root -g cups "$OMARCHY_PATH/etc-overrides/cups-cups-files.conf" /etc/cups/cups-files.conf
  rm -f /etc/cups/cups-files.conf.pacnew
fi

source "$OMARCHY_INSTALL/hardware/pacman.sh"
