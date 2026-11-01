/**
 * 记忆归档器的核心逻辑：只用 node 内置模块，可离线测试。
 *
 * 设计要点：
 * - 所有写入（文件和索引）都必须落在 allowedRoots 内；判断前先把路径规范化（realpath），
 *   因此 `..`、junction、symlink 都逃不出去。
 * - 记忆文件一律 UTF-8 **不带 BOM**（DSH 不剥离 BOM，带 BOM 的 JSON 会把 `dsh plugin` 搞崩）。
 * - 索引文件保持原有 BOM 状态与换行风格；同一行已存在时不重复写。
 *
 * @module dsh-memory-archiver/core
 */
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 归档失败（越界、参数非法、锚点找不到等）统一抛这个。 */
export class MemoryArchiveError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MemoryArchiveError'
  }
}

const isWindows = process.platform === 'win32'

function samePath(a, b) {
  return isWindows ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * 规范化路径：解析"最深的已存在祖先"的真实位置（realpath），再把剩下的部分拼回去。
 * 这样即使目标文件还不存在，中间的 junction/symlink 也会被解析出来。
 * @param {string} input - 任意路径。
 * @returns {string} 规范化后的绝对路径。
 */
function canonical(input) {
  let current = path.resolve(input)
  const tail = []
  while (!existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    tail.unshift(path.basename(current))
    current = parent
  }
  let real = current
  try {
    real = realpathSync.native ? realpathSync.native(current) : realpathSync(current)
  } catch {
    real = current
  }
  return tail.length > 0 ? path.join(real, ...tail) : real
}

/**
 * 把配置里的根目录整理成绝对路径去重列表。
 * @param {string[]} roots - 配置或默认值。
 * @returns {string[]} 绝对路径列表。
 */
export function normalizeRoots(roots) {
  const out = []
  for (const raw of roots ?? []) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const abs = path.resolve(raw.trim())
    if (!out.some((existing) => samePath(existing, abs))) out.push(abs)
  }
  if (out.length === 0) throw new MemoryArchiveError('allowedRoots 为空：没有可写的记忆目录')
  return out
}

/**
 * 断言目标落在某个允许的根之内（按规范化后的路径比较）。
 * @param {string[]} roots - 允许的根目录。
 * @param {string} target - 待检查路径。
 * @param {string} what - 出错时的中文提示词。
 * @returns {string} 规范化后的绝对路径。
 */
export function assertInside(roots, target, what = '路径') {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new MemoryArchiveError(`${what}不能为空`)
  }
  const abs = canonical(target.trim())
  for (const root of roots) {
    const rootAbs = canonical(root)
    if (samePath(abs, rootAbs)) return abs
    const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep
    const hit = isWindows
      ? abs.toLowerCase().startsWith(prefix.toLowerCase())
      : abs.startsWith(prefix)
    if (hit) return abs
  }
  throw new MemoryArchiveError(
    `${what}不在允许的记忆目录内，已拒绝：${abs}\n允许的根：${roots.join(' | ')}`,
  )
}

/**
 * 校验记忆文件名：只能是文件名，必须是 .md，不能含路径分隔符或 Windows 非法字符。
 * @param {string} file - 模型给的文件名。
 * @returns {string} 去掉首尾空白后的文件名。
 */
export function assertMemoryFileName(file) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new MemoryArchiveError('file 不能为空')
  }
  const name = file.trim()
  if (name !== path.basename(name) || name.includes('/') || name.includes('\\')) {
    throw new MemoryArchiveError(`file 只能是文件名，不能含路径：${name}`)
  }
  if (name === '.' || name === '..') throw new MemoryArchiveError(`file 非法：${name}`)
  if (!/\.md$/i.test(name)) throw new MemoryArchiveError(`记忆文件必须是 .md：${name}`)
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) {
    throw new MemoryArchiveError(`file 含非法字符：${name}`)
  }
  return name
}

/**
 * 写一个记忆文件（UTF-8 无 BOM）。
 * @param {object} input - 参数。
 * @param {string[]} input.roots - 允许的根目录。
 * @param {string} input.dir - 目标记忆目录（绝对路径）。
 * @param {string} input.file - 文件名（YYYY-MM-DD-短标题.md）。
 * @param {string} input.content - 完整正文。
 * @param {boolean} [input.overwrite] - 目标已存在时是否覆盖，默认拒绝。
 * @returns {Promise<{path: string, bytes: number, created: boolean}>} 写入结果。
 */
export async function writeMemoryFile({ roots, dir, file, content, overwrite = false }) {
  const name = assertMemoryFileName(file)
  const dirAbs = assertInside(roots, dir, '目标目录')
  const target = assertInside(roots, path.join(dirAbs, name), '目标文件')
  if (typeof content !== 'string' || content.trim() === '') {
    throw new MemoryArchiveError('content 不能为空')
  }
  const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  const created = !existsSync(target)
  if (!created && overwrite !== true) {
    throw new MemoryArchiveError(`文件已存在；要覆盖请显式传 overwrite=true → ${target}`)
  }
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, body, { encoding: 'utf8' })
  return { path: target, bytes: Buffer.byteLength(body, 'utf8'), created }
}

/**
 * 就地替换已有记忆文件里的一段文本（用于"结论过期 → 标注更正"这类归档收尾）。
 * 保持原 BOM 状态；`oldString` 不唯一时必须显式 replaceAll。
 * @param {object} input - 参数。
 * @param {string[]} input.roots - 允许的根目录。
 * @param {string} input.file - 目标文件绝对路径。
 * @param {string} input.oldString - 要被替换的原文。
 * @param {string} input.newString - 替换后的文本。
 * @param {boolean} [input.replaceAll] - 是否替换全部匹配，默认只允许唯一匹配。
 * @returns {Promise<{path: string, replacements: number, bytes: number}>} 替换结果。
 */
export async function patchMemoryFile({ roots, file, oldString, newString, replaceAll = false }) {
  const target = assertInside(roots, file, '目标文件')
  if (typeof oldString !== 'string' || oldString === '') {
    throw new MemoryArchiveError('oldString 不能为空')
  }
  if (typeof newString !== 'string') throw new MemoryArchiveError('newString 必须是字符串')
  if (oldString === newString) throw new MemoryArchiveError('oldString 与 newString 相同，无需替换')
  if (!existsSync(target)) throw new MemoryArchiveError(`文件不存在：${target}`)

  const raw = await readFile(target)
  const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
  let text = raw.toString('utf8')
  if (hasBom) text = text.slice(1)
  const matches = text.split(oldString).length - 1
  if (matches === 0) throw new MemoryArchiveError(`oldString 在文件里找不到：${target}`)
  if (matches > 1 && replaceAll !== true) {
    throw new MemoryArchiveError(
      `oldString 在文件里出现 ${matches} 次；请改得更唯一，或显式传 replaceAll=true`,
    )
  }
  const next =
    replaceAll === true ? text.split(oldString).join(newString) : text.replace(oldString, newString)
  await writeFile(target, (hasBom ? '\uFEFF' : '') + next, { encoding: 'utf8' })
  return {
    path: target,
    replacements: replaceAll === true ? matches : 1,
    bytes: Buffer.byteLength(next, 'utf8'),
  }
}

/**
 * 往索引文件里追加或插入一行（保持原 BOM 状态与换行风格，重复行跳过）。
 * @param {object} input - 参数。
 * @param {string[]} input.roots - 允许的根目录。
 * @param {string} input.indexFile - 索引文件绝对路径。
 * @param {string} input.row - 单行内容（表格行以 | 开头）。
 * @param {string} [input.after] - 锚点子串：插到最后一条包含它的行之后；省略则追加到末尾。
 * @returns {Promise<{path: string, action: string, line: string}>} 处理结果。
 */
export async function insertIndexRow({ roots, indexFile, row, after }) {
  const target = assertInside(roots, indexFile, '索引文件')
  if (typeof row !== 'string' || row.trim() === '') {
    throw new MemoryArchiveError('row 不能为空')
  }
  if (/[\r\n]/.test(row)) throw new MemoryArchiveError('row 必须是单行')
  const line = row.trim()
  if (!existsSync(target)) throw new MemoryArchiveError(`索引文件不存在：${target}`)

  const raw = await readFile(target)
  const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
  let text = raw.toString('utf8')
  if (hasBom) text = text.slice(1)
  if (text.split(/\r?\n/).some((existing) => existing.trim() === line)) {
    return { path: target, action: 'skipped-duplicate', line }
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'

  if (typeof after === 'string' && after !== '') {
    const lines = text.split(/\r?\n/)
    let at = -1
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(after)) at = i
    }
    if (at < 0) throw new MemoryArchiveError(`索引里找不到锚点：${after}`)
    lines.splice(at + 1, 0, line)
    text = lines.join(eol)
  } else {
    if (!text.endsWith(eol)) text += eol
    text += line + eol
  }

  await writeFile(target, (hasBom ? '\uFEFF' : '') + text, { encoding: 'utf8' })
  return { path: target, action: after ? 'inserted' : 'appended', line }
}
