/**
 * 端到端校验：**唯一模式 root 全盘直读 + 顶层列出存储空间**（1.0.8 起）。
 *
 * 覆盖两件事：
 *   1) 不在任何白名单里的路径也必须能列、能读 —— 这是"双击任意位置的图纸
 *      都能打开"的前提（1.0.5 就是这里翻的车：包改成 root 了，代码却还按
 *      "授权目录为空 → 全部拦下"处理）。
 *   2) 图纸库顶层列出的是**各个存储空间的挂载点**（`/vol1`、`/vol2` …，
 *      显示成「存储空间 1」）—— 1.0.6 的形态。
 *      1.0.7 曾在应用里替用户分「我的文件 / 团队文件 / 外接存储 / 远程挂载 /
 *      应用文件」，1.0.8 已撤掉：飞牛自己的文件管理已经分好了，应用里再分
 *      一套只是多一层要维护的映射（卷怎么切、哪些算外接盘是系统的事）。
 *
 * 怎么在开发机上跑：
 *   只有 FNOS_VOL_ROOTS 一个开关 —— 模拟若干存储空间的挂载点。
 *   e2e-fixtures 由本脚本自己创建（幂等）。
 *
 * 用法：
 *   FNOS_VOL_ROOTS="C:/tmp/fnos-sim2/vol1:C:/tmp/fnos-sim2/vol2:C:/tmp/fnos-sim2/vol00:C:/tmp/fnos-sim2/vol3" \
 *   PORT=8129 TRIM_PKGVAR=C:/tmp/fnos-sim2/var node server/index.mjs
 *   node scripts/e2e-allmode.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（读 package.json 里的版本号用） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const B = process.env.E2E_BASE || 'http://127.0.0.1:8129'
const SIM = process.env.E2E_SIM_ROOT || 'C:/tmp/fnos-sim2'
/** 完全在存储空间之外的普通目录：验证"白名单外也能读" */
const OUTSIDE = process.env.E2E_OUTSIDE_ROOT || 'C:/tmp/fnos-outside'

/* ---------- 夹具：一棵"假的飞牛存储" ---------- */
const VOLS = {
  vol1: ['1000/售前项目/2026/812图纸A栋.dxf', '1000/阿里云盘/网盘图纸.dwg', '@team/团队图纸/b.dwg', '@appshare/fnos-dwg-viewer/drawings/c.dxf', '@appdata/fnos-dwg-viewer/data.bin'],
  vol2: ['1001/我的图纸/a.dxf'],
  // 两位数列卷（飞牛上外接盘是 /vol00、/vol01 …）：对应用户就是一个普通存储空间
  vol00: ['RemovableDisk/U盘图纸/d.dxf'],
  vol3: ['普通图纸/e.dxf']
}

const DXF = '0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n'
const write = (abs) => {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, DXF)
}

for (const [vol, files] of Object.entries(VOLS)) {
  for (const rel of files) write(path.join(SIM, vol, rel))
}
fs.mkdirSync(SIM, { recursive: true })
write(path.join(OUTSIDE, '外挂图纸', 'o.dxf'))

/* ---------- 断言 ---------- */
let bad = 0
const ok = (cond, name, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? '   ' + extra : ''}`)
  if (!cond) bad++
}
const j = async (u) => (await fetch(B + u)).json()
const canon = (p) => String(p || '').replace(/\\/g, '/')

/** 夹具里那个绝对路径（在 URL 里要用 encodeURIComponent） */
const simPath = (...parts) => canon(path.join(SIM, ...parts))

const cfg = await j('/api/config')
ok(cfg.accessMode === 'root', '处于 root 直读模式', cfg.accessMode)
ok(cfg.unrestricted === true, 'unrestricted 为真')
/*
 * 版本号**别写死**（这里原来写的是 '1.0.8'，于是每次升版这条都会红 ——
 * 它检查的其实是"服务端报的版本 == 仓库版本"，跟具体是哪个号无关）。
 * 与 e2e-local.mjs 保持一致：从 package.json 读。
 */
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
ok(cfg.version === PKG_VERSION, '版本号取自运行期 package.json', `${cfg.version} / 期望 ${PKG_VERSION}`)
ok(Array.isArray(cfg.sources) && cfg.sources.length > 0, 'config 回传顶层入口 sources')

/* 关键词：白名单外的路径也能读 —— 正常安装时"任何位置"都在此列 */
const OUTSIDE_DXF = canon(path.join(OUTSIDE, '外挂图纸', 'o.dxf'))

const outside = await j('/api/list?path=' + encodeURIComponent(OUTSIDE))
ok(outside.code === undefined && Array.isArray(outside.items), '不在任何白名单里的目录也能列出', `${outside.items?.length ?? 0} 项`)

const probe = await j('/api/probe?path=' + encodeURIComponent(OUTSIDE_DXF))
ok(probe.ok === true, '不在任何白名单里的图纸也能 probe 通过', probe.name)

const resp = await fetch(`${B}/api/file/${encodeURIComponent('o.dxf')}?source=local&path=${encodeURIComponent(OUTSIDE_DXF)}`)
ok(resp.ok, '图纸内容能真的下载下来', `HTTP ${resp.status}`)
const bytes = (await resp.arrayBuffer()).byteLength
ok(bytes > 0, '拿到非空内容', `${bytes} 字节`)

/* 顶层：各个存储空间的挂载点 */
const root = await j('/api/list?path=%2F')
const labels = (root.items || []).map((i) => i.name)
console.log('    顶层：' + JSON.stringify(labels))
ok(root.virtual === true, '顶层是虚拟根（存储空间列表）')
ok(root.items.every((i) => i.isDir), '每一项都是目录')

// 夹具里 4 个卷都要出现，且都叫「存储空间 N」
const EXPECTED = ['存储空间 00', '存储空间 1', '存储空间 2', '存储空间 3']
ok(
  labels.length === EXPECTED.length && EXPECTED.every((n) => labels.includes(n)),
  '4 个存储空间都在，名字是「存储空间 N」',
  JSON.stringify(labels)
)
// 挂载点不再暴露给用户（/vol1 这种名字认不出是哪个盘）
ok(labels.every((n) => /^存储空间 \d+$/.test(n)), '顶层不再出现 /volN 这种挂载点名字')
// 顺序：按名字排（00 在最前，与 detectStorageRoots 的字典序一致）
ok(JSON.stringify(labels) === JSON.stringify(EXPECTED), '顺序稳定（存储空间 00 → 1 → 2 → 3）', JSON.stringify(labels))

// 点进去真的能列到图纸：存储空间 1 → 1000/售前项目
const vol1 = root.items.find((i) => i.name === '存储空间 1')
const vol1List = await j('/api/list?path=' + encodeURIComponent(vol1.path))
const vol1Names = vol1List.items.map((i) => i.name)
ok(vol1Names.includes('1000') && vol1Names.includes('@team'), '「存储空间 1」里能看到用户目录与 @team', JSON.stringify(vol1Names))

const mine = vol1List.items.find((i) => i.name === '1000')
const mineList = await j('/api/list?path=' + encodeURIComponent(mine.path))
ok(mineList.items.some((i) => i.name === '售前项目'), '继续深入能看到「售前项目」', JSON.stringify(mineList.items.map((i) => i.name)))

// 外接盘（两位数列卷）同样当成一个存储空间列出来
const vol00 = root.items.find((i) => i.name === '存储空间 00')
const vol00List = await j('/api/list?path=' + encodeURIComponent(vol00.path))
ok(vol00List.items.some((i) => i.name === 'RemovableDisk'), '「存储空间 00」指向外接盘挂载点')

// 每个存储空间都要能站在顶层被 stat 到（不存在的不该出现在列表里）
ok(root.items.every((i) => i.readable !== false), '每个存储空间都读得动')

/* doctor：如实报告模式，并且不再给 setfacl 建议（root 模式下那没意义） */
const doc = await j('/api/doctor')
ok(doc.accessMode === 'root' && doc.unrestricted === true, 'doctor 报告 root 模式')
ok(doc.fixCommands.length === 0, 'root 模式不输出 setfacl 修复命令', JSON.stringify(doc.fixCommands))
ok(doc.sources.length === cfg.sources.length, 'doctor 与 config 的入口一致')
ok(doc.roots.every((r) => r.listable), '所有存储空间都可读', JSON.stringify(doc.roots.filter((r) => !r.listable).map((r) => r.path)))
ok(doc.sources.every((s) => /^存储空间 \d+$/.test(s.label)), 'doctor 里的名字也是「存储空间 N」')
ok(doc.hints.some((h) => h.includes('root')), 'doctor 提示里说明了 root 直读', JSON.stringify(doc.hints[0]))
ok(!('mountsFile' in doc), 'doctor 不再回传挂载表位置（1.0.8 已不需要读挂载表）')

/* 已删除的授权相关接口 / 字段 */
const grantResp = await fetch(`${B}/api/grant`)
ok(grantResp.status === 404, '/api/grant 已删除（返回 404）', `HTTP ${grantResp.status}`)
const cfgRaw = await (await fetch(`${B}/api/config`)).text()
ok(
  !/grantedRoots|needsAuthorization|rootVariant/.test(cfgRaw),
  'config 不再回传授权目录 / root 版标记等字段'
)

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`)
process.exit(bad === 0 ? 0 : 1)
