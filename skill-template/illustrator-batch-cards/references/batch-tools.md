# 批量制卡工具参数

调用时以 MCP 实际返回的工具定义为准。本参考说明模板对应关系与流程约束。

## batch_cards

必要输入为 `template_path`、新的 `output_path` 和 `cards`。模板必须是已保存的 AI 副本；输出已存在时拒绝覆盖。工具复制全部模板顶层图层，并在完成时移除原模板图层和画板，留下各角色的独立父图层与画板。`template_artboard` 为零起始索引，默认 0；`columns` 与 `gap_pt` 控制画板排列。

每个卡牌条目：

- `id`、`name`：父图层和画板命名为「id name」。`id` 仅使用字母、数字、下划线和连字符，可用作预览文件名。
- `texts`：每项含唯一的 `item_name` 与准确的 `contents`；可选 `font_size`。沿用模板文字对象，复杂混合样式需先做小样核验。
- `images`：每项含唯一的 `item_name`、`file_path` 和明确的 `embed`。默认要求目标位于裁切蒙版内；仅对确实无需蒙版的图标设 `require_clipping: false`。链接图片将复制到输出旁的 `Links/`；嵌入图不作为外部依赖交付。
- `aligned_image_pairs`：主图与破框图的对象名配对，如 `[["主图", "破框图"]]`，供重开后核对几何边界。
- `name_art`：可选。包含 `pdf_path`、`page`、目标 `layer_path`（从该角色父图层向下的层名数组）、新字面组的 `group_name` 和 `fit_bounds`；旧字稿需替换时用 `replace_item_name` 明确对象。
- `name_art.backing`：可选。含 `backing_name`、`offset_pt`，以及模板的 `gradient_name` 或明确的 `stops`。自定义色标采用 `position` 0–100 和 `rgb: [r,g,b]`；`angle` 为角度。印刷模板优先复用已有的 CMYK／专色渐变。

`fit_bounds` 使用 Illustrator 原生文档坐标与点：`[左, 上, 右, 下]`，Y 向上。这些参数根据模板实际位置读取，不能直接填像素或毫米。名称按等比例缩放并居中放入区域。

`expected_sublayers` 可传规范化模板的顶层图层名称数组，供检查每张卡的子图层名称和顺序。

## 专用工具的范围

- `duplicate_layer_tree`：指定文档路径、源图层路径数组、新父图层名和位移；跨卡复制保留层级、对象顺序、蒙版与锁定／可见状态。
- `import_pdf_as_paths`：只接受准备好的轮廓矢量 PDF；含文字对象、位图或链接替代物时拒绝。PDF 仍为活字时先检查字体并通过单独脚本转为轮廓、验收后再导入。已有 AI 字库用 `run_script` 复制已验收字形。
- `replace_masked_image`：保留原图的版面矩形，要求素材比例相符；旋转、倾斜、镜像或需重新构图的模板先使用经过验证的专用脚本。不能把图片拉伸成符合矩形就算成功。
- `build_name_backing`：生成独立的背后副本、渐变与可调整的偏移路径效果；工具返回不代表视觉效果已经验收。
- `validate_cards`：最终文件应已保存并关闭；独立重开后检查。传任务的准备后计划，以使用实际 Links 路径。可用 `preview_directory` 导出预览，目录应预先创建。

不要为迎合某个工具的参数而改变用户已确认的素材、排版或效果；超出工具范围时使用统一脚本入口，或明确报告限制。
