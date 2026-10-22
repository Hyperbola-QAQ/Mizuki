import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Use Astro's existing Vite runtime to resolve the production module's aliases
// and TypeScript enums in the same way as the application build.
const require = createRequire(import.meta.url);
const astroRequire = createRequire(require.resolve("astro/package.json"));
const { createServer } = await import(
	pathToFileURL(astroRequire.resolve("vite")).href
);
const server = await createServer({
	configFile: false,
	resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
	server: { middlewareMode: true },
});
after(async () => {
	await server.close();
});
const {
	getPostHomeContent,
	getPostPublicDescription,
} = await server.ssrLoadModule("/src/utils/post-card-content.ts");
const { i18n } = await server.ssrLoadModule("/src/i18n/translation.ts");
const { default: I18nKey } = await server.ssrLoadModule("/src/i18n/i18nKey.ts");
const encryptedPostHomeContent = i18n(I18nKey.postEncryptedMessage);

describe("getPostHomeContent", () => {
	it("hides post content by default when a password is set", () => {
		const content = getPostHomeContent(
			{
				description: "private summary",
				password: "secret",
			},
			"private excerpt",
		);

		assert.equal(content, encryptedPostHomeContent);
	});

	it("shows content for password protected posts when hiding is disabled", () => {
		const content = getPostHomeContent(
			{
				description: "public summary",
				hideHomeContent: false,
				password: "secret",
			},
			"public excerpt",
		);

		assert.equal(content, "public summary");
	});

	it("shows content by default when no password is set", () => {
		const content = getPostHomeContent(
			{
				description: "",
			},
			"plain excerpt",
		);

		assert.equal(content, "plain excerpt");
	});

	it("hides content when hiding is explicitly enabled without a password", () => {
		const content = getPostHomeContent(
			{
				description: "hidden summary",
				hideHomeContent: true,
			},
			"hidden excerpt",
		);

		assert.equal(content, encryptedPostHomeContent);
	});
});

describe("getPostPublicDescription", () => {
	it("hides public descriptions by default when a password is set", () => {
		const description = getPostPublicDescription(
			{
				description: "private summary",
				password: "secret",
			},
			"fallback title",
		);

		assert.equal(description, encryptedPostHomeContent);
	});

	it("hides public descriptions when hiding is explicitly enabled", () => {
		const description = getPostPublicDescription(
			{
				description: "hidden summary",
				hideHomeContent: true,
			},
			"fallback title",
		);

		assert.equal(description, encryptedPostHomeContent);
	});

	it("keeps normal fallback behavior when hiding is disabled", () => {
		const description = getPostPublicDescription(
			{
				description: "",
				hideHomeContent: false,
				password: "secret",
			},
			"fallback title",
		);

		assert.equal(description, "fallback title");
	});
});
