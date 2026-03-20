# recordly-aur

**Canonical** home for Arch packaging for [Recordly](https://github.com/webadderall/Recordly): `PKGBUILD`, `recordly.desktop`, automation, and pushes to the [recordly-bin](https://aur.archlinux.org/packages/recordly-bin) AUR package.

The main Recordly repo documents install for Arch users only (see its README); it does not ship PKGBUILDs or per-release packaging updates.

## Usage

- **Arch users**: `yay -S recordly-bin` (or any AUR helper). You do not need this repo.
- **Maintainers**:
  1. On the AUR, be maintainer or co-maintainer of [recordly-bin](https://aur.archlinux.org/packages/recordly-bin); add your SSH **public** key in the package’s “SSH public key” field.
  2. In this GitHub repo, add the **private** key as the `AUR_SSH_KEY` secret (Settings → Secrets → Actions). PEM text is fine; you can also store `base64 -w0 < privatekey` if multiline secrets misbehave in CI.
  3. Run “Update AUR” manually once to test, or rely on the cron schedule (every 6 hours).

[`update-aur.ts`](./update-aur.ts) (run with **[Bun](https://bun.sh/)**: `bun run update-aur.ts`) picks the latest upstream GitHub release tag, copies `PKGBUILD` + `recordly.desktop` from **this** repo into the AUR checkout, recomputes checksums for the release AppImage and `LICENSE.md`, regenerates `.SRCINFO`, commits, and pushes. Use `DRY_RUN=1 bun run update-aur.ts` or `bun run update-aur:dry` for a diff-only run.

Templates live in the repo root. Edit them here when packaging logic or the `.desktop` file changes; do not rely on files under `packaging/` in the main Recordly tree.

## Local package from your own AppImage build

Use this when you build Recordly from source and want a pacman package alongside the AUR release:

1. In a Recordly clone: `npm install` then `npm run build:linux` — produces `release/Recordly.AppImage`.
2. Copy that file here: `cp /path/to/Recordly/release/Recordly.AppImage ./Recordly-linux-x64.AppImage`
3. From this repo directory: `makepkg -p PKGBUILD.from-source -si`

This installs `recordly-bin-local` and a “Recordly (Local)” menu entry. Uninstall: `sudo pacman -R recordly-bin-local`.

## CI: safety and forks

- **Host keys:** The workflow runs `ssh-keyscan` for `aur.archlinux.org` and uses `StrictHostKeyChecking yes` with that `known_hosts` file (no blind `accept-new` / `no`).
- **Secret:** On push runs, the workflow checks that `AUR_SSH_KEY` is non-empty and looks like a PEM private key (only the first line is inspected in logs).
- **PKGBUILD patch:** `update-aur.ts` asserts after editing that placeholder checksums are gone, `pkgver` matches, both hashes appear, and the tab-indented `# AppImage` / `# Upstream MIT LICENSE` lines still match the expected shape.
- **Downloads:** Release assets are streamed to disk; SHA-256 is computed with a file stream (large AppImages are not held fully in RAM).
- **Forks:** The “Update AUR” job runs only when `github.repository == 'firtoz/recordly-aur'`, so forks do not run a failing cron against missing secrets. Rename the repo literal in [`.github/workflows/update-aur.yml`](./.github/workflows/update-aur.yml) if you move the canonical copy.

## License

MIT. See Recordly upstream [LICENSE.md](https://github.com/webadderall/Recordly/blob/main/LICENSE.md).
