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
import { copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
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

/** 去掉开头的 UTF-8 BOM。 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 清理 `.backup/` 里的旧备份。**只删备份，不碰任何记忆正文。**
 *
 * - `retentionDays > 0`：删除 mtime 早于 `now - retentionDays` 天的备份；
 * - `maxBytes > 0`：按 mtime 从旧到新删，直到目录总大小不超过 `maxBytes`；
 * - 两者都不设（或 <= 0）时什么都不做。
 *
 * 只处理备份目录里的普通 `.md` 文件，且每次删除都单独容错：删不掉的保留，
 * 计数回滚，不影响主流程。
 *
 * @param {string} backupDir - `.backup` 目录。
 * @param {{retentionDays?: number, maxBytes?: number, now?: number}} [options] - 清理策略。
 * @returns {Promise<{removed: number, freedBytes: number, kept: number}>} 清理结果。
 */
export async function pruneBackups(backupDir, { retentionDays = 30, maxBytes = 0, now = Date.now() } = {}) {
  let entries
  try {
    entries = await readdir(backupDir, { withFileTypes: true })
  } catch {
    return { removed: 0, freedBytes: 0, kept: 0 }
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
    const full = path.join(backupDir, entry.name)
    try {
      const info = await stat(full)
      files.push({ full, size: info.size, mtimeMs: info.mtimeMs, dropped: false })
    } catch {
      // 扫描与 stat 之间文件消失：忽略。
    }
  }
  let removed = 0
  let freedBytes = 0
  const drop = (file) => {
    if (file.dropped) return
    file.dropped = true
    removed += 1
    freedBytes += file.size
  }

  if (Number.isFinite(retentionDays) && retentionDays > 0) {
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
    for (const file of files) {
      if (file.mtimeMs < cutoff) drop(file)
    }
  }

  let total = files.reduce((sum, file) => sum + (file.dropped ? 0 : file.size), 0)
  if (Number.isFinite(maxBytes) && maxBytes > 0 && total > maxBytes) {
    const survivors = files.filter((file) => !file.dropped).sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const file of survivors) {
      if (total <= maxBytes) break
      drop(file)
      total -= file.size
    }
  }

  for (const file of files) {
    if (!file.dropped) continue
    try {
      await unlink(file.full)
    } catch {
      // 删不掉（并发/权限）：保留文件并把计数回滚。
      removed -= 1
      freedBytes -= file.size
    }
  }
  return { removed, freedBytes, kept: files.length - removed }
}

/**
 * 把目标文件复制一份到同目录的 `.backup/` 里（文件名带时间戳），
 * 用于覆盖/就地更正之前留底。备份以 `.` 开头，会被 kb-lite 的目录扫描
 * 当作隐藏目录跳过。
 *
 * 复制完成后按配置清理旧备份（默认保留 30 天，默认不设总大小上限）。
 *
 * @param {string} target - 已存在的记忆文件绝对路径。
 * @param {{retentionDays?: number, maxBytes?: number}} [options] - 备份保留策略。
 * @returns {Promise<string>} 备份文件的绝对路径。
 */
async function backupMemoryFile(target, { retentionDays = 30, maxBytes = 0 } = {}) {
  const dir = path.dirname(target)
  const ext = path.extname(target) || '.md'
  const base = path.basename(target, ext)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = path.join(dir, '.backup')
  await mkdir(backupDir, { recursive: true })
  let dest = path.join(backupDir, `${base}.${stamp}${ext}`)
  let n = 1
  while (existsSync(dest)) dest = path.join(backupDir, `${base}.${stamp}-${n++}${ext}`)
  await copyFile(target, dest)
  await pruneBackups(backupDir, { retentionDays, maxBytes })
  return dest
}

/**
 * 给一段 Markdown 正文打上"已被取代"的 front-matter 标记。
 * 已有 front-matter 就更新/追加这三个键；没有就在顶部补一个。
 * 纯字符串处理，不引入 YAML 依赖；保持原有换行风格。
 * @param {string} text - 去掉 BOM 后的正文。
 * @param {{by: string, at: string}} meta - 取代者文件名与日期。
 * @returns {string} 标记后的正文。
 */
export function markSuperseded(text, { by, at }) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const keys = [
    ['status', 'superseded'],
    ['superseded_by', by],
    ['superseded_at', at],
  ]
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[0].trim() === '---') {
    let end = -1
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '---') {
        end = i
        break
      }
    }
    if (end > 0) {
      const fm = lines.slice(1, end)
      for (const [key, value] of keys) {
        const line = `${key}: ${value}`
        const idx = fm.findIndex((row) => new RegExp(`^${key}\\s*:`).test(row))
        if (idx >= 0) fm[idx] = line
        else fm.push(line)
      }
      lines.splice(1, end - 1, ...fm)
      return lines.join(eol)
    }
  }
  const block = ['---', ...keys.map(([key, value]) => `${key}: ${value}`), '---', '']
  return block.join(eol) + eol + text
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
export async function writeMemoryFile({
  roots,
  dir,
  file,
  content,
  overwrite = false,
  retentionDays = 30,
  maxBytes = 0,
}) {
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
  const backup = created ? undefined : await backupMemoryFile(target, { retentionDays, maxBytes })
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, body, { encoding: 'utf8' })
  return { path: target, bytes: Buffer.byteLength(body, 'utf8'), created, backup }
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
export async function patchMemoryFile({
  roots,
  file,
  oldString,
  newString,
  replaceAll = false,
  retentionDays = 30,
  maxBytes = 0,
}) {
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
  const backup = await backupMemoryFile(target, { retentionDays, maxBytes })
  const next =
    replaceAll === true ? text.split(oldString).join(newString) : text.replace(oldString, newString)
  await writeFile(target, (hasBom ? '\uFEFF' : '') + next, { encoding: 'utf8' })
  return {
    path: target,
    replacements: replaceAll === true ? matches : 1,
    bytes: Buffer.byteLength(next, 'utf8'),
    backup,
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

/**
 * 写一条新结论，并把被它取代的旧文件就地标成 `status: superseded`（不删除任何文件）。
 * 顺序：校验 → 备份旧文件 → 写新文件 → 标记旧文件。旧文件原文因此始终可找回。
 * @param {object} input - 参数。
 * @param {string[]} input.roots - 允许的根目录。
 * @param {string} input.dir - 新文件所在目录（绝对路径）。
 * @param {string} input.file - 新文件名（YYYY-MM-DD-短标题.md）。
 * @param {string} input.content - 新文件正文。
 * @param {string} input.supersedes - 被取代的旧文件绝对路径（必须在允许的根内）。
 * @param {string} [input.at] - 取代日期，默认今天（YYYY-MM-DD）。
 * @returns {Promise<{path: string, oldPath: string, backup: string, created: boolean}>} 写入结果。
 */
export async function supersedeMemoryFile({
  roots,
  dir,
  file,
  content,
  supersedes,
  at,
  retentionDays = 30,
  maxBytes = 0,
}) {
  const name = assertMemoryFileName(file)
  const dirAbs = assertInside(roots, dir, '目标目录')
  const newTarget = assertInside(roots, path.join(dirAbs, name), '新文件')
  if (typeof content !== 'string' || content.trim() === '') {
    throw new MemoryArchiveError('content 不能为空')
  }
  if (typeof supersedes !== 'string' || supersedes.trim() === '') {
    throw new MemoryArchiveError('supersedes 不能为空：请传被取代旧文件的绝对路径')
  }
  const oldTarget = assertInside(roots, supersedes, '被取代的文件')
  if (!/\.md$/i.test(oldTarget)) throw new MemoryArchiveError(`被取代的文件必须是 .md：${oldTarget}`)
  if (samePath(newTarget, oldTarget)) throw new MemoryArchiveError('新文件与被取代的文件是同一个，已拒绝')
  if (existsSync(newTarget)) {
    throw new MemoryArchiveError(`新文件已存在；请换一个文件名 → ${newTarget}`)
  }
  if (!existsSync(oldTarget)) throw new MemoryArchiveError(`被取代的文件不存在：${oldTarget}`)

  const backup = await backupMemoryFile(oldTarget, { retentionDays, maxBytes })

  const body = stripBom(content)
  await mkdir(dirAbs, { recursive: true })
  await writeFile(newTarget, body, { encoding: 'utf8' })

  const rawOld = await readFile(oldTarget)
  const hasBom = rawOld.length >= 3 && rawOld[0] === 0xef && rawOld[1] === 0xbb && rawOld[2] === 0xbf
  const oldText = stripBom(rawOld.toString('utf8'))
  const day = typeof at === 'string' && at.trim() !== '' ? at.trim() : new Date().toISOString().slice(0, 10)
  const marked = markSuperseded(oldText, { by: name, at: day })
  await writeFile(oldTarget, (hasBom ? '\uFEFF' : '') + marked, { encoding: 'utf8' })

  return { path: newTarget, oldPath: oldTarget, backup, created: true }
}
