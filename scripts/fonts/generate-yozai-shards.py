from fontTools.ttLib import TTFont
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import subprocess

src=Path('node_modules/shirones/src/assets/fonts/Yozai-Medium.ttf')
out=Path('src/assets/fonts/yozai-shards')
out.mkdir(parents=True, exist_ok=True)
font=TTFont(src)
cmap=font.getBestCmap()
groups=sorted(set(cp//4096 for cp in cmap))
def build(group):
    start=group*4096
    end=start+4095
    dest=out/f'yozai-{group:03x}.woff2'
    subprocess.run(['pyftsubset', str(src), f'--output-file={dest}', '--flavor=woff2', f'--unicodes=U+{start:X}-{end:X}', '--layout-features=*', '--name-IDs=*', '--name-languages=*', '--notdef-glyph', '--recommended-glyphs'], check=True, stdout=subprocess.DEVNULL)
    return group
with ThreadPoolExecutor(max_workers=3) as pool:
    list(pool.map(build, groups))
actual=set()
for group in groups:
    f=TTFont(out/f'yozai-{group:03x}.woff2')
    actual.update(f.getBestCmap())
if actual != set(cmap):
    raise SystemExit(f'cmap mismatch missing={len(set(cmap)-actual)} extra={len(actual-set(cmap))}')
print('groups:', ' '.join(f'{group:03x}' for group in groups))
print(f'verified {len(actual)} code points across {len(groups)} shards')
