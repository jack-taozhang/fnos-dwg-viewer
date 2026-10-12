/**
 * 本地端到端校验：**应急的 scoped 模式**。
 *
 * 1.0.7 起安装包只有一种模式 —— root 权限版，进程直接读全部存储空间
 * （正常路径的校验见 scripts/e2e-allmode.mjs）。这里校验的是留在代码里的
 * 那个应急开关：FNOS_ACCESS_MODE=scoped 时退回"只认 ALLOW_PREFIXES 白名单"，
 * 免得某个系统版本不允许第三方应用以 root 运行时整个应用不可用。
 *
 * 顺带钉住这几个历史坑：
 *   · 多个授权目录是**冒号**拼接的（早期只按逗号切分 → 授权了也读不到）
 *   · 中文文件名、百分号编码路径
 *   · 目录被删/改名时上溯到最近存在的上级
 *
 * 用法：
 *   ALLOW_PREFIXES="C:/tmp/fnos-sim/vol1/1000/售前项目:C:/tmp/fnos-sim/vol1/@appshare/fnos-dwg-viewer/drawings" \
 *   FNOS_ACCESS_MODE=scoped PORT=8123 TRIM_PKGVAR=C:/tmp/fnos-sim/var node server/index.mjs
 *   node scripts/e2e-local.mjs
 *
 * 夹具由本脚本自己创建（幂等），不再依赖手工搭出来的目录 —— 之前有一次
 * 夹具里被人多放了一个 `2025`，就撞死了"恰好只有一个子目录"那两条断言。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（读 package.json 里的版本号用） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const B = process.env.E2E_BASE || 'http://127.0.0.1:8123'
const R1 = 'C:/tmp/fnos-sim/vol1/1000/售前项目'
const R2 = 'C:/tmp/fnos-sim/vol1/@appshare/fnos-dwg-viewer/drawings'
const FILE = `${R1}/2026/812图纸A栋.dxf`

/* ---------- 夹具：白名单内两棵树（幂等） ---------- */
const MINIMAL_DXF = '0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n'
for (const abs of [FILE, `${R2}/共享图纸.dxf`]) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, MINIMAL_DXF)
}
fs.mkdirSync('C:/tmp/fnos-sim/var', { recursive: true })

let bad = 0
const ok = (cond, name, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? '   ' + extra : ''}`)
  if (!cond) bad++
}
const j = async (u) => (await fetch(B + u)).json()
const canon = (p) => String(p || '').replace(/\\/g, '/')

const cfg = await j('/api/config')
ok(cfg.allowedRoots.length === 2, '白名单被正确拆成 2 个', JSON.stringify(cfg.allowedRoots))
ok(canon(cfg.allowedRoots[0]) === R1, '第 1 个根目录 = 配置里的第 1 个')
ok(cfg.multiRoot === true, '处于多根模式')

const root = await j('/api/list?path=%2F')
ok(root.virtual === true && root.items.length === 2, '虚拟根列出 2 个白名单目录', JSON.stringify(root.items.map((i) => i.name)))
ok(root.items.every((i) => i.isDir), '两个都是目录')

const l1 = await j('/api/list?path=' + encodeURIComponent(R1))
ok(canon(l1.path) === R1, '回传的 path 与实际目录一致', l1.path)
// 只断言"能列出目录 + 里面有 2026"，不写死"恰好一个"：夹具目录可能被手工加过别的东西
const names1 = l1.items.map((i) => i.name)
ok(names1.includes('2026') && l1.items.every((i) => i.isDir), '列出「售前项目」下的子目录', JSON.stringify(names1))

const l2 = await j('/api/list?path=' + encodeURIComponent(`${R1}/2026`))
const names2 = l2.items.map((i) => i.name)
const dxfItem = l2.items.find((i) => i.name === '812图纸A栋.dxf')
ok(Boolean(dxfItem) && !dxfItem.isDir, '列出中文名图纸', JSON.stringify(names2))
ok(dxfItem && canon(dxfItem.path).endsWith('/2026/812图纸A栋.dxf'), '子项 path 由服务端回传的目录拼出', dxfItem?.path)

const p1 = await j('/api/probe?path=' + encodeURIComponent(FILE))
ok(p1.ok && p1.name === '812图纸A栋.dxf', 'probe 返回真实文件名', p1.name)
ok(canon(p1.path) === FILE, 'probe 返回修正后的路径', p1.path)

// 飞牛偶发把整串授权目录当成一个路径传进来。
//
// ⚠️ 这一条**在 Windows 上无法复现**，不是回归：
//   recoverCandidates 是按 `:` 朴素切段的，而 Windows 盘符自带冒号 ——
//   "C:/tmp/a:C:/tmp/b" 会被切成 ["C","/tmp/a","C","/tmp/b"]，盘符被吃掉，
//   剩下的 /tmp/a、/tmp/b 都落在白名单（C:/tmp/a、C:/tmp/b）之外，一个都匹配不上。
//   飞牛是 Linux，"/vol1/a:/vol1/b" 切出来正好是两段完整路径，所以生产上没问题。
//   （同一个坑 splitEnvList 已经用「单字母段把冒号还回去」处理过，recoverCandidates
//     没有复用它 —— 属于本地开发环境的已知差异。**没有改产品代码**：这条只在
//     Windows 的开发机上跑不出来，改服务端逻辑只为让本机测试变绿是不该做的事。）
if (process.platform === 'win32') {
  console.log('  - 跳过「冒号拼接串兜底还原」：Windows 盘符自带冒号，本地复现不了（生产是 Linux）')
} else {
  const rec = await j('/api/list?path=' + encodeURIComponent(`${R1}:${R2}`))
  ok(canon(rec.path) === R1, '冒号拼接串被兜底还原到第 1 个目录', rec.path)
}

// 百分号编码的请求路径
const enc = await j('/api/probe?path=' + encodeURIComponent(encodeURIComponent(FILE)))
ok(enc.ok && enc.name === '812图纸A栋.dxf', '百分号编码路径也能还原成中文名', enc.name)

// 白名单外的目录必须拦住（这就是应急模式存在的意义）
const denied = await j('/api/list?path=' + encodeURIComponent('C:/Windows'))
ok(denied.code === 'OUT_OF_SCOPE', '白名单外目录仍返回 OUT_OF_SCOPE')
ok(denied.suggest && canon(denied.suggest).startsWith('C:/Windows'), '报错里给出"该授权哪个目录"', denied.suggest)

// 不存在的文件 -> NOT_FOUND（不能被兜底成父目录）
const nf = await j('/api/probe?path=' + encodeURIComponent(`${R1}/2026/不存在.dxf`))
ok(nf.code === 'NOT_FOUND', '不存在的文件给 NOT_FOUND', nf.code)
ok(String(nf.error).includes('不存在.dxf'), '错误消息里带上了真实路径', nf.error)

// 目录被删/改名 -> 上溯到最近存在的上级
const up = await j('/api/list?path=' + encodeURIComponent(`${R1}/2026/子目录没了`))
ok(canon(up.path) === `${R1}/2026`, '目录不存在时上溯到最近存在的上级', up.path)

// 文件下载头
const resp = await fetch(`${B}/api/file/${encodeURIComponent('812图纸A栋.dxf')}?source=local&path=${encodeURIComponent(FILE)}`)
const cd = resp.headers.get('content-disposition')
ok(resp.ok && /filename\*=UTF-8''/.test(cd), 'Content-Disposition 用 RFC 5987 传中文名', cd)

/* ---------------- 1.0.7：访问模式与已删除的接口 ---------------- */

// 版本号别写死：从 package.json 读，省得每次升版都来改一行测试
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
ok(cfg.version === PKG_VERSION, '版本号取自运行期 package.json', `${cfg.version} / 期望 ${PKG_VERSION}`)
ok(typeof cfg.appUser === 'string' && cfg.appUser.length > 0, 'config 回传运行账号（诊断用）', cfg.appUser)
ok(cfg.accessMode === 'scoped' && cfg.unrestricted === false, '识别为应急的 scoped 模式', cfg.accessMode)
ok(Array.isArray(cfg.sources), 'config 回传顶层入口 sources')
ok(Array.isArray(cfg.storageRoots), 'config 回传 storageRoots 字段')

// 1.0.7 已删掉「授权目录 / 按需授权」那一整套字段（app 变量名未定义 → TypeError）
const cfgRaw = await (await fetch(`${B}/api/config`)).text()
ok(!/grantedRoots|needsAuthorization|rootVariant/.test(cfgRaw), 'config 不再回传授权目录相关字段')

// /api/grant（运行期按需授权）已整体删除
const grantResp = await fetch(`${B}/api/grant`)
ok(grantResp.status === 404, '/api/grant 已删除（返回 404）', `HTTP ${grantResp.status}`)

const doc = await j('/api/doctor')
ok(doc.ok === true, '/api/doctor 可用')
ok(doc.appUser === cfg.appUser, 'doctor 与 config 的运行账号一致')
ok(doc.accessMode === 'scoped' && doc.unrestricted === false, 'doctor 报告应急模式', doc.accessMode)
ok(Array.isArray(doc.sources) && Array.isArray(doc.rawRoots), 'doctor 给出入口与白名单')
ok(!('mountsFile' in doc), 'doctor 不再回传挂载表位置（1.0.8 已不读挂载表）')
ok(doc.fixCommands.length === 0, '目录可读时不会给出多余的修复命令')
ok(
  doc.hints.some((h) => h.includes('应急')),
  '提示里说明这是应急模式',
  JSON.stringify(doc.hints)
)
const r1info = doc.roots.find((r) => canon(r.path) === R1)
ok(Boolean(r1info) && r1info.listable === true, 'doctor 报告第 1 个目录可读')

/* ---------------- WebDAV 地址容错 ---------------- */

const davResp = await fetch(`${B}/api/session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: '127.0.0.1:1', user: 'u', pass: 'p' })
})
const davBody = await davResp.json()
ok(
  davResp.status === 400 && /http:\/\/127\.0\.0\.1:1/.test(String(davBody.error)),
  'WebDAV 地址容错：只填 IP:端口 自动补 http:// 并给出明确报错',
  davBody.error
)
const davStatus = await j('/api/session')
ok(davStatus.configured === false, '连接失败后不会留下半残的会话')

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`)
process.exit(bad === 0 ? 0 : 1)
