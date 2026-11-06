# Illustrator MCP Unified

这是一个根据 [ie3jp/illustrator-mcp-server](https://github.com/ie3jp/illustrator-mcp-server) 和 [ajfonthemove/illustrator-mcp](https://github.com/ajfonthemove/illustrator-mcp) 制作的 MCP，当前工具数量 **81**。

经过我自己的测试，在本机 **macOS（Apple Silicon）+ Adobe Illustrator 2026（30.2.1）** 上运行良好，可以在后台静默完成任务，不需要保持 Illustrator 在前台。

**PS：如果你无法使用，可以自己用你的 AI 修复看看。**

本项目以 `ie3jp/illustrator-mcp-server` 的 67 个工具为基础，参考 `ajfonthemove/illustrator-mcp` 的通用脚本入口思路，增加后台执行、任务恢复和批量制卡能力。通用脚本入口重新实现，并统一到同一个执行器中。

## 可以做什么

- 读取和编辑 Illustrator 文档、图层、路径、文字、图片，保存和导出作品。
- 默认后台执行，不主动把 Illustrator 切到前台，不通过模拟鼠标键盘完成任务。
- 通过 `run_script` 运行可信的 ExtendScript，补充专用工具没有覆盖的操作。
- 按模板批量制卡：复制完整图层、替换蒙版内图片、导入可编辑 PDF 字稿、生成名称渐变衬边。
- 保存后重新打开文件检查结构，导出预览供 AI 和用户检查。
- 多个调用共用任务占用记录，避免同时修改文档；超时后保留记录，不盲目重跑。
- 预检、批量组装 SVG 为可编辑路径，并在运行状态中查看占用与恢复信息。

工具清单见 [docs/TOOLS.md](docs/TOOLS.md)。

## 安装

需要 **Node.js 22.12 或更高版本**、macOS，以及已经安装的 Adobe Illustrator。当前公开版本以 macOS 为验证范围；没有验证 Windows 的后台行为。

在终端执行：

```bash
git clone https://github.com/lazyq666/illustrator-mcp-unified.git
cd illustrator-mcp-unified
npm ci
npm run build
npm run verify
npm run configure
```

`build` 把源码生成可运行程序；`verify` 检查 MCP 连接、81 个工具和后台配置，不修改 Illustrator 文档。`configure` 根据这台电脑的实际路径生成连接配置，也不会修改你的个人设置。

如果安装了多个 Illustrator 版本，可明确选择：

```bash
npm run configure -- --app "/Applications/Adobe Illustrator 2026/Adobe Illustrator.app"
```

### 连接 Codex

生成的 `generated/codex-config.toml` 是需要合并到 Codex 配置中的 MCP 条目。保留其他设置；已有同名条目时先备份再替换，避免重复添加。

也可以把 `generated/安装到Codex的提示词.txt` 发给 Codex，让它按实际路径完成配置和配套 skill 安装。

配置后重新连接 MCP。开始操作前，先手动打开 Illustrator；首次连接时，macOS 可能要求允许客户端自动化控制 Illustrator。

### 连接其他 MCP 客户端

使用生成的 `generated/mcp-config.json`，将其中的 `mcpServers` 条目合并到支持本地 stdio MCP 的客户端配置中。stdio 是由客户端直接启动本机程序的连接方式，不需要部署服务器或填写 API Key。

配置结构如下，实际使用时优先复制生成的文件：

```json
{
  "mcpServers": {
    "illustrator-mcp-server": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/illustrator-mcp-unified/dist/index.js"],
      "env": {
        "ILLUSTRATOR_MCP_BACKGROUND": "1",
        "ILLUSTRATOR_MCP_STATE_DIR": "/absolute/path/to/illustrator-mcp-unified/var",
        "ILLUSTRATOR_MCP_APP_PATH": "/Applications/Adobe Illustrator 2026/Adobe Illustrator.app",
        "ILLUSTRATOR_MCP_KEEP_AWAKE": "1"
      }
    }
  }
}
```

为兼容配套 skill，连接条目保留 `illustrator-mcp-server` 这个名称。原来的同名 MCP 和 `illustrator-bridge` 应停用，避免 AI 混用多个 Illustrator 入口。

移动项目文件夹后，重新运行 `npm run configure` 并更新客户端配置。该版本通过 GitHub 源码分发，尚未发布到 npm。

## 使用与配套 skill

连接后可以这样告诉 AI：

> 先检查统一 Illustrator MCP 的运行状态，确认后台模式正常，再读取当前文档的图层结构。不要切换 Illustrator 到前台。

`get_runtime_status` 的预期值：

| 字段 | 预期 |
| --- | --- |
| `version` | `1.8.0-local.2` |
| `revision` | `20261105.1` |
| `background` | `true` |
| `computer_use_fallback` | `false` |
| `state_directory` | 配置中指定的 `var` 目录 |
| `execution`、`batch` | 空闲时均为 `null` |

可选制卡 skill 位于 `skill-template/illustrator-batch-cards`。请安装 `configure` 生成的 `generated/illustrator-batch-cards`，它已填入本机状态目录，原始模板中的占位符不能直接使用。

该 skill 要求每次文档操作前检查版本和后台状态。检查不符就停止并提示，不自动切换其他 MCP、Computer Use 或终端脚本。批量任务返回 `ready_for_visual_review` 只表示结构检查通过，仍需查看导出的预览。

## 后台运行的范围

- Illustrator 必须已经打开，macOS 用户会话保持登录。屏幕可以锁定，但电脑不能进入系统休眠。
- 执行时默认临时阻止空闲休眠，允许熄屏和锁屏；合盖、手动休眠、退出登录和退出 Illustrator 会影响任务。
- 依赖弹窗、菜单或剪贴板的操作可能被后台策略拒绝，不会自动转为电脑操作。
- `run_script` 面向可信脚本，包含后台策略和语法检查，但不是隔离恶意代码的安全沙箱。
- 批量制卡需要先检查并整理实际模板。字体、链接素材、特殊效果和不同 Illustrator 版本都可能影响结果。
- 任务超时不等于 Illustrator 已经停止。先读状态和日志；`recover_execution` 仅在有完成证据时释放占用记录，不会取消或重跑任务。

## 测试与开发

```bash
npm run check
```

当前源码包含自动测试，另有 MCP 连接和工具数量检查。开发过程中在上述本机环境验证过后台保存、重开、导出、两张卡的批量生成，以及锁屏期间继续执行。这些测试不代表 81 个工具、所有模板和所有 Illustrator 版本均已完整验证。

2026-10-30 更新：批量制卡默认每 4 张保存、关闭并重开同一输出文件，最终保存默认保留 PDF 兼容性；长任务的 AppleScript 等待时间随执行超时延长。新增分组流程已覆盖自动测试，尚未在真实 Illustrator 中验证。

请勿提交 `generated/`、`var/`、个人客户端配置或作品素材；这些本机文件已经加入 `.gitignore`。

## 来源与许可

- [ie3jp/illustrator-mcp-server](https://github.com/ie3jp/illustrator-mcp-server)：主要代码基础，保留其 MIT 版权声明。
- [ajfonthemove/illustrator-mcp](https://github.com/ajfonthemove/illustrator-mcp)：通用脚本桥接思路参考；未打包该项目的源码或素材。

本仓库使用 [MIT License](LICENSE)。更多版本来源见 [NOTICE.md](NOTICE.md)。这是个人使用与分享的社区项目，与 Adobe 没有官方隶属关系。
