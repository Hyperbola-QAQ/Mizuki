# Strapi CMS

This is a Strapi 5 app using PostgreSQL. `posts`, `series-items`, and `moments` preserve the original Markdown body, source path as `slug`, and frontmatter in the `metadata` JSON field. Draft & Publish controls the publicly readable version; tokens with read permission must only be used on the server. Content API types are private by default. In particular, never expose credentials or raw protected article content through a public API role.

Configure the values in `.env.example` with secrets from a protected store; do not commit them. The persistent media directory is `public/uploads`. Production should use one CMS instance until search indexing is coordinated across replicas. Meilisearch synchronization runs after successful content changes and periodically rebuilds the index to repair missed operations.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

The app requires supported Node.js 20–24 and PostgreSQL. Search sync requires `MEILI_URL` and `MEILI_ADMIN_KEY`. This application and its schema have not yet been integration-tested against a running database or production cluster.

## Archive migration

Run from this directory against a checked-out, verified `archive/mizuki` snapshot. The default is read-only and reports post, draft, asset and unresolved-reference counts:

```sh
node scripts/import-mizuki.mjs --source /path/to/mizuki
STRAPI_URL=https://cms.example STRAPI_IMPORT_TOKEN="..." \
  node scripts/import-mizuki.mjs --source /path/to/mizuki --apply
```

Use a temporary full-access token supplied through a protected environment, revoke it afterward, and never paste a real token into shell history. Execute one importer at a time against a staging CMS. The importer checks every slug before upload, aborts on conflicting existing records, and skips matching source-and-asset hashes on retry. Strapi's upload API generates new filenames; the migration does not overwrite same-named public files. Interrupted uploads may leave unreferenced media for an administrator to review. Markdown image references, HTML media `src`/`poster`, and cover images are rewritten when their relative or `public/` source exists. Missing root URLs remain unchanged and are reported; missing relative media blocks non-MDX import. Check the report before switching production.

Draft MDX remains a draft with the exact original source in `metadata.migration.source` and a manual conversion flag; unresolved draft MDX media is reported and left unchanged. Published MDX blocks migration until supported or converted. Root-relative non-media links and unrecognized custom syntax are not automatically transformed and need review. Original frontmatter stays in `metadata`; `_mizukiMigration` is reserved for importer hashes. A passing import is not evidence that the new site renders all legacy extensions, encryption, links or images correctly.
