# recordly-aur

Automation to keep the **recordly-bin** [AUR](https://aur.archlinux.org/packages/recordly-bin) package in sync with [webadderall/Recordly](https://github.com/webadderall/Recordly) releases.

The canonical PKGBUILD and packaging files live in the upstream repo under [`packaging/arch`](https://github.com/webadderall/Recordly/tree/main/packaging/arch). This repo only runs a scheduled (and manual) workflow that detects new upstream tags, updates `pkgver` and checksums, and pushes to `aur.archlinux.org`.

## Usage

- **Arch users**: install with `yay -S recordly-bin` (or any AUR helper). No need to use this repo.
- **Maintainers**:
  1. On the AUR, ensure you are the maintainer or a co-maintainer of [recordly-bin](https://aur.archlinux.org/packages/recordly-bin), and add your SSH **public** key in the package’s “SSH public key” field (so the AUR accepts pushes from that key).
  2. In this GitHub repo, add the **private** key as the `AUR_SSH_KEY` secret (Settings → Secrets and variables → Actions).
  3. Run the “Update AUR” workflow manually once to test, or wait for the cron (every 6 hours).

## License

MIT. See [LICENSE](LICENSE).
