/**
 * 老式 DXF 兼容层自检（见 server/dxf-legacy.mjs）
 *
 * 关注两件事：
 *  1) 缺 100 子类标记的图元，几何组码必须落到 100 AcDb<子类> 之后；
 *  2) 已经带标记的现代 DXF、二进制 DXF 一律原样返回。
 *
 * 用法：npm run test:dxf
 */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { normalizeLegacyDxf, isBinaryDxf } from '../server/dxf-legacy.mjs'

let passed = 0
const check = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

/** 把 DXF 文本按「组码 / 值」解析成便于断言的序列 */
const parse = (text) => {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  const pairs = []
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i].trim() === '') continue
    pairs.push([Number(lines[i]), lines[i + 1]])
  }
  return pairs
}

const legacy = (eol = '\r\n') =>
  [
    '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', 'WALL', '10', '0.0', '20', '0.0', '30', '0.0', '11', '8000.0', '21', '6000.0', '31', '0.0',
    '0', 'CIRCLE', '8', 'FURNITURE', '10', '1800.0', '20', '1600.0', '30', '0.0', '40', '900.0',
    '0', 'ARC', '8', 'DOOR', '10', '4200.0', '20', '3200.0', '30', '0.0', '40', '700.0', '50', '0.0', '51', '90.0',
    '0', 'ENDSEC', '0', 'EOF'
  ].join(eol) + eol

console.log('dxf-legacy 自检')

check('缺子类标记的 LINE：层在前、几何在 100 AcDbLine 之后', () => {
  const out = normalizeLegacyDxf(Buffer.from(legacy(), 'latin1')).toString('latin1')
  const pairs = parse(out)
  const lineAt = pairs.findIndex(([c, v]) => c === 0 && v === 'LINE')
  assert.ok(lineAt >= 0, 'LINE 记录还在')

  const tail = pairs.slice(lineAt + 1)
  const layer = tail.findIndex(([c, v]) => c === 8 && v === 'WALL')
  const marker = tail.findIndex(([c, v]) => c === 100 && v === 'AcDbLine')
  const x1 = tail.findIndex(([c, v]) => c === 10 && v === '0.0')

  assert.ok(layer >= 0, 'layer 组码 8 必须保留')
  assert.ok(layer < marker, 'layer 必须在子类标记之前，否则基类读不到')
  assert.ok(marker < x1, '几何组码必须在 100 AcDbLine 之后，否则子类读不到')
})

check('ARC 需要 AcDbCircle + AcDbArc 两个标记且顺序正确', () => {
  const out = normalizeLegacyDxf(Buffer.from(legacy(), 'latin1')).toString('latin1')
  const pairs = parse(out)
  const at = pairs.findIndex(([c, v]) => c === 0 && v === 'ARC')
  const tail = pairs.slice(at + 1)

  const circle = tail.findIndex(([c, v]) => c === 100 && v === 'AcDbCircle')
  const arc = tail.findIndex(([c, v]) => c === 100 && v === 'AcDbArc')
  const radius = tail.findIndex(([c, v]) => c === 40)

  assert.ok(circle >= 0 && arc >= 0, '两个标记都要有')
  assert.ok(circle < arc, 'AcDbCircle 必须在 AcDbArc 之前')
  assert.ok(arc < radius, '半径必须在 AcDbArc 之后')
})

check('数值一个都没改', () => {
  const out = normalizeLegacyDxf(Buffer.from(legacy(), 'latin1')).toString('latin1')
  for (const v of ['8000.0', '6000.0', '1800.0', '1600.0', '900.0', '4200.0', '3200.0', '700.0']) {
    assert.ok(out.includes(v), `原值 ${v} 应保留`)
  }
})

check('LF 换行的文件同样处理，且换行风格不被改写', () => {
  const out = normalizeLegacyDxf(Buffer.from(legacy('\n'), 'latin1')).toString('latin1')
  assert.ok(out.includes('\n100\nAcDbLine\n'), 'LF 文件应注入标记')
  assert.ok(!out.includes('\r'), '不应引入 CR')
})

check('已带子类标记的现代 DXF 原样返回', () => {
  const modern = LegacyToModern()
  const buf = Buffer.from(modern, 'latin1')
  const out = normalizeLegacyDxf(buf)
  assert.equal(out, buf, '必须是同一个 Buffer')
})

check('二进制 DXF 原样返回', () => {
  const buf = Buffer.concat([
    Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00', 'latin1'),
    Buffer.from([0x00, 0x01, 0x02, 0x03])
  ])
  assert.equal(isBinaryDxf(buf), true)
  assert.equal(normalizeLegacyDxf(buf), buf)
})

check('空文件与超限文件原样返回', () => {
  const empty = Buffer.alloc(0)
  assert.equal(normalizeLegacyDxf(empty), empty)

  const big = Buffer.from(legacy(), 'latin1')
  assert.equal(normalizeLegacyDxf(big, { maxBytes: 16 }), big)
})

/** 造一份「已带标记」的文件，用来验证不会二次处理 */
function LegacyToModern() {
  return (
    [
      '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LINE', '5', '2B', '330', '1F', '100', 'AcDbEntity', '8', '0',
      '100', 'AcDbLine', '10', '0.0', '20', '0.0', '30', '0.0', '11', '1000.0', '21', '1000.0', '31', '0.0',
      '0', 'ENDSEC', '0', 'EOF'
    ].join('\r\n') + '\r\n'
  )
}

console.log(`\n全部通过（${passed} 项）`)
