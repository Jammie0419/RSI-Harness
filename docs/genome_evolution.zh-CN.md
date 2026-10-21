# Genome 增量进化

[English](genome_evolution.md)

对**已经存在的** Genome 做增量的、证据驱动的进化。

正常的 `rsih` 运行使用一个 Genome；这个子系统读取属于该 Genome 的会话中实际发生
了什么，让模型给出一小组改动，交给人工审核，然后把审核通过的改动物化为同一个
Genome 的下一个 revision。名字不变，旧版本归档，新版本可以回滚。

这个子系统刻意独立于 core 的 `HarnessPatch` 词汇（`PATCH_OPERATIONS`、
`applyHarnessPatch`、`harnessPatchSchema`）。它拥有自己的 `EvolutionPatch`、自己的
apply 引擎和自己的编译器；只在最后以只读方式调用 core 的
loader/settings/complexity 校验。除非运行下面这些命令，正常 RSIH 行为完全不变。

## 命令

所有命令都在 `rsih genome` 下：

```bash
# 只检查新证据。不调用模型、不写 state/index、不安装。
rsih genome scan paperlab
rsih genome scan paperlab --workspaces /work/proj --json

# 让模型提案，在 staging 编译校验后保存。不安装，也不推进证据状态。
rsih genome plan paperlab --config providers.json --intent "make smoke tests stricter"

# 安装 plan（或审核中保存）的 proposal。不调用模型。
rsih genome apply ~/.rsih/evolution/paperlab/proposals/2026-10-21T10-00-00-000Z.json

# 审核、编译、校验、安装。一次命令最多创建一个 revision。
rsih genome evolve paperlab --config providers.json --intent "..."

# TTY 下同样展示完整流程，但不提问；校验仍然逐项把关。
rsih genome evolve paperlab --auto --config providers.json

# 只读比较。
rsih genome diff paperlab --to 1
rsih genome diff paperlab --proposal <proposal.json>

# 版本历史与回滚。
rsih genome versions paperlab
rsih genome rollback paperlab --to 1
```

### TTY 行为

| 场景 | 行为 |
| --- | --- |
| TTY 下 `evolve` | 进入 TUI，显示 `baseline → scan → digest → model → proposal → review → compile → validate → install`，逐项审核每个 operation。 |
| TTY 下 `evolve --auto` | 使用同一套页面并展示每项改动，但自动应用。 |
| 无 TTY 的 `evolve` | 等价于 `plan`：写 proposal 后退出，不安装。 |
| 无 TTY 的 `evolve --auto` | 运行完整流程并安装。 |
| `scan` / `plan` / `apply` / `diff` / `versions` / `rollback` | 文本或 `--json` 输出，不进 TUI。 |

审核按键：`a` Apply，`r` Reject，`c` Comment，`d` Details，`q` Cancel。

## 流水线

```text
解析 base Genome
        │
        ├─ baseline: --since → state → manifest evolution.created_at → 全历史
        │
        ├─ 发现/读取 transcript（rsih.genome marker、完整流、offset）
        │
        ├─ 证据索引 + watermark
        │
        ├─ digest: strong / weak / context / coverage / excluded
        │
        ├─ base 摘要：当前 skill/template 正文 + 组件元数据
        │
        ├─ proposal 模型 → EvolutionPatch
        │
        ├─ 逐项审核 → working set
        │
        ├─ compile：复制 base，只重写变化组件/资产
        │
        ├─ validate：语义等价、资源、复杂度、generated tools
        │
        └─ 归档旧版本 → 原子替换 → 保存 state/history
```

`scan` 在 digest 之后停止。`plan` 在写完 proposal 后停止。`apply` 跳过证据、模型和
审核，直接从保存的 proposal 开始。

## 模块表

| 文件 | 职责 |
| --- | --- |
| `events.ts` | 归一化的 `EvidenceEvent` schema 和 source id。 |
| `sources.ts` | 发现 RSIH/Pi/Claude/Codex/Copilot transcript 文件；默认只读 `rsih`。 |
| `reader.ts` | 完整流 JSONL reader、Pi/Claude/Codex/Copilot 适配器、`rsih.genome` marker、skill/command 提取。 |
| `watermark.ts` | 每个文件的 size/mtime/offset/line/generation 状态；扫描计划。 |
| `index-store.ts` | 追加式 `events.jsonl`，去重并修复 cursor。 |
| `scan.ts` | 端到端文件扫描；隔离读取错误，失败的文件不推进水位。 |
| `sequences.ts` | transition、retry、correction、重复序列、session shape。 |
| `state.ts` | `state.json`：baseline、watermark、index cursor、history、单写者锁。 |
| `digest.ts` | 确定性证据 digest 和 provenance；strong/weak 闸门。 |
| `base-summary.ts` | 当前 skill/template 正文，供细粒度 `find` 使用；默认 60k 上限。 |
| `proposal.ts` | proposal schema、prompt、解析、weak-only 检查、模型调用封装。 |
| `model.ts` | provider profile 解析（`--config` / `--profile`）。 |
| `patch.ts` | `EvolutionPatch` schema、target 校验、wide 操作分类。 |
| `components.ts` | evolution 本地的组件/字段/资产映射；与 core 做 parity 测试。 |
| `apply.ts` | 把 operation 应用到内存工作模型；产出 asset 写入/删除。 |
| `compile.ts` | 把工作模型物化为自包含 v3 bundle；只读调用 core 校验。 |
| `versions.ts` | 归档、原子安装、版本列表、回滚。 |
| `review.ts` | 逐项审核状态机；terminal 和 plain 两种适配器。 |
| `evolve.ts` | 编排 scan/plan/evolve/apply/diff/versions/rollback。 |
| `src/cli/evolution-command.ts` | 解析 `rsih genome` 的进化子命令。 |

`src/cli/genome-command.ts` 只在命令名匹配时动态 import 进化 CLI。正常会话不会加载
这些模块。

## 证据与归属

RSIH 在会话开始时写入一个 custom marker：

```json
{
  "type": "custom",
  "customType": "rsih.genome",
  "data": {
    "reference": "paperlab",
    "baseDirectory": "C:\\Users\\...\\.rsih\\genomes\\paperlab",
    "genome_id": "harness:...",
    "genome": { "...": "snapshot" }
  }
}
```

- TUI、print、JSON 和 RPC 运行都会写这个 marker。
- `/switch-genome` 会追加新 marker；reader 按 marker 分段，所以一个 transcript 可以
  同时包含多个 Genome 的证据。
- 默认用稳定的 reference 或 marker 的 `baseDirectory` realpath 匹配，因此较早
  revision 产生的会话仍然算数。`genome_id` 可用，但默认 lineage 匹配不用它。
- 默认 source 是 `rsih`。Pi/Claude/Codex/Copilot 需要通过
  `--sources pi,claude,...` 显式开启，并标记为 external/weak。
- 没有 marker 的会话是 `unattributed`，默认排除；除非显式请求了外部 source。

### Baseline

`--since` 是可选的。第一次运行、还没有 state 时，起点按以下顺序确定：

1. `--since`（如果提供）；
2. state 里的 `baseline_at`；
3. manifest 里的 `evolution.created_at`；
4. 全历史。

刻意不使用 bundle 的文件系统 birthtime：复制或重新安装会改变它。

`--workspaces` 接受逗号分隔的根目录。一个根目录包含其子目录：`/work/proj` 包含
`/work/proj/sub`，但不包含 `/work/project2`。Windows 路径大小写不敏感。

## `scan`、`plan`、`evolve`、`apply` 分别写什么

| 命令 | 读取 transcript | 追加 `events.jsonl` | 写 proposal | 保存 state/watermark | 安装 |
| --- | --- | --- | --- | --- | --- |
| `scan` | 是 | 否 | 否 | 否 | 否 |
| `plan` | 是 | 是 | 是 | 否 | 否 |
| `evolve` | 是 | 是 | no-change/save 时写 | 仅成功时 | 有通过的改动时 |
| `apply` | 否 | 否 | 否 | 是 | 是 |

`scan` 被设计成只读：查看证据不能消费证据。`plan` 追加 index 只是证据缓存，不是消费
游标；决定下次从哪里重读的是 state 里的 watermark。失败的 plan/evolve 不会推进
watermark，所以下一次仍然覆盖同一时间段。

## EvolutionPatch

```jsonc
{
  "schema_version": "1",
  "base_genome_id": "harness:...",
  "base_version": 1,
  "base_content_hash": "...",
  "hypothesis": "One step is wrong.",
  "evidence_refs": ["skill_use:/sessions/a.jsonl:12"],
  "operations": [
    {
      "op": "text.patch",
      "target": {
        "component": "skills",
        "entry": "experiment-bootstrap",
        "field": "content"
      },
      "find": "old step",
      "replace": "new step",
      "expected_occurrences": 1
    }
  ],
  "expected_effect": "The next bootstrap run follows the corrected step.",
  "risks": []
}
```

Target：

```ts
{
  component: "instructions" | "skills" | "tools" | "commands" | "memory"
           | "policies" | "runtime" | "integrations" | "model"
           | "appearance" | "settings" | "keybindings" | "resources";
  entry?: string;   // skill/tool/template/memory key/MCP server name
  field?: string;   // description/content/enabled/...
  asset?: string;   // skills/<name>/SKILL.md, prompts/<name>.md, ...
}
```

Operation：

| 操作 | 粒度 | 说明 |
| --- | --- | --- |
| `text.patch` | 精确 `find`/`replace` | `expected_occurrences` 默认 1；0 次或多次命中都失败。 |
| `text.append` | 追加到字段/资产 | |
| `text.set` | 整段替换文本 | wide |
| `entry.update` | 单个 entry 的字段 | |
| `entry.upsert` | 新增或整条替换一个 entry | wide |
| `entry.remove` | 删除一个 entry | protected tools 不可删除 |
| `asset.create` | 新建文件 | 已存在则失败 |
| `asset.remove` | 删除文件/目录 | wide |
| `field.set` | 单个组件字段 | review-only 组件属于 wide |
| `component.set` | 整个组件 | wide；generated tools 仍被阻断 |

### file-backed skill

表示形态保持不变。file-backed skill 仍然是 file-backed：

- 修改正文：`text.patch`，target 使用
  `{component:"skills", entry:"<name>", field:"content"}`（或
  `asset:"skills/<name>/SKILL.md"`）；
- 修改 frontmatter：`entry.update` / `field.set` 设置 `description`；
- 新建 file-backed skill：

```jsonc
[
  {
    "op": "asset.create",
    "target": { "component": "skills", "entry": "new-skill", "asset": "skills/new-skill/SKILL.md" },
    "content": "---\nname: new-skill\ndescription: ...\n---\n\n# ...\n"
  },
  {
    "op": "entry.upsert",
    "target": { "component": "skills", "entry": "new-skill" },
    "value": { "source": "./skills/new-skill" }
  }
]
```

`source` 可用于 skills/commands 的 `entry.upsert`，但不被 `field.set` 接受；改变
表示形态必须显式 upsert。

Memory entry 没有稳定 id。`entry.update` / `entry.remove` 用 entry 当前精确的
`content` 作为匹配 key；内容重复会被视为歧义并拒绝。

Generated tools 在 apply 和 compile 两层都硬阻断。Protected 内置工具可以禁用，但
不能删除。

## 审核

每个 patch operation 是一个审核项。计数器是**按项独立**的：

- `applyFailures`：Apply 校验失败最多 3 次。达到 3 次后，Apply 在本地被拦住，该项
  只能重拟或拒绝。
- `revisionRounds`：Comment 重拟最多 3 轮。提交 comment 就消耗一轮，即使模型的
  重拟失败；在评论框按 Esc 取消不消耗。
- 重拟成功会重置 `applyFailures`（因为 operation 已经变了），但不会重置
  `revisionRounds`。
- `Comment` 只重拟当前项；其他项和已经 Apply 的项不受影响。
- `--auto` 没有 Comment；Apply 第一次失败就拒绝该项。

最终接受的操作集合只编译一次。因此一次 `evolve` 命令最多创建一个 revision，即使
各项是逐项 Apply 的。

## 校验与硬阻断

安装前，`compile.ts` 会：

1. 把 base bundle 复制到 staging，并删除 `.rsih-seed.json`；
2. 只重写字段发生变化的组件；
3. 写入变化的资产文件，以及带 contract 的新组件文件；
4. 更新 `genome.json`（`version + 1`、`parent_id`、新的 `genome_id`、
   `evolution` 元数据）；
5. 用 core loader 加载结果；
6. 要求加载结果与工作模型语义等价（排除 `component_manifest`）；
7. 检查 skills/templates/extensions/themes 是相对路径且存在于 bundle 内；
8. 检查 `DEFAULT_HARNESS_COMPLEXITY_LIMITS`；
9. 确认 generated tools 没有变化；
10. 如果 proposal 固定了 base content hash，检查它仍然匹配。

任何失败都会删除 staging，active Genome 保持不变。

## 版本与回滚

```text
~/.rsih/genomes/paperlab/                     active，名字永远不变
~/.rsih/evolution/paperlab/
├── state.json                               baseline、watermark、cursor、history
├── events.jsonl                             追加式证据索引
├── proposals/<timestamp>.json               已保存的 proposal
└── versions/
    ├── 1/                                   完整 bundle
    └── 2/                                   完整 bundle
```

- revision 是整数（`1, 2, 3...`）；永远不会产生 `paperlab-v2`。
- 安装时先把当前 active bundle 归档，再原子替换。
- `versions` 列出 active revision 和所有归档。
- `rollback --to N` 先归档当前 revision，再从归档恢复 `N`。归档是复制而不是移动，
  所以仍然保留。
- `nextEvolutionVersion` 取 active 和所有归档 revision 的最大值加一，因此回滚后
  再进化不会和归档版本冲突。

## 与 core RSIH 解耦

- 不修改 `PATCH_OPERATIONS`、`applyHarnessPatch`、`harnessPatchSchema`、
  `COMPONENT_OPERATIONS`、现有 extension 或正常会话路径。
- `EvolutionPatch`、`applyEvolutionPatch` 和编译器都归 evolution 所有。
- core 调用都是只读的：`loadHarnessGenomeFile`、`validateHarnessGenome`、
  `projectGenomeSettings` / `mergeManagedSettings`、`assertHarnessComplexity`。
- CLI 只在进化的子命令上动态 import。
- `components.ts` 与 core 组件列表做 parity 测试；新增 core 组件时必须同步更新
  映射和测试。

## 测试

```bash
npm run typecheck
npm test
npm run check        # typecheck + test + build
```

相关测试：

- `test/evolution-evidence.test.ts` —— reader、marker、watermark、index、sequences。
- `test/evolution-state.test.ts` —— baseline 顺序、state 往返、锁。
- `test/evolution-digest.test.ts` —— 分层、上限、provenance、skill/command usage。
- `test/evolution-proposal.test.ts` —— schema、weak-only 闸门、模型调用。
- `test/evolution-model.test.ts` —— profile 解析。
- `test/evolution-patch.test.ts` —— EvolutionPatch schema/校验/parity。
- `test/evolution-base-summary.test.ts` —— 当前正文、越界、上限。
- `test/evolution-apply.test.ts` —— 细粒度操作和硬阻断。
- `test/evolution-compile.test.ts` —— 物化、语义等价、paperlab。
- `test/evolution-versions.test.ts` —— 归档、替换、回滚、冲突。
- `test/evolution-review.test.ts` —— 审核状态机和计数器。
- `test/evolution-e2e.test.ts` —— paperlab 自动进化、plan/apply、逐项审核、
  weak-only 拒绝、CLI versions/rollback。
- `test/evolution-cli.test.ts` —— 命令解析和分发。

当前基线：**299/299** 测试通过；`npm run typecheck` 和 `npm run build` 通过。

## 已知限制

- **Commands 使用证据是弱信号**：Pi 在记录用户轮之前就把 `/command` 模板展开，
  所以命令名通常不存在。digest 会报告 `command_usage_signal: "unknown"`，不会伪造 0。
- **Skill 使用不等于 skill 有效**：`load_skill`/`read SKILL.md` 只证明 skill 被加载过，
  不代表它有帮助。失败和纠正只是相关性，不是因果。
- **Instructions/memory 没有使用计数**：相关性来自当前正文，加上纠正/失败/
  compaction。
- **Base 正文上限**：`base-summary.ts` 默认 60k 字符。正文被省略时，模型不能猜
  `find` 字符串；必须使用整文件替换。
- **精确 find/replace**：0 次或多次命中都会拒绝。
- **表示形态保持**：file-backed skill 仍然 file-backed；inline 仍然 inline。新 skill
  默认写到 `skills/<name>/SKILL.md`。
- **TUI raw key 行为未自动化**：CI 没有真实 TTY。状态机和适配器选择用假 UI 测试；
  需要在终端运行 `rsih genome evolve paperlab` 验证 `a/r/c/d/q`、Comment 输入和
  `--auto` 展示。
- **旧索引**：在 `genome`/`skill`/`command` 字段出现之前写入的事件，需要
  `--reset-watermark` 重建 provenance。
- **模型 planning 需要 provider profile**：传入
  `--config <providers.json>`（可选 `--profile <id>`）。嵌入或测试调用可以注入
  `propose`。

## 状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| A | reader、events、watermark、index、sequences、genome 归属、skill/command 证据 | 完成 |
| B | state/baseline、digest 分层、proposal/model、当前正文、weak-only 闸门 | 完成 |
| C0 | `EvolutionPatch`、组件映射、validator | 完成 |
| C1 | apply 引擎、编译器、归档/安装/回滚 | 完成 |
| D | CLI、TUI 审核、plan/proposal/apply/diff/versions/rollback、paperlab E2E | 完成 |
| E | 文档、`npm run check`、提交 | 完成 |
| F | session-end/scheduled 触发器、promote | 未实现 |

完整设计记录、决策和验收标准见 `.zcode/plans/evolution-plan.md`。
