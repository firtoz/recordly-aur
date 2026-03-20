#!/usr/bin/env bun
/**
 * Update the recordly-bin AUR package from upstream webadderall/Recordly releases.
 * Templates (PKGBUILD, recordly.desktop) live in this repo root.
 *
 * Env: DRY_RUN=1 — diff only, no commit/push
 * Env: RECORDLY_TEMPLATE_DIR — PKGBUILD + recordly.desktop directory (default: script dir)
 * Env: RECORDLY_APPIMAGE_PATH — use this AppImage file instead of downloading
 * Env: UPSTREAM_REPO (default webadderall/Recordly), AUR_PKG (default recordly-bin)
 *
 * Run: bun update-aur.ts   |   bun update-aur.ts --dry-run
 */
import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const scriptDir = import.meta.dir;
const dryRun =
	process.env.DRY_RUN === "1" ||
	process.env.DRY_RUN === "true" ||
	process.argv.includes("--dry-run");

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

/** Stream file to SHA-256 without loading whole file into memory. */
async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	const stream = createReadStream(path);
	return new Promise((resolve, reject) => {
		stream.on("data", (chunk: Buffer | string) => {
			hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		});
		stream.on("end", () => resolve(hash.digest("hex")));
		stream.on("error", reject);
	});
}

/** Stream HTTP response body to disk (for large assets e.g. AppImage). */
async function downloadToFile(url: string, dest: string): Promise<void> {
	const res = await fetch(url);
	if (!res.ok) die(`Download failed ${res.status}: ${url}`);
	const body = res.body;
	if (!body) die("No response body");
	await mkdir(dirname(dest), { recursive: true });

	const reader = body.getReader();
	const stream = createWriteStream(dest);
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value?.byteLength) {
				await new Promise<void>((resolve, reject) => {
					stream.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
				});
			}
		}
		await new Promise<void>((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));
	} finally {
		reader.releaseLock();
	}
}

function run(
	cmd: string,
	args: string[],
	opts: { cwd: string; inherit?: boolean },
): { stdout: string } {
	const inherit = opts.inherit ?? false;
	const r = spawnSync(cmd, args, {
		cwd: opts.cwd,
		stdio: inherit ? "inherit" : ["ignore", "pipe", "inherit"],
		encoding: "utf-8",
	});
	if (r.status !== 0) {
		die(`Command failed (${r.status}): ${cmd} ${args.join(" ")}`);
	}
	const out = r.stdout;
	return { stdout: typeof out === "string" ? out.trimEnd() : "" };
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
	if (!/^\t'[0-9a-f]{64}'.*# Upstream MIT LICENSE/m.test(content)) {
		die("PKGBUILD: missing tab-indented # Upstream MIT LICENSE sha256sums line (template format drift?)");
	}
}

async function main(): Promise<void> {
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

	const workDir = await mkdtemp(join(tmpdir(), "recordly-aur-"));
	const aurDir = join(workDir, "aur");
	try {
		run("git", ["clone", "--depth", "1", `ssh://aur@aur.archlinux.org/${aurPkg}.git`, aurDir], {
			cwd: workDir,
			inherit: true,
		});

		let currentVer = "";
		try {
			const existing = await readFile(join(aurDir, "PKGBUILD"), "utf-8");
			const m = /^pkgver=(.*)$/m.exec(existing);
			if (m) currentVer = m[1]?.trim() ?? "";
		} catch {
			/* fresh or missing */
		}

		if (currentVer === pkgver) {
			console.log(`AUR already at ${pkgver}. Nothing to do.`);
			return;
		}

		console.log(`Updating ${aurPkg} from ${currentVer || "none"} to ${pkgver} (tag ${latestTag}).`);

		await copyFile(pkgbuildPath, join(aurDir, "PKGBUILD"));
		await copyFile(desktopPath, join(aurDir, "recordly.desktop"));

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
		pkgbuild = pkgbuild.replace(
			/^\t'[0-9a-f]{64}'.*# AppImage.*/m,
			`\t'${appimageSha}' # AppImage v\${pkgver}`,
		);
		pkgbuild = pkgbuild.replace(
			/^\t'[0-9a-f]{64}'.*# Upstream MIT LICENSE.*/m,
			`\t'${licenseSha}' # Upstream MIT LICENSE`,
		);
		validatePatchedPkgbuild(pkgbuild, pkgver, appimageSha, licenseSha);
		await writeFile(join(aurDir, "PKGBUILD"), pkgbuild);

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

		run("git", ["add", "PKGBUILD", ".SRCINFO", "recordly.desktop"], {
			cwd: aurDir,
			inherit: true,
		});
		run("git", ["config", "user.email", "aur@firtoz.com"], { cwd: aurDir, inherit: true });
		run("git", ["config", "user.name", "recordly-aur"], { cwd: aurDir, inherit: true });
		run("git", ["commit", "-m", `Update to ${pkgver}`], { cwd: aurDir, inherit: true });
		run("git", ["push"], { cwd: aurDir, inherit: true });

		console.log(`Pushed ${aurPkg} ${pkgver} to AUR.`);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

await main();
