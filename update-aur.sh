#!/usr/bin/env bash
# Update the recordly-bin AUR package from upstream webadderall/Recordly.
# Requires: curl, jq, git, sha256sum, makepkg (Arch).
# DRY-RUN: set DRY_RUN=1 or pass --dry-run to skip commit/push and just show diff.
# Local source: set RECORDLY_SOURCE_DIR to your Recordly repo root (e.g. your fork clone)
#   to use packaging/arch and LICENSE from there instead of the release tag (e.g. when
#   upstream has no packaging/arch in that tag yet).
# Local AppImage: set RECORDLY_APPIMAGE_PATH to a local AppImage file to use its
#   checksum instead of downloading from the release.
set -e

DRY_RUN="${DRY_RUN:-0}"
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

UPSTREAM_REPO="${UPSTREAM_REPO:-webadderall/Recordly}"
AUR_PKG="${AUR_PKG:-recordly-bin}"
BASE_URL="https://api.github.com/repos/${UPSTREAM_REPO}"
RAW_BASE="https://raw.githubusercontent.com/${UPSTREAM_REPO}"

LATEST_TAG=$(curl -sS "${BASE_URL}/releases/latest" | jq -r .tag_name)
PKGVER="${LATEST_TAG#v}"

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

git clone --depth 1 "ssh://aur@aur.archlinux.org/${AUR_PKG}.git" "$WORKDIR/aur"

CURRENT_VER=$(grep -m1 '^pkgver=' "$WORKDIR/aur/PKGBUILD" 2>/dev/null | cut -d= -f2 || true)
if [ "$CURRENT_VER" = "$PKGVER" ]; then
  echo "AUR already at ${PKGVER}. Nothing to do."
  exit 0
fi

echo "Updating ${AUR_PKG} from ${CURRENT_VER:-none} to ${PKGVER} (tag ${LATEST_TAG})."

# Validate RECORDLY_SOURCE_DIR *before* doing any heavy network work, so we fail fast.
if [ -n "${RECORDLY_SOURCE_DIR:-}" ]; then
  if [ ! -d "$RECORDLY_SOURCE_DIR" ]; then
    echo "RECORDLY_SOURCE_DIR is set but not a directory: $RECORDLY_SOURCE_DIR" >&2
    exit 1
  fi
  SRC_ARCH="$RECORDLY_SOURCE_DIR/packaging/arch"
  if [ ! -f "$SRC_ARCH/PKGBUILD" ] || [ ! -f "$SRC_ARCH/recordly.desktop" ]; then
    echo "RECORDLY_SOURCE_DIR must contain packaging/arch/PKGBUILD and packaging/arch/recordly.desktop" >&2
    exit 1
  fi
  echo "Using local source: $RECORDLY_SOURCE_DIR"
  if [ -f "$RECORDLY_SOURCE_DIR/LICENSE" ]; then
    cp "$RECORDLY_SOURCE_DIR/LICENSE" "$WORKDIR/LICENSE"
  else
    # Fallback: fetch LICENSE from the release tag if not present locally
    curl -sSL -o "$WORKDIR/LICENSE" "${RAW_BASE}/${LATEST_TAG}/LICENSE"
  fi
  cp "$SRC_ARCH/PKGBUILD" "$WORKDIR/aur/PKGBUILD"
  cp "$SRC_ARCH/recordly.desktop" "$WORKDIR/aur/recordly.desktop"
else
  curl -sSL -o "$WORKDIR/LICENSE" "${RAW_BASE}/${LATEST_TAG}/LICENSE"
  curl -sSL -o "$WORKDIR/aur/PKGBUILD" "${RAW_BASE}/${LATEST_TAG}/packaging/arch/PKGBUILD"
  if head -1 "$WORKDIR/aur/PKGBUILD" | grep -qE '<!DOCTYPE|<html'; then
    echo "packaging/arch/PKGBUILD not found for tag ${LATEST_TAG} (got 404). Use RECORDLY_SOURCE_DIR pointing to your Recordly repo (e.g. your fork) to use local packaging files." >&2
    exit 1
  fi
  curl -sSL -o "$WORKDIR/aur/recordly.desktop" "${RAW_BASE}/${LATEST_TAG}/packaging/arch/recordly.desktop"
fi
LICENSE_SHA=$(sha256sum "$WORKDIR/LICENSE" | cut -d' ' -f1)

if [ -n "${RECORDLY_APPIMAGE_PATH:-}" ]; then
  if [ ! -f "$RECORDLY_APPIMAGE_PATH" ]; then
    echo "RECORDLY_APPIMAGE_PATH is set but file does not exist: $RECORDLY_APPIMAGE_PATH" >&2
    exit 1
  fi
  echo "Using local AppImage: $RECORDLY_APPIMAGE_PATH"
  cp "$RECORDLY_APPIMAGE_PATH" "$WORKDIR/Recordly-linux-x64.AppImage"
else
  echo "Downloading AppImage (may take a minute)..."
  curl -L -o "$WORKDIR/Recordly-linux-x64.AppImage" \
    "https://github.com/${UPSTREAM_REPO}/releases/download/${LATEST_TAG}/Recordly-linux-x64.AppImage"
fi
echo "Computing AppImage checksum..."
APPIMAGE_SHA=$(sha256sum "$WORKDIR/Recordly-linux-x64.AppImage" | cut -d' ' -f1)

sed -i "s/^pkgver=.*/pkgver=${PKGVER}/" "$WORKDIR/aur/PKGBUILD"
sed -i "s/^  '[0-9a-f]\{64\}'.*# AppImage.*/  '${APPIMAGE_SHA}'  # AppImage v\${pkgver}/" "$WORKDIR/aur/PKGBUILD"
sed -i "s/^  '[0-9a-f]\{64\}'.*# Upstream MIT.*/  '${LICENSE_SHA}'  # Upstream MIT LICENSE/" "$WORKDIR/aur/PKGBUILD"

cd "$WORKDIR/aur"
makepkg --printsrcinfo > .SRCINFO

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN: showing diff that would be pushed to AUR:"
  git --no-pager diff
  echo "DRY RUN: no changes have been committed or pushed."
  exit 0
fi

git add PKGBUILD .SRCINFO recordly.desktop
git config user.email "aur@firtoz.com"
git config user.name "recordly-aur"
git commit -m "Update to ${PKGVER}"
git push

echo "Pushed ${AUR_PKG} ${PKGVER} to AUR."
