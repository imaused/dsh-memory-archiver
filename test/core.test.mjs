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
  markSuperseded,
  patchMemoryFile,
  supersedeMemoryFile,
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

test('writeMemoryFile backs up the previous content before overwriting', async () => {
  const dir = root()
  await writeMemoryFile({ roots: [dir], dir, file: '2026-11-01-a.md', content: '# old\n' })
  const second = await writeMemoryFile({
    roots: [dir],
    dir,
    file: '2026-11-01-a.md',
    content: '# new\n',
    overwrite: true,
  })
  assert.ok(second.backup, 'backup path returned')
  assert.equal(readFileSync(second.backup, 'utf8'), '# old\n')
  assert.equal(readFileSync(join(dir, '2026-11-01-a.md'), 'utf8'), '# new\n')
  rmSync(dir, { recursive: true, force: true })
})

test('patchMemoryFile backs up before an in-place correction', async () => {
  const dir = root()
  const file = join(dir, '2026-11-01-a.md')
  await writeMemoryFile({ roots: [dir], dir, file: '2026-11-01-a.md', content: '结论 A\n' })
  const res = await patchMemoryFile({
    roots: [dir],
    file,
    oldString: '结论 A',
    newString: '结论 A（此处更正）\n',
  })
  assert.ok(res.backup)
  assert.equal(readFileSync(res.backup, 'utf8'), '结论 A\n')
  assert.match(readFileSync(file, 'utf8'), /此处更正/)
  rmSync(dir, { recursive: true, force: true })
})

test('supersedeMemoryFile writes the new file and marks the old one without deleting it', async () => {
  const dir = root()
  const oldName = '2026-10-01-old.md'
  const newName = '2026-11-05-new.md'
  await writeMemoryFile({
    roots: [dir],
    dir,
    file: oldName,
    content: '---\nid: old\nstatus: active\n---\n\n旧结论\n',
  })
  const res = await supersedeMemoryFile({
    roots: [dir],
    dir,
    file: newName,
    content: '# 新结论\n',
    supersedes: join(dir, oldName),
    at: '2026-11-05',
  })
  assert.equal(existsSync(join(dir, newName)), true)
  assert.equal(readFileSync(join(dir, newName), 'utf8'), '# 新结论\n')
  const oldText = readFileSync(join(dir, oldName), 'utf8')
  assert.match(oldText, /status: superseded/)
  assert.match(oldText, /superseded_by: 2026-11-05-new\.md/)
  assert.match(oldText, /superseded_at: 2026-11-05/)
  assert.match(oldText, /旧结论/)
  assert.ok(res.backup)
  assert.equal(readFileSync(res.backup, 'utf8').includes('status: active'), true)
  rmSync(dir, { recursive: true, force: true })
})

test('supersedeMemoryFile adds front-matter to a file that has none', async () => {
  const dir = root()
  const oldName = 'plain.md'
  await writeMemoryFile({ roots: [dir], dir, file: oldName, content: '没有头部的旧结论\n' })
  await supersedeMemoryFile({
    roots: [dir],
    dir,
    file: 'new.md',
    content: '新\n',
    supersedes: join(dir, oldName),
    at: '2026-11-05',
  })
  const oldText = readFileSync(join(dir, oldName), 'utf8')
  assert.match(oldText, /^---\nstatus: superseded/)
  assert.match(oldText, /没有头部的旧结论/)
  rmSync(dir, { recursive: true, force: true })
})

test('supersedeMemoryFile refuses to clobber, refuses a missing target, and stays inside roots', async () => {
  const allowed = root()
  const outside = root()
  await writeMemoryFile({ roots: [allowed], dir: allowed, file: 'old.md', content: 'x\n' })
  await writeMemoryFile({ roots: [allowed], dir: allowed, file: 'new.md', content: 'y\n' })
  await assert.rejects(
    () =>
      supersedeMemoryFile({
        roots: [allowed],
        dir: allowed,
        file: 'new.md',
        content: 'z\n',
        supersedes: join(allowed, 'old.md'),
      }),
    /新文件已存在/,
  )
  await assert.rejects(
    () =>
      supersedeMemoryFile({
        roots: [allowed],
        dir: allowed,
        file: 'n2.md',
        content: 'z\n',
        supersedes: join(allowed, 'missing.md'),
      }),
    /不存在/,
  )
  await assert.rejects(
    () =>
      supersedeMemoryFile({
        roots: [allowed],
        dir: allowed,
        file: 'n3.md',
        content: 'z\n',
        supersedes: join(outside, 'old.md'),
      }),
    /不在允许的记忆目录内/,
  )
  rmSync(allowed, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test('markSuperseded updates an existing status line instead of appending a duplicate', () => {
  const text = '---\nstatus: active\nupdated: 2026-10-17\n---\n\n正文\n'
  const marked = markSuperseded(text, { by: '2026-11-05-new.md', at: '2026-11-05' })
  assert.equal(marked.split('status: superseded').length, 2)
  assert.match(marked, /status: superseded/)
  assert.match(marked, /superseded_by: 2026-11-05-new\.md/)
  assert.match(marked, /updated: 2026-10-17/)
})
