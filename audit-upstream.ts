#!/usr/bin/env bun
/**
 * Compare published AUR recordly-bin sha256sums to what GitHub serves today.
 * Fetches PKGBUILD from AUR cgit, re-downloads AppImage + LICENSE from upstream URLs,
 * prints GitHub release asset metadata (e.g. updated_at) for the AppImage.
 *
 * Env: UPSTREAM_REPO (default webadderall/Recordly), AUR_PKG (default recordly-bin), GITHUB_TOKEN (optional, rate limits)
 * Env: GITHUB_STEP_SUMMARY — when set (GitHub Actions), appends a Markdown section to the job summary.
 * Run: bun run audit-upstream.ts
 *
 * Exit: 0 if both hashes match live upstream; 1 if mismatch or error.
 */
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const upstreamRepo = process.env.UPSTREAM_REPO ?? "webadderall/Recordly";
const aurPkg = process.env.AUR_PKG ?? "recordly-bin";
const baseUrl = `https://api.github.com/repos/${upstreamRepo}`;
const rawBase = `https://raw.githubusercontent.com/${upstreamRepo}`;
const aurPkgbuildUrl = `https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h=${encodeURIComponent(aurPkg)}`;

function die(msg: string): never {
	console.error(msg);
	process.exit(1);
}

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

async function downloadToFile(url: string, dest: string): Promise<void> {
	const res = await fetch(url);
	if (!res.ok) die(`Download failed ${res.status}: ${url}`);
	await mkdir(dirname(dest), { recursive: true });
	const written = await Bun.write(dest, res);
	if (written <= 0) die(`Downloaded empty file: ${url}`);
}

async function writeJobSummary(markdown: string): Promise<void> {
	const path = process.env.GITHUB_STEP_SUMMARY;
	if (!path) return;
	await appendFile(path, `${markdown}\n`, "utf8");
}

function githubHeaders(): Record<string, string> {
	const token = process.env.GITHUB_TOKEN;
	const h: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "recordly-aur-audit-upstream",
	};
	if (token) h.Authorization = `Bearer ${token}`;
	return h;
}

function parsePublishedPkgbuild(text: string): {
	pkgver: string;
	pkgrel: string;
	appimageSha: string;
	licenseSha: string;
} {
	const pkgver = /^pkgver=(.+)$/m.exec(text)?.[1]?.trim().replace(/^["']|["']$/g, "");
	const pkgrel = /^pkgrel=(.+)$/m.exec(text)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "?";
	if (!pkgver) die("Could not parse pkgver from AUR PKGBUILD");
	const appM = /^\t'([0-9a-f]{64})'.*# AppImage/m.exec(text);
	const licM = /^\t'([0-9a-f]{64})'.*# Upstream MIT LICENSE/m.exec(text);
	if (!appM) die("Could not parse AppImage sha256 line (# AppImage) from AUR PKGBUILD");
	if (!licM) {
		die(
			"Could not parse LICENSE sha256 line (# Upstream MIT LICENSE) from AUR PKGBUILD",
		);
	}
	return {
		pkgver,
		pkgrel,
		appimageSha: appM[1]!,
		licenseSha: licM[1]!,
	};
}

async function main(): Promise<void> {
	console.log(`Fetching published PKGBUILD: ${aurPkgbuildUrl}`);
	const aurRes = await fetch(aurPkgbuildUrl, { headers: { "User-Agent": "recordly-aur-audit" } });
	if (!aurRes.ok) die(`AUR PKGBUILD fetch failed ${aurRes.status}`);
	const pkgbuildText = await aurRes.text();
	const { pkgver, pkgrel, appimageSha: aurApp, licenseSha: aurLic } =
		parsePublishedPkgbuild(pkgbuildText);

	const tag = pkgver.startsWith("v") ? pkgver : `v${pkgver}`;
	const appimageUrl = `https://github.com/${upstreamRepo}/releases/download/${tag}/Recordly-linux-x64.AppImage`;
	const licenseUrl = `${rawBase}/${tag}/LICENSE.md`;

	console.log(`AUR ${aurPkg}: pkgver=${pkgver} pkgrel=${pkgrel}`);
	console.log("");

	const ghRel = await fetch(`${baseUrl}/releases/tags/${encodeURIComponent(tag)}`, {
		headers: githubHeaders(),
	});
	if (!ghRel.ok) {
		const errBody = await ghRel.text();
		console.error(`GitHub release API ${ghRel.status} for tag ${tag}: ${errBody}`);
		await writeJobSummary(
			[
				"## AUR vs upstream (checksum audit)",
				"",
				"**GitHub release API** failed.",
				"",
				`| | |`,
				`|---|---|`,
				`| Tag | \`${tag}\` |`,
				`| HTTP | ${ghRel.status} |`,
				"",
				`<pre>${errBody.slice(0, 4000).replace(/</g, "&lt;")}</pre>`,
			].join("\n"),
		);
		process.exit(1);
	}
	const rel = (await ghRel.json()) as {
		published_at?: string;
		assets?: { name: string; updated_at?: string; size?: number; browser_download_url?: string }[];
	};
	const appAsset = rel.assets?.find((a) => a.name === "Recordly-linux-x64.AppImage");
	if (appAsset) {
		console.log("GitHub release asset (AppImage):");
		console.log(`  name:       ${appAsset.name}`);
		console.log(`  updated_at: ${appAsset.updated_at ?? "?"}`);
		console.log(`  size:       ${appAsset.size ?? "?"}`);
		console.log(`  url:        ${appAsset.browser_download_url ?? appimageUrl}`);
	} else {
		console.log("GitHub release: no asset named Recordly-linux-x64.AppImage in API response");
		console.log(`  expected URL: ${appimageUrl}`);
	}
	if (rel.published_at) console.log(`  release published_at: ${rel.published_at}`);
	console.log("");

	const workDir = await mkdtemp(join(tmpdir(), "recordly-audit-"));
	try {
		const appPath = join(workDir, "Recordly-linux-x64.AppImage");
		const licPath = join(workDir, "LICENSE.md");
		console.log("Downloading upstream files (this may take a while for the AppImage)...");
		await downloadToFile(appimageUrl, appPath);
		await downloadToFile(licenseUrl, licPath);
		const liveApp = await sha256File(appPath);
		const liveLic = await sha256File(licPath);

		const appOk = liveApp === aurApp;
		const licOk = liveLic === aurLic;

		console.log("");
		console.log("SHA-256 comparison (AUR PKGBUILD vs live download today):");
		console.log(
			`  AppImage  ${appOk ? "MATCH" : "MISMATCH"}\n    AUR:  ${aurApp}\n    live: ${liveApp}`,
		);
		console.log(
			`  LICENSE   ${licOk ? "MATCH" : "MISMATCH"}\n    AUR:  ${aurLic}\n    live: ${liveLic}`,
		);
		console.log("");

		const appImageLink = appAsset?.browser_download_url ?? appimageUrl;
		const assetRows = appAsset
			? [
					`| AppImage \`updated_at\` | \`${appAsset.updated_at ?? "?"}\` |`,
					`| AppImage size | ${appAsset.size ?? "?"} |`,
					`| AppImage URL | [GitHub release asset](${appImageLink}) |`,
				]
			: [`| AppImage URL (expected) | [constructed URL](${appimageUrl}) |`];
		const relRow = rel.published_at
			? [`| Release \`published_at\` | \`${rel.published_at}\` |`]
			: [];

		const summaryHead = [
			"## AUR vs upstream (checksum audit)",
			"",
			`Comparing published [\`${aurPkg}\`](${aurPkgbuildUrl}) on AUR to live upstream **${upstreamRepo}** tag **\`${tag}\`**.`,
			"",
			`| | |`,
			`|---|---|`,
			`| AUR pkgver | \`${pkgver}\` |`,
			`| AUR pkgrel | \`${pkgrel}\` |`,
			...relRow,
			...assetRows,
			"",
		];

		const hashSection = [
			"### SHA-256 (AUR PKGBUILD vs download today)",
			"",
			`| Artifact | Result | AUR | Live |`,
			`|----------|--------|-----|------|`,
			`| AppImage | **${appOk ? "MATCH ✅" : "MISMATCH ❌"}** | \`${aurApp}\` | \`${liveApp}\` |`,
			`| LICENSE | **${licOk ? "MATCH ✅" : "MISMATCH ❌"}** | \`${aurLic}\` | \`${liveLic}\` |`,
			"",
		];

		if (appOk && licOk) {
			console.log("Upstream bytes match the published AUR checksums.");
			await writeJobSummary(
				[
					...summaryHead,
					"**Outcome:** upstream bytes match the published AUR `sha256sums`.",
					"",
					...hashSection,
				].join("\n"),
			);
			return;
		}

		console.error(
			"If you see MISMATCH, upstream changed (or replaced) a file for this pkgver after the AUR revision was published. Bump pkgrel with fresh sums (e.g. FORCE=1 bun run update-aur.ts).",
		);
		await writeJobSummary(
			[
				...summaryHead,
				"**Outcome:** **MISMATCH** — published AUR checksums do not match what GitHub serves now. Refresh the package (e.g. `FORCE=1 bun run update-aur.ts`).",
				"",
				...hashSection,
			].join("\n"),
		);
		process.exit(1);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

await main();
