#!/usr/bin/env bun
/**
 * Fail if published AUR pkgver is greater than GitHub releases/latest tag.
 * That usually means upstream removed or re-pointed "Latest" (e.g. pulled release);
 * AppImage URLs for the old pkgver may 404 until update-aur.ts runs.
 *
 * Env: UPSTREAM_REPO (default webadderall/Recordly), AUR_PKG (default recordly-bin),
 *      GITHUB_TOKEN (optional, rate limits), GITHUB_STEP_SUMMARY (GitHub Actions)
 * Run: bun run check-aur-vs-latest.ts
 *
 * Exit: 0 if AUR pkgver <= upstream latest; 1 if AUR is ahead or on error.
 */
import { appendFile } from "node:fs/promises";

const upstreamRepo = process.env.UPSTREAM_REPO ?? "webadderall/Recordly";
const aurPkg = process.env.AUR_PKG ?? "recordly-bin";
const baseUrl = `https://api.github.com/repos/${upstreamRepo}`;
const aurPkgbuildUrl = `https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h=${encodeURIComponent(aurPkg)}`;

function die(msg: string): never {
	console.error(msg);
	process.exit(1);
}

function githubHeaders(): Record<string, string> {
	const token = process.env.GITHUB_TOKEN;
	const h: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "recordly-aur-check-aur-vs-latest",
	};
	if (token) h.Authorization = `Bearer ${token}`;
	return h;
}

/** Strip leading v/V from tag or version string. */
function normalizeVersion(s: string): string {
	const t = s.trim();
	return t.startsWith("v") || t.startsWith("V") ? t.slice(1) : t;
}

/**
 * Arch-style version compare: negative if a<b, 0 if equal, positive if a>b.
 * Uses `vercmp` when available (Arch); dotted numeric fallback elsewhere.
 */
function comparePkgVersions(a: string, b: string): number {
	const proc = Bun.spawnSync({
		cmd: ["vercmp", normalizeVersion(a), normalizeVersion(b)],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode === 0) {
		const out = proc.stdout.toString().trim();
		const n = Number.parseInt(out, 10);
		if (Number.isFinite(n)) return n;
	}
	return compareDotted(normalizeVersion(a), normalizeVersion(b));
}

function compareDotted(a: string, b: string): number {
	const pa = a.split(/[._-]+/).map((x) => Number.parseInt(x, 10));
	const pb = b.split(/[._-]+/).map((x) => Number.parseInt(x, 10));
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const na = Number.isFinite(pa[i]!) ? pa[i]! : 0;
		const nb = Number.isFinite(pb[i]!) ? pb[i]! : 0;
		if (na !== nb) return na > nb ? 1 : -1;
	}
	return 0;
}

async function fetchLatestReleaseTag(): Promise<string> {
	const res = await fetch(`${baseUrl}/releases/latest`, { headers: githubHeaders() });
	if (!res.ok) die(`GitHub API error ${res.status} for releases/latest: ${await res.text()}`);
	const data = (await res.json()) as { tag_name?: string };
	if (!data.tag_name) die("releases/latest: missing tag_name");
	return data.tag_name;
}

async function fetchAurPkgver(): Promise<string> {
	const res = await fetch(aurPkgbuildUrl, { headers: { "User-Agent": "recordly-aur-drift-check" } });
	if (!res.ok) die(`AUR PKGBUILD fetch failed ${res.status}: ${aurPkgbuildUrl}`);
	const text = await res.text();
	const m = /^pkgver=(.+)$/m.exec(text);
	const raw = m?.[1]?.trim().replace(/^["']|["']$/g, "");
	if (!raw) die("Could not parse pkgver from AUR PKGBUILD");
	return raw;
}

async function writeJobSummary(markdown: string): Promise<void> {
	const path = process.env.GITHUB_STEP_SUMMARY;
	if (!path) return;
	await appendFile(path, `${markdown}\n`, "utf8");
}

async function main(): Promise<void> {
	const [aurPkgver, latestTag] = await Promise.all([
		fetchAurPkgver(),
		fetchLatestReleaseTag(),
	]);
	const latestPkgver = normalizeVersion(latestTag);
	const cmp = comparePkgVersions(aurPkgver, latestPkgver);

	console.log(`AUR ${aurPkg}: pkgver=${aurPkgver}`);
	console.log(`Upstream ${upstreamRepo} releases/latest: ${latestTag} (${latestPkgver})`);
	console.log("");

	if (cmp > 0) {
		const msg = [
			`Published AUR pkgver (${aurPkgver}) is greater than GitHub releases/latest (${latestPkgver}).`,
			"Upstream may have removed or re-pointed the latest release; PKGBUILD download URLs can 404 until you run the update workflow.",
			`Run: Actions → "Update AUR" → workflow_dispatch with push=true (or: bun run update-aur.ts with AUR SSH).`,
		].join("\n");
		console.error(msg);
		const failSummary = [
			"## AUR vs upstream releases/latest",
			"",
			"**Failed:** published AUR pkgver is **ahead** of GitHub Latest.",
			"",
			"| | |",
			"|---|---|",
			`| AUR pkgver | ${aurPkgver} |`,
			`| GitHub Latest | ${latestTag} |`,
			"",
			"**Next step:** run [Update AUR](.github/workflows/update-aur.yml) with **push** enabled, or run `bun run update-aur.ts` locally with AUR SSH.",
		].join("\n");
		await writeJobSummary(failSummary);
		process.exit(1);
	}

	console.log(
		cmp === 0
			? "OK: AUR matches upstream Latest."
			: "OK: AUR is behind upstream Latest (normal until the next update run).",
	);
	const okSummary = [
		"## AUR vs upstream releases/latest",
		"",
		`**OK:** AUR pkgver (${aurPkgver}) is not ahead of GitHub Latest (${latestTag}).`,
	].join("\n");
	await writeJobSummary(okSummary);
}

await main();
