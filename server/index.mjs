/**
 * fnOS CAD 看图 —— 后端服务（零第三方依赖）
 *
 * 只用 Node 内置模块实现，原因：
 *  · 飞牛原生应用要自带运行期依赖，装 node_modules 会让打包变慢、体积变大；
 *  · 这里的功能很薄——列目录、读文件、托管静态资源、代理 WebDAV，手写即可。
 *
 * 职责：
 *  1) 托管前端静态资源（dist/）
 *  2) 提供「本机磁盘」与「fnOS WebDAV」两种数据源的文件列举 / 下载
 *
 * 为什么要后端：
 *  浏览器跨域直连 fnOS 的 WebDAV（5005/5006）会被 CORS 拦截，
 *  由 Node 侧代理 PROPFIND / GET 即可绕开限制，且凭据不必暴露在 URL 里。
 */
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { normalizeLegacyDxf } from './dxf-legacy.mjs'
import {
  CAD_EXT,
  isInside,
  parentCandidates,
  recoverCandidates,
  splitEnvList,
  suggestAuthorizeDir
} from './path-utils.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/**
 * 版本号取自 package.json，避免这里再写死一个和 manifest 对不上的数字。
 * 打包后是同目录的 package.json（build-fpk 按 manifest 生成）；
 * 源码目录里没有这一份，就退到项目根目录的，行为保持一致。
 */
const APP_VERSION = (() => {
  for (const p of [path.join(__dirname, 'package.json'), path.join(__dirname, '..', 'package.json')]) {
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version
      if (v) return v
    } catch {
      /* 试下一个 */
    }
  }
  return 'dev'
})()

const PORT = Number(process.env.PORT || 8020)
const HOST = process.env.HOST || '0.0.0.0'

/**
 * 本机数据源的浏览根目录。
 *
 * 飞牛原生应用不设它：顶层直接列出各个存储空间的挂载点（`/vol1`、`/vol2` …，
 * 界面上显示成「存储空间 1」）。Docker 部署时通常只挂一个目录，
 * 就设 LOCAL_ROOT 指向它。
 */
const LOCAL_ROOT = process.env.LOCAL_ROOT ? path.resolve(process.env.LOCAL_ROOT) : null

/**
 * 应急白名单：只有 FNOS_ACCESS_MODE=scoped 时才用得上（见下面的 SCOPED_MODE）。
 *
 * 保留 splitEnvList 这一步是因为它踩过坑：飞牛把多个授权目录用**冒号**拼成
 * 一个字符串传下来（和 PATH 一样），早期版本只按逗号切分，整串被当成一个
 * 路径，白名单里躺着一根不存在的字符串，于是用户明明授权了、双击图纸仍然
 * 报「该目录尚未授权」。现在 , ; : 都认，且不会切坏 Windows 盘符。
 */
const ALLOW_PREFIXES = splitEnvList(process.env.ALLOW_PREFIXES).map((s) => path.resolve(s))

/**
 * 进程真实身份。
 *
 * 为什么必须看运行期 uid，而不是看"安装的是不是 root 版包"：
 *   飞牛的 root 权限版（config/privilege 里 run-as: root）会让 cmd/ 里的
 *   生命周期脚本以 root 执行，node 进程随之拿到 root 身份 —— 这时它本来
 *   就能读全盘。可如果代码仍然按"白名单为空 → 全部拦住"处理，用户就会
 *   遇到「装了 root 版、双击图纸还是提示这个目录还没授权」这种荒唐结果。
 *   所以权限判定一律只看 uid，包里的声明只用来写排障提示。
 */
const IS_ROOT = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0

/**
 * 访问模式。
 *
 * 1.0.7 起**只有一种模式**：安装包统一是 root 权限版（config/privilege 里
 * run-as: root），服务直接读写全部存储空间 —— 既不需要「授权目录」，
 * 界面上也不再有跟授权有关的任何提示。
 *
 * FNOS_ACCESS_MODE=scoped 是留给自己的应急开关：万一某个系统版本不允许
 * 第三方应用以 root 运行，可以退回"只认 ALLOW_PREFIXES 白名单"的老行为，
 * 免得整个应用不可用。它不会被自动设置，界面上也没有任何入口。
 */
const ACCESS_MODE_ENV = String(process.env.FNOS_ACCESS_MODE || '').trim().toLowerCase()
const SCOPED_MODE = ACCESS_MODE_ENV === 'scoped'
const UNRESTRICTED = !SCOPED_MODE

/**
 * 存储空间的挂载点（飞牛上是 /vol1、/vol2 …，外接盘是 /vol00、/vol01 …）。
 *
 * 不把 / 当浏览根：那样一进图纸库就是 bin / etc / proc，既没用又容易误触。
 * 读不到根目录（非 Linux）就返回空数组，由 browseSources() 兜底。
 * FNOS_VOL_ROOTS 可以显式指定根（Docker 挂载整盘 / e2e 造场景）。
 */
function detectStorageRoots() {
  const override = splitEnvList(process.env.FNOS_VOL_ROOTS)
  if (override.length) return [...new Set(override.map((p) => path.resolve(p)))].sort()
  const vols = []
  try {
    for (const name of fs.readdirSync('/')) {
      if (!/^vol\d+$/.test(name)) continue
      try {
        if (fs.statSync('/' + name).isDirectory()) vols.push('/' + name)
      } catch {
        /* 单个挂载点探测失败就跳过，不影响其它 */
      }
    }
  } catch {
    /* 读不动 /：交给兜底 */
  }
  return vols.sort()
}

/**
 * 「本机存储」的浏览根 —— 就是各个存储空间的挂载点。
 *
 * 1.0.8 起回到 1.0.6 的形态：顶层列 `/vol1`、`/vol2`…（显示成「存储空间 1」），
 * 不再在应用里替用户分"我的文件 / 团队文件 / 外接存储…"这些类 ——
 * 飞牛自己的文件管理已经分好了，应用里再分一套反而多一层要维护的映射，
 * 而且卷怎么切、哪些算外接盘是系统的事。
 *
 * 应急的 scoped 模式下列的是白名单目录（名字取目录名）。
 */
function browseSources() {
  return allowedRoots().map((p) => ({ label: rootLabel(p) || p, path: p }))
}

/** 老式 DXF 兼容层只处理这个体积以内的文件，超出则原样透传 */
const DXF_FIX_MAX_BYTES = 64 * 1024 * 1024

if (process.env.FNOS_INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

/**
 * 运行本服务的系统账号 —— 环境里的排障信息。
 *
 * 飞牛给每个原生应用建一个独立系统账号（config/privilege 里的 username）。
 * 1.0.7 起本应用是 root 权限版（run-as: root），进程实际以 root 跑，
 * 这个账号名只在诊断面板里显示、以及应急模式下拼 setfacl 命令时才用到。
 */
const APP_USER = (() => {
  try {
    return os.userInfo().username || process.env.TRIM_RUN_USERNAME || ''
  } catch {
    return process.env.TRIM_RUN_USERNAME || ''
  }
})()

/** 运行期数据目录（飞牛下是 TRIM_PKGVAR），放 PID / 日志 / WebDAV 连接信息 */
const DATA_DIR = process.env.TRIM_PKGVAR || path.join(ROOT, 'var')
try {
  fs.mkdirSync(DATA_DIR, { recursive: true })
} catch {
  /* 只读环境就退化成内存态 */
}

/** WebDAV 连接信息落盘位置：应用重启后不用重新填账号 */
const DAV_STORE = path.join(DATA_DIR, 'webdav.json')

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.dxf': 'application/dxf',
  '.dwg': 'application/acad'
}

/** 未做内容哈希的解析 worker：缓存时间适中，改包后不至于长期读到旧文件 */
const WORKER_ASSETS = new Set([
  '/assets/libredwg-parser-worker.js',
  '/assets/libredwg-web.wasm',
  '/assets/mtext-renderer-worker.js'
])

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

/**
 * 构造 Content-Disposition。
 *
 * HTTP 头部只能安全地写 ASCII，中文名直接塞进 filename="…" 会变成乱码，
 * 所以：filename 放一个 ASCII 回退值，真名走 RFC 5987 的 filename*。
 */
function contentDisposition(name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'drawing'
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * 带状态码与机器可读 code 的错误。
 *
 * code 会原样返回给前端，用来决定展示哪段排错指引：
 *   OUT_OF_SCOPE  路径不在白名单里（只有应急的 scoped 模式才可能）
 *   EACCES        进程没能从内核拿到读权限（全盘直读下极少见：坏挂载、只读介质…）
 *   NOT_FOUND     文件真的不在
 *   NOT_A_FILE    目标是目录
 */
class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

/** 把 Node 的 errno 翻译成 ApiError */
function toApiError(err, absPath) {
  if (err instanceof ApiError) return err
  const name = String(err?.message || err)
  const where = absPath || '(未知路径)'
  if (/不是文件/.test(name)) return new ApiError(400, 'NOT_A_FILE', '这是一个目录，不是图纸文件')
  switch (err?.code) {
    case 'ENOENT':
      return new ApiError(404, 'NOT_FOUND', `文件不存在：${where}`, { path: where })
    case 'EACCES':
    case 'EPERM':
      return eaccesError(where)
    case 'EISDIR':
      return new ApiError(400, 'NOT_A_FILE', '这是一个目录，不是图纸文件')
    default:
      return new ApiError(500, 'INTERNAL', `${name}（${where}）`)
  }
}

/**
 * 「内核还是拒绝了」——飞牛上最常见的一类权限报错。
 *
 * 原因通常是：应用以**自己专属的系统账号**运行（config/privilege 的 username），
 * 而磁盘上的权限归用户本人；飞牛 v1.2 起存储改用 Windows ACL 管理，授权列表
 * 没同步成 ACL 时内核就会直接 EACCES。
 *
 * 1.0.7 起进程是 root，这类错基本不会出现。所以：
 *   · 应急的 scoped 模式：照旧给出可复制的 setfacl 修复命令；
 *   · 正常（root）模式：只说明现象（只读介质、坏挂载、被 SELinux/容器策略挡住
 *     之类），不给 setfacl —— 那对 root 毫无意义，照抄反而容易改坏系统权限。
 */
function eaccesError(where, overrideCommand) {
  const user = APP_USER || '<应用账号>'
  const target = overrideCommand?.target || (fs.existsSync(where) ? where : suggestAuthorizeDir(where))
  return new ApiError(403, 'EACCES', `没有读取权限：${where}`, {
    path: where,
    appUser: user,
    mode: UNRESTRICTED ? 'root' : 'scoped',
    // scoped 模式下建议授权的"目录"：双击进来的是一个文件路径，授它所在的
    // 目录更合适（同一个文件夹里的其他图纸也就一起能打开了）
    suggest: UNRESTRICTED ? '' : suggestAuthorizeDir(where),
    fixCommand:
      overrideCommand?.command ||
      (SCOPED_MODE ? `sudo setfacl -R -m u:${user}:rwx "${target}"` : '')
  })
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req) {
  const raw = await readBody(req)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** 日志/接口回显时隐藏可能的账号信息 */
function maskUrl(url) {
  return String(url).replace(/\/\/[^@/]+@/, '//')
}

/* ------------------------------------------------------------------ */
/* 本机数据源                                                          */
/* ------------------------------------------------------------------ */

/**
 * 白名单。
 *
 * 全盘模式（唯一模式）下它只用来回显诊断信息 —— 判定走 isAllowed() 的第一行，
 * 不参与拦截。只有 FNOS_ACCESS_MODE=scoped 的应急模式才会真正拿它卡路径。
 *
 * LOCAL_ROOT 只影响"浏览根"，不参与拼接 —— 单根模式下它本来就是用户
 * 指定的那个目录，重复加进来只会让 /api/config 的列表出现两份。
 */
function allowedRoots() {
  return [
    ...new Set([
      ...(LOCAL_ROOT ? [LOCAL_ROOT] : []),
      ...detectStorageRoots(),
      ...ALLOW_PREFIXES
    ])
  ]
}

/**
 * 多根模式：没有单一浏览根、且至少有一个入口时启用。
 *
 * 为什么是个函数：入口来自磁盘上的实际目录（挂载点会变），每次请求重算
 * 才不会出现"插了 U 盘但列表里没有"。之前用 let 变量在几处手工同步，
 * 漏一处就会出现"授了权虚拟根还是列不出来"。
 *
 * 另外要挡掉一个退化情形：只有一个入口、且它就是文件系统根（非 Linux
 * 环境退化成 /）时不能再当多根，否则虚拟根里会列出一个指向自己的条目，
 * 点进去原地打转。
 */
function multiRoot() {
  if (LOCAL_ROOT) return false
  const sources = browseSources()
  if (sources.length === 1 && path.parse(sources[0].path).root === sources[0].path) return false
  return sources.length > 0
}

function isAllowed(abs) {
  // 全盘模式：进程本身就是 root，白名单没有存在意义
  if (UNRESTRICTED) return true
  const roots = allowedRoots()
  if (roots.length === 0) return isInside(abs, ROOT)
  return roots.some((root) => isInside(abs, root))
}

/**
 * 把请求路径解析成真实磁盘路径。
 *
 * 支持两种形态：
 *  - 浏览用相对路径：`/1000/图纸` → LOCAL_ROOT/1000/图纸
 *  - fnOS 绝对路径：`/vol1/1000/图纸/a.dwg`（来自文件管理器双击）
 *
 * 解析过程带兜底（见 path-utils.recoverCandidates）：先按原样、再按冒号
 * 切段、再按百分号解码、最后逐级上溯到父目录。每一步都用 isAllowed
 * 卡一遍白名单，所以兜底不会把越权路径放进来。
 */
function localCandidates(raw) {
  const out = []
  const push = (p) => {
    const abs = path.resolve(p)
    if (!out.includes(abs)) out.push(abs)
  }
  for (const cand of recoverCandidates(raw)) {
    if (path.isAbsolute(cand)) {
      push(cand)
      // 单根模式下，绝对路径也可能要按 LOCAL_ROOT 前缀来找
      if (LOCAL_ROOT) push(path.resolve(LOCAL_ROOT, '.' + cand))
    } else if (LOCAL_ROOT) {
      push(path.resolve(LOCAL_ROOT, cand))
    }
  }
  return out
}

/** 真实存在的、且类型符合预期（文件 / 目录）才返回 true */
async function matchesWant(abs, want) {
  let st
  try {
    st = await fsp.stat(abs)
  } catch {
    return false
  }
  if (want === 'file') return st.isFile()
  if (want === 'dir') return st.isDirectory()
  return true
}

/**
 * 解析并校验路径。
 *
 * @param raw  客户端传来的路径
 * @param want 'file' | 'dir' | 'any'
 * @returns 真实绝对路径
 * @throws ApiError OUT_OF_SCOPE / NOT_FOUND / EACCES
 */
async function resolveLocalPath(raw, want = 'any') {
  const candidates = localCandidates(String(raw || '/'))
  const allowed = candidates.filter(isAllowed)

  if (allowed.length === 0) {
    throw new ApiError(403, 'OUT_OF_SCOPE', `该目录不在可访问范围内：${raw}`, {
      path: raw,
      suggest: SCOPED_MODE ? suggestAuthorizeDir(raw) : '',
      allowedRoots: allowedRoots()
    })
  }

  for (const abs of allowed) {
    if (await matchesWant(abs, want)) return abs
  }

  // 目录：退到最近一个真实存在的上级（目录被改名/删除时的兜底）
  if (want !== 'file') {
    for (const cand of candidates) {
      for (const parent of parentCandidates(cand)) {
        if (isAllowed(parent) && (await matchesWant(parent, 'dir'))) return parent
      }
    }
  }

  // 已授权但确实不存在／或类型不符：让文件系统给出真实错误
  try {
    await fsp.stat(allowed[0])
  } catch (err) {
    throw toApiError(err, allowed[0])
  }
  return allowed[0]
}

/** 回给前端的路径形态：单根模式给相对路径，多根/绝对路径给绝对路径 */
function toClientPath(abs) {
  const posix = abs.split(path.sep).join('/')
  if (LOCAL_ROOT && isInside(abs, LOCAL_ROOT)) {
    const rel = path.relative(LOCAL_ROOT, abs).split(path.sep).filter(Boolean).join('/')
    return rel ? '/' + rel : '/'
  }
  return posix
}

function sortItems(items) {
  return items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
}

/**
 * 虚拟根里那个条目的显示名。
 *
 * 顶层是存储空间的挂载点 /vol1、/vol2 —— 直接把 basename 摆出来用户认不出
 * 是哪个盘，换成飞牛界面里的叫法「存储空间 1」。
 *
 * 匹配的是"路径最后一段是 volN"，不是"整条路径就是 /volN"：
 * Docker 挂到 /mnt/vol1、开发机上夹具在 C:/tmp/xxx/vol1 时同样要认出来。
 */
function rootLabel(root) {
  const p = String(root).split(path.sep).join('/').replace(/\/+$/, '')
  const m = /(?:^|\/)vol(\d+)$/.exec(p)
  return m ? `存储空间 ${m[1]}` : path.basename(p) || root
}

/** 这个目录当前进程读得动吗（只用来给界面打标记，不做拦截） */
async function canRead(abs) {
  try {
    await fsp.access(abs, fs.constants.R_OK | fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function listLocal(p) {
  const raw = String(p || '/').replace(/\\/g, '/')

  /*
   * 图纸库顶层：列出各个存储空间的挂载点（见 browseSources）。
   * 只列真实存在的目录，否则用户点进去只会看到一个"打不开"的空壳。
   */
  if (multiRoot() && (raw === '/' || raw === '')) {
    const items = []
    for (const src of browseSources()) {
      let st
      try {
        st = await fsp.stat(src.path)
      } catch {
        console.warn(`[warn] 存储空间不存在，已跳过：${src.path}`)
        continue
      }
      const clientPath = toClientPath(src.path)
      items.push({
        name: src.label || rootLabel(src.path) || clientPath,
        path: clientPath,
        isDir: st.isDirectory(),
        size: st.size,
        mtime: st.mtimeMs,
        ext: st.isDirectory() ? '' : path.extname(src.path).toLowerCase(),
        // 进程读不动时前端会在这条上打个警示标记：让用户一眼看出
        // "图纸库里有东西，只是这一个读不动"，而不是以为目录是空的。
        readable: await canRead(src.path)
      })
    }
    return { source: 'local', path: '/', virtual: true, items: sortItems(items) }
  }

  const abs = await resolveLocalPath(raw, 'dir')
  const dir = toClientPath(abs)

  let entries
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true })
  } catch (err) {
    // 关键：一定要把 abs 带进来，否则用户看到的是"没有读取权限：undefined"
    throw toApiError(err, abs)
  }

  const prefix = dir.replace(/\/+$/, '')
  const items = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const childAbs = path.join(abs, e.name)
    let st
    try {
      st = await fsp.stat(childAbs)
    } catch {
      continue
    }
    const isDir = st.isDirectory()
    const ext = isDir ? '' : path.extname(e.name).toLowerCase()
    if (!isDir && !CAD_EXT.has(ext)) continue
    items.push({ name: e.name, path: childPathOf(prefix, e.name), isDir, size: st.size, mtime: st.mtimeMs, ext })
  }
  return { source: 'local', path: dir, items: sortItems(items) }
}

function childPathOf(prefix, name) {
  return `${prefix}/${name}` || '/'
}

async function streamLocal(p, res, headOnly = false) {
  const abs = await resolveLocalPath(String(p), 'file')
  let st
  try {
    st = await fsp.stat(abs)
  } catch (err) {
    throw toApiError(err, abs)
  }
  if (!st.isFile()) throw new ApiError(400, 'NOT_A_FILE', '这是一个目录，不是图纸文件')
  const ext = path.extname(abs).toLowerCase()
  const name = path.basename(abs)

  // 老式 DXF 补一次子类标记（见 server/dxf-legacy.mjs），其余类型直接透传
  let body = null
  if (ext === '.dxf' && st.size > 0 && st.size <= DXF_FIX_MAX_BYTES) {
    try {
      body = normalizeLegacyDxf(await fsp.readFile(abs), { maxBytes: DXF_FIX_MAX_BYTES })
    } catch (err) {
      throw toApiError(err, abs)
    }
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': String(body ? body.length : st.size),
    'Content-Disposition': contentDisposition(name),
    'Cache-Control': 'no-store'
  })
  if (headOnly) return res.end()
  if (body) return res.end(body)
  fs.createReadStream(abs).pipe(res)
}

/* ------------------------------------------------------------------ */
/* WebDAV 数据源（任意标准 WebDAV；飞牛自带的是 http 5005 / https 5006） */
/* ------------------------------------------------------------------ */

/**
 * WebDAV 连接信息：进程内会话 > 落盘文件 > 环境变量 > 请求头。
 *
 * 为什么放在服务端：浏览器的 CAD 查看器会自己去 fetch `/api/file...`，
 * 没法附加自定义请求头，凭据也就无法随请求下发。
 *
 * 为什么还要落盘：飞牛在用户改「访问权限」后会重启应用，只放内存里
 * 的话每次都被清空，用户得重新填一遍账号密码。
 */
let davSession = null

/** 地址容错：允许只填 `192.168.1.10:5005`，自动补 http:// */
function normalizeDavUrl(raw) {
  const text = String(raw || '').trim().replace(/\s+/g, '')
  if (!text) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return (u.origin + u.pathname).replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function loadDavSession() {
  try {
    const raw = JSON.parse(fs.readFileSync(DAV_STORE, 'utf8'))
    if (raw && raw.url) {
      davSession = { url: String(raw.url), user: String(raw.user || ''), pass: String(raw.pass || '') }
    }
  } catch {
    /* 文件不存在或损坏：当作没配过 */
  }
}

function saveDavSession() {
  try {
    fs.writeFileSync(DAV_STORE, JSON.stringify(davSession ?? {}, null, 2), { mode: 0o600 })
    fs.chmodSync(DAV_STORE, 0o600)
  } catch (err) {
    console.warn('[warn] WebDAV 连接信息保存失败：' + (err?.message || err))
  }
}

loadDavSession()

function getDavConfig(req) {
  const h = req?.headers || {}
  const url = (davSession?.url || h['x-fnos-url'] || process.env.FNOS_URL || '').trim()
  const user = (davSession?.user || h['x-fnos-user'] || process.env.FNOS_USER || '').trim()
  const pass = davSession ? davSession.pass : h['x-fnos-pass'] || process.env.FNOS_PASS || ''
  let rootPath = '/'
  try {
    rootPath = new URL(url).pathname || '/'
  } catch {
    /* url 为空或非法 */
  }
  return { url, user, pass, rootPath }
}

/** WebDAV 相关的用户可读报错（统一走 ApiError，前端才能按 code 分流） */
function davError(message, status = 400) {
  return new ApiError(status, 'WEBDAV', message)
}

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')
}

function joinUrl(base, p) {
  const b = base.replace(/\/+$/, '')
  const s = String(p || '/').startsWith('/') ? String(p || '/') : '/' + String(p)
  return b + s.split('/').map(encodeURIComponent).join('/').replace(/%2F/g, '/')
}

function xmlUnescape(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

const tagRe = (name) => new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'i')

/** 只解析 PROPFIND 响应里我们关心的几项，够用且不引入 XML 依赖 */
function parseMultiStatus(xml) {
  const out = []
  const blocks = xml.match(/<(?:[\w.-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?response>/gi) || []
  for (const block of blocks) {
    const href = block.match(tagRe('href'))
    if (!href) continue
    const name = block.match(tagRe('displayname'))
    const len = block.match(tagRe('getcontentlength'))
    const mod = block.match(tagRe('getlastmodified'))
    out.push({
      href: xmlUnescape(href[1].trim()),
      displayname: name ? xmlUnescape(name[1].trim()) : '',
      length: len ? Number(len[1].trim()) : 0,
      lastModified: mod ? xmlUnescape(mod[1].trim()) : '',
      isDir: /<(?:[\w.-]+:)?collection\b/i.test(block)
    })
  }
  return out
}

/** 从 <d:href> 反解出相对于根路径的规范化路径 */
function hrefToPath(href, basePath) {
  let h = decodeURIComponent(String(href))
  try {
    if (/^https?:\/\//i.test(h)) h = new URL(h).pathname
  } catch {
    /* 相对 href */
  }
  const prefix = (basePath || '').replace(/\/+$/, '')
  if (prefix && prefix !== '/' && h.startsWith(prefix)) h = h.slice(prefix.length)
  if (!h.startsWith('/')) h = '/' + h
  return h.replace(/\/+$/, '') || '/'
}

async function listWebdav(cfg, p) {
  if (!cfg.url) throw davError('还没有配置 WebDAV 地址。在左侧「WebDAV」页填上地址与账号即可。')
  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop>
<D:displayname/><D:getcontentlength/><D:getlastmodified/><D:resourcetype/>
</D:prop></D:propfind>`

  let resp
  try {
    resp = await fetch(joinUrl(cfg.url, p), {
      method: 'PROPFIND',
      headers: {
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
        Authorization: basicAuth(cfg.user, cfg.pass)
      },
      body
    })
  } catch (err) {
    throw davError(`连不上 WebDAV：${cfg.url}（${err?.cause?.code || err?.message || err}）`)
  }

  if (resp.status === 401 || resp.status === 403) {
    throw davError('WebDAV 认证失败：请检查用户名 / 密码（部分服务需要单独的「应用密码」）', 401)
  }
  if (resp.status === 404) throw davError('WebDAV 路径不存在：' + p, 404)
  if (resp.status === 405) {
    throw davError('对方不支持 PROPFIND，可能不是标准 WebDAV 服务（有些网盘只提供 WebDAV 的 GET 下载）')
  }
  if (!(resp.status === 207 || resp.ok)) {
    throw davError(`WebDAV 返回 ${resp.status} ${resp.statusText}`)
  }

  const selfPath = String(p || '/').replace(/\/+$/, '') || '/'
  const items = []
  for (const r of parseMultiStatus(await resp.text())) {
    const full = hrefToPath(r.href, cfg.rootPath)
    if (full === selfPath) continue
    const name = decodeURIComponent(r.displayname || full.split('/').pop() || '')
    const ext = r.isDir ? '' : path.extname(name).toLowerCase()
    if (!r.isDir && !CAD_EXT.has(ext)) continue
    items.push({
      name,
      path: full,
      isDir: r.isDir,
      size: r.length,
      mtime: r.lastModified ? Date.parse(r.lastModified) || 0 : 0,
      ext
    })
  }
  return { source: 'webdav', path: selfPath, items: sortItems(items) }
}

async function streamWebdav(cfg, p, res, headOnly = false) {
  if (!cfg.url) throw davError('还没有配置 WebDAV 地址')
  let resp
  try {
    resp = await fetch(joinUrl(cfg.url, p), {
      headers: { Authorization: basicAuth(cfg.user, cfg.pass) }
    })
  } catch (err) {
    throw davError(`连不上 WebDAV：${cfg.url}（${err?.cause?.code || err?.message || err}）`)
  }
  if (resp.status === 401 || resp.status === 403) {
    throw davError('WebDAV 认证失败：请检查用户名 / 密码', 401)
  }
  if (!resp.ok) throw davError(`WebDAV 返回 ${resp.status} ${resp.statusText}`)

  const ext = path.extname(String(p)).toLowerCase()
  const name = path.basename(String(p))
  let body = Buffer.from(await resp.arrayBuffer())

  // 与本地数据源保持一致：老式 DXF 补一次子类标记
  if (ext === '.dxf' && body.length > 0 && body.length <= DXF_FIX_MAX_BYTES) {
    body = normalizeLegacyDxf(body, { maxBytes: DXF_FIX_MAX_BYTES })
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': String(body.length),
    'Content-Disposition': contentDisposition(name),
    'Cache-Control': 'no-store'
  })
  if (headOnly) return res.end()
  res.end(body)
}

/**
 * 打开前的 WebDAV 预检：确认这个路径真的存在、而且是文件。
 *
 * 优先用 Depth:0 的 PROPFIND（大多数服务支持，且不会真的把文件传下来）；
 * 少数服务对文件不支持 PROPFIND（405/501），退回 Range 取首字节来探活。
 */
async function probeWebdav(cfg, p) {
  if (!cfg.url) throw davError('还没有配置 WebDAV 地址。在左侧「WebDAV」页填上地址与账号即可。')
  const auth = { Authorization: basicAuth(cfg.user, cfg.pass) }
  const url = joinUrl(cfg.url, p)
  const name = decodeURIComponent(String(p).split('/').pop() || '')

  const fail = (status) => {
    if (status === 401 || status === 403) throw davError('WebDAV 认证失败：请检查用户名 / 密码', 401)
    if (status === 404) throw davError(`文件不存在：${p}`, 404)
  }

  let resp
  try {
    resp = await fetch(url, {
      method: 'PROPFIND',
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8', ...auth },
      body: `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:getcontentlength/><D:resourcetype/></D:prop></D:propfind>`
    })
  } catch (err) {
    throw davError(`连不上 WebDAV：${cfg.url}（${err?.cause?.code || err?.message || err}）`)
  }

  if (resp.status === 207 || resp.ok) {
    const blocks = parseMultiStatus(await resp.text())
    return { name, size: blocks[0]?.length || 0, isDir: Boolean(blocks[0]?.isDir) }
  }
  fail(resp.status)
  if (resp.status !== 405 && resp.status !== 501) {
    throw davError(`WebDAV 返回 ${resp.status} ${resp.statusText}`)
  }

  // 退化路径：Range 只取 1 个字节
  let head
  try {
    head = await fetch(url, { headers: { ...auth, Range: 'bytes=0-0' } })
  } catch (err) {
    throw davError(`连不上 WebDAV：${cfg.url}（${err?.cause?.code || err?.message || err}）`)
  }
  fail(head.status)
  if (!(head.ok || head.status === 206)) {
    throw davError(`WebDAV 返回 ${head.status} ${head.statusText}`)
  }
  return { name, size: Number(head.headers.get('content-range')?.split('/')?.[1] || 0), isDir: false }
}

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

const distCandidates = [path.join(ROOT, 'dist'), path.join(__dirname, 'dist')]
const distDir =
  distCandidates.find((d) => fs.existsSync(path.join(d, 'index.html'))) || distCandidates[0]

function cacheHeader(pathname) {
  if (WORKER_ASSETS.has(pathname)) return 'public, max-age=604800'
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  return 'no-cache'
}

async function serveStatic(req, res, pathname) {
  let rel
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    return false
  }
  if (rel.includes('\0') || rel.includes('..')) return false
  if (rel === '/' || rel === '') rel = '/index.html'

  const file = path.join(distDir, rel)
  if (!isInside(file, distDir)) return false

  let st
  try {
    st = await fsp.stat(file)
  } catch {
    return false
  }
  if (!st.isFile()) return false

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': String(st.size),
    'Cache-Control': cacheHeader(rel)
  })
  // 查看器探测 worker 是否可用时发的是 HEAD 请求，必须支持
  if (req.method === 'HEAD') return res.end(), true
  fs.createReadStream(file).pipe(res)
  return true
}

/* ------------------------------------------------------------------ */
/* 权限自检（/api/doctor）                                             */
/* ------------------------------------------------------------------ */

/** 从根到目标逐级列出来，用来定位"到底在哪一层被内核拒绝" */
function ancestorChain(abs) {
  const resolved = path.resolve(abs)
  const parts = resolved.split(path.sep).filter(Boolean)
  const out = []
  let cur = ''
  for (const part of parts) {
    if (!cur) {
      cur = /^[a-zA-Z]:$/.test(part) ? part + path.sep : path.sep + part
    } else {
      cur = cur.endsWith(path.sep) ? cur + part : cur + path.sep + part
    }
    out.push(cur)
  }
  return out
}

async function inspectPath(dir) {
  const info = { path: dir, exists: false, isDir: false, mode: '', uid: null, gid: null }
  try {
    const st = await fsp.stat(dir)
    info.exists = true
    info.isDir = st.isDirectory()
    info.mode = '0' + (st.mode & 0o7777).toString(8)
    info.uid = st.uid
    info.gid = st.gid
  } catch (err) {
    info.error = `${err?.code || ''} ${err?.message || err}`.trim()
    return info
  }
  info.canRead = await permOk(dir, fs.constants.R_OK)
  info.canTraverse = await permOk(dir, fs.constants.X_OK)
  return info
}

async function permOk(p, flag) {
  try {
    await fsp.access(p, flag)
    return true
  } catch {
    return false
  }
}

/** getfacl 不是每个系统都装了；拿不到就算了，不影响结论 */
function aclOf(dir) {
  try {
    const r = spawnSync('getfacl', ['-p', dir], { encoding: 'utf8', timeout: 2500 })
    if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim()) {
      return r.stdout.trim().split('\n').slice(0, 60).join('\n')
    }
  } catch {
    /* 忽略 */
  }
  return ''
}

async function buildDoctorReport() {
  const sources = browseSources()
  const isRoot = IS_ROOT

  const report = {
    ok: true,
    version: APP_VERSION,
    node: process.version,
    platform: `${process.platform}/${process.arch} ${os.release()}`,
    appUser: APP_USER,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    gid: typeof process.getgid === 'function' ? process.getgid() : null,
    runsAsRoot: isRoot,
    dataDir: DATA_DIR,
    multiRoot: multiRoot(),
    /* 访问模式：1.0.7 起只有 root；scoped 仅作应急（见 server/index.mjs 顶部说明） */
    accessMode: UNRESTRICTED ? 'root' : 'scoped',
    unrestricted: UNRESTRICTED,
    /** 图纸库顶层的浏览根：各个存储空间（「存储空间 1」「存储空间 2」…） */
    sources,
    storageRoots: detectStorageRoots(),
    /** 应急模式用的白名单（正常模式下仅作回显） */
    rawRoots: allowedRoots(),
    runUsername: process.env.TRIM_RUN_USERNAME || '',
    env: {
      rawAccessiblePaths: process.env.TRIM_DATA_ACCESSIBLE_PATHS || '',
      rawSharePaths: process.env.TRIM_DATA_SHARE_PATHS || '',
      rawAllowPrefixes: process.env.ALLOW_PREFIXES || '',
      accessMode: ACCESS_MODE_ENV,
      volRoots: process.env.FNOS_VOL_ROOTS || ''
    },
    roots: [],
    ancestors: [],
    fixCommands: [],
    hints: []
  }

  const seenAncestors = new Set()

  for (const src of sources) {
    const info = await inspectPath(src.path)
    info.label = src.label

    // 只在"读得到"时才去数文件，读不到就交给祖先链条说明原因
    if (info.exists && info.isDir && info.canRead && info.canTraverse) {
      try {
        const entries = await fsp.readdir(src.path, { withFileTypes: true })
        info.entryCount = entries.length
        info.cadFiles = entries.filter((e) => CAD_EXT.has(path.extname(e.name).toLowerCase())).length
        info.listable = true
      } catch (err) {
        info.listable = false
        info.listError = `${err?.code || ''} ${err?.message || err}`.trim()
      }
    } else {
      info.listable = false
    }

    if (!info.listable) {
      // 逐级上溯：第一个"进不去"的目录就是根因所在
      const chain = ancestorChain(src.path)
      const unreachable = []
      for (const level of chain) {
        const lv = await inspectPath(level)
        if (!seenAncestors.has(level)) {
          seenAncestors.add(level)
          report.ancestors.push(lv)
        }
        // 目录本身不算，只看祖先能不能进
        if (level !== src.path && (!lv.exists || !lv.canTraverse)) unreachable.push(level)
      }
      info.blockedBy = unreachable

      // setfacl 只在应急的 scoped 模式下有意义：root 进程的读权限来自身份，
      // 加 ACL 解决不了它遇到的问题（坏挂载、只读介质…），照抄反而容易改坏系统权限。
      if (SCOPED_MODE) {
        const targets = [...new Set([...unreachable, src.path])]
        for (const t of targets) report.fixCommands.push(`sudo setfacl -m u:${APP_USER}:rwx "${t}"`)
        report.fixCommands.push(`sudo setfacl -R -m u:${APP_USER}:rwx "${src.path}"`)
        report.fixCommands.push(`sudo setfacl -R -d -m u:${APP_USER}:rwx "${src.path}"`)
      }
    }

    info.acl = info.exists && SCOPED_MODE ? aclOf(src.path) : ''
    report.roots.push(info)
  }

  if (UNRESTRICTED) {
    if (isRoot) {
      report.hints.push(
        `本服务以 root 身份运行，可以直接读取全部存储空间（${sources.map((s) => s.path).join(' / ')}）—— 不需要授权任何目录。`
      )
    } else {
      /*
       * 声明了全盘模式、进程却不是 root（Windows 上开发、或系统没让 root 生效）。
       * 必须点出来：否则用户读不到文件时会以为"图纸库漏了东西"。
       */
      report.hints.push(
        `注意：服务进程实际以 ${APP_USER}（uid ${report.uid ?? '-'}）运行，不是 root，` +
          '所以能读到的只有这个账号本身有权限的目录。飞牛上安装包是 root 权限版（config/privilege 里 run-as: root），' +
          '若这里仍然显示非 root，请确认装的是最新包并重启过应用。'
      )
    }
  } else {
    report.hints.push(
      `当前处于应急的「按目录白名单」模式（FNOS_ACCESS_MODE=${ACCESS_MODE_ENV}）：` +
        `只有 ${report.rawRoots.join(' / ') || '（白名单为空）'} 能被读取。正常情况下不需要这个开关。`
    )
  }

  if (report.fixCommands.length) {
    report.hints.push(
      `本服务以系统账号 ${APP_USER} 运行，而图纸通常属于你本人的账号 —— 应用账号必须在目标目录上有权限才读得到。` +
        'SSH 登录飞牛后执行下面 list 里的命令即可：'
    )
  }

  report.fixCommands = [...new Set(report.fixCommands)]
  return report
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url
  const source = searchParams.get('source') === 'webdav' ? 'webdav' : 'local'
  const headOnly = req.method === 'HEAD'

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, app: 'fnos-dwg-viewer', version: APP_VERSION, node: process.version })
  }

  if (pathname === '/api/config') {
    const cfg = getDavConfig(req)
    const roots = allowedRoots()
    const multi = multiRoot()
    return sendJson(res, 200, {
      port: PORT,
      version: APP_VERSION,
      multiRoot: multi,
      localRoot: LOCAL_ROOT || '',
      /** 面包屑在顶层显示的叫法（进去之后显示真实路径） */
      localRootName: multi ? '存储空间' : path.basename(LOCAL_ROOT || ROOT) || '本机',
      allowedRoots: roots,
      /** 图纸库顶层的浏览根：各个存储空间（「存储空间 1」「存储空间 2」…） */
      sources: browseSources(),
      defaultSource: cfg.url ? 'webdav' : 'local',
      /* ---- 运行模式：1.0.7 起只有 root，scoped 仅应急 ---- */
      accessMode: UNRESTRICTED ? 'root' : 'scoped',
      unrestricted: UNRESTRICTED,
      /** 探测到的存储空间挂载点（/vol1 …），排障用 */
      storageRoots: detectStorageRoots(),
      /* 权限自检要用到的身份信息 */
      appUser: APP_USER,
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      runsAsRoot: IS_ROOT,
      /** 飞牛告诉我们的运行账号名（排障用，和 os.userInfo 可能不一致） */
      runUsername: process.env.TRIM_RUN_USERNAME || '',
      dataDir: DATA_DIR,
      /* 排障用：把飞牛传下来的原始环境变量一并回显，出问题时看一眼就清楚 */
      env: {
        rawAllowPrefixes: process.env.ALLOW_PREFIXES || '',
        rawAccessiblePaths: process.env.TRIM_DATA_ACCESSIBLE_PATHS || '',
        rawSharePaths: process.env.TRIM_DATA_SHARE_PATHS || '',
        accessMode: ACCESS_MODE_ENV,
        volRoots: process.env.FNOS_VOL_ROOTS || ''
      },
      webdav: {
        configured: Boolean(cfg.url),
        url: cfg.url ? maskUrl(cfg.url) : '',
        user: cfg.user,
        remembered: Boolean(davSession?.url),
        fromEnv: Boolean(process.env.FNOS_URL)
      }
    })
  }

  /** 权限自检：一把梭把所有可能的原因一次性查清楚 */
  if (pathname === '/api/doctor') {
    return sendJson(res, 200, await buildDoctorReport())
  }

  /*
   * 说明：1.0.7 之前这里有一个 /api/grant（运行期"按需授权"）接口，
   * 用来把飞牛宿主当场授权的目录补进服务白名单。现在进程本身就是 root、
   * 全盘直读，白名单已经没有任何拦截作用，这个接口连同前端那套
   * 「从飞牛选择文件夹」按钮一起删掉了。
   */

  // WebDAV 连接信息：GET 看状态 / POST 保存并立即验证 / DELETE 断开
  if (pathname === '/api/session') {
    if (req.method === 'GET') {
      const cfg = getDavConfig(req)
      return sendJson(res, 200, {
        configured: Boolean(cfg.url),
        url: cfg.url ? maskUrl(cfg.url) : '',
        user: cfg.user,
        remembered: Boolean(davSession?.url)
      })
    }

    if (req.method === 'POST') {
      const { url: rawUrl, user, pass, remember = true } = await readJsonBody(req)
      const davUrl = normalizeDavUrl(rawUrl)
      if (!davUrl) {
        return sendJson(res, 400, {
          error: '地址填写不正确。可以只写 IP:端口（如 192.168.1.10:5005），也可以写完整的 https 地址。',
          code: 'WEBDAV'
        })
      }
      davSession = { url: davUrl, user: String(user ?? '').trim(), pass: String(pass ?? '') }
      try {
        // 立刻验证一次，避免前端"以为连上了"
        const probe = await listWebdav(getDavConfig(req), '/')
        if (remember) saveDavSession()
        return sendJson(res, 200, { ok: true, root: probe.path, count: probe.items.length, url: davUrl })
      } catch (err) {
        davSession = null
        const api = err instanceof ApiError ? err : new ApiError(400, 'WEBDAV', String(err?.message || err))
        return sendJson(res, api.status === 401 ? 401 : 400, { error: api.message, code: api.code })
      }
    }

    if (req.method === 'DELETE') {
      davSession = null
      try {
        fs.rmSync(DAV_STORE, { force: true })
      } catch {
        /* 删不掉也不影响使用 */
      }
      return sendJson(res, 200, { ok: true })
    }
  }

  if (pathname === '/api/list') {
    const p = searchParams.get('path') || '/'
    const data = source === 'webdav' ? await listWebdav(getDavConfig(req), p) : await listLocal(p)
    return sendJson(res, 200, data)
  }

  /**
   * 打开前的预检：只做权限与存在性检查，不返回内容。
   *
   * 前端拿到 ?path= 之后先问一次这里，被拒时就能显示"去授权"的指引，
   * 而不是把裸 URL 丢给查看器、由它抛一句看不懂的错误。
   */
  if (pathname === '/api/probe') {
    const p = searchParams.get('path') || ''
    if (!p) return sendJson(res, 400, { error: '缺少 path 参数' })
    if (source === 'webdav') {
      const info = await probeWebdav(getDavConfig(req), p)
      return sendJson(res, 200, { ok: true, source, path: p, ...info })
    }
    const abs = await resolveLocalPath(p, 'file')
    let st
    try {
      st = await fsp.stat(abs)
    } catch (err) {
      throw toApiError(err, abs)
    }
    if (!st.isFile()) throw new ApiError(400, 'NOT_A_FILE', '这是一个目录，不是图纸文件')
    return sendJson(res, 200, {
      ok: true,
      source,
      // 回传「修正后」的路径与文件名：客户端据此纠正面包屑 / 显示名，
      // 例如请求里带着百分号编码时，这里给的是解码后的真实文件名。
      path: toClientPath(abs),
      name: path.basename(abs),
      size: st.size,
      ext: path.extname(abs).toLowerCase()
    })
  }

  // /api/file 与 /api/file/<文件名>
  // 文件名只是为了满足查看器"按 URL 后缀判断类型"的规则，真正读哪个文件看 path 参数
  if (pathname === '/api/file' || pathname.startsWith('/api/file/')) {
    const p = searchParams.get('path') || '/'
    if (source === 'webdav') return void (await streamWebdav(getDavConfig(req), p, res, headOnly))
    return void (await streamLocal(p, res, headOnly))
  }

  return sendJson(res, 404, { error: '接口不存在：' + pathname })
}

const server = http.createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url, 'http://localhost')
  } catch {
    return sendJson(res, 400, { error: '非法请求地址' })
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url)
      return
    }

    if (await serveStatic(req, res, url.pathname)) return

    // SPA 兜底：把 /open?path=... 之类的路径交给前端路由
    if (req.method === 'GET' || req.method === 'HEAD') {
      const indexPath = path.join(distDir, 'index.html')
      if (fs.existsSync(indexPath)) {
        const html = await fsp.readFile(indexPath)
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(html.length),
          'Cache-Control': 'no-cache'
        })
        return res.end(req.method === 'HEAD' ? undefined : html)
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end('<h2>前端尚未构建</h2><p>请先执行 <code>npm run build</code>。</p>')
    }

    sendJson(res, 404, { error: 'Not Found' })
  } catch (err) {
    if (res.headersSent) {
      res.end()
      return
    }
    const api = err instanceof ApiError ? err : toApiError(err)
    if (url.pathname.startsWith('/api/')) {
      const payload = { error: api.message, code: api.code, ...api.extra }
      if (api.status >= 500) console.error('[api]', api.code, api.message)
      sendJson(res, api.status, payload)
    } else {
      res.writeHead(api.status, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('服务器错误：' + api.message)
    }
  }
})

/**
 * PID 文件由服务自己写。
 *
 * cmd/main 里的 `$!` 在 `nohup setsid node … &` 这种写法下拿到的可能是
 * 立刻退出的壳进程，pid 一旦是错的，应用中心就会判定"服务没在跑"，
 * 显示成已停用。让真正在监听的进程写自己的 pid，状态判断才可靠。
 */
const PID_FILE = process.env.FNOS_PID_FILE || ''

function writePidFile() {
  if (!PID_FILE) return
  try {
    fs.writeFileSync(PID_FILE, String(process.pid))
  } catch (err) {
    console.warn('[warn] 写 PID 文件失败：' + (err?.message || err))
  }
}

function clearPidFile() {
  if (!PID_FILE) return
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.rmSync(PID_FILE, { force: true })
  } catch {
    /* 文件没了也无所谓 */
  }
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    clearPidFile()
    server.close()
    setTimeout(() => process.exit(0), 300).unref()
  })
}

server.listen(PORT, HOST, () => {
  writePidFile()
  const uid = typeof process.getuid === 'function' ? process.getuid() : '-'
  console.log(`\n  fnOS CAD 看图 v${APP_VERSION}  →  http://localhost:${PORT}`)
  console.log(`  运行账号 ${APP_USER || '(未知)'}  uid=${uid}`)
  if (UNRESTRICTED) {
    if (IS_ROOT) {
      console.log('  访问模式：root（全部存储空间直读，不需要授权任何目录）')
    } else {
      // Windows 上开发、或系统没让 root 生效时走这里：说清楚"读得到的只有这个账号有权限的部分"
      console.log('  ⚠ 访问模式声明为全盘，但进程不是 root —— 只能读到当前账号有权限的目录。')
    }
    console.log('  可浏览的存储空间：')
    const sources = browseSources()
    for (const src of sources) {
      let note = ''
      try {
        fs.accessSync(src.path, fs.constants.R_OK | fs.constants.X_OK)
      } catch {
        note = '   ← 当前账号读不进去（见 /api/doctor）'
      }
      console.log(`    · ${src.label}  →  ${src.path}${note}`)
    }
    if (!sources.length) console.log(`    (未找到飞牛存储空间，退回单根：${LOCAL_ROOT || ROOT})`)
    console.log('')
  } else if (multiRoot()) {
    console.log(`  应急模式（FNOS_ACCESS_MODE=${ACCESS_MODE_ENV}）：只按下面的白名单放行`)
    console.log('  可浏览目录：')
    for (const root of allowedRoots()) {
      let note = ''
      try {
        const st = fs.statSync(root)
        // 目录存在 ≠ 读得到：在飞牛上这两件事经常不一致，日志里先点出来
        try {
          fs.accessSync(root, fs.constants.R_OK | fs.constants.X_OK)
          note = st.isDirectory() ? '' : '   ← 不是目录'
        } catch {
          note = '   ← 存在但当前账号读不进去（见 /api/doctor）'
        }
      } catch {
        note = '   ← 不存在，已忽略'
      }
      console.log(`    · ${root}${note}`)
    }
    if (allowedRoots().length === 0) console.log('    (白名单为空)')
    console.log('')
  } else {
    console.log(`  本机浏览根目录 →  ${LOCAL_ROOT || ROOT}\n`)
  }
})
