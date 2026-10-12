"""打源码包（开发环境没装 zip，用 Python 的 zipfile）。

排除：node_modules / release / .tools / var / 任意 dist / .git。
排除 dist 是因为它是构建产物，跑一次 npm run build 就有；
排除 fnos-package/app/server 下由打包脚本复制进去的那份副本也一样。
"""
import os
import sys
import zipfile

SRC = sys.argv[1]
OUT = sys.argv[2]

SKIP_DIRS = {'node_modules', 'release', '.tools', 'var', 'dist', '.git', '__pycache__'}

count = 0
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for dirpath, dirnames, filenames in os.walk(SRC):
        # 原地裁剪，os.walk 就不会往下走
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, SRC).replace(os.sep, '/')
            z.write(full, rel)
            count += 1

size = os.path.getsize(OUT)
print(f'已写入 {OUT}')
print(f'  条目 {count} 个，{size / 1024 / 1024:.1f} MB')
