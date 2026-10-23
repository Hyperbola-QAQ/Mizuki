import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Configuration modules use extensionless relative TypeScript imports.
export async function resolve(specifier, context, nextResolve) {
	try {
		return await nextResolve(specifier, context);
	} catch (error) {
		if (
			error.code === "ERR_MODULE_NOT_FOUND" &&
			specifier.startsWith(".") &&
			!/\.[cm]?[jt]s$/.test(specifier)
		) {
			return nextResolve(`${specifier}.ts`, context);
		}
		throw error;
	}
}

// Native type stripping cannot execute LinkPreset's enum on Node 26.
export async function load(url, context, nextLoad) {
	if (!url.startsWith("file:") || !new URL(url).pathname.endsWith(".ts")) {
		return nextLoad(url, context);
	}
	const source = await readFile(new URL(url), "utf8");
	return {
		format: "module",
		shortCircuit: true,
		source: ts.transpileModule(source, {
			fileName: fileURLToPath(url),
			compilerOptions: {
				module: ts.ModuleKind.ESNext,
				target: ts.ScriptTarget.ESNext,
			},
		}).outputText,
	};
}
