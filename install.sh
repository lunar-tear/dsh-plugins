#!/usr/bin/env bash
#
# Install (or remove) these dsh plugins for a profile.
#
# Default mode copies each plugin into $DSH_HOME/plugins/<package> and writes a
# managed block of profile rows into $DSH_HOME/profiles/<profile>/cordis.patch.yml.
# The web profile applies user patch edits live, so a running `dsh web` picks the
# rows up within a second — only the browser half needs a page reload.
#
# The patch file is always replaced atomically (write a sibling temp file, then
# rename). The live watcher re-reads that file on every change, so a partial
# write would otherwise be observed as an invalid patch and rejected.
#
#   ./install.sh                 # copy, install, register
#   ./install.sh --link          # symlink instead of copy (edit the repo copy live)
#   ./install.sh --uninstall     # remove the plugin dirs and the managed rows
#   ./install.sh --profile web   # target another profile (default: web)
#
set -euo pipefail

DIRS=(image-paths markdown-preview)
PACKAGES=(dsh-image-paths dsh-markdown-preview)
IDS=(image-paths markdown-preview)

MODE=install
LINK=0
PROFILE=web
BEGIN_MARK='# >>> dsh-plugins (managed by install.sh) >>>'
END_MARK='# <<< dsh-plugins (managed by install.sh) <<<'
HEADER='# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).'

while [ $# -gt 0 ]; do
  case "$1" in
    --link) LINK=1 ;;
    --uninstall|--remove) MODE=uninstall ;;
    --profile) shift; PROFILE="${1:?--profile needs a name}" ;;
    -h|--help) sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_HOME="$DSH_HOME/plugins"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "no such profile directory: $PROFILE_DIR" >&2
  echo "start the harness once ('dsh web' or 'dsh --profile $PROFILE') to create it" >&2
  exit 1
fi

# One plugin's version, used as the row URL's cache key.
package_version() {
  local manifest="$REPO_DIR/$1/package.json"
  local version
  version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -1)"
  if [ -z "$version" ]; then
    echo "cannot read a version from $manifest" >&2
    exit 1
  fi
  printf '%s' "$version"
}

# The patch without any block this script previously wrote, so a re-install is
# idempotent and an uninstall keeps whatever else the user has in the layer.
patch_without_managed_block() {
  [ -f "$PATCH_FILE" ] || return 0
  awk -v begin="$BEGIN_MARK" -v end="$END_MARK" '
    index($0, begin) == 1 { skipping = 1; next }
    index($0, end) == 1 { skipping = 0; next }
    !skipping { print }
  ' "$PATCH_FILE"
}

# Whether a patch body carries any YAML of its own (comments and `[]` do not).
has_own_entries() {
  local content
  content="$(printf '%s\n' "$1" | grep -v '^[[:space:]]*#' | tr -d '[:space:]')"
  [ -n "$content" ] && [ "$content" != "[]" ]
}

# Replace the patch atomically with one complete, valid state.
replace_patch() {
  local tmp="$PATCH_FILE.new.$$"
  printf '%s\n' "$1" > "$tmp"
  mv "$tmp" "$PATCH_FILE"
}

install_rows() {
  local body next
  body="$(patch_without_managed_block)"
  if has_own_entries "$body"; then
    next="$body"
  else
    next="$HEADER"
  fi
  next="$next

$BEGIN_MARK"
  for index in "${!IDS[@]}"; do
    # The ?v= query is the host half's cache key: Node caches ES modules per
    # URL, so a changed index.js only loads when the URL changes. Taking it from
    # the package version makes "bump the version, re-install" the whole ritual.
    local version
    version="$(package_version "${DIRS[$index]}")"
    next="$next
- insert:
    - id: ${IDS[$index]}
      name: 'file://$PLUGIN_HOME/${PACKAGES[$index]}/index.js?v=$version'"
  done
  next="$next
$END_MARK"
  replace_patch "$next"
}

uninstall_rows() {
  local body next
  body="$(patch_without_managed_block)"
  if has_own_entries "$body"; then
    next="$body"
  else
    # An emptied layer becomes the documented `[]`; comments alone fail boot.
    next="$HEADER

[]"
  fi
  replace_patch "$next"
}

if [ -f "$PATCH_FILE" ]; then
  cp "$PATCH_FILE" "$PATCH_FILE.bak-$(date +%Y%m%d-%H%M%S)"
fi

if [ "$MODE" = uninstall ]; then
  for index in "${!IDS[@]}"; do
    target="$PLUGIN_HOME/${PACKAGES[$index]}"
    if [ -L "$target" ] || [ -d "$target" ]; then
      rm -rf "$target"
      echo "removed $target"
    fi
  done
  uninstall_rows
  echo "removed the managed rows from $PATCH_FILE"
  echo "reload the GUI page to drop the browser halves."
  exit 0
fi

mkdir -p "$PLUGIN_HOME"
for index in "${!DIRS[@]}"; do
  source="$REPO_DIR/${DIRS[$index]}"
  target="$PLUGIN_HOME/${PACKAGES[$index]}"
  [ -f "$source/index.js" ] || { echo "missing plugin source: $source" >&2; exit 1; }
  rm -rf "$target"
  if [ "$LINK" = 1 ]; then
    ln -s "$source" "$target"
    echo "linked $target -> $source"
  else
    cp -r "$source" "$target"
    echo "installed $target"
  fi
done

# The diagram engine is a documentation dependency of the harness, not something
# this repository ships: copy whatever the host has next to the installed plugin
# so the preview can render mermaid without reaching the network. A host without
# one is fine — diagrams then render as the code blocks they are.
vendor_mermaid() {
  local target="$PLUGIN_HOME/dsh-markdown-preview/vendor"
  local candidate
  local dsh_bin
  dsh_bin="$(command -v dsh 2>/dev/null || true)"
  for candidate in \
    "$DSH_HOME/profiles/node_modules/mermaid/dist/mermaid.min.js" \
    "$HOME"/Workspace/*/node_modules/.pnpm/mermaid@*/node_modules/mermaid/dist/mermaid.min.js \
    "$HOME"/*/node_modules/.pnpm/mermaid@*/node_modules/mermaid/dist/mermaid.min.js \
    ${dsh_bin:+"$(dirname "$(readlink -f "$dsh_bin")")"/../node_modules/.pnpm/mermaid@*/node_modules/mermaid/dist/mermaid.min.js}; do
    if [ -f "$candidate" ]; then
      mkdir -p "$target"
      cp "$candidate" "$target/mermaid.min.js"
      echo "vendored the diagram engine from $candidate"
      return 0
    fi
  done
  echo "no mermaid build found on this host: the preview renders diagrams as code blocks"
  return 0
}

install_rows
vendor_mermaid
echo "registered the rows in $PATCH_FILE"
echo "(the running dsh web applies them live; reload the GUI page to load the browser halves)"
