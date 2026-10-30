# Yozai font shards

These WOFF2 files are derived from the Yozai Medium font distributed by the pinned `shirones@0.1.5` package. They retain the source font's complete Unicode character map; a shard is selected by its Unicode range rather than by characters present at build time. The source font's SIL Open Font License 1.1 and copyright are in `OFL.txt`.

To reproduce, install Python fontTools with WOFF2/Brotli support and run `python scripts/fonts/generate-yozai-shards.py` after installing the pinned package. The script verifies that the union of shard character maps equals the original character map. The range declarations in `shirones/config/fontConfig.ts` must match the reported groups. OpenType layout features are retained; fontTools reports that it drops the source font's Apple-specific AAT `feat` and `morx` tables.
