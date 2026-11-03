/**
 * 与 fnOS 后端（server/index.mjs）通信的极薄客户端。
 *
 * 后端返回的错误统一是 `{ error, code, path?, fixCommand? }`，这里保留
 * status / code / 附加字段，App.vue 才能按 code 决定显示哪段排障指引。
 */
export class ApiError extends Error {
  status: number
  code: string
  path?: string
  fixCommand?: string

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.path = typeof extra.path === 'string' ? extra.path : undefined
    this.fixCommand = typeof extra.fixCommand === 'string' ? extra.fixCommand : undefined
  }
}

export interface ProbeResult {
  ok: boolean
  source: string
  path: string
  name: string
  size: number
  ext: string
}

async function parseResponse(res: Response): Promise<any> {
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.code || 'INTERNAL',
      body?.error || `${res.status} ${res.statusText || '请求失败'}`,
      body || {}
    )
  }
  return body
}

export const api = {
  probe(source: string, path: string): Promise<ProbeResult> {
    return fetch(`/api/probe?source=${source}&path=${encodeURIComponent(path)}`).then(parseResponse)
  },

  /**
   * 预览地址里带一个看起来像文件的路径，满足查看器「按 URL 后缀判断类型」
   * 的规则；真正读哪个文件由 path 参数决定。
   */
  fileUrl(source: string, path: string): string {
    const name = path.split('/').pop() || 'drawing.dxf'
    return new URL(
      `/api/file/${encodeURIComponent(name)}?source=${source}&path=${encodeURIComponent(path)}`,
      window.location.origin
    ).href
  }
}
