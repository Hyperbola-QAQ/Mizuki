import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

async function createFixture(includeConfigs) {
	const fixtureDir = await mkdtemp(
		path.join(os.tmpdir(), "mizuki-config-export-"),
	);
	try {
		const files = new Set([
			"scripts/export-config.mjs",
			"scripts/config-typescript-loader.mjs",
			"src/config/deepMerge.ts",
			"src/types/config.ts",
		]);
		if (includeConfigs) {
			// Only tracked TypeScript files enter the fixture, never private overrides.
			const tracked = spawnSync(
				"git",
				["ls-files", "-z", "--", "src/config", "src/types"],
				{
					cwd: rootDir,
					encoding: "utf8",
				},
			);
			assert.equal(tracked.status, 0, tracked.stderr);
			for (const file of tracked.stdout.split("\0")) {
				if (file.endsWith(".ts") && !file.split("/").includes("overrides"))
					files.add(file);
			}
		}
		for (const file of files) {
			const target = path.join(fixtureDir, file);
			await mkdir(path.dirname(target), { recursive: true });
			await copyFile(path.join(rootDir, file), target);
		}
		await symlink(
			path.join(rootDir, "node_modules"),
			path.join(fixtureDir, "node_modules"),
			"junction",
		);
		await writeFile(path.join(fixtureDir, "package.json"), '{"type":"module"}');
		for (const args of [
			["init", "--quiet"],
			[
				"add",
				"package.json",
				...(includeConfigs ? ["src/config", "src/types"] : []),
			],
			[
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"-c",
				"commit.gpgsign=false",
				"-c",
				"core.hooksPath=/dev/null",
				"commit",
				"--quiet",
				"-m",
				"fixture",
			],
		]) {
			const git = spawnSync("git", args, { cwd: fixtureDir, encoding: "utf8" });
			assert.equal(git.status, 0, git.stderr);
		}
		return fixtureDir;
	} catch (error) {
		await rm(fixtureDir, { recursive: true, force: true });
		throw error;
	}
}

function exportFixture(fixtureDir) {
	const outDir = path.join(fixtureDir, "out");
	return spawnSync(
		process.execPath,
		["scripts/export-config.mjs", "--ref=HEAD", `--out=${outDir}`],
		{
			cwd: fixtureDir,
			encoding: "utf8",
			timeout: 30_000,
		},
	);
}

it("exports an identical baseline without experimental TypeScript flags", async () => {
	const fixtureDir = await createFixture(true);
	try {
		const outDir = path.join(fixtureDir, "out");
		await mkdir(outDir);
		const result = exportFixture(fixtureDir);
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.match(result.stdout, /与上游完全一致/);
		assert.deepEqual(await readdir(outDir), []);
	} finally {
		await rm(fixtureDir, { recursive: true, force: true });
	}
});

it("fails when the baseline has no exportable configurations", async () => {
	const fixtureDir = await createFixture(false);
	try {
		const result = exportFixture(fixtureDir);
		assert.ifError(result.error);
		assert.equal(result.status, 1, result.stderr || result.stdout);
		assert.match(result.stdout, /需要手工处理/);
		assert.doesNotMatch(result.stdout, /与上游完全一致/);
	} finally {
		await rm(fixtureDir, { recursive: true, force: true });
	}
});
