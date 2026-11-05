# dsh-memory-archiver

给 DSH 加四个**免审批**的记忆归档工具，把可写范围硬限制在记忆目录内。

## 为什么需要它

DSH 的文件沙箱只有三档（`read-only` / `workspace-write` / `danger-full-access`），**不支持额外可写根**；
审批策略只有 `ask` / `never`，**没有 allow-always**。所以"只让记忆归档免审批、其余照旧审批"没法用配置表达。

本插件的做法：**用插件自己的代码写文件**（走 `node:fs`，不经过 `ctx.fs`，因此不进文件沙箱、也不触发审批），
同时把可写范围**硬编码校验**在 `allowedRoots` 内——越界（含 `..`、junction、symlink 逃逸）一律拒绝。
其余操作仍然走 `workspace-write` + `ask`，照旧弹审批。

## 工具

| 工具 | 作用 |
|---|---|
| `memory_archive` | 写一个记忆文件（`dir` + `file` + `content`，默认拒绝覆盖；覆盖前自动备份；UTF-8 **无 BOM**） |
| `memory_index` | 往索引文件追加/按锚点插入一行（保持原 BOM 与换行；重复行跳过） |
| `memory_patch` | 就地替换一段文本（替换前自动备份；要求唯一匹配或显式 `replaceAll`） |
| `memory_supersede` | 一次完成"写新文件 + 旧文件标 `status: superseded` + 备份"，不删除任何文件 |

## 默认根与配置

默认只允许一个根：`~/.dsh/memory`（`~` 解析为 `USERPROFILE` / `HOME`）。

要加更多根，二选一：

1. 环境变量 `DSH_MEMORY_ROOTS`（用系统路径分隔符分隔：Windows `;`，类 Unix `:`）：

   ```text
   DSH_MEMORY_ROOTS=C:/work/memory;D:/notes/memory
   ```

2. 在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

   ```yaml
   - id: memory-archiver
     name: dsh-memory-archiver
     config:
       allowedRoots:
         - 'C:/Users/you/.dsh/memory'
         - 'D:/work/memory'
   ```

配置优先于环境变量，环境变量优先于默认值。

### 备份保留策略

覆盖/更正产生的备份在 `<记忆目录>/.backup/`，每次写新备份后自动清理：

| 配置键 | 默认 | 作用 |
|---|---|---|
| `backupRetentionDays` | `30` | 删除超过 N 天的旧备份；`<= 0` 关闭时间清理 |
| `backupMaxBytes` | `0` | 备份目录总大小上限（字节）；`0` 表示不设上限，超限时从最旧删 |

只清理 `.backup/` 里的 `.md` 备份，**不碰任何记忆正文**。

```yaml
- id: memory-archiver
  name: dsh-memory-archiver
  config:
    backupRetentionDays: 30
    backupMaxBytes: 52428800
```

## 安装

从源码打包：

```sh
npm pack
dsh plugin --profile <profile> add file:<tgz 的绝对路径>
```

或直接指向源码目录：

```sh
dsh plugin --profile <profile> add file:<repo 目录>
```

装完重启 DSH，并**新开一个会话**（工具在会话创建时绑定）。

## 验证

```sh
npm test          # node --test test/core.test.mjs，16 项
node test/smoke.mjs
```

## 0.2.x 的变化

- 覆盖/就地更正前，旧文件自动备份到同目录 `.backup/<原名>.<时间戳>.md`，返回值多 `backup` 字段。
- 旧备份按保留策略自动清理：默认保留 30 天，可设 `backupMaxBytes` 总大小上限（默认不设）。
- 新增 `memory_supersede`。
- 默认根改为通用（`~/.dsh/memory`），不再硬编码任何机器上的路径。
- 仍然**没有删除工具**（清理只发生在 `.backup/` 内的旧备份上）。

## 安全边界

- 只能写 `.md`，且必须落在 `allowedRoots` 内；参数非法、锚点找不到、文件已存在（未声明 `overwrite`）都会拒绝。
- 插件运行在 DSH 主进程内，不受文件沙箱约束——这是 DSH 的设计（沙箱防的是模型，不是插件）。
  本插件把该能力收窄成"只能写记忆目录里的 .md"。
- 不写凭据、不联网、不 spawn 子进程。

## 卸载

```sh
dsh plugin --profile <profile> remove dsh-memory-archiver
```

## License

MIT，见 [LICENSE](LICENSE)。
