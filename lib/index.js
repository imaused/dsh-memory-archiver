/**
 * dsh-memory-archiver —— 让"按记忆约定归档"不再需要审批。
 *
 * 为什么需要它：DSH 的文件沙箱只有三档（read-only / workspace-write / danger-full-access），
 * 且不支持额外可写根；审批只有 ask/never 且没有 allow-always。
 * 所以"只给记忆目录开口子、其余照旧审批"没法用配置表达——只能由插件用**自己的代码**写文件
 * （插件代码走 node:fs，不经过 `ctx.fs`，因此不进文件沙箱、也不触发审批），
 * 同时把可写范围**硬限制**在 allowedRoots 内（越界一律拒绝）。
 *
 * 加载安全性：`@deepseek-ai/dsh-tools` 的 import 失败只会导致"工具不注册"，
 * 绝不会抛错拖垮 profile 启动。
 *
 * @module dsh-memory-archiver
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { MemoryArchiveError, insertIndexRow, normalizeRoots, patchMemoryFile, supersedeMemoryFile, writeMemoryFile } from './core.js'

/** 插件名（与 package.json 一致）。 */
const name = 'dsh-memory-archiver'

/** 依赖的工具注册表服务。 */
const inject = ['tools']

/** 默认记忆根：`~/.dsh/memory`；可用环境变量 DSH_MEMORY_ROOTS 或配置 allowedRoots 覆盖。 */
function computeDefaultRoots() {
  const env = process.env.DSH_MEMORY_ROOTS
  if (typeof env === "string" && env.trim() !== "") {
    return env.split(path.delimiter).map((s) => s.trim()).filter(Boolean)
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ""
  return home ? [path.join(home, ".dsh", "memory")] : []
}
const DEFAULT_ROOTS = computeDefaultRoots()

/** 加载 `defineTool` 时记录的错误，供注册失败时报警。 */
let loadFailure

/**
 * 取 `defineTool`：先按正常裸包名 import（DSH 的锚点解析会给 profile 插件补上核心包），
 * 失败再退回从应用锚点直接 import（Electron 的 asar 支持）。
 * @returns {Promise<Function|undefined>} `defineTool` 或 undefined。
 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod.defineTool === 'function') return mod.defineTool
    loadFailure = new Error('@deepseek-ai/dsh-tools 未导出 defineTool')
  } catch (error) {
    loadFailure = error
  }
  try {
    const resources = process.resourcesPath
    if (typeof resources === 'string' && resources !== '') {
      const entry = path.join(
        resources,
        'app.asar',
        'dsh',
        'node_modules',
        '@deepseek-ai',
        'dsh-tools',
        'lib',
        'index.js',
      )
      const mod = await import(pathToFileURL(entry).href)
      if (typeof mod.defineTool === 'function') {
        loadFailure = undefined
        return mod.defineTool
      }
    }
  } catch (error) {
    loadFailure = error
  }
  return undefined
}

const defineTool = await loadDefineTool()

/**
 * 注册三个工具：`memory_archive`（写记忆文件）、`memory_index`（写索引行）、
 * `memory_patch`（就地标注更正）。
 * @param {object} ctx - 插件上下文，需要 `tools` 服务。
 * @param {{allowedRoots?: string[]}} [config] - 可选配置：覆盖记忆目录白名单。
 */
function apply(ctx, config) {
  if (typeof defineTool !== 'function') {
    ctx.logger?.warn?.(
      `[${name}] 无法加载 @deepseek-ai/dsh-tools，工具未注册（应用不受影响）：${loadFailure?.message ?? 'unknown'}`,
    )
    return
  }
  let roots
  try {
    roots = normalizeRoots(config?.allowedRoots ?? DEFAULT_ROOTS)
  } catch (error) {
    ctx.logger?.warn?.(`[${name}] 没有可写的记忆目录，工具未注册（应用不受影响）：${error.message}`)
    return
  }
  ctx.logger?.info?.(`[${name}] 已启用，允许的记忆目录：${roots.join(' | ')}`)

  ctx.tools.register(
    defineTool({
      name: 'memory_archive',
      description:
        'Write one memory file (a conclusion, per this machine\'s memory convention) WITHOUT any approval: ' +
        `only paths under the configured memory roots are writable (${roots.join(' | ')}); ` +
        'anything outside is refused. Content is written as UTF-8 without BOM. ' +
        'After writing, add the index row with memory_index.',
      parameters: {
        dir: {
          type: 'string',
          required: true,
          description: 'Absolute path of the target memory folder; must be inside an allowed memory root.',
        },
        file: {
          type: 'string',
          required: true,
          description: 'File name only, e.g. 2026-10-16-短标题.md — no path separators, must end with .md.',
        },
        content: {
          type: 'string',
          required: true,
          description: 'Full Markdown body of the memory file.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Allow overwriting an existing file. Defaults to false (refused).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
            created: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `${value.created ? 'Created' : 'Overwrote'} ${value.path} (${value.bytes} bytes, UTF-8 without BOM).`,
          },
        ],
      },
      execute: async (args) =>
        writeMemoryFile({
          roots,
          dir: args.dir,
          file: args.file,
          content: args.content,
          overwrite: args.overwrite === true,
        }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'memory_index',
      description:
        'Add one row to a memory index file WITHOUT any approval (memory roots only): appends to the end, ' +
        'or inserts after the last line containing the `after` anchor. Duplicate rows are skipped, and the ' +
        "file's existing BOM state and line endings are preserved.",
      parameters: {
        indexFile: {
          type: 'string',
          required: true,
          description:
            'Absolute path of the index file, e.g. <workspace>\\memory\\README.md or C:\\Users\\DPXT\\.dsh\\memory\\00-目录.md.',
        },
        row: {
          type: 'string',
          required: true,
          description: 'One single line to write; a Markdown table row starts with "|".',
        },
        after: {
          type: 'string',
          description: 'Anchor substring: insert after the last line containing it. Omit to append at the end.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            action: { type: 'string', required: true },
            line: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `${value.action}: ${value.path}\n${value.line}`,
          },
        ],
      },
      execute: async (args) =>
        insertIndexRow({
          roots,
          indexFile: args.indexFile,
          row: args.row,
          after: args.after,
        }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'memory_patch',
      description:
        'Replace one exact snippet inside an existing memory file WITHOUT any approval (memory roots only) — ' +
        'this is how an outdated conclusion gets an in-place "此处更正" note. Fails when the snippet is missing, ' +
        'or appears more than once and replaceAll is not true. Existing BOM state is preserved.',
      parameters: {
        file: {
          type: 'string',
          required: true,
          description: 'Absolute path of the existing memory file inside an allowed root.',
        },
        oldString: {
          type: 'string',
          required: true,
          description: 'Exact text to replace (as written in the file, whitespace included).',
        },
        newString: {
          type: 'string',
          required: true,
          description: 'Replacement text; use an empty string to delete the match.',
        },
        replaceAll: {
          type: 'boolean',
          description: 'Replace every match. Defaults to false, which requires exactly one match.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            replacements: { type: 'integer', required: true },
            bytes: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `patched ${value.path} (${value.replacements} replacement(s), ${value.bytes} bytes).`,
          },
        ],
      },
      execute: async (args) =>
        patchMemoryFile({
          roots,
          file: args.file,
          oldString: args.oldString,
          newString: args.newString,
          replaceAll: args.replaceAll === true,
        }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'memory_supersede',
      description:
        'Write a new memory file and mark the old one it replaces in one approval-free call: ' +
        'writes `file`/`content`, backs the old file up under `.backup/`, then sets ' +
        '`status: superseded` / `superseded_by` / `superseded_at` in the old file. ' +
        'Nothing is deleted. Use this instead of overwrite when a conclusion is revised.',
      parameters: {
        dir: {
          type: 'string',
          required: true,
          description: 'Absolute path of the target memory folder; must be inside an allowed memory root.',
        },
        file: {
          type: 'string',
          required: true,
          description: 'New file name only, e.g. 2026-11-05-短标题.md — no path separators, must end with .md.',
        },
        content: {
          type: 'string',
          required: true,
          description: 'Full Markdown body of the new memory file.',
        },
        supersedes: {
          type: 'string',
          required: true,
          description: 'Absolute path of the existing memory file being replaced (must be inside an allowed root).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            oldPath: { type: 'string', required: true },
            backup: { type: 'string', required: true },
            created: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `Created ${value.path}; marked ${value.oldPath} as superseded (backup: ${value.backup}).`,
          },
        ],
      },
      execute: async (args) =>
        supersedeMemoryFile({
          roots,
          dir: args.dir,
          file: args.file,
          content: args.content,
          supersedes: args.supersedes,
        }),
    }),
  )
}

export { DEFAULT_ROOTS, MemoryArchiveError, apply, inject, name }
