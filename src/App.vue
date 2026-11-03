<script setup lang="ts">
import { ref } from 'vue'
import { MlCadViewer } from '@mlightcad/cad-viewer'
import { AcApOpenViewMode, AcEdOpenMode } from '@mlightcad/cad-simple-viewer'
import { ApiError, api } from './api'

interface OpenTarget {
  name: string
  path: string
  source: string
}

interface ViewerError {
  title: string
  detail: string
  raw: string
  focus: string
  steps: string[]
}

const params = new URLSearchParams(window.location.search)
const initialPath = params.get('path') || ''
const initialName = initialPath ? initialPath.split('/').pop() || initialPath : ''

const url = ref<string | undefined>(undefined)
const loading = ref(false)
const copied = ref(false)
const error = ref<ViewerError | null>(null)

/** 最近一次「要打开的目标」：重试时用它，而不是当前已修正的 URL */
let lastTarget: OpenTarget | null = null

function describeError(err: unknown): ViewerError {
  const apiErr = err instanceof ApiError ? err : new ApiError(0, 'INTERNAL', String((err as any)?.message || err))
  const focus = apiErr.path || ''

  if (apiErr.code === 'OUT_OF_SCOPE') {
    return {
      title: '打不开：这个位置不在可访问范围内',
      detail:
        '当前服务运行在应急的「按目录白名单」模式下（正常安装不会这样）。请把服务端的 FNOS_ACCESS_MODE 去掉并重启应用，即可恢复读取全部存储空间。',
      raw: apiErr.message,
      focus,
      steps: [
        '① 到应用中心把「CAD 看图」停止再启动一次',
        '② 仍然如此：查看 /api/doctor 里的访问模式与白名单，确认没有设置 FNOS_ACCESS_MODE=scoped'
      ]
    }
  }

  if (apiErr.code === 'EACCES') {
    return {
      title: '打不开：这个位置读不进去',
      detail:
        '文件存在，但系统没有把读取权限给到本应用。常见原因是这个位置所在的磁盘/共享是只读的、已断开，或者尚未挂载完成。',
      raw: apiErr.message,
      focus: apiErr.fixCommand || focus,
      steps: apiErr.fixCommand
        ? ['① 按上面的命令在 SSH 里补一次权限（-R 是关键）', '② 确认该存储空间 / 外接盘已正常挂载，再点下面的「重试」']
        : [
            '① 到「系统设置 → 存储空间管理」确认这个存储空间状态正常（不是已卸载/已降级）',
            '② 外接盘 / 远程挂载的话，确认设备已插好、连接没有断开',
            '③ 确认完后点下面的「重试」'
          ]
    }
  }

  if (apiErr.code === 'NOT_FOUND') {
    return {
      title: '打不开：文件不存在',
      detail: '文件可能已被移动、重命名或删除。',
      raw: apiErr.message,
      focus,
      steps: ['回文件管理器确认这个文件还在原处，然后重新双击打开']
    }
  }

  if (apiErr.code === 'NOT_A_FILE') {
    return {
      title: '打不开：这是一个目录',
      detail: '请选择 .dwg / .dxf 图纸文件。',
      raw: apiErr.message,
      focus,
      steps: []
    }
  }

  return {
    title: '打不开这张图纸',
    detail: '读取文件时出错了。',
    raw: apiErr.message,
    focus,
    steps: ['确认文件是 .dwg / .dxf 格式且未损坏', '如果图纸在内网的其他位置，检查网络是否可达']
  }
}

async function open(name: string, path: string, source: string): Promise<void> {
  lastTarget = { name, path, source }
  loading.value = true
  error.value = null
  try {
    const info = await api.probe(source, path)
    const fixedPath = info.path || path
    const fixedName = info.name || name
    lastTarget = { name: fixedName, path: fixedPath, source }
    url.value = api.fileUrl(source, fixedPath)
  } catch (err) {
    url.value = undefined
    error.value = describeError(err)
  } finally {
    loading.value = false
  }
}

function retry(): void {
  if (!lastTarget) return
  void open(lastTarget.name, lastTarget.path, lastTarget.source)
}

async function copyFocus(): Promise<void> {
  const text = error.value?.focus
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    try {
      document.execCommand('copy')
    } catch {
      /* 复制失败也不影响阅读 */
    }
    document.body.removeChild(textarea)
  }
  copied.value = true
  window.setTimeout(() => {
    copied.value = false
  }, 1800)
}

if (initialPath) void open(initialName, initialPath, 'local')
</script>

<template>
  <div class="app">
    <div class="viewer">
      <MlCadViewer
        :url="url"
        :mode="AcEdOpenMode.Write"
        :open-view-mode="AcApOpenViewMode.Extents"
        :progressive-rendering="true"
        theme="dark"
        :background="0x1a1e24"
      />
    </div>

    <div v-if="error" class="blocker">
      <section class="card">
        <h3><span class="warn">!</span>{{ error.title }}</h3>
        <p class="detail">{{ error.detail }}</p>
        <div v-if="error.focus" class="focus">
          <code :title="error.focus">{{ error.focus }}</code>
          <button class="mini" @click="copyFocus">{{ copied ? '已复制' : '复制' }}</button>
        </div>
        <ol v-if="error.steps.length" class="steps">
          <li v-for="(step, index) in error.steps" :key="index">{{ step }}</li>
        </ol>
        <p class="raw">{{ error.raw }}</p>
        <div class="acts">
          <button class="primary" :disabled="loading" @click="retry">{{ loading ? '重试中…' : '重试' }}</button>
        </div>
      </section>
    </div>

    <div v-else-if="!initialPath" class="blocker">
      <section class="card intro">
        <h3><span class="info">i</span>没有指定要打开的图纸</h3>
        <p class="detail">
          本应用只用来打开图纸：在飞牛的「文件管理」里双击（或右键选「用 CAD 看图打开」）
          任意 .dwg / .dxf 文件即可。
        </p>
        <p class="raw">支持 DWG / DXF。打开后可用图层开关、测量、导出 PDF / SVG / HTML —— 这些都在图面自己的工具栏里。</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.app {
  position: fixed;
  inset: 0;
  overflow: hidden;
}

.viewer {
  position: absolute;
  inset: 0;
}

.blocker {
  position: absolute;
  inset: 0;
  z-index: 2147482500;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: #0c0f13d1;
  backdrop-filter: blur(3px);
}

.card {
  width: min(520px, 100%);
  max-height: 100%;
  padding: 20px 22px;
  overflow: auto;
  color: #dfe5ec;
  background: #22272f;
  border: 1px solid #3a424e;
  border-radius: 12px;
  box-shadow: 0 18px 50px #0000008c;
}

.card h3 {
  display: flex;
  gap: 9px;
  align-items: center;
  margin: 0 0 10px;
  font-size: 15px;
  color: #fff;
}

.warn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  font-size: 13px;
  font-weight: 700;
  color: #1b1f25;
  background: #ffc857;
  border-radius: 50%;
}

.info {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  font-size: 12px;
  font-weight: 700;
  color: #0f1620;
  background: #6fb1ff;
  border-radius: 50%;
}

.intro {
  text-align: left;
}

.detail {
  margin: 0 0 14px;
  font-size: 12.5px;
  line-height: 1.75;
  color: #a9b3bf;
}

.focus {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 14px;
}

.focus code {
  flex: 1;
  padding: 8px 10px;
  overflow: hidden;
  font-size: 12px;
  color: #8fd0ff;
  white-space: nowrap;
  text-overflow: ellipsis;
  background: #191d23;
  border: 1px solid #333a45;
  border-radius: 7px;
}

.mini {
  flex: none;
  padding: 8px 12px;
  font-size: 12px;
  color: #cfd7e1;
  background: #2d343d;
  border: 1px solid #3d4551;
  border-radius: 7px;
  cursor: pointer;
}

.mini:hover {
  color: #fff;
  background: #363e49;
}

.steps {
  margin: 0 0 14px;
  padding-left: 20px;
  font-size: 12.5px;
  line-height: 1.9;
  color: #c6cedb;
}

.raw {
  margin: 0 0 16px;
  padding-top: 12px;
  font-size: 11px;
  line-height: 1.7;
  color: #6f7985;
  word-break: break-all;
  border-top: 1px dashed #363d47;
}

.intro .raw {
  margin-bottom: 0;
}

.acts {
  display: flex;
  gap: 9px;
  justify-content: flex-end;
}

.acts button {
  padding: 9px 16px;
  font-size: 12.5px;
  border-radius: 8px;
  cursor: pointer;
}

.primary {
  color: #fff;
  background: #2f6feb;
  border: 1px solid #2f6feb;
}

.primary:hover {
  background: #3b7bf5;
}

.primary:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
