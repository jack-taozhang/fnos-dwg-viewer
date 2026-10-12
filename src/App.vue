<template>
  <div class="app">
    <!-- CAD 查看器本体：占满整个视口，自带的 ribbon / 图层 / 命令行都在这里 -->
    <div class="viewer">
      <!--
        为什么是 Write 而不是 Read：
          查看器的 ribbon 标签是**按打开模式过滤的**——源码里那张白名单是
            measurement → 恒显示
            review      → mode >= Review
            其余(常用/插入) → mode === Write
          用 Read 打开就只剩「测量」一个标签，用户看到的就是"菜单不全"。

        open-view-mode 必须显式写成 Extents：
          Write 模式下查看器默认用 Saved（还原图纸里存的视图），
          没有 VPORT 表的图纸会被缩成一个点。显式声明按图纸范围取景。
      -->
      <!--
        progressive-rendering：图元转完就撤掉「正在渲染图纸」遮罩，边转边画。
        默认 false 时会一直等到文字几何也算完，大图纸上遮罩停留很久。
      -->
      <MlCadViewer
        :url="currentUrl"
        :mode="AcEdOpenMode.Write"
        :open-view-mode="AcApOpenViewMode.Extents"
        :progressive-rendering="true"
        theme="dark"
        :background="0x1a1e24"
      />
    </div>

    <!-- 打不开时的可操作指引：比查看器抛出的裸 URL 有用得多 -->
    <div v-if="blocked" class="blocker">
      <section class="card">
        <h3><span class="warn">!</span>{{ blocked.title }}</h3>
        <p class="detail">{{ blocked.detail }}</p>

        <div v-if="blocked.focus" class="focus">
          <code :title="blocked.focus">{{ blocked.focus }}</code>
          <button class="mini" @click="copyFocus">{{ copied ? '已复制' : '复制' }}</button>
        </div>

        <ol v-if="blocked.steps.length" class="steps">
          <li v-for="(s, i) in blocked.steps" :key="i">{{ s }}</li>
        </ol>

        <p class="raw">{{ blocked.raw }}</p>

        <div class="acts">
          <button class="primary" :disabled="loading" @click="retry">
            {{ loading ? '重试中…' : '重试' }}
          </button>
        </div>
      </section>
    </div>

    <!--
      没带 ?path= 时的说明页（比如有人手动敲了地址）。

      ★ 条件用 `!launchPath`（而不是"还没有 url"）：带着 ?path= 进来时
        文件还在解析，那会儿 currentUrl 也还没赋值 —— 用后者会让这张
        卡片先闪一下再被图纸盖掉。有没有 path 在载入前就是确定的。

      ★ 这里曾经是「图纸库」抽屉 —— 1.0.9 起整块删掉了。
        本应用已收窄成纯粹的「打开方式」，入口只有文件管理器里双击这一条；
        再放一个文件树就等于在应用里复刻一个只读的文件管理器（用户已经有
        飞牛自己的文件管理了，那才是这个职责的正主）。同时也就不存在
        "应用内部再套一层导航"的问题。
    -->
    <div v-else-if="!launchPath" class="blocker">
      <section class="card intro">
        <h3><span class="info">i</span>没有指定要打开的图纸</h3>
        <p class="detail">
          本应用只用来打开图纸：在飞牛的「文件管理」里双击（或右键选「用 CAD 看图打开」）
          任意 .dwg / .dxf 文件即可。
        </p>
        <p class="raw">支持 DWG / DXF。打开后可用图层开关、测量、导出 PDF / SVG / HTML ——
          这些都在图面自己的工具栏里。</p>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { MlCadViewer } from '@mlightcad/cad-viewer'
import { AcApOpenViewMode, AcEdOpenMode } from '@mlightcad/cad-simple-viewer'
import { ApiError, api, type SourceKind } from './api'

/**
 * 飞牛文件管理器双击 DWG/DXF 时，会以 ?path=/vol1/… 的形式打开本应用
 * （见 app/ui/config 里的 fileTypes 入口）。
 *
 * 应用已经取消桌面图标，所以正常入口只有这一条；不带 ?path= 进入
 * （手动敲地址）时给一张说明卡片，见模板里的 intro。
 */
const launchPath = new URLSearchParams(window.location.search).get('path') || ''
const launchName = launchPath ? launchPath.split('/').pop() || launchPath : ''

const currentUrl = ref<string | undefined>()
const current = ref<{ name: string; path: string; source: SourceKind } | null>(null)
const loading = ref(false)
const copied = ref(false)

/* 说明：查看器标题栏显示中文文件名的问题在 main.ts 里统一处理（给
 * AcApDocument 的 fileName / docTitle 取值器套一层百分号解码）。 */

interface Blocked {
  title: string
  detail: string
  raw: string
  steps: string[]
  /** 可以直接复制执行的修复命令（应急模式才会有） */
  focus?: string
}

const blocked = ref<Blocked | null>(null)

/** 最近一次尝试打开的目标，供「重试」使用 */
let last: { name: string; path: string; source: SourceKind } | null = null

/**
 * 把后端的错误码翻译成「用户看得懂 + 知道下一步做什么」的指引。
 *
 * 后端 /api/probe 会返回 code，这里按 code 分流。
 * 正常情况下（进程以 root 读全部存储空间）这里几乎不会被触发 ——
 * 只有文件确实不存在、类型不对，或遇到坏挂载 / 只读介质时才会。
 */
function describe(err: unknown): Blocked {
  const e = err instanceof ApiError ? err : new ApiError(String((err as Error)?.message || err))
  const where = e.path || ''

  if (e.code === 'OUT_OF_SCOPE') {
    return {
      title: '打不开：这个位置不在可访问范围内',
      detail:
        '当前服务运行在应急的「按目录白名单」模式下（正常安装不会这样）。' +
        '请把服务端的 FNOS_ACCESS_MODE 去掉并重启应用，即可恢复读取全部存储空间。',
      raw: e.message,
      focus: where,
      steps: [
        '① 到应用中心把「CAD 看图」停止再启动一次',
        '② 仍然如此：查看 /api/doctor 里的访问模式与白名单，确认没有设置 FNOS_ACCESS_MODE=scoped'
      ]
    }
  }

  if (e.code === 'EACCES') {
    return {
      title: '打不开：这个位置读不进去',
      detail:
        '文件存在，但系统没有把读取权限给到本应用。常见原因是这个位置所在的磁盘/共享是只读的、已断开，或者尚未挂载完成。',
      raw: e.message,
      // 应急模式下后端会给一条可复制的 setfacl；有就把它摆在最显眼的位置
      focus: e.fixCommand || where,
      steps: e.fixCommand
        ? [
            '① 按上面的命令在 SSH 里补一次权限（-R 是关键）',
            '② 确认该存储空间 / 外接盘已正常挂载，再点下面的「重试」'
          ]
        : [
            '① 到「系统设置 → 存储空间管理」确认这个存储空间状态正常（不是已卸载/已降级）',
            '② 外接盘 / 远程挂载的话，确认设备已插好、连接没有断开',
            '③ 确认完后点下面的「重试」'
          ]
    }
  }

  if (e.code === 'NOT_FOUND') {
    return {
      title: '打不开：文件不存在',
      detail: '文件可能已被移动、重命名或删除。',
      raw: e.message,
      steps: ['回文件管理器确认这个文件还在原处，然后重新双击打开']
    }
  }

  if (e.code === 'NOT_A_FILE') {
    return {
      title: '打不开：这是一个目录',
      detail: '请选择 .dwg / .dxf 图纸文件。',
      raw: e.message,
      steps: []
    }
  }

  return {
    title: '打不开这张图纸',
    detail: '读取文件时出错了。',
    raw: e.message,
    steps: ['确认文件是 .dwg / .dxf 格式且未损坏', '如果图纸在内网的其他位置，检查网络是否可达']
  }
}

/** 打开前先预检：拿到明确原因，而不是把裸 URL 丢给查看器 */
async function openPath(name: string, p: string, source: SourceKind) {
  last = { name, path: p, source }
  loading.value = true
  blocked.value = null
  try {
    const info = await api.probe(source, p)
    // 用后端修正过的真实路径/文件名（编码还原等）
    const realPath = info.path || p
    const realName = info.name || name
    last = { name: realName, path: realPath, source }
    currentUrl.value = api.fileUrl(source, realPath)
    current.value = { name: realName, path: realPath, source }
  } catch (err) {
    // 保持查看器挂载，只是不再给它新的 url，避免它自己抛那句"无法打开 http://…"
    currentUrl.value = undefined
    current.value = null
    blocked.value = describe(err)
  } finally {
    loading.value = false
  }
}

function retry() {
  if (last) void openPath(last.name, last.path, last.source)
}

/** iframe 里 navigator.clipboard 常被限制，退化到 execCommand */
async function copyFocus() {
  const text = blocked.value?.focus
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
    } catch {
      /* 复制不了也不影响，用户手动抄一下路径 */
    }
    document.body.removeChild(ta)
  }
  copied.value = true
  window.setTimeout(() => (copied.value = false), 1800)
}

/* 文件管理器传来的图纸：直接打开。不带 ?path= 时走模板里的说明卡片。 */
if (launchPath) void openPath(launchName, launchPath, 'local')
</script>

<style scoped>
/*
 * 用 fixed + inset 钉住视口，而不是 height:100%。
 * 宿主（飞牛桌面 iframe / 查看器自带的全局样式）都可能改动 body 的布局方式，
 * 靠百分比高度传递太脆弱 —— 之前就因此把整个抽屉裁没了。
 *
 * 1.0.9 起这里不再有 `drawer-open` 这个状态类：抽屉已删，整页就是图纸。
 */
.app {
  position: fixed;
  inset: 0;
  overflow: hidden;
}

.viewer {
  position: absolute;
  inset: 0;
}

/* ---------- 打开失败 / 使用说明的卡片 ---------- */

.blocker {
  position: absolute;
  inset: 0;
  z-index: 2147482500;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(12, 15, 19, 0.82);
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
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
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

/* 说明卡片用的中性徽标（不是错误） */
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

.intro { text-align: left; }

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

.mini:hover { color: #fff; background: #363e49; }

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

/* 说明卡片里的 raw 是最后一行，不需要再留底部间距 */
.intro .raw { margin-bottom: 0; }

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

.primary:hover { background: #3b7bf5; }

.primary:disabled { opacity: 0.6; cursor: default; }
</style>
