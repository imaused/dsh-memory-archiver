import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import {
  MemoryArchiveError,
  normalizeRoots,
  assertInside,
  assertMemoryFileName,
  writeMemoryFile,
} from '../lib/core.js'

function root() {
  return mkdtempSync(join(tmpdir(), 'dsh-mem-archiver-'))
}

test('normalizeRoots trims, resolves and de-duplicates', () => {
  const dir = root()
  const roots = normalizeRoots([dir, ` ${dir}${sep} `, '', 42, null])
  assert.equal(roots.length, 1)
  assert.equal(roots[0].toLowerCase(), dir.toLowerCase())
  rmSync(dir, { recursive: true, force: true })
})

test('normalizeRoots refuses an empty configuration', () => {
  assert.throws(() => normalizeRoots([]), MemoryArchiveError)
  assert.throws(() => normalizeRoots(['', '  ']), MemoryArchiveError)
})

test('assertInside accepts descendants and rejects escapes', () => {
  const dir = root()
  assert.equal(assertInside([dir], join(dir, 'a', 'b.md')).toLowerCase(), join(dir, 'a', 'b.md').toLowerCase())
  assert.equal(assertInside([dir], dir).toLowerCase(), dir.toLowerCase())
  assert.throws(() => assertInside([dir], join(dir, '..', 'outside.md')), /不在允许的记忆目录内/)
  // sibling with a shared prefix must not be treated as inside
  assert.throws(() => assertInside([dir], `${dir}-evil${sep}x.md`), /不在允许的记忆目录内/)
  assert.throws(() => assertInside([dir], '   '), /不能为空/)
  rmSync(dir, { recursive: true, force: true })
})

test('assertMemoryFileName only accepts a plain .md file name', () => {
  assert.equal(assertMemoryFileName(' 2026-11-01-note.md '), '2026-11-01-note.md')
  assert.throws(() => assertMemoryFileName(''), /不能为空/)
  assert.throws(() => assertMemoryFileName('../x.md'), /不能含路径|只能是文件名/)
  assert.throws(() => assertMemoryFileName('sub/x.md'), /不能含路径/)
  assert.throws(() => assertMemoryFileName('x.txt'), /必须是 \.md/)
  assert.throws(() => assertMemoryFileName('bad<name>.md'), /非法字符/)
})

test('writeMemoryFile writes UTF-8 without BOM and refuses to clobber by default', async () => {
  const dir = root()
  const first = await writeMemoryFile({ roots: [dir], dir, file: '2026-11-01-a.md', content: '# a\n' })
  assert.equal(first.created, true)
  const bytes = readFileSync(join(dir, '2026-11-01-a.md'))
  assert.notEqual(bytes[0], 0xef) // no UTF-8 BOM
  assert.equal(bytes.toString('utf8'), '# a\n')

  await assert.rejects(
    () => writeMemoryFile({ roots: [dir], dir, file: '2026-11-01-a.md', content: '# b\n' }),
    /已存在|overwrite/,
  )
  const second = await writeMemoryFile({ roots: [dir], dir, file: '2026-11-01-a.md', content: '# b\n', overwrite: true })
  assert.equal(second.created, false)
  assert.equal(readFileSync(join(dir, '2026-11-01-a.md'), 'utf8'), '# b\n')
  rmSync(dir, { recursive: true, force: true })
})

test('writeMemoryFile refuses a directory outside the allowed roots', async () => {
  const allowed = root()
  const outside = root()
  await assert.rejects(
    () => writeMemoryFile({ roots: [allowed], dir: outside, file: 'x.md', content: 'x' }),
    /不在允许的记忆目录内/,
  )
  assert.equal(existsSync(join(outside, 'x.md')), false)
  rmSync(allowed, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})
