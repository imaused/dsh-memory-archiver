/**
 * 离线冒烟测试：只测 lib/core.js（纯 node 内置模块，不需要 DSH）。
 * 跑法：node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  MemoryArchiveError,
  assertInside,
  insertIndexRow,
  normalizeRoots,
  patchMemoryFile,
  writeMemoryFile,
} from '../lib/core.js'

const base = mkdtempSync(path.join(tmpdir(), 'memarc-'))
const root = path.join(base, 'memory')
const outside = path.join(base, 'outside')
mkdirSync(root, { recursive: true })
mkdirSync(outside, { recursive: true })
const roots = normalizeRoots([root])
const link = path.join(root, 'link-out')
let passed = 0

async function rejects(label, fn) {
  await assert.rejects(fn, MemoryArchiveError, `应当拒绝但没拒绝：${label}`)
  passed += 1
  console.log(`  [拒绝] ${label}`)
}

function ok(label) {
  passed += 1
  console.log(`  [通过] ${label}`)
}

try {
  // 1. 正常写入：UTF-8、无 BOM、返回字节数
  const first = await writeMemoryFile({
    roots,
    dir: root,
    file: '2026-10-16-测试.md',
    content: '# 结论\n\n正文。\n',
  })
  assert.equal(first.created, true)
  assert.equal(first.bytes, Buffer.byteLength('# 结论\n\n正文。\n', 'utf8'))
  const raw = readFileSync(first.path)
  assert.notDeepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], '不得写入 BOM')
  assert.equal(raw.toString('utf8'), '# 结论\n\n正文。\n')
  ok('正常写入（无 BOM、字节数正确、子目录自动建）')

  // 2. 已存在且未声明 overwrite → 拒绝
  await rejects('已存在且 overwrite=false', () =>
    writeMemoryFile({ roots, dir: root, file: '2026-10-16-测试.md', content: 'x' }),
  )

  // 3. overwrite=true → 覆盖且 created=false
  const second = await writeMemoryFile({
    roots,
    dir: root,
    file: '2026-10-16-测试.md',
    content: '覆盖后的内容\n',
    overwrite: true,
  })
  assert.equal(second.created, false)
  assert.equal(readFileSync(first.path, 'utf8'), '覆盖后的内容\n')
  ok('overwrite=true 覆盖，created=false')

  // 4. 带 BOM 的正文会被剥掉
  const bom = await writeMemoryFile({
    roots,
    dir: root,
    file: '2026-10-16-bom.md',
    content: '\uFEFF# 带 BOM 的输入\n',
  })
  assert.equal(readFileSync(bom.path)[0], 0x23)
  ok('正文起始 BOM 被剥离')

  // 5. `..` 逃逸
  await rejects('dir 用 .. 逃逸', () =>
    writeMemoryFile({ roots, dir: path.join(root, '..', 'outside'), file: 'a.md', content: 'x' }),
  )

  // 6. junction 逃逸（在根内建一个指向根外的 junction，再往里写）
  symlinkSync(outside, link, 'junction')
  await rejects('经由 junction 逃逸', () =>
    writeMemoryFile({ roots, dir: link, file: 'a.md', content: 'x' }),
  )
  assert.equal(existsSync(path.join(outside, 'a.md')), false, 'junction 逃逸不得在根外落地')

  // 7. 文件名里带路径
  await rejects('file 含 ..\\', () =>
    writeMemoryFile({ roots, dir: root, file: '..\\evil.md', content: 'x' }),
  )
  await rejects('file 含子目录', () =>
    writeMemoryFile({ roots, dir: root, file: 'sub/a.md', content: 'x' }),
  )
  await rejects('file 不是 .md', () =>
    writeMemoryFile({ roots, dir: root, file: 'a.txt', content: 'x' }),
  )

  // 8. 空 content
  await rejects('content 为空', () =>
    writeMemoryFile({ roots, dir: root, file: 'empty.md', content: '   ' }),
  )

  // 9. 索引：追加
  const idx = path.join(root, 'README.md')
  writeFileSync(idx, '| 文件 | 摘要 |\n| --- | --- |\n| a.md | 甲 |\n', 'utf8')
  const appended = await insertIndexRow({ roots, indexFile: idx, row: '| b.md | 乙 |' })
  assert.equal(appended.action, 'appended')
  assert.ok(readFileSync(idx, 'utf8').endsWith('| b.md | 乙 |\n'))
  ok('索引追加到末尾')

  // 10. 索引：重复行跳过
  const dup = await insertIndexRow({ roots, indexFile: idx, row: '| b.md | 乙 |' })
  assert.equal(dup.action, 'skipped-duplicate')
  ok('索引重复行跳过')

  // 11. 索引：插到锚点后
  const inserted = await insertIndexRow({
    roots,
    indexFile: idx,
    row: '| a2.md | 甲二 |',
    after: '| a.md | 甲 |',
  })
  assert.equal(inserted.action, 'inserted')
  const idxText = readFileSync(idx, 'utf8')
  assert.ok(idxText.indexOf('| a.md | 甲 |') < idxText.indexOf('| a2.md | 甲二 |'))
  assert.ok(idxText.indexOf('| a2.md | 甲二 |') < idxText.indexOf('| b.md | 乙 |'))
  ok('索引按锚点插入（最后一条匹配之后）')

  // 12. 索引：锚点找不到 → 拒绝
  await rejects('锚点不存在', () =>
    insertIndexRow({ roots, indexFile: idx, row: '| c.md | 丙 |', after: '不存在的锚点' }),
  )

  // 13. 索引：多行 row → 拒绝
  await rejects('row 是多行', () => insertIndexRow({ roots, indexFile: idx, row: 'a\nb' }))

  // 14. 索引：BOM 与 CRLF 保持
  const bomIdx = path.join(root, 'bom-index.md')
  writeFileSync(bomIdx, '\uFEFF|x|\r\n', 'utf8')
  await insertIndexRow({ roots, indexFile: bomIdx, row: '|y|' })
  const bomIdxRaw = readFileSync(bomIdx)
  assert.deepEqual([...bomIdxRaw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM 应保持')
  assert.ok(bomIdxRaw.toString('utf8').includes('|y|\r\n'), 'CRLF 应保持')
  ok('索引保持原 BOM 与 CRLF')

  // 15. 索引文件在根外 → 拒绝
  await rejects('索引文件越界', () =>
    insertIndexRow({ roots, indexFile: path.join(outside, 'x.md'), row: '|y|' }),
  )

  // 16. 根列表为空 → 拒绝
  assert.throws(() => normalizeRoots([]), MemoryArchiveError)
  passed += 1
  console.log('  [拒绝] allowedRoots 为空')

  // 17. assertInside 对根自身放行
  assert.equal(assertInside(roots, root), path.resolve(root))
  passed += 1
  console.log('  [通过] 根目录自身被视为在内')

  // 18. patch：唯一匹配替换（就地标注更正）
  const patchTarget = path.join(root, 'patch.md')
  writeFileSync(patchTarget, '# 标题\n\n旧结论：A。\n', 'utf8')
  const patched = await patchMemoryFile({
    roots,
    file: patchTarget,
    oldString: '旧结论：A。',
    newString: '此处更正：B。',
  })
  assert.equal(patched.replacements, 1)
  assert.ok(readFileSync(patchTarget, 'utf8').includes('此处更正：B。'))
  ok('patch 唯一匹配替换')

  // 19. patch：多处匹配未声明 replaceAll → 拒绝；声明后全替换
  writeFileSync(patchTarget, 'x\nx\n', 'utf8')
  await rejects('patch 多处匹配未声明 replaceAll', () =>
    patchMemoryFile({ roots, file: patchTarget, oldString: 'x', newString: 'y' }),
  )
  const all = await patchMemoryFile({
    roots,
    file: patchTarget,
    oldString: 'x',
    newString: 'y',
    replaceAll: true,
  })
  assert.equal(all.replacements, 2)
  ok('patch replaceAll=true 全替换')

  // 20. patch：找不到 / 越界 / 空 oldString → 拒绝
  await rejects('patch 找不到 oldString', () =>
    patchMemoryFile({ roots, file: patchTarget, oldString: '不存在', newString: 'z' }),
  )
  await rejects('patch 目标越界', () =>
    patchMemoryFile({ roots, file: path.join(outside, 'x.md'), oldString: 'a', newString: 'b' }),
  )
  await rejects('patch oldString 为空', () =>
    patchMemoryFile({ roots, file: patchTarget, oldString: '', newString: 'z' }),
  )

  console.log(`\n全部通过：${passed} 项`)
} finally {
  // 先摘 junction 链接本身，再删临时树（不要对 junction 用递归删除）
  try {
    rmSync(link, { force: true })
  } catch {
    /* 没建成就忽略 */
  }
  rmSync(base, { recursive: true, force: true })
}
