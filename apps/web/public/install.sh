#!/bin/sh
# Install og, the OutreachGraph command line (npm: @profullstack/outreachgraph).
#
#   curl -fsSL https://outreachgraph.com/install.sh | sh
#
# Uses bun if present, otherwise npm (Node >= 20). When the global npm prefix
# is not writable it installs into ~/.local instead of asking for sudo.
# Re-running it upgrades to the latest version.
set -eu

PKG="@profullstack/outreachgraph"

say() { printf '%s\n' "$*"; }
die() { printf 'og install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

say "Installing og (OutreachGraph CLI)..."

if have bun; then
  # bun add -g writes into the nearest package.json above its global dir, so
  # give that dir its own before installing.
  BUN_GLOBAL="${BUN_INSTALL:-$HOME/.bun}/install/global"
  mkdir -p "$BUN_GLOBAL"
  [ -f "$BUN_GLOBAL/package.json" ] || printf '{}\n' > "$BUN_GLOBAL/package.json"
  bun add -g "$PKG@latest"
  BIN_DIR="${BUN_INSTALL:-$HOME/.bun}/bin"
elif have npm && have node; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 20 ] || die "Node >= 20 required (found $(node -v)). Upgrade Node or install bun: https://bun.sh"
  prefix=$(npm config get prefix)
  modules="$prefix/lib/node_modules"
  [ -d "$modules" ] || modules="$prefix/lib"
  if [ -w "$modules" ] && [ -w "$prefix/bin" ]; then
    npm install -g "$PKG@latest"
    BIN_DIR="$prefix/bin"
  else
    BIN_DIR="$HOME/.local/bin"
    say "npm prefix $prefix is not writable; installing into $HOME/.local"
    npm install -g --prefix "$HOME/.local" "$PKG@latest"
  fi
else
  die "needs bun (https://bun.sh) or Node >= 20 with npm (https://nodejs.org)"
fi

say ""
if have og; then
  say "$(og --version 2>/dev/null || echo og) installed."
else
  say "og installed to $BIN_DIR, which is not on your PATH. Add it:"
  say "  export PATH=\"$BIN_DIR:\$PATH\""
fi
say ""
say "Next: create an API key in OutreachGraph (Settings), then"
say "  export OUTREACHGRAPH_API_URL=https://outreachgraph.com"
say "  export OUTREACHGRAPH_API_TOKEN=og_live_..."
say "  og today    # the approval queue"
say "  og --help   # every command"
