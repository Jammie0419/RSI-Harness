# RSIH 修复日志

本文档按日期记录 RSIH 的修复与改进，供后续维护查阅。

写法约定：

- 每次有实质性改动，在文件末尾追加一节 `## YYYY-MM-DD`；同一天的多组改动都写在同一个日期节内，按"组"划分（组名 + 提交号）。
- 每条包含四个部分：**现象**（能观察到的问题）、**原因**（出问题的代码位置与逻辑）、**解决**（改了什么）、**验证**（测试或实测方式）。
- 文中的文件路径、函数名、参数名均为实际值，可直接用于检索代码。
- 未修复/未处理的事项写在"设计决定与限制"里，注明原因。

---

## 2026-10-15

### 当天概览

做了四件事：

1. 对源码做了一轮系统审计（多路并行检查 + 逐条复现），得到一批确认的缺陷；
2. 按优先级分四组修复：安装与发行版（组 A，提交 `7abbcf1`）、审计缺陷（组 B，`53632c9`）、优先项（组 C，`ac468ad`）、第二批（组 D，`d1a23af`）、第四批（组 E，未提交）；
3. 补齐验证：对三条"已知限制"逐条处理（能改的改、能测的补测、改不了的加提示并用测试固定行为）；
4. 可选改进（组 F，未提交）：版本常量独立、消除循环导入、测试脚本通配符化、契约同步脚本覆盖 examples。

| 组 | 提交 | 条目 | 状态 |
| --- | --- | --- | --- |
| A. 安装与发行版 | `7abbcf1` | 8 | 已提交并推送 |
| B. 审计缺陷 | `53632c9` | 9 | 已提交并推送 |
| C. 优先项 | `ac468ad` | 10 | 已提交并推送 |
| D. 第二批 | `d1a23af` | 5 | 已提交并推送 |
| E. 第四批 | 未提交 | 13 | 待提交 |
| F. 可选改进 | 未提交 | 4 | 待提交 |

### 对现有使用的影响

#### 对 pi 的影响：无

- 全部改动都在 RSIH 自己的文件里：`src/`、`test/`、`docs/`、`config/`、`examples/`、`install.sh`、`README.md`、`package.json`、`scripts/`。没有任何一个文件属于内嵌的 Pi（`node_modules/@earendil-works/*`），仓库里也没有对 Pi 打补丁的脚本或构建步骤。
- 单独运行 `pi` 时，加载的是 Pi 自己的代码和它自己的配置目录（默认 `~/.pi/agent`，或 `PI_CODING_AGENT_DIR` 指定的目录），本仓库的代码不会被加载。
- `rsih` 运行时通过两个环境变量把内嵌 Pi 指向 RSIH 自己的位置：`PI_PACKAGE_DIR`（让 Pi 读取 rsih 的 `package.json`，其中 `piConfig.configDir` 为 `.rsih`）和 `RSIH_CODING_AGENT_DIR`（默认 `~/.rsih`），两者都在 `src/cli.ts` 里设置。`src/` 中没有任何 `~/.pi` 路径引用（已用 grep 确认）。因此 rsih 的读写都发生在 `~/.rsih` 与当前项目内。
- 本机没有安装全局 `pi`，无法并排运行对比；以上结论来自模块加载路径与配置目录隔离的静态检查。

#### 对 rsih 正常功能的影响：已验证无回归

- `npm test`：216/216 通过；`tsc --noEmit` 无错误。
- 真实运行（使用构建产物 `dist/`，即全局 `rsih` 命令执行的同一份代码）：
  - print 模式对话（mock 模型）：退出码 0，正常输出回答；含一个无法启动的 MCP 服务器时，其余功能不受影响，失败项以警告列出；
  - `rsih --version` → `0.1.0`；
  - `rsih genome list` / `validate` / `show` 正常（`show` 输出合并后的设置文件）；
  - 交互式 TUI：正常启动，底部状态栏正常显示当前 Genome；
  - `rsih --resume` 选择器：选中记录的 Genome 与本次运行不同时给出提示（见 E2）；
  - 组 B 的 36 项核查脚本重跑全部通过（无回归）。

#### 有意的行为变化（全部是修复目标，使用时可能感知到）

| 变化 | 说明 |
| --- | --- |
| 新增警告输出 | print 模式走 stderr、TUI 模式走通知条：设置文件写失败、MCP 服务器未能启动、`--resume` 选中会话的 Genome 与本次运行不同。均不影响运行结果。 |
| 子命令路由 | `rsih :名称 auth check` 这类调用现在真正到 Pi 的子命令（以前被当成聊天消息）。 |
| `--new` 组合报错 | `--new` 与 `--continue/-c`、`--resume/-r`、`--session`、`--session-id`、`--run-id`、`--fork` 同用会直接报错（以前部分组合会静默恢复旧会话）。 |
| `--version` 识别更严格 | 只把真正的旗标当版本请求；`--name -v` 里的 `-v` 视为名字（以前会直接打印版本退出）。 |
| `--export` | 导出运行不再向项目 `.gitignore` 写入内容。 |
| 信号退出码 | 子进程被信号终止时，supervisor 返回 128+信号号（SIGINT 即 130；以前返回 128）。 |
| 模型重试策略 | 401/403/404 等不可重试状态立即失败（以前会重试到上限）；服务器给出的 `Retry-After` 超过 5 分钟按 5 分钟处理。 |
| `.env` 解析 | 支持 `export KEY=value`；`KEY=value # 注释` 的值不再包含注释（值里需要保留 `#` 时请用引号）。 |
| `genome show` 输出 | 从"Genome 的补丁"改为"合并后实际会写入的文件内容"（包含已有键、`quietStartup`、`$rsih` 标记）。解析旧格式的脚本需要更新。 |
| 校验更严格 | Genome 的容器字段类型、嵌套设置键名、内容哈希只接受 JSON 值、工具参数 schema 关键字；以前静默通过的非法输入现在报错。 |
| 生成工具输出截断 | 按字符数截断并追加 `[truncated]`（以前多字节输出会直接失败、且从不截断）。 |

未变的既有行为：Genome 声明的设置键仍会覆盖 `settings.json` 中同名键；`~/.rsih` 与项目的 `.rsih/` 目录结构不变；`rsih` 与 `pi` 的会话目录仍各自独立。

### 修复明细

#### 组 A：安装与发行版（提交 `7abbcf1`，8 项）

##### A1. 配置目录在 Windows 上写进了仓库

- 现象：在 Windows 的 cmd.exe / PowerShell 里从源码目录运行，`~/.rsih` 配置（含凭据）被写进安装目录或源码仓库。
- 原因：配置目录来自 `process.env.HOME`，而 cmd.exe 与 PowerShell 不设置 `HOME`，代码回退到了包目录。
- 解决：`src/cli.ts` 改用 `os.homedir()`（在 Windows 上读取 `USERPROFILE`）。
- 验证：CLI 目录设置相关用例。

##### A2. 通过符号链接安装后命令静默无效

- 现象：`npm link` 或 `npm install -g .` 之后运行 `rsih`，程序什么都不做并以退出码 0 结束。
- 原因：入口检测用 `import.meta.url` 与 `resolve(argv[1])` 直接比较；符号链接路径与真实路径不同，比较失败，入口代码不执行。
- 解决：比较时先做 `realpathSync`（Windows 上大小写归一），检测提取到 `src/cli/entry-point.ts` 供 `rsih` 与 `gee` 共用。
- 验证：`test/cli.test.ts`（符号链接入口用例）。

##### A3. `--version` 回答 RSIH 版本且无副作用

- 解决：`rsih --version` / `-v` 在解析 Genome、编译设置之前直接回答 RSIH 版本。
- 验证：`test/cli.test.ts` 的 `--version answers for RSIH, not for the Pi it embeds`。

##### A4. Windows 安装脚本

- 现象：`install.sh` 在 Windows 上不可用（没有 Bun 二进制可符号链接，也没有免管理员的 symlink 可放进 PATH）。
- 解决：Windows 分支改用 tsc 构建，生成 node 包装脚本与 `.cmd` 孪生文件，`.cmd` 通过 `%~dp0` 引用同目录文件。
- 验证：`test/cli.test.ts`（install.sh 各平台形式）。

##### A5. 发行版缺少 Pi 的版本与资源

- 现象：npm/dist 布局下 Pi 的版本、文档、示例缺失；pi.dev 只对它能识别的版本提供模型目录。
- 解决：`scripts/copy-build-assets.ts` 把内嵌 Pi 的版本写进 `dist/package.json`，并复制 Pi 的 README、docs、examples 以及导出模板（`dist/src/core/export-html`）。
- 验证：模型目录相关测试与 `--export` 用例。

##### A6. Windows 上生成工具的 `/bin/sh`

- 问题：在 Linux 写的 Genome 里的生成工具在 Windows 上无法启动（`/bin/sh` 不存在）。
- 解决：`src/harness/builtin-tools.ts` 的 `generatedToolShell()` 在 win32 上把 `/bin/sh` 解析为 `sh`（经 PATH）。
- 验证：`test/core-harness.test.ts`（生成工具用例）。

##### A7. 项目自己的 `.rsih` 自动加入 `.gitignore`

- 解决：`src/harness/project-ignore.ts` 的 `ensureProjectIgnored()` 在三个条件下向项目 `.gitignore` 追加 `.rsih/`：目录已存在于 cwd 到工作树根之间、运行位于 git 工作树内、`.gitignore` 已存在。条目写到工作树根，保留原有换行风格（CRLF/LF），每次写入都有提示。
- 验证：`test/core-harness.test.ts` 的 ignore 规则用例、`test/cli.test.ts` 的退出时复查用例。

##### A8. TUI 头部在 Windows 的路径分隔符

- 解决：TUI 头部按终端实际显示渲染路径分隔符。
- 验证：`test/cli.test.ts` 的头部宽度与渲染用例。

#### 组 B：审计缺陷（提交 `53632c9`，9 项）

##### B1. `runtime.thinking_level: "max"` 被拒

- 现象：Genome 写 `runtime.thinking_level: "max"` 时加载失败，而 Pi 支持 `max`。
- 原因：`src/harness/genome.ts` 的 thinking 档位枚举比 Pi 支持的少一级。
- 解决：枚举补上 `"max"`。
- 验证：`test/core-harness.test.ts` 的 thinking 档位用例。

##### B2. 生成工具可以覆盖 Pi 的内置工具

- 现象：生成工具命名为 `ls`、`find` 或 `powershell` 时会替换 Pi 自带的同名工具。
- 原因：受保护工具名单写的是 `list`（目录工具的旧名），漏了 `ls`、`find`、`powershell`。
- 解决：名单改为 `read, list, ls, grep, find, write, edit, bash, powershell, load_skill, scratchpad`。
- 验证：`test/core-harness.test.ts` 的受保护工具名用例。

##### B3. `--export` 与 `/export` 因 ENOENT 失败

- 现象：导出会话为 HTML 时报文件不存在。
- 原因：npm/dist 布局下 Pi 在 `dist/src/core/export-html` 查找导出模板，构建过程没有复制该目录。
- 解决：`scripts/copy-build-assets.ts` 增加该目录的复制。
- 验证：构建产物检查与导出测试。

##### B4. `settings.json` 带 BOM 或为空时补丁被丢弃

- 现象：编辑器留下的 BOM、或被截断为空文件的 `settings.json`，会让 Genome 声明的所有设置键静默失效。
- 原因：`src/harness/settings-layer.ts` 读取该文件时把这两种情况判为格式错误并放弃编译。
- 解决：`readJsonFile()` 剥离 BOM（`/^\uFEFF/`），空内容按 `{}` 处理，与 Pi 的读取方式一致。
- 验证：`test/settings-layer.test.ts` 的 `a settings file with a BOM or nothing in it still compiles`。

##### B5. 提示词拼接把 `$&` 等当作替换模式

- 现象：Genome 指令文本里包含 `$&`、`$$`、`$'` 时，切换 Genome 会把上一个 Genome 的指令块插入到这些位置，且没有任何提示。
- 原因：使用 `String.replace(block, replacement)` 做拼接，第二个参数会被当作替换模式解析。
- 解决：`src/harness/genome-session.ts` 改为字面替换 `text.replace(block, () => replacement)`。
- 验证：`test/genome-switch.test.ts` 的 `prompt text is spliced literally, not as a replacement pattern`。

##### B6. `.gitignore` 覆盖检查把 `/.rsih/` 当作覆盖所有层级

- 现象：项目 `.gitignore` 里已有 `/.rsih/` 时，子目录里的 `.rsih` 不会被补进 ignore，可能被提交。
- 原因：`.rsih` 前的前导斜杠在 git 中锚定工作树根；检查代码把它当成了任意层级都覆盖。
- 解决：`src/harness/project-ignore.ts` 的覆盖集合限定为 `[".rsih", ".rsih/", "**/.rsih", "**/.rsih/"]`。
- 验证：`test/core-harness.test.ts` 的 ignore 规则用例（锚定式与 `**/` 式）。

##### B7. 窄终端下 TUI 头部产生超宽行

- 现象：终端宽度小于 24 列时，TUI 头部渲染出比终端更宽的行，Pi 的渲染器检测到后直接退出。
- 原因：头部渲染强制了 24 列最小宽度。
- 解决：`src/tui/rsih-tui.ts` 按实际终端宽度收敛。
- 验证：`test/cli.test.ts` 的 `the header never renders a line wider than the terminal`。

##### B8. `--` 没有结束 RSIH 自己的选项解析

- 现象：`rsih -p -- --genome foo` 把消息吃掉并切换了 Genome。
- 原因：`--` 只对 Pi 的解析生效，RSIH 自己的解析仍继续扫描后续参数。
- 解决：`src/pi-cli-runtime.ts` 的解析函数在遇到 `--` 时把剩余参数整体交给 Pi。
- 验证：`test/cli.test.ts` 的 `arguments after -- reach Pi as messages, not as RSIH options`。

##### B9. `genome-session.ts` 内嵌裸 NUL 字节

- 现象：git、grep 和文件工具把该源文件当作二进制，diff 与搜索都失效。
- 原因：文件里有两个原始 NUL 字节。
- 解决：改为 `"\u0000"` 转义。
- 验证：文件文本检查与全套测试。

#### 组 C：优先项（提交 `ac468ad`，10 项）

##### C1. artifact 类型名路径穿越

- 现象：类型名含 `../` 的 artifact 被写到存储目录之外；`store.get("../...")` 能读到存储目录之外的文件。
- 原因：`src/core/artifacts.ts` 的 `fileNameFor()` 直接拼接类型名，未清理路径分隔符。
- 解决：文件名只保留 `[A-Za-z0-9._-]`，`:` 替换为 `__`；写盘与读取的最终路径都限制在存储目录内。
- 验证：`test/core-harness.test.ts` 的 `an artifact stays inside its store`；核查脚本第 1 组。

##### C2. 内容规范化折叠非 JSON 值导致哈希撞号

- 现象：`Date` 变为 `{}`、`NaN` 变为 `null`、数组里的 `undefined` 被丢弃；不同内容算出同一个 artifact id，后写的覆盖先写的。
- 原因：`src/core/json.ts` 的 `canonicalize()` 依赖 `JSON.stringify` 的默认行为，未校验值是否为 JSON。
- 解决：拒绝非 JSON 值（非纯对象原型、非有限数字、`undefined`、`bigint`、函数、symbol），`-0` 归一为 `0`。
- 验证：`test/core-harness.test.ts` 的 `canonical hashing accepts JSON only`；核查脚本第 2 组。

##### C3. artifacts 非原子写

- 现象：大文件写入过程中并发读取会读到半截 JSON（解析失败或数据残缺）。
- 原因：`FileArtifactStore.put()` 直接写目标文件。
- 解决：先写 `${target}.tmp-${进程号}` 再 rename。
- 验证：核查脚本第 3 组（写入过程中并发读 60 次，0 次损坏）。

##### C4. 容器字段类型未校验

- 现象：`runtime`、`policies`、`memory`、`model`、`mcp`、`appearance` 传入字符串、数字或数组时被静默接受。
- 原因：`src/harness/genome.ts` 的校验只检查了部分字段。
- 解决：这些字段必须是对象，否则加载即报错。
- 验证：`test/core-harness.test.ts` 的 `the components that own nested objects must be objects`；核查脚本第 4 组。

##### C5. 文件形式的技能/模板无法按名字操作

- 现象：`remove_skill`、`upsert_skill`、`remove_prompt_template` 对 `{source: "./skills/x"}` 形式的条目匹配不到；同名 `upsert` 变成追加（出现重复）；技能重名检查漏掉文件形式条目。
- 原因：名字匹配只认内联条目上的 `name` 字段。
- 解决：新增 `sourceName()`（从文件名推导名字）与 `resourceName()`（字符串、内联、source 三种形式归一），上述操作与重名检查统一走它。
- 验证：`test/core-harness.test.ts` 的 `a file-backed skill is addressed by the name Pi gives it`；核查脚本第 5 组。

##### C6. 单文件 Genome 拒绝 `null` 字段

- 现象：单文件 Genome 写 `settings: null` 等字段时加载报错。
- 原因：补丁语义中 `null` 表示"不覆盖/还原"，但单文件加载路径没有先剥离这些键。
- 解决：`src/harness/genome-bundle.ts` 在校验前剥离顶层值为 `null` 的键。
- 验证：`test/core-harness.test.ts` 的 `a flat Genome reads a top-level null as inherit`；核查脚本第 6 组。

##### C7. 工具参数校验器不支持标准 JSON Schema 关键字

- 现象：两类错误同时存在——合法的 `type: ["string","null"]` 与 `patternProperties + additionalProperties: false` 被误拒；`oneOf`、`anyOf`、`allOf`、`not`、`const`、`enum`、`exclusiveMinimum/Maximum`、元组形式 `items`、`additionalProperties` 为 schema 的写法全部不生效（非法参数放行）。
- 原因：`src/core/schema.ts` 的校验器只实现了少数关键字。
- 解决：重写校验器，实现上述关键字（含枚举深比较与 `pattern`）。
- 验证：`test/core-harness.test.ts` 的 `the tool schema gate honours the standard keywords`；核查脚本第 7 组（13 条断言）。

##### C8. 请求携带 RSIH 自己的 `strict` 字段

- 现象：发给模型提供方的工具定义带 `strict` 字段，与 pi-ai 自己的严格模式转换冲突。
- 解决：`src/model/model-runtime.ts` 移除 RSIH 注入的 `strict`，两种请求格式（chat/completions 与 responses）都不再携带，严格转换完全交给 pi-ai。
- 验证：`test/model-runtime.test.ts`（两种载荷均无 strict）；核查脚本第 8 组。

##### C9. 一个 MCP 服务器失败会拖垮整个扩展

- 现象：声明多个 MCP 服务器时，任何一个启动失败都会让整个扩展初始化失败，其余服务器已连接的工具也全部丢失。
- 原因：`src/harness/mcp.ts` 用一个总的 try/catch 包住全部服务器并重新抛出。
- 解决：逐服务器隔离：失败者关闭其客户端、工具丢弃，错误以 `"<服务器名>: <原因>"` 记入返回的 `errors`；其余服务器照常。调用方（`src/pi-cli-runtime.ts`）在会话启动时把 `errors` 上报（TUI 通知条 / print 模式 stderr）。
- 验证：`test/core-harness.test.ts` 的 `an MCP server that fails is isolated and reported, not fatal`；混合探针（正常服务器工具实际可调用）。

##### C10. Genome 的 argv 吞掉 Pi 的子命令

- 现象：`rsih :paperlab auth check` 把 "auth check" 当成聊天消息，而不是执行 Pi 的凭据检查子命令。
- 原因：RSIH 把 Genome 参数前置到 argv，Pi 按第一个参数分派子命令，于是子命令被挤到第二位。
- 解决：`src/pi-cli-runtime.ts` 的 `PI_SUBCOMMANDS` 识别 `auth/install/remove/uninstall/update/list/config` 时不前置 Genome 参数。
- 验证：`test/cli.test.ts` 的 `a Genome does not swallow Pi's subcommands`。

#### 组 D：第二批（提交 `d1a23af`，5 项）

##### D1. 生成工具输出上限用错单位

- 现象：声明 `max_output_chars: 20000` 的工具输出 1 万个中文字符（3 万字节）时直接失败（`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`）；任何情况下输出都不会按上限截断。
- 原因：该值被直接传给进程的 `maxBuffer`（单位是字节，超限即杀进程），而不是作为截断阈值。
- 解决：`src/harness/builtin-tools.ts` 里字节缓冲只做失控保护（`max(上限×4+1024, 4MB)`）；输出按字符数截断，超出部分追加 `[truncated]`。
- 验证：`test/core-harness.test.ts` 的 `a generated tool's output limit counts characters, not bytes`；tier2 探针实测（1 万中文成功返回）。

##### D2. 提示词块出现多次时被盲替换

- 现象：切换 Genome 时，若旧指令块在提示词中出现多次，"替换第一处"可能改到不属于旧 Genome 的文本，且无提示。
- 原因：`spliceBlock()` 只判断"包含"，不判断出现次数。
- 解决：`src/harness/genome-session.ts` 仅当恰好出现一次时替换；多于一次则保持原样，并在 caveats 中说明"出现多次、未替换，重启会话可清理"。
- 验证：`test/genome-switch.test.ts` 的 `appended text that appears twice is left in place and reported`。

##### D3. 设置文件写失败导致启动被拒

- 现象：`settings.json` / `keybindings.json` 只读或被占用时，启动直接抛错失败。
- 解决：`src/harness/settings-layer.ts` 捕获写入错误，收集为 `warnings` 随 `{settings, keybindings, warnings}` 返回；调用方在会话启动时提示（通知条 / stderr），本次运行按文件旧值继续。
- 验证：`test/settings-layer.test.ts` 的 `a settings file that cannot be written is reported, not fatal`。

##### D4. 嵌套设置键拼错被静默接受

- 现象：`settings: { terminal: { showImage: true } }`（正确键名是 `showImages`）通过校验、实际什么都不配置。
- 原因：对象型设置项（`terminal`、`images`、`thinkingBudgets`、`markdown`、`warnings`、`branchSummary`）不在键白名单中，其子键完全不校验。
- 解决：`src/harness/pi-surface.ts` 的 `PI_SETTINGS_OBJECT_KEYS` 按 Pi 的接口定义补全；拼错时报错并列出 Pi 接受的键名。
- 验证：`test/settings-layer.test.ts` 的未知键用例；探针（`showImage` 被拒并给出候选键名）。

##### D5. `--new` 无效

- 现象：`--new` 的文档承诺是"开始新会话而不是恢复"，实际只挡住 `-c/-r/--session`；`rsih --new --run-id X` 在 X 已存在时仍然打开旧会话。
- 原因：`--new` 解析后除组合校验外没有任何行为；唯一真正会恢复会话的路径（`--run-id` 映射为 Pi 的 `--session-id`，命中即打开；`--fork` 从旧会话派生）没有被检查。
- 解决：`src/pi-cli-runtime.ts` 新增 `assertFreshSession()`：`--new` 命中 `--continue/-c`、`--resume/-r`、`--session`、`--session-id`（含 `--run-id`）、`--fork` 时直接报错并指明具体选项。
- 验证：`test/cli.test.ts` 的 `--new refuses every option that can resume a session` 与 `--new with a run id stops before Pi starts`；两轮同 run-id 的复现脚本（修复前静默追加进旧会话，修复后第二轮 exit 1 且旧会话未被写入）。

#### 组 E：第四批（未提交，13 项）

##### E1. 会话目录解析与 Pi 不一致（4 处）

- 现象：恢复/续跑会话时，Genome 快照可能找错或找不到（静默回退默认 Genome）。
- 原因：`src/pi-cli-runtime.ts` 的 `piSessionDirectory()` 只读全局 `settings.json`、不展开 `~`；`findSessionFile()` 列会话文件不按当前项目过滤（共享 `--session-dir` 时会命中其他项目的同 id 会话）；完全不处理 `--fork`。
- 解决：按 Pi 的实现对齐——
  - 目录优先级：`--session-dir` → `RSIH_CODING_AGENT_SESSION_DIR` → `sessionDir` 设置（项目级覆盖全局）→ 默认的按项目目录；`~` 展开、相对路径按 cwd 解析；
  - 仅在"自定义目录"时按 cwd 过滤会话（`sessionBelongsTo()`，与 Pi 的 `SessionManager.list` 相同条件）；
  - `--fork` 解析源会话（路径或 id；本项目优先，未命中回退全部项目，与 Pi 的 `resolveSessionPath` 相同顺序）；
  - `--session-id` 只接受本项目的会话（与 Pi 一致：未命中即创建新会话）。
- 验证：`test/session-lookup.test.ts`（2 个用例覆盖目录优先级、`~`、cwd 过滤、fork 路径与 id、跨项目回退）。

##### E2. `--resume` 无法预读所选会话的 Genome 快照（已加提示）

- 现象：用 `--resume` 的选择器恢复一个在非默认 Genome 下创建的会话时，本次运行按默认 Genome 执行，且会话会被改记为默认 Genome——全程没有任何提示。
- 原因：所选会话在 Pi 的交互选择器运行之后才确定，RSIH 必须在启动前决定 Genome。
- 解决：会话启动后若发现所选会话记录的 Genome 与本次运行的不同，就报告——"该会话创建于 X Genome，`--resume` 无法在启动前读取选择结果，本次按 Y 运行且会话将记录 Y；要按原 Genome 运行请传 `--genome X`"（TUI 通知条 / print 模式 stderr；实现为 `resumeGenomeNotice()`，`src/pi-cli-runtime.ts`）。`findSessionFile()` 对 `--resume`/`--no-session` 返回空的行为用注释说明并有测试固定；`--session`、`--session-id`、`--run-id`、`--continue`、`--fork` 均能读取快照。
- 验证：单元测试 `--resume without a Genome explains the picker's limit`（`test/cli.test.ts`）；真实 `--resume` 选择器实测——屏幕上出现该提示，且会话的 `rsih.genome` 记录由自定义 Genome 变为 `default`（与提示所述一致）。要彻底消除这一限制，需要 Pi 在启动前暴露选择结果。

##### E3. 会话文件中的坏行导致整份文件读空

- 现象：会话 JSONL 中有一行损坏时，该会话的 id 与 `rsih.genome` 快照全部读不到。
- 原因：`readSessionEntries()` 把整份文件的解析放在一个 try/catch 里，任一行失败即返回空数组。
- 解决：逐行 try/catch，坏行跳过，其余保留。
- 验证：`test/session-lookup.test.ts`（会话文件带撕裂尾行仍能读到头部）。

##### E4. 切换请求文件非原子写

- 现象：子进程写切换请求时若 supervisor 恰好读取，会读到半截内容；`takeSwitchRequest()` 会删除该文件并返回空——切换请求丢失，进程退出但不重启。
- 原因：`writeSwitchRequest()`（`src/cli/supervisor.ts`）直接覆盖写入。
- 解决：改写临时文件再 rename（同 artifacts 做法）。
- 验证：`test/supervisor.test.ts` 的 `a switch request replaces the previous file atomically`。

##### E5. `gee` 绕过 supervisor

- 现象：在 `gee` 的交互会话里执行 `/switch-genome`，请求被写入但无人消费，切换不生效。
- 原因：`src/gee/cli.ts` 直接调用 `runCli()`，没有经过 `rsih` 的 `runLauncher()`（supervisor 在该函数里建立）。
- 解决：`runLauncher()` 从 `src/cli.ts` 导出，`gee` 改走同一条路径。
- 验证：用 winpty 启动真实 TUI，进程树中有 supervisor + 子进程两个 node 进程（修复前只有一个），画面与通知条正常；该路径仍无自动化用例（需要真实终端）。

##### E6. 不可重试的 HTTP 状态码仍被重试

- 现象：401/403/404 等判定为"不可重试"后仍然被重试到上限，且最终错误被包装成 "Model request failed after N attempt(s)"，丢失原始状态信息。
- 原因：判定后抛出的 `Error` 位于重试循环的 try 块内，catch 把无标记的错误一律当作可重试的传输错误。
- 解决：`src/model/model-runtime.ts` 中不可重试状态抛出带 `code = "MODEL_REQUEST_HTTP"` 的错误，catch 识别该标记后直接透传给调用方。
- 验证：`test/model-runtime.test.ts` 的 `a non-retryable HTTP status fails immediately, not after retries`（401 只请求 1 次、错误信息原样）。

##### E7. `Retry-After` 无上限

- 现象：服务器返回 `Retry-After: 86400`（一天）会真的等待一天；超大数值会触发 Node 的 setTimeout 溢出（被夹为 1ms 并告警），行为不可预期。
- 原因：`parseRetryAfterMs()` / `rateLimitDelayMs()` 对服务器给出的等待时间没有上限。
- 解决：只钳制服务器给出的 `Retry-After`（上限 5 分钟，`MAX_RETRY_AFTER_MS = 300_000`）；Genome 自己配置的基础延迟保持不变。
- 验证：`test/model-runtime.test.ts` 的 `an overflowing Retry-After is capped instead of parking the run`（实际等待 300000ms）；现有的 120 秒用例仍然通过。

##### E8. 信号退出码不是 128+信号号

- 现象：子进程因 Ctrl+C 退出时，supervisor 返回 128（约定应为 130 = 128+SIGINT）。
- 原因：原实现尝试 `process.kill(process.pid, signal)` 重发信号，但 supervisor 自身挂着 SIGINT 的忽略处理器，重发不会终止进程；Windows 也没有信号可以重发。
- 解决：`src/cli/supervisor.ts` 直接返回 `128 + 信号号`（`node:os` 的 `constants.signals`）。
- 验证：`test/supervisor.test.ts` 的 `a signalled child reports the conventional 128+signal exit code`（SIGINT → 130）。

##### E9. `--export` 未列入"只打印"参数

- 现象：导出会话时会执行针对项目的操作（例如向 `.gitignore` 追加 `.rsih/`）。
- 解决：`--export` 加入 `PRINT_ONLY_ARGUMENTS`，启动与退出两处 ignore 检查都会跳过。
- 验证：`test/cli.test.ts` 的 `--export is a print-only run and leaves the project alone`。

##### E10. `--version` 识别不区分选项值

- 现象：`rsih --name -v` 把 `-v` 当作版本请求，直接打印版本退出。
- 原因：`versionRequested()` 对全部参数做简单 token 扫描。
- 解决：新增取值选项集合 `VALUE_TAKING_OPTIONS`；遇到取值选项时跳过其后面的值，`--` 之后不再识别。
- 验证：`test/cli.test.ts` 的 `a version request is a flag, never an option's value`；实测 `rsih --name -v -p hi` 不再输出 `0.1.0`。

##### E11. `.env` 解析边界

- 现象：`export KEY=value` 的键名会变成 "export KEY"；`KEY=value # 注释` 把注释算进值里；只有成对的最外层引号被去掉；非法键名被接受。
- 解决（`src/model/env.ts`）：识别并剥离 `export ` 前缀；非引号值在空白+`#` 处截断（`a#b` 保留）；引号值取到闭引号为止；键名必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`。
- 验证：`test/model-runtime.test.ts` 的 `loadEnvFile reads dotenv spellings: export, comments, quoting`。

##### E12. `genome show` 输出与"落盘内容"的说法不符

- 现象：命令只打印 Genome 的 settings 补丁，而代码注释与预期是"展示实际会写入的内容"；用户拿输出与真实 `settings.json` 对照会不一致。
- 解决：`showGenome()` 改用 `applyManagedConfiguration({..., write: false})` 打印合并后的结果（保留已有键、叠加补丁、写入 `$rsih` 标记、包含 `quietStartup`），仍为只读；README 与中英文 CLI 文档同步改为 "the Pi files it would write"。
- 验证：`test/harness-rsi-genome.test.ts` 的 `genome show prints the files the run would write, without writing`（合并内容含 `$rsih`，文件字节不变）；实测输出含 `"$rsih"` 与 `quietStartup`。

##### E13. MCP 握手无超时控制且失败客户端未清理

- 现象一：服务器连上后不回应时，启动会被 SDK 默认的 60 秒握手超时拖住，无法缩短。
- 现象二：握手阶段失败的客户端不会被关闭（`clients.push` 发生在连接成功之后），挂起的服务器子进程会残留。
- 解决：`src/harness/mcp.ts` 增加服务器级可选字段 `startup_timeout_ms`（正整数），传给 `client.connect(transport, { timeout })`；默认值显式声明为 `DEFAULT_STARTUP_TIMEOUT_MS = 60_000`（与 SDK 默认相同，但不随依赖升级漂移）；catch 分支改为只要创建过客户端就关闭它并从列表移除；`src/harness/genome.ts` 校验该字段；`docs/genome/components/integrations.dev.md` 补充说明并同步到随包契约副本。
- 验证：`test/core-harness.test.ts` 的 `a server that never answers is bounded by startup_timeout_ms`（1 秒超时可配置、正常服务器不受影响、测试进程能自行退出说明无泄漏）与 `startup_timeout_ms must be a positive integer`；不配置超时时挂起服务器约 60.6 秒后隔离（探针实测）。

#### 组 F：可选改进（未提交，4 项）

##### F1. 版本常量独立成模块

- 现象：`RSIH_VERSION` 定义在 CLI 运行时模块 `src/pi-cli-runtime.ts` 里，而 `src/harness/mcp.ts` 另外硬编码了一份 `"0.1.0"`（MCP 客户端信息）；升级版本号时两处可能漏改。
- 原因：常量没有独立的家，消费者只能从 CLI 模块导入或自行复制。
- 解决：新增叶子模块 `src/core/version.ts` 导出 `RSIH_VERSION`；`src/pi-cli-runtime.ts`、`src/harness/mcp.ts`、`src/cli/genome-command.ts` 统一从这里导入，删除硬编码副本。
- 验证：新增测试 `RSIH_VERSION stays in sync with package.json`（`test/cli.test.ts`）；全套测试 216 通过。

##### F2. 消除 `genome-command` 对 `pi-cli-runtime` 的循环导入

- 现象：`src/cli/genome-command.ts` 为取 `RSIH_VERSION`/`RSIH_BASE_SETTINGS` 反向导入 `src/pi-cli-runtime.ts`，而后者又导入前者，形成模块环（运行时可用，但结构脆弱）。
- 解决：`RSIH_BASE_SETTINGS` 移到 `src/harness/settings-layer.ts`（与 `RSIH_MANAGED_MARKER` 同属设置层常量），`RSIH_VERSION` 移到 F1 的 `src/core/version.ts`；`src/cli/genome-command.ts` 不再导入 `src/pi-cli-runtime.ts`，模块环消除。
- 验证：`npm run typecheck` 与全套测试通过；确认 `src/cli/genome-command.ts` 已无 `pi-cli-runtime` 引用。

##### F3. 测试脚本改为通配符

- 现象：`package.json` 的 `test` 脚本是显式文件清单，新增测试文件必须手动加入；组 E 的 `test/session-lookup.test.ts` 就漏过一次（预期 213 条只跑 211 条，靠核对数量才发现）。
- 解决：改为 `node --experimental-strip-types --test "test/*.test.ts"`，由 Node 测试运行器展开通配符；新增文件自动包含。
- 验证：`npm test` 216 个用例全部通过（清单 10 个文件全部命中）。

##### F4. `sync:contracts` 覆盖 examples 副本

- 现象：脚本只同步 `config/genomes/*` 的契约副本；`examples/genomes/*` 的两份要手工复制，组 E 改 `integrations.dev.md` 时就漏过一次（靠测试发现）。
- 解决：`scripts/sync-contracts.ts` 列出四类目标——`config/genomes/paperlab`、`config/genomes/harness-rsi`、`examples/genomes/paperlab`（完整 12 份）与 `examples/genomes/parallel-search`（只更新其 manifest 引用的 1 份，不新增未引用的契约）。
- 验证：`npm run sync:contracts` 输出四个目标；`test/harness-rsi-genome.test.ts` 的字节一致用例通过。

### 验证汇总

- 单元与端到端测试：`npm test` 共 216 个用例全部通过（组 B 结束时 186 个；组 C 195 个；组 D 200 个；组 E + F 216 个）。测试文件由 `test/*.test.ts` 自动收集。
- 类型检查：`tsc --noEmit` 无错误；`npm run build`（tsc + 资源复制）成功；`npm run check` 一条命令跑完全部三项。
- 组 B 的 36 项核查脚本（覆盖路径穿越、规范化、原子写、容器校验、资源名、单文件 null、schema 关键字、strict）：重跑全部通过。
- 现场实测（使用 `dist/` 构建产物）：
  - print 模式对话、`--version`、`genome list/validate/show`、交互式 TUI 启动；
  - MCP：混合服务器（1 正常 + 2 种坏法）时正常工具可调用、坏服务器仅出现在警告中；全部坏掉时不抛错；挂起服务器按配置的超时隔离；
  - `--new --run-id` 报错且不写入旧会话；`--name -v` 不再当作版本请求；
  - `--resume` 选择器：提示出现，会话的 Genome 记录更新为 `default`；
  - `gee` 交互式运行：进程树中 supervisor + 子进程齐全，TUI 与通知条正常。

### 设计决定与验证状态

1. **MCP 服务器握手超时**：默认 60 秒，在 `src/harness/mcp.ts` 中显式声明为 `DEFAULT_STARTUP_TIMEOUT_MS`，不随依赖升级漂移。每个服务器可用 `startup_timeout_ms` 覆盖。默认保持 60 秒是刻意决定：`npx` 首次下载安装的服务器可能需要几十秒，缩短默认值会让这类合法情形失败。已实测：不配置超时时，挂起的服务器约 60.6 秒后超时并隔离（`errors` 记入 `hung: MCP error -32001: Request timed out`），同一 Genome 中其余服务器不受影响。
2. **`--resume` 无法在启动前读取选择结果**：属于 Pi 的选择器机制，RSIH 不能修改；已加提示（见 E2）并用测试固定行为。要彻底消除，需要 Pi 在启动前暴露选择结果（上游 API）。
3. **通知与 `gee` 的验证方式**：MCP 未启动、设置写失败、`--resume` 提示三个通知分支都经过 `reportSessionWarning(ctx, message)`（TUI 走通知条、print/RPC 走 stderr `rsih:` 前缀），并有单元测试 `session warnings reach the TUI notification or stderr`；TUI 实际渲染与 `gee` 进程树为终端捕获实测，无自动化用例（需要真实终端，Node 无内置 pty）。

---

## 附录：Pi 升级检查清单

升级 `@earendil-works/pi-coding-agent`（或 `pi-ai` / `pi-tui` / `@modelcontextprotocol/sdk`）后，以下位置是"对齐上游实现"的镜像代码，需逐项复核。跑 `npm run check` 作为第一道筛子。

1. **会话目录与查找**：`piSessionDirectory()`、`findSessionFile()`、`sessionBelongsTo()` 镜像 Pi 的 `getDefaultSessionDirPath` / `SessionManager.list` / `resolveSessionPath`。对照 `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js` 与 `dist/main.js`，并跑 `test/session-lookup.test.ts`。
2. **会话头字段**：`sessionHeader()` 依赖会话 JSONL 中 `type: "session"` 条目上的 `id` 与 `cwd`。对照 `listSessionsFromDir` 的解析方式，并用一个真实会话文件验证。
3. **主题键**：`src/modes/interactive/theme/dark.json`、`light.json` 必须覆盖 Pi 内置主题的全部颜色键。`test/cli.test.ts` 的 `the shipped themes carry every color Pi's own themes define` 会在升级后失败并列出缺失键，按 Pi 的取值补齐。
4. **设置表面**：`src/harness/pi-surface.ts` 的 `PI_SETTINGS_OBJECT_KEYS` 与已知设置键/键位来自 Pi 的设置接口。对照 `dist/core/settings-manager.d.ts` 等类型定义同步新增或改名的键，并跑 `test/settings-layer.test.ts`、`test/pi-surface.test.ts`。
5. **工具与严格模式**：RSIH 的请求不再携带 `strict`，由 pi-ai 转换。升级 `pi-ai` 后确认 `getJsonSchemaToolParameters` / `makeStrictJsonSchema`（`dist/api/constrained-sampling.js`）仍存在且行为一致，跑 `test/model-runtime.test.ts`。
6. **MCP SDK**：`DEFAULT_STARTUP_TIMEOUT_MS` 对齐 SDK 默认（60 秒），`client.connect(transport, { timeout })` 与 `DEFAULT_REQUEST_TIMEOUT_MSEC` 是依赖的行为。升级后确认两者仍在（`dist/shared/protocol.js`），跑 `test/core-harness.test.ts` 的 MCP 用例。
7. **Pi 子命令列表**：`PI_SUBCOMMANDS`（`src/pi-cli-runtime.ts`）需与 Pi 的 CLI 子命令集合一致，对照 `pi --help` 或 `dist/cli/args.js`，跑 `test/cli.test.ts` 的子命令用例。
8. **取值选项列表**：`VALUE_TAKING_OPTIONS`（`versionRequested` 用）需与 Pi 的取值选项一致，对照 `dist/cli/args.js`，跑 `a version request is a flag, never an option's value`。
9. **导出模板路径**：`scripts/copy-build-assets.ts` 复制 Pi 的 `dist/core/export-html`。升级后确认路径未变，并用 `rsih --export` 实测一次。
10. **冒烟**：`npm run build` 后做一次真实运行——print 模式对话、`genome show`、TUI 启动各一次。
