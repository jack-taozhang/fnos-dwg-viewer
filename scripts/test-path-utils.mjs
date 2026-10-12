/**
 * server/path-utils.mjs 的回归测试。
 *
 * 覆盖的都是踩过的坑：
 *  · 飞牛用冒号拼多个授权目录，早期只按逗号切 → 白名单里躺着整根字符串，
 *    用户"明明授权了却打不开"；
 *  · Windows 盘符自带冒号，不能一刀切；
 *  · 请求路径里出现冒号拼接串 / 百分号编码时要能兜底还原。
 *
 * 用法：npm run test:path
 */
import assert from 'node:assert/strict'
import {
  isInside,
  parentCandidates,
  recoverCandidates,
  splitEnvList,
  suggestAuthorizeDir
} from '../server/path-utils.mjs'

let passed = 0
const cases = []
const test = (name, fn) => cases.push([name, fn])

/* ---------------- splitEnvList ---------------- */

test('冒号分隔（飞牛授权目录的真实形态）', () => {
  assert.deepEqual(
    splitEnvList('/vol1/1000/售前项目:/vol1/@appshare/fnos-dwg-viewer/drawings'),
    ['/vol1/1000/售前项目', '/vol1/@appshare/fnos-dwg-viewer/drawings']
  )
})

test('逗号 / 分号 / 冒号 混用', () => {
  assert.deepEqual(splitEnvList('/a,/b;/c:/d'), ['/a', '/b', '/c', '/d'])
})

test('Windows 盘符的冒号要保留', () => {
  assert.deepEqual(splitEnvList('C:/tmp/a:C:/tmp/b'), ['C:/tmp/a', 'C:/tmp/b'])
  assert.deepEqual(splitEnvList('C:\\data;D:\\work'), ['C:\\data', 'D:\\work'])
})

test('空值 / 多余分隔符 / 重复项 / 结尾斜杠', () => {
  assert.deepEqual(splitEnvList(''), [])
  assert.deepEqual(splitEnvList(undefined), [])
  assert.deepEqual(splitEnvList('  '), [])
  assert.deepEqual(splitEnvList('/a::/b:'), ['/a', '/b'])
  assert.deepEqual(splitEnvList('/a/,/a,/a/'), ['/a'])
})

/* ---------------- isInside ---------------- */

test('isInside 前缀匹配不会误伤同名兄弟目录', () => {
  assert.equal(isInside('/a/b/c', '/a/b'), true)
  assert.equal(isInside('/a/b', '/a/b'), true)
  assert.equal(isInside('/a/bc', '/a/b'), false)
  assert.equal(isInside('/a/b/../b/c', '/a/b'), true)
})

/* ---------------- recoverCandidates ---------------- */

test('冒号拼接串可以被拆开还原', () => {
  const got = recoverCandidates('/vol1/1000/售前项目:/vol1/@appshare/fnos-dwg-viewer/drawings')
  assert.ok(got.includes('/vol1/1000/售前项目'))
  assert.ok(got.includes('/vol1/@appshare/fnos-dwg-viewer/drawings'))
  assert.equal(got[0], '/vol1/1000/售前项目:/vol1/@appshare/fnos-dwg-viewer/drawings')
})

test('百分号编码的文件名可以被解码还原', () => {
  const got = recoverCandidates('/vol1/1000/%E5%94%AE%E5%89%8D/812%E5%9B%BE.dwg')
  assert.ok(got.includes('/vol1/1000/售前/812图.dwg'))
})

test('普通路径不产生多余候选', () => {
  assert.deepEqual(recoverCandidates('/vol1/1000/图纸'), ['/vol1/1000/图纸'])
})

test('非法转义不会抛异常', () => {
  assert.doesNotThrow(() => recoverCandidates('/a/%E4%B8'))
})

/* ---------------- parentCandidates ---------------- */

test('逐级上溯到根为止', () => {
  assert.deepEqual(parentCandidates('/a/b/c'), ['/a/b', '/a'])
  assert.deepEqual(parentCandidates('/a'), [])
  assert.deepEqual(parentCandidates('/a/b/'), ['/a'])
})

/* ---------------- suggestAuthorizeDir ---------------- */

test('建议授权目录：文件退父目录', () => {
  assert.equal(suggestAuthorizeDir('/vol1/1000/项目/a.dwg'), '/vol1/1000/项目')
  assert.equal(suggestAuthorizeDir('/vol1/1000/项目/'), '/vol1/1000/项目')
  assert.equal(suggestAuthorizeDir('/vol1/1000/项目'), '/vol1/1000/项目')
  assert.equal(suggestAuthorizeDir('/'), '/')
})

/* ---------------- 跑起来 ---------------- */

for (const [name, fn] of cases) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`)
    process.exitCode = 1
  }
}

console.log(`\n${passed}/${cases.length} 通过（平台 ${process.platform}）`)
