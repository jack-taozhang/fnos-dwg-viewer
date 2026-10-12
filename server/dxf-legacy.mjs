/**
 * 老式 DXF（R12 / AC1009 及更早）兼容层
 *
 * 为什么需要它
 * ------------
 * `@mlightcad/data-model` 的 `AcDbEntity.dxfInFields` 逻辑是这样写的：
 *
 *   if (!filer.atSubclassData('AcDbEntity')) {
 *     const next = filer.peekItem()
 *     if (next && Number(next.code) === 100) return this   // 只有下一个是 100 才提前返回
 *   }
 *   while (!filer.atEndOfObject) { ...只认识 8/6/62/370… }   // 否则吞到对象结束
 *
 * R12 及更早的 DXF **没有 100 子类标记**（子类标记从 R13/AC1012 才引入）。
 * 于是基类这个循环会把后面本属于子类的组码全部当"未知码"吃掉：
 * LINE 的 10/20/11/21、CIRCLE 的 40、TEXT 的 1/40 … 统统丢失，
 * 结果就是所有图元的几何都变成默认值（顶点全 0、半径 1），
 * 在查看器里表现为"只画出一个单位圆"。
 *
 * 这个模块在把 DXF 交给前端之前，按 DXF 规范把这些缺失的 100 标记补回去，
 * 不改动任何数值。判定是**逐条记录**做的：已经带 100 的记录原样保留，
 * 整份文件无需改动时逐字节返回原内容，所以现代 DXF（R2000+）完全不受影响。
 *
 * 组码分类依据（与库源码逐条对齐，不是猜的）：
 *  · OBJECT_PREFIX_CODES：AcDbObject.dxfIn 消费的 handle / owner / 控制串
 *  · ENTITY_COMMON_CODES：AcDbEntity.dxfInFields 消费的公共实体字段
 *  · 其余组码一律留给子类读取器，必须排在 100 AcDb<子类> 之后
 *  · 1001+ 是扩展数据（XData），天然排在最后
 */
import { Buffer } from 'node:buffer'

/** AcDbObject.dxfIn 认识的组码，必须排在记录最前面 */
const OBJECT_PREFIX_CODES = new Set([5, 102, 105, 330, 360])

/** AcDbEntity.dxfInFields 认识的组码，必须排在 100 AcDbEntity 之前 */
const ENTITY_COMMON_CODES = new Set([
  6, 8, 48, 60, 62, 67, 92, 160, 284, 310, 347, 370, 380, 390, 410, 420, 430, 440
])

/**
 * 各实体类型应补的子类标记，顺序即 DXF 写出顺序。
 * 取自各实体 `dxfOutFields` 里的 `writeSubclassMarker(...)` 调用序列。
 * 表里没有的类型原样透传 —— 宁可不处理，也不乱改。
 */
const ENTITY_SUBCLASS = {
  LINE: ['AcDbLine'],
  CIRCLE: ['AcDbCircle'],
  ARC: ['AcDbCircle', 'AcDbArc'],
  TEXT: ['AcDbText'],
  MTEXT: ['AcDbMText'],
  POINT: ['AcDbPoint'],
  ELLIPSE: ['AcDbEllipse'],
  SPLINE: ['AcDbSpline'],
  INSERT: ['AcDbBlockReference'],
  LWPOLYLINE: ['AcDbPolyline'],
  SOLID: ['AcDbTrace'],
  TRACE: ['AcDbTrace'],
  '3DFACE': ['AcDbFace'],
  RAY: ['AcDbRay'],
  XLINE: ['AcDbXline'],
  SHAPE: ['AcDbShape'],
  VIEWPORT: ['AcDbViewport'],
  ATTRIB: ['AcDbAttribute'],
  ATTDEF: ['AcDbAttributeDefinition'],
  LEADER: ['AcDbLeader'],
  HATCH: ['AcDbHatch'],
  '3DSOLID': ['AcDb3dSolid'],
  IMAGE: ['AcDbRasterImage'],
  WIPEOUT: ['AcDbRasterImage'],
  ACAD_PROXY_ENTITY: ['AcDbProxyEntity'],
  OLE2FRAME: ['AcDbOle2Frame'],
  OLEFRAME: ['AcDbOleFrame'],
  MLINE: ['AcDbMLine'],
  MULTILEADER: ['AcDbMLeader'],
  MLEADER: ['AcDbMLeader'],
  ACAD_TABLE: ['AcDbTable'],
  ARCALIGNEDTEXT: ['AcDbArcAlignedText'],
  TOLERANCE: ['AcDbFcf']
}

/**
 * 这些记录不走 `entity.dxfIn`，由专门的分支解析，
 * 注入 100 标记反而可能节外生枝，直接跳过。
 */
const SKIP_TYPES = new Set([
  'POLYLINE',
  'VERTEX',
  'SEQEND',
  'DIMENSION',
  'BLOCK',
  'ENDBLK',
  'SECTION',
  'ENDSEC',
  'EOF',
  'CLASS',
  'TABLE',
  'ENDTAB'
])

/** 需要处理的段：图元只可能出现在这两段里 */
const TARGET_SECTIONS = new Set(['ENTITIES', 'BLOCKS'])

const BINARY_DXF_MAGIC = 'AutoCAD Binary DXF\r\n\x1a\x00'

export function isBinaryDxf(buffer) {
  if (buffer.length < BINARY_DXF_MAGIC.length) return false
  return buffer.toString('latin1', 0, BINARY_DXF_MAGIC.length) === BINARY_DXF_MAGIC
}

/** 按行切分并保留每行原本的换行符，回写时逐字节还原 */
function splitLines(text) {
  const out = []
  let i = 0
  while (i < text.length) {
    let j = i
    while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j++
    const content = text.slice(i, j)
    let eol = ''
    if (j < text.length) {
      if (text[j] === '\r' && text[j + 1] === '\n') {
        eol = '\r\n'
        j += 2
      } else {
        eol = text[j]
        j += 1
      }
    }
    out.push({ content, eol })
    i = j
  }
  return out
}

function pickEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length
  const lfTotal = (text.match(/\n/g) || []).length
  return crlf > 0 && crlf >= lfTotal - crlf ? '\r\n' : '\n'
}

function makePair(code, value, eol) {
  const codeLine = { content: String(code), eol }
  return { code: String(code), codeLine, valueLine: { content: String(value), eol } }
}

function pairCode(pair) {
  return Number(pair.code)
}

function pairValue(pair) {
  return pair.valueLine.content.trim()
}

/** 原样回写一对组码；注入的新行用各自的默认换行 */
function render(pair) {
  const codeLine = pair.codeLine || { content: pair.code, eol: '' }
  return codeLine.content + codeLine.eol + pair.valueLine.content + pair.valueLine.eol
}

/** 给一条记录补上 100 AcDbEntity / 100 AcDb<子类>；已带标记的记录原样返回 */
function transformRecord(type, record, eol) {
  const markers = ENTITY_SUBCLASS[type]
  if (!markers) return record
  if (record.some((p) => pairCode(p) === 100)) return record

  const prefix = []
  const common = []
  const specific = []
  for (const pair of record) {
    const code = pairCode(pair)
    if (OBJECT_PREFIX_CODES.has(code)) prefix.push(pair)
    else if (ENTITY_COMMON_CODES.has(code)) common.push(pair)
    else specific.push(pair)
  }

  return [
    ...prefix,
    ...common,
    makePair(100, 'AcDbEntity', eol),
    ...markers.map((name) => makePair(100, name, eol)),
    ...specific
  ]
}

function normalizeText(text) {
  const lines = splitLines(text)
  const eol = pickEol(text)

  const pairs = []
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push({
      code: lines[i].content.trim(),
      codeLine: lines[i],
      valueLine: lines[i + 1]
    })
  }
  // 行数为奇数时最后一行无法配对，原样挂回尾部
  const oddTail = lines.length % 2 === 1 ? lines[lines.length - 1] : null

  const out = []
  let section = null
  let i = 0
  while (i < pairs.length) {
    const pair = pairs[i]
    if (pairCode(pair) !== 0) {
      // 正常文件里不会出现游离的非 0 组码，原样透传
      out.push(pair)
      i += 1
      continue
    }

    const type = pairValue(pair).toUpperCase()
    let j = i + 1
    while (j < pairs.length && pairCode(pairs[j]) !== 0) j++
    const record = pairs.slice(i + 1, j)

    if (type === 'SECTION') {
      const namePair = record.find((p) => pairCode(p) === 2)
      section = namePair ? pairValue(namePair).toUpperCase() : null
      out.push(pair, ...record)
    } else if (type === 'ENDSEC') {
      section = null
      out.push(pair, ...record)
    } else if (TARGET_SECTIONS.has(section) && !SKIP_TYPES.has(type)) {
      out.push(pair, ...transformRecord(type, record, eol))
    } else {
      out.push(pair, ...record)
    }
    i = j
  }

  let result = out.map(render).join('')
  if (oddTail) result += oddTail.content + oddTail.eol
  return result
}

/**
 * 把老式 DXF 补全成带子类标记的形式。
 *
 * @param {Buffer} buffer 原始文件内容
 * @param {{ maxBytes?: number }} [options] 超过体积上限直接放弃处理，避免大文件被整体读进内存
 * @returns {Buffer} 处理后的内容；无需处理时返回原 buffer
 */
export function normalizeLegacyDxf(buffer, options = {}) {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return buffer
  if (buffer.length > maxBytes) return buffer
  if (isBinaryDxf(buffer)) return buffer

  // latin1 是逐字节映射，任何代码页（GBK/UTF-8/Big5…）都能无损往返
  const text = buffer.toString('latin1')
  let normalized
  try {
    normalized = normalizeText(text)
  } catch {
    // 兼容层永远不该影响"图能不能打开"，异常时退回原始内容
    return buffer
  }
  if (!normalized || normalized === text) return buffer
  return Buffer.from(normalized, 'latin1')
}
