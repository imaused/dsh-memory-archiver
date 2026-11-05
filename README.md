# dsh-memory-archiver

给 DSH 加两个**免审批**的记忆归档工具，把可写范围硬限制在记忆目录内。

## 为什么需要它

DSH 的文件沙箱只有三档（`read-only` / `workspace-write` / `danger-full-access`），**不支持额外可写根**
（`@deepseek-ai/dsh-sandbox-policy` README「已知限制」第 1 条）；审批策略只有 `ask` / `never`，
**没有 allow-always、没有已记住的规则、没有授权存储**（`@deepseek-ai/dsh-user-approval` README）。
所以"只让记忆归档免审批、其余照旧审批"**没法用配置表达**：

| 想要 | 原生能不能 |
|---|---|
| 只给某些路径免审批（写） | ❌ 沙箱无路径维度 |
| 审批里点一次"以后都允许" | ❌ 只有 `allowed-once` |
| 联网免审批 | ✅ 本来就不需要（沙箱策略词汇只含文件操作，不含网络/进程） |

本插件的做法：**用插件自己的代码写文件**（走 `node:fs`，不经过 `ctx.fs`，因此不进文件沙箱、
也不触发审批），同时把可写范围**硬编码校验**在 `allowedRoots` 内——越界（含 `..`、junction、symlink 逃逸）
一律拒绝。其余操作仍然走 `workspace-write` + `ask`，照旧弹审批。

## 工具

| 工具 | 作用 |
|---|---|
| `memory_archive` | 写一个记忆文件（`dir` + `file` + `content`，默认拒绝覆盖；覆盖前自动备份到 `.backup/`；UTF-8 **无 BOM**） |
| `memory_index` | 往索引文件追加/按锚点插入一行（保持原 BOM 与换行；重复行跳过） |
| `memory_patch` | 就地替换已有记忆文件里的一段文本（替换前自动备份；要求唯一匹配，或显式 `replaceAll`）——用于"此处更正" |
| `memory_supersede` | 一次完成"写新文件 + 旧文件标 `status: superseded` + 备份旧文件"，不删除任何文件 |

默认允许的根：

- `%USERPROFILE%\.dsh\memory`（全局记忆总目录 `00-目录.md`）
- `E:\dsh\memory`
- `E:\AI\memory`
- `...\default-workspace\memory`

要改就在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: memory-archiver
  name: 'dsh-memory-archiver'
  config:
    allowedRoots:
      - 'D:\some\memory'
```

## 安装（本机）

```powershell
cd E:\dsh
.\rollback.cmd guard add file:<本目录打出的 tgz 绝对路径>   # 先快照 → 装前自查 → 装 → 体检
.\rollback.cmd health                                      # [OK] 才重启
```

## 验证

```powershell
node test/smoke.mjs      # 离线：写入 / 越界拒绝 / junction 逃逸 / BOM / CRLF / 索引（19 项）
```

装好后：`health` 报 `[OK]`；新会话里应能看到 `memory_archive` 与 `memory_index` 两个工具。

## 0.2.0：覆盖有备份、更正一步到位

- `memory_archive(overwrite: true)` 与 `memory_patch` 在写之前，会把旧文件复制到同目录的
  `.backup/<原名>.<时间戳>.md`；返回结果里的 `backup` 就是这份留底。备份只增不删。
- `memory_supersede` 把"写新结论 + 把旧文件标成 `status: superseded`"合成一次调用：
  旧文件保留原文，只在 front-matter 里加 `status: superseded` / `superseded_by` / `superseded_at`。
  没有 front-matter 的文件会在顶部补一个。
- 仍然**没有删除工具**：删除只能人工或 git 做。
- 测试：`node --test test/core.test.mjs`（12 项，含备份与 supersede）。

## 安全边界（重要）

- 本插件**只**能写 `.md` 文件，且必须落在 `allowedRoots` 内；参数非法、锚点找不到、文件已存在（未声明 `overwrite`）都会拒绝。
- 插件代码运行在 DSH 主进程内，**不受文件沙箱约束**——这是 DSH 的设计（沙箱防的是模型，不是插件）。
  本插件把这能力收窄成"只能写记忆目录里的 .md"，这是它的全部价值所在。
- 单个进程内不写入任何凭据、不联网、不 spawn 子进程。

## 卸载

```powershell
cd E:\dsh
.\rollback.cmd snapshot -Note "卸载 memory-archiver 前"
& "C:\Users\DPXT\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-memory-archiver
.\rollback.cmd health
```
