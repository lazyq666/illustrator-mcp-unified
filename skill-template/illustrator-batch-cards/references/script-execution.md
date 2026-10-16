# 统一 MCP 与后台执行

本技能的所有 Illustrator 操作仅使用统一 `illustrator-mcp-server`，完整工具前缀为 `mcp__illustrator_mcp_server__`。后台执行禁止激活 Illustrator 到前台、模拟鼠标键盘或使用系统剪贴板。Illustrator 必须已经运行且保持登录；锁屏与休眠不同，系统进入休眠后不能继续执行。

## 版本和后台状态核验（强制）

每次调用会读取或改变 Illustrator 文档、保存或导出的工具前，先调用 `mcp__illustrator_mcp_server__get_runtime_status`，检查这一次返回的实际值，全部满足才可继续：

| 字段 | 必须满足 |
| --- | --- |
| `version` | 精确等于 `1.8.0-local.1` |
| `background` | 布尔值 `true` |
| `computer_use_fallback` | 布尔值 `false` |
| `state_directory` | 精确等于 `@@MCP_STATE_DIRECTORY@@` |
| `execution` | `null`，不存在运行中或结果未确认的执行 |
| `batch` | `null`，不存在正在占用文档的批量任务 |

版本号指统一 MCP 的版本，不是 Illustrator 应用版本。即使返回看似更新的版本，也不能自动接受或修改本表来让检查通过；须先提示用户，再按用户明确的升级要求重新验证并更新规则。布尔值的字符串形式、缺失字段、解析失败、工具调用错误均视为未通过，不能根据本地配置文件或上次成功结果推定通过。

核验失败时，停止所有新的 Illustrator 操作，提示用户具体不符字段、期望值和实际值；无法连接则说明需要恢复或重新连接统一版 MCP。保留已有任务编号、最近保存路径和日志，不另行发出保存、关闭、重试或取消操作。“停止”不代表已经中止 Illustrator 内仍在运行的任务。

`get_runtime_status` 本身和 `get_batch_status` 仅查看执行器状态，不操作 Illustrator，无需递归执行前置核验。已有批量任务占用文档时，只能用统一服务查询它的状态、读取本地日志；不能启动第二个文档操作。一次 `batch_cards` 提交前完成核验后，由统一服务执行内部逐卡步骤；随后每次独立文档操作仍需重新核验。

任何不符合条件的情况，都不能自动切换其他 MCP、旧 bridge、Computer Use、菜单脚本、AppleScript 或直接运行本地执行器，也不能通过关闭后台模式或改写版本条件来继续。只恢复并重新核验统一入口。

## 选择工具

以下短工具名均指 `mcp__illustrator_mcp_server__` 下的工具，不能根据短名称选择其他服务中的同名工具。

1. 模板检查、正文修改、链接检查和导出继续使用已有专用工具。批量生成使用 `batch_cards`；完整图层复制用 `duplicate_layer_tree`；PDF 字稿用 `import_pdf_as_paths`；蒙版内换图用 `replace_masked_image`；名称渐变衬边用 `build_name_backing`。
2. 专用工具无法表达的模板操作，通过 `run_script` 运行 ExtendScript（Illustrator 使用的脚本语言）。该工具共享后台策略、跨进程独占执行与结果记录，不需要第二套 MCP。
3. `BACKGROUND_UNSUPPORTED` 表示该步骤有界面或剪贴板依赖。报告具体缺口并保留成果，不自动切换到「电脑」、旧 bridge 或菜单脚本加载。

已有 67 个工具保留在统一服务中。后台模式会拦截部分仍依赖菜单的操作；这不意味着所有原工具都已经通过后台验证。始终以当前工具定义和本次结果为准。

## 模板和计划

读取[批量工具参数](batch-tools.md)后，根据实际模板建立计划。`batch_cards` 面向一个卡牌模板文档：它复制全部顶层图层到每张卡的父图层，建立独立画板。模板含额外字库、说明画板或参考素材时，先在工作副本中整理出明确的卡牌模板；不要把无关图层一并复制。

第一层图层命名、角色内容确认与图片优化授权仍按主技能执行。工具不会替用户选择素材，也不会自动缩小图片。模板中每个外部链接的图片，都应明确包含在各卡的图片计划中；沿用的图片也要明确其来源和链接／嵌入方式。

## 通用脚本

`run_script` 接受 `script` 或 UTF-8 `script_path`，二者择一；可通过 `params` 传入 JSON 数据。脚本在函数体内执行，用 `return` 返回普通数据。提供 JSON 兼容处理；不要返回 Illustrator 原生对象引用。

```javascript
return { version: app.version, documents: app.documents.length };
```

已保存目标文档应传 `document_path`，避免依赖用户当前文档。脚本使用 ExtendScript 兼容语法。后台脚本直接操作文档对象，不使用菜单、弹窗、系统剪贴板或动态脚本加载；源码检查是可信脚本的操作约束，并不是安全沙箱。

本地只准备脚本文件，不在终端直接执行 Illustrator 脚本。提交时使用统一 MCP 的 `run_script`／`script_path`，并先完成本节规定的状态核验。MCP 连接不可用时停止并提示用户；`scripts/run_jsx.py` 已停用，旧命令会直接返回错误，不连接 Illustrator。

## 批量任务状态

- `queued`、`preparing`、`running`：尚未完成，读取 `get_batch_status`。
- `ready_for_visual_review`：已保存、重开结构检查通过，并导出预览；逐张查看预览之后才能声明视觉验收。
- `validation_failed`：已生成但验收未通过，按 `validation.errors` 定位。
- `failed`：查看阶段、受影响角色、最后完成编号和日志。中断文档可能仍打开，先核查成果。
- `execution_unconfirmed`：超时或调用进程退出不能证明 Illustrator 内部脚本已停止。读取运行状态和原任务日志，先确认完成或停止，再决定恢复；不自动重跑。

任务的 `prepared_plan_path` 记录实际交付链接路径；后续独立验收以此为准。重试使用新输出路径，保留前次成果与日志，不覆盖未确认的文件。

后台模式不会调用「电脑」来关闭意外弹窗。独立任务会临时阻止系统因空闲自动休眠，同时允许屏幕关闭和锁屏；合盖、手动休眠、退出登录、关机或强制退出 Illustrator 仍会影响任务。每次长任务前先确保素材和必要授权齐全。

## 验收方式

用新的调用重新打开文件，获取对象和路径。预览通过导出画板图像并读取本地图片完成，不需要截取应用窗口。结构检查不能替代镂空、衬边、裁切和文字可读性的视觉检查。

本地验证范围及未验证项以项目 README 为准。另一个模板、效果或 Illustrator 版本不能自动继承成功结论。
