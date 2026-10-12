/**
 * 服务端接口的最小封装。
 *
 * 1.0.9 起这里只剩两个调用：**预检**（probe）和**取文件地址**（fileUrl）。
 * 「图纸库」文件浏览那套（list / session / 诊断面板）随抽屉一起删掉了 ——
 * 服务端的 /api/list、/api/session、/api/doctor 仍在（排障时可以直接用
 * 浏览器或 curl 访问），但本应用不再从界面上调用它们。
 */

/**
 * 数据源。
 *
 * 界面上现在只会用 'local'（'webdav' 曾经是"授权目录读不到"的备用通道，
 * 1.0.7 改为 root 直读之后就不需要了）。类型里保留它是因为**服务端仍然支持**，
 * 手工带 ?source=webdav 还能用。
 */
export type SourceKind = 'local' | 'webdav'

/** 后端返回的机器可读错误码，决定前端展示哪一段排错指引 */
export type ApiErrorCode =
  | 'OUT_OF_SCOPE'
  | 'EACCES'
  | 'NOT_FOUND'
  | 'NOT_A_FILE'
  | 'WEBDAV'
  | 'INTERNAL'
  | string

export class ApiError extends Error {
  status: number
  code: ApiErrorCode
  path?: string
  allowedRoots?: string[]
  /** 权限不足时后端给出的「一键修复命令」（应急模式才会有） */
  fixCommand?: string
  appUser?: string

  constructor(message: string, status = 0, code: ApiErrorCode = 'INTERNAL', body?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.path = typeof body?.path === 'string' ? body.path : undefined
    this.allowedRoots = Array.isArray(body?.allowedRoots) ? (body.allowedRoots as string[]) : undefined
    this.fixCommand = typeof body?.fixCommand === 'string' ? body.fixCommand : undefined
    this.appUser = typeof body?.appUser === 'string' ? body.appUser : undefined
  }
}

async function unwrap<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    let body: Record<string, unknown> | null = null
    try {
      body = await resp.json()
    } catch {
      /* 非 JSON 响应，保留原始信息 */
    }
    const message =
      (typeof body?.error === 'string' && body.error) || `${resp.status} ${resp.statusText || '请求失败'}`
    throw new ApiError(message, resp.status, (body?.code as ApiErrorCode) || 'INTERNAL', body ?? {})
  }
  return (await resp.json()) as T
}

export const api = {
  /**
   * 打开前的预检：只验存在性与类型，不返回内容。
   *
   * 为什么不直接把 URL 丢给查看器：查看器拿到 404/403 只会把整条 URL 抛出来
   * （"无法打开 http://…"），用户完全看不出发生了什么。先问一次，
   * 就能换成可操作的指引。
   *
   * 返回的 `path`/`name` 是**服务端修正过**的：文件管理器偶尔会传来
   * 百分号编码过的路径，服务端会把它们还原成真实路径与真实文件名，
   * 前端拿这个覆盖显示即可。
   */
  probe: (source: SourceKind, p: string) =>
    fetch(`/api/probe?source=${source}&path=${encodeURIComponent(p)}`).then((r) =>
      unwrap<{ ok: true; source: SourceKind; path: string; name?: string; size?: number; isDir?: boolean }>(r)
    ),

  /**
   * 交给 CAD 查看器自己 fetch 的地址（同源，无 CORS 问题）。
   *
   * 两个坑：
   *  1) 查看器内部用 `new URL(uri)` 解析且不带 base，必须给绝对地址；
   *  2) 查看器按 URL 后缀判断文件类型，所以路径末位必须是真实文件名（.dwg/.dxf），
   *     真正读哪个文件由 `path` 参数决定。
   *
   * 末段用 encodeURIComponent 是必须的（URL 里不能裸放中文）。副作用是查看器
   * 的标题栏会显示成 "%E5%9B%BE…" —— 它在 getFileNameFromUri 里只取
   * pathname 末段、不做解码。这个只能在 main.ts 里给 AcApDocument 的
   * fileName / docTitle 取值器套一层解码来解决，别试图在这里换别的编码方式。
   */
  fileUrl: (source: SourceKind, p: string) => {
    const name = p.split('/').pop() || 'drawing.dxf'
    return new URL(
      `/api/file/${encodeURIComponent(name)}?source=${source}&path=${encodeURIComponent(p)}`,
      window.location.origin
    ).href
  }
}
