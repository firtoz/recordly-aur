#!/usr/bin/env bun
/**
 * Update the recordly-bin AUR package from upstream webadderall/Recordly releases.
 * Templates (PKGBUILD, recordly.desktop) live in this repo root.
 *
 * Env: DRY_RUN=1 — diff only, no commit/push
 * Env: RECORDLY_TEMPLATE_DIR — PKGBUILD + recordly.desktop directory (default: script dir)
 * Env: RECORDLY_APPIMAGE_PATH — use this AppImage file instead of downloading
 * Env: UPSTREAM_REPO (default webadderall/Recordly), AUR_PKG (default recordly-bin)
 * Env: GITHUB_EVENT_NAME=schedule — soft-skip when AUR is under maintenance (cron)
 * Env: AUR_SOFT_FAIL_TRANSIENT=1|0 — force soft-skip / hard-fail on AUR outages
 *
 * Clone uses anonymous HTTPS; SSH is only required for push (GIT_SSH_COMMAND / IdentityFile).
 *
 * Run: bun update-aur.ts   |   bun update-aur.ts --dry-run   |   bun update-aur.ts --verify-only
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const scriptDir = import.meta.dir;
const dryRun =
	process.env.DRY_RUN === "1" ||
	process.env.DRY_RUN === "true" ||
	process.argv.includes("--dry-run");
const forceRefresh =
	process.env.FORCE === "1" ||
	process.env.FORCE === "true" ||
	process.argv.includes("--force");
const verifyOnly = process.argv.includes("--verify-only");

const templateDir = process.env.RECORDLY_TEMPLATE_DIR ?? scriptDir;
const upstreamRepo = process.env.UPSTREAM_REPO ?? "webadderall/Recordly";
const aurPkg = process.env.AUR_PKG ?? "recordly-bin";
const baseUrl = `https://api.github.com/repos/${upstreamRepo}`;
const rawBase = `https://raw.githubusercontent.com/${upstreamRepo}`;

/** Placeholder in template PKGBUILD; must not remain after patching. */
const PLACEHOLDER_SHA256 = "0000000000000000000000000000000000000000000000000000000000000000";

function die(msg: string): never {
	console.error(msg);
	process.exit(1);
}

/** Compute SHA-256 via system utility (streaming, no large memory spike). */
async function sha256File(path: string): Promise<string> {
	const proc = Bun.spawnSync({
		cmd: ["sha256sum", path],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		const err = proc.stderr.toString().trim();
		die(`sha256sum failed for ${path}: ${err || `exit ${proc.exitCode}`}`);
	}
	const out = proc.stdout.toString().trim();
	const hash = out.split(/\s+/)[0];
	if (!hash || !/^[0-9a-f]{64}$/.test(hash)) {
		die(`Invalid sha256sum output for ${path}: ${out}`);
	}
	return hash;
}

/** Save HTTP response body directly to file via Bun.write. */
async function downloadToFile(url: string, dest: string): Promise<void> {
	const res = await fetch(url);
	if (!res.ok) die(`Download failed ${res.status}: ${url}`);
	await mkdir(dirname(dest), { recursive: true });
	const written = await Bun.write(dest, res);
	if (written <= 0) die(`Downloaded empty file: ${url}`);
}

function run(
	cmd: string,
	args: string[],
	opts: { cwd: string; inherit?: boolean },
): { stdout: string } {
	const inherit = opts.inherit ?? false;
	const r = Bun.spawnSync({
		cmd: [cmd, ...args],
		cwd: opts.cwd,
		stdout: inherit ? "inherit" : "pipe",
		stderr: "inherit",
	});
	if (r.exitCode !== 0) {
		die(`Command failed (${r.exitCode}): ${cmd} ${args.join(" ")}`);
	}
	return { stdout: inherit ? "" : (r.stdout?.toString().trimEnd() ?? "") };
}

/** Run a command capturing stdout/stderr (still echoed), without exiting on failure. */
function runCapturing(
	cmd: string,
	args: string[],
	opts: { cwd: string },
): { exitCode: number; stdout: string; stderr: string } {
	const r = Bun.spawnSync({
		cmd: [cmd, ...args],
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = r.stdout?.toString() ?? "";
	const stderr = r.stderr?.toString() ?? "";
	if (stdout) process.stdout.write(stdout);
	if (stderr) process.stderr.write(stderr);
	return { exitCode: r.exitCode ?? 1, stdout, stderr };
}

/** AUR maintenance / brief network blips — safe to retry or soft-skip on cron. */
function isTransientAurFailure(output: string): boolean {
	return (
		/AUR is down due to maintenance/i.test(output) ||
		/Could not resolve hostname/i.test(output) ||
		/Connection timed out/i.test(output) ||
		/Connection reset/i.test(output) ||
		/Network is unreachable/i.test(output) ||
		/Temporary failure in name resolution/i.test(output) ||
		/unable to access/i.test(output)
	);
}

/**
 * Soft-skip cron/dry-run when AUR is in maintenance (or similar); hard-fail manual push.
 * Env AUR_SOFT_FAIL_TRANSIENT=0 forces hard fail; =1 forces soft skip.
 */
function shouldSoftFailTransient(): boolean {
	const override = process.env.AUR_SOFT_FAIL_TRANSIENT;
	if (override === "0" || override === "false") return false;
	if (override === "1" || override === "true") return true;
	return dryRun || process.env.GITHUB_EVENT_NAME === "schedule";
}

function softSkipOrDie(msg: string): never {
	if (shouldSoftFailTransient()) {
		console.warn(msg);
		console.warn("Soft-skipping this run (schedule/dry-run). Next cron or a manual push will retry.");
		process.exit(0);
	}
	die(msg);
}

async function cloneAurRepo(workDir: string, aurDir: string): Promise<void> {
	// Anonymous HTTPS clone for reads; SSH is only needed to push.
	const httpsUrl = `https://aur.archlinux.org/${aurPkg}.git`;
	const maxAttempts = 4;
	let lastOutput = "";
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		await rm(aurDir, { recursive: true, force: true });
		const result = runCapturing("git", ["clone", "--depth", "1", httpsUrl, aurDir], {
			cwd: workDir,
		});
		lastOutput = `${result.stdout}\n${result.stderr}`;
		if (result.exitCode === 0) return;

		const transient = isTransientAurFailure(lastOutput);
		if (!transient || attempt === maxAttempts) break;

		const delayMs = 5_000 * 2 ** (attempt - 1);
		console.warn(
			`AUR clone failed (attempt ${attempt}/${maxAttempts}, transient); retrying in ${delayMs / 1000}s...`,
		);
		await Bun.sleep(delayMs);
	}

	if (isTransientAurFailure(lastOutput)) {
		softSkipOrDie(
			`AUR clone failed after ${maxAttempts} attempts (likely maintenance/outage):\n${lastOutput.trim()}`,
		);
	}
	die(`Command failed: git clone --depth 1 ${httpsUrl} ${aurDir}`);
}

async function pushAurRepo(aurDir: string): Promise<void> {
	const sshUrl = `ssh://aur@aur.archlinux.org/${aurPkg}.git`;
	run("git", ["remote", "set-url", "origin", sshUrl], { cwd: aurDir, inherit: true });

	const maxAttempts = 4;
	let lastOutput = "";
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const result = runCapturing("git", ["push"], { cwd: aurDir });
		lastOutput = `${result.stdout}\n${result.stderr}`;
		if (result.exitCode === 0) return;

		const transient = isTransientAurFailure(lastOutput);
		if (!transient || attempt === maxAttempts) break;

		const delayMs = 5_000 * 2 ** (attempt - 1);
		console.warn(
			`AUR push failed (attempt ${attempt}/${maxAttempts}, transient); retrying in ${delayMs / 1000}s...`,
		);
		await Bun.sleep(delayMs);
	}

	if (isTransientAurFailure(lastOutput)) {
		softSkipOrDie(
			`AUR push failed after ${maxAttempts} attempts (likely maintenance/outage):\n${lastOutput.trim()}`,
		);
	}
	die(`Command failed: git push (${sshUrl})`);
}

async function fetchLatestTag(): Promise<string> {
	const token = process.env.GITHUB_TOKEN;
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "recordly-aur-update-script",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	const res = await fetch(`${baseUrl}/releases/latest`, { headers });
	if (!res.ok) die(`GitHub API error ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as { tag_name?: string };
	if (!data.tag_name) die("releases/latest: missing tag_name");
	return data.tag_name;
}

/** Fail fast if template layout or regex replacements drift. */
function validatePatchedPkgbuild(
	content: string,
	pkgver: string,
	appimageSha: string,
	licenseSha: string,
): void {
	const pv = /^pkgver=(.*)$/m.exec(content)?.[1]?.trim();
	if (pv !== pkgver) {
		die(`PKGBUILD: pkgver mismatch (expected ${pkgver}, got ${pv ?? "?"})`);
	}
	if (content.includes(PLACEHOLDER_SHA256)) {
		die(
			"PKGBUILD: placeholder sha256sums still present — fix template (tab-indented lines + comments) or regex in update-aur.ts",
		);
	}
	if (!content.includes(`'${appimageSha}'`)) {
		die("PKGBUILD: AppImage sha256 not found after patch");
	}
	if (!content.includes(`'${licenseSha}'`)) {
		die("PKGBUILD: LICENSE sha256 not found after patch");
	}
	if (!/^\t'[0-9a-f]{64}'.*# AppImage/m.test(content)) {
		die("PKGBUILD: missing tab-indented # AppImage sha256sums line (template format drift?)");
	}
	if (!/^\t'[0-9a-f]{64}'.*# Upstream AGPL LICENSE/m.test(content)) {
		die("PKGBUILD: missing tab-indented # Upstream AGPL LICENSE sha256sums line (template format drift?)");
	}
}

/**
 * No AUR clone: patch template PKGBUILD for the latest release and run
 * makepkg --verifysource so checksums are checked against a fresh download (CI / local gate).
 */
async function verifyPackagingOnly(): Promise<void> {
	const pkgbuildPath = join(templateDir, "PKGBUILD");
	const desktopPath = join(templateDir, "recordly.desktop");
	try {
		await readFile(pkgbuildPath);
		await readFile(desktopPath);
	} catch {
		die(`Missing PKGBUILD or recordly.desktop in TEMPLATE_DIR (${templateDir})`);
	}

	const latestTag = await fetchLatestTag();
	const pkgver = latestTag.startsWith("v") ? latestTag.slice(1) : latestTag;
	const workDir = await mkdtemp(join(tmpdir(), "recordly-verify-"));
	const pkgDir = join(workDir, "pkg");
	try {
		await mkdir(pkgDir, { recursive: true });
		await copyFile(pkgbuildPath, join(pkgDir, "PKGBUILD"));
		await copyFile(desktopPath, join(pkgDir, "recordly.desktop"));

		const licensePath = join(workDir, "LICENSE.md");
		await downloadToFile(`${rawBase}/${latestTag}/LICENSE.md`, licensePath);
		const licenseSha = await sha256File(licensePath);

		const appimagePath = join(workDir, "Recordly-linux-x64.AppImage");
		const localApp = process.env.RECORDLY_APPIMAGE_PATH;
		if (localApp) {
			try {
				await readFile(localApp);
			} catch {
				die(`RECORDLY_APPIMAGE_PATH is set but file does not exist: ${localApp}`);
			}
			await copyFile(localApp, appimagePath);
		} else {
			await downloadToFile(
				`https://github.com/${upstreamRepo}/releases/download/${latestTag}/Recordly-linux-x64.AppImage`,
				appimagePath,
			);
		}
		const appimageSha = await sha256File(appimagePath);

		let pkgbuild = await readFile(join(pkgDir, "PKGBUILD"), "utf-8");
		pkgbuild = pkgbuild.replace(/^pkgver=.*/m, `pkgver=${pkgver}`);
		pkgbuild = pkgbuild.replace(/^pkgrel=.*/m, "pkgrel=1");
		pkgbuild = pkgbuild.replace(
			/^\t'[0-9a-f]{64}'.*# AppImage.*/m,
			`\t'${appimageSha}' # AppImage v\${pkgver}`,
		);
		pkgbuild = pkgbuild.replace(
			/^\t'[0-9a-f]{64}'.*# Upstream AGPL LICENSE.*/m,
			`\t'${licenseSha}' # Upstream AGPL LICENSE`,
		);
		validatePatchedPkgbuild(pkgbuild, pkgver, appimageSha, licenseSha);
		await writeFile(join(pkgDir, "PKGBUILD"), pkgbuild);

		console.log(
			"Running makepkg --verifysource (re-download sources and match sha256sums)...",
		);
		run("makepkg", ["--verifysource", "-C"], { cwd: pkgDir, inherit: true });
		console.log(`verify-only OK for ${pkgver} (${latestTag}).`);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	if (verifyOnly) {
		await verifyPackagingOnly();
		return;
	}

	const pkgbuildPath = join(templateDir, "PKGBUILD");
	const desktopPath = join(templateDir, "recordly.desktop");
	const templateLicensePath = join(templateDir, "LICENSE");
	const templateHasPackagingLicense = await Bun.file(templateLicensePath).exists();
	try {
		await readFile(pkgbuildPath);
		await readFile(desktopPath);
	} catch {
		die(`Missing PKGBUILD or recordly.desktop in TEMPLATE_DIR (${templateDir})`);
	}

	const latestTag = await fetchLatestTag();
	const pkgver = latestTag.startsWith("v") ? latestTag.slice(1) : latestTag;

	const workDir = await mkdtemp(join(tmpdir(), "recordly-aur-"));
	const aurDir = join(workDir, "aur");
	try {
		await cloneAurRepo(workDir, aurDir);

		let currentVer = "";
		let currentRel = 1;
		try {
			const existing = await readFile(join(aurDir, "PKGBUILD"), "utf-8");
			const verMatch = /^pkgver=(.*)$/m.exec(existing);
			const relMatch = /^pkgrel=(.*)$/m.exec(existing);
			if (verMatch) currentVer = verMatch[1]?.trim() ?? "";
			const parsedRel = Number.parseInt(relMatch?.[1]?.trim() ?? "1", 10);
			if (Number.isFinite(parsedRel) && parsedRel > 0) currentRel = parsedRel;
		} catch {
			/* fresh or missing */
		}

		const sameVersion = currentVer === pkgver;
		if (sameVersion && !forceRefresh) {
			console.log(`AUR already at ${pkgver}. Nothing to do.`);
			return;
		}

		const nextRel = sameVersion ? currentRel + 1 : 1;
		console.log(
			`Updating ${aurPkg} from ${currentVer || "none"}-${currentRel} to ${pkgver}-${nextRel} (tag ${latestTag}).`,
		);

		await copyFile(pkgbuildPath, join(aurDir, "PKGBUILD"));
		await copyFile(desktopPath, join(aurDir, "recordly.desktop"));
		if (!templateHasPackagingLicense) {
			// Keep AUR checkout aligned with templates: drop legacy packaging LICENSE if removed locally.
			run("git", ["rm", "-f", "--ignore-unmatch", "LICENSE"], { cwd: aurDir, inherit: true });
		}

		const licensePath = join(workDir, "LICENSE.md");
		await downloadToFile(`${rawBase}/${latestTag}/LICENSE.md`, licensePath);
		const licenseSha = await sha256File(licensePath);

		const appimagePath = join(workDir, "Recordly-linux-x64.AppImage");
		const localApp = process.env.RECORDLY_APPIMAGE_PATH;
		if (localApp) {
			try {
				await readFile(localApp);
			} catch {
				die(`RECORDLY_APPIMAGE_PATH is set but file does not exist: ${localApp}`);
			}
			console.log(`Using local AppImage: ${localApp}`);
			await copyFile(localApp, appimagePath);
		} else {
			console.log("Downloading AppImage (may take a minute)...");
			await downloadToFile(
				`https://github.com/${upstreamRepo}/releases/download/${latestTag}/Recordly-linux-x64.AppImage`,
				appimagePath,
			);
		}

		console.log("Computing AppImage checksum...");
		const appimageSha = await sha256File(appimagePath);

		let pkgbuild = await readFile(join(aurDir, "PKGBUILD"), "utf-8");
		pkgbuild = pkgbuild.replace(/^pkgver=.*/m, `pkgver=${pkgver}`);
		pkgbuild = pkgbuild.replace(/^pkgrel=.*/m, `pkgrel=${nextRel}`);
		pkgbuild = pkgbuild.replace(
			/^\t'[0-9a-f]{64}'.*# AppImage.*/m,
			`\t'${appimageSha}' # AppImage v\${pkgver}`,
		);
		pkgbuild = pkgbuild.replace(
			/^\t'[0-9a-f]{64}'.*# Upstream AGPL LICENSE.*/m,
			`\t'${licenseSha}' # Upstream AGPL LICENSE`,
		);
		validatePatchedPkgbuild(pkgbuild, pkgver, appimageSha, licenseSha);
		await writeFile(join(aurDir, "PKGBUILD"), pkgbuild);

		console.log(
			"Verifying PKGBUILD: makepkg --verifysource (must match fresh download, not only script cache)...",
		);
		run("makepkg", ["--verifysource", "-C"], { cwd: aurDir, inherit: true });

		const { stdout: srcinfo } = run("makepkg", ["--printsrcinfo"], { cwd: aurDir });
		await writeFile(
			join(aurDir, ".SRCINFO"),
			srcinfo.endsWith("\n") ? srcinfo : `${srcinfo}\n`,
		);

		if (dryRun) {
			console.log("DRY RUN: showing diff that would be pushed to AUR:");
			run("git", ["--no-pager", "diff"], { cwd: aurDir, inherit: true });
			console.log("DRY RUN: no changes have been committed or pushed.");
			return;
		}

		// Never `git add -A`: makepkg --verifysource leaves large files under src/; AUR rejects >~488KiB blobs.
		run("git", ["add", "PKGBUILD", ".SRCINFO", "recordly.desktop"], {
			cwd: aurDir,
			inherit: true,
		});
		run("git", ["config", "user.email", "aur@firtoz.com"], { cwd: aurDir, inherit: true });
		run("git", ["config", "user.name", "recordly-aur"], { cwd: aurDir, inherit: true });
		run("git", ["commit", "-m", `Update to ${pkgver}`], { cwd: aurDir, inherit: true });
		await pushAurRepo(aurDir);

		console.log(`Pushed ${aurPkg} ${pkgver} to AUR.`);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

await main();
