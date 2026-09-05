echo "Hand Hermes Desktop the Omarchy theme as a skin"

# Only the app Omarchy installed under Install > AI follows the theme by itself.
# A Hermes the user set up some other way keeps whatever skin they chose.
omarchy-pkg-present hermes-desktop || exit 0

# Renders the skin for a theme applied before the template existed, publishes
# it, and names it in Hermes' config the same way a fresh install does: through
# Hermes itself, and only when Hermes is still on its default skin, so a skin
# the user chose stays. A Hermes that is not ready is told and skipped; a Hermes
# that refuses the write is cosmetic and must not hold up later migrations.
omarchy-theme-set-hermes --activate || true
