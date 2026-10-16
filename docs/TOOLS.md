# 工具清单

当前 MCP 实际注册 **77** 个工具：67 个原有工具，加上 10 个统一执行与制卡工具。以下说明来自工具本身，参数以客户端读取的 MCP 定义为准。

后台策略可能拒绝依赖界面或剪贴板的操作；工具已注册不等于每项操作都通过后台验证。

## 统一执行与批量制卡

### `get_runtime_status`

Read background policy and cross-process execution ownership without sending a script to Illustrator. An uncertain execution must not be replayed. No Computer Use.

### `recover_execution`

Recover an uncertain execution only after a valid native completion receipt or a recognized legacy native compile failure. Requires the exact execution_id from get_runtime_status. Archives the evidence, releases only that lock, and never sends a script, cancels, or retries Illustrator work. Refuses running or unproven timeout states.

### `run_script`

Run trusted ExtendScript directly in the shared background executor. Supply script or an existing UTF-8 .jsx script_path, not both. Use ES3-compatible syntax (no E4X or preprocessor directives); quote reserved property names. Syntax is checked before native execution. Return plain data with return; params contains JSON input. JSON compatibility is provided. UI, clipboard and dynamic script requests are rejected in background mode. This is not a security sandbox. Use batch_cards for long jobs; never replay an unconfirmed timeout.

### `duplicate_layer_tree`

Copy a complete layer hierarchy into a new parent layer in the specified open document, preserving item order, clipping groups and child layer state. Native document coordinates in points. Refuses a duplicate target parent.

### `import_pdf_as_paths`

Open a prepared outlined vector PDF and copy actual paths into an open target document, retaining compound paths and holes. No clipboard, linked PDF or raster substitute. Rejects source PDFs already open by the user. Bounds use native document points.

### `replace_masked_image`

Replace a named raster inside its existing clipping group while preserving the image rectangle and stacking. Explicitly choose linked or embedded. Rejects rotated/sheared/mirrored images and aspect mismatches before replacement; use a template-specific script for them.

### `build_name_backing`

Duplicate an editable name face behind itself, apply a template gradient or explicit RGB stops, and attach a live Offset Path effect. Preserves face holes and separate face/backing objects. Bounds and thickness are native document points; visual review is still required.

### `batch_cards`

Start a detached background card job from a saved normalized AI template and confirmed content. Creates a new output, copies linked images into Links, clones complete layers, replaces named text/images, imports optional PDF name paths and builds backing. Saves each card, removes template copies, reopens for structural checks and exports previews. No image downscaling or UI fallback. Return is job acceptance, not completion; poll get_batch_status and visually inspect previews. One simple card template per source document; verify the template first.

### `get_batch_status`

Read a background card job and its per-card progress, prepared plan, log and preview paths. ready_for_visual_review means structural checks passed, not visual approval. Never automatically restart failed or unconfirmed jobs.

### `validate_cards`

Independently reopen a saved, closed AI output, check card/layer/text/image/path correspondence, and optionally export artboard previews without the clipboard. This tool does not perform visual judgment. Use the prepared plan from get_batch_status so packaged link paths match.

## 原有工具

| 工具 | 说明 |
| --- | --- |
| `get_document_info` | Get document metadata |
| `get_artboards` | Get all artboard information |
| `get_layers` | Get layer structure as a tree |
| `get_selection` | Get detailed information about the currently selected objects |
| `list_text_frames` | List text frames with summary-level information. Supports reading-order sort, pagination, and a lightweight contents-only mode. |
| `get_text_frame_detail` | Get detailed text frame attributes including per-character runs (font, tracking, akiLeft/akiRight, tsume, proportionalMetrics), kerning pairs with manual kerning values (1/1000 em), and paragraph attributes. Returns cssHints for web/CSS reproduction. Note: paragraph leading/autoLeading may return 0 in some ExtendScript versions due to missing API support. |
| `get_colors` | Get all color information used in the document |
| `get_path_items` | Get path and shape data. Note: fill/stroke do not include per-attribute opacity; use the item-level opacity field for transparency. |
| `get_guidelines` | Get guide information |
| `get_groups` | Get structure of groups, clipping masks, and compound paths |
| `get_effects` | Get effect and appearance information |
| `get_images` | Get embedded and linked image information |
| `get_symbols` | Get symbol definitions and instances |
| `get_document_structure` | Get tree structure of layers, groups, and objects |
| `find_objects` | Search for objects by specified criteria |
| `check_contrast` | Check WCAG color contrast ratios. Manual mode: provide two colors. Auto mode: detect overlapping foreground/background pairs in the document. Note: GrayColor uses ink-quantity interpretation (0=white, 100=black), which differs from the API reference. |
| `extract_design_tokens` | Extract colors, typography, and spacing from the document as design tokens in CSS custom properties, JSON, or Tailwind format |
| `export` | Export objects, groups, artboards, or selection. Use target "artboard:all" to batch-export every artboard in one call. For single PNG/JPG exports, the exported image is returned as base64 in the response — you can view it directly without reading the file from disk ("artboard:all" returns file paths only). Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `export_pdf` | Export print-ready PDF. Runs without activating Illustrator in default background mode; never invokes Computer Use. The exported PDF should be verified by a human before final submission. |
| `get_overprint_info` | Get overprint settings with K100/rich black detection and intent classification |
| `get_separation_info` | Get color separation information: CMYK process plates and spot color plates with usage counts |
| `preflight_check` | Run pre-press quality checks. Note: This check is not exhaustive — it does not replace a human final review. GrayColor uses ink-quantity interpretation (0=white/no ink, 100=black/full ink), which differs from the API reference. |
| `check_text_consistency` | Analyze text frames for dummy/placeholder text and known notation variation patterns (katakana long vowel, fullwidth/halfwidth, wave dash/tilde). Returns all text contents for LLM-driven deeper analysis of inconsistencies, typos, and version mismatches. Note: AI analysis may miss errors and does not replace a human text review. |
| `set_workflow` | Set the session-level workflow and default coordinate system. Call this after confirming the user's intent (web, print, or video). Once set, all tools that omit coordinate_system will use the session default. Use clear: true to reset to auto-detection from document (CMYK/print → document coords, RGB/web → artboard-web). |
| `set_illustrator_version` | Set which Illustrator version to target when multiple versions are installed. Specify a version year (e.g. "2024", "2025"). If Illustrator is already running, connects to the running instance regardless of version. If not running, launches the specified version. Use clear: true to reset to default behavior (connect to any running Illustrator). |
| `create_rectangle` | Create a rectangle. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `create_ellipse` | Create an ellipse. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `create_line` | Create a line. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `create_text_frame` | Create a text frame. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `create_path` | Create a custom path. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `modify_object` | Modify properties of an existing object. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `convert_to_outlines` | Convert text to outlines. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `assign_color_profile` | Assign (tag) a color profile to the document. WARNING: This only changes the profile tag — it does NOT convert color values (ICC conversion). For full conversion, use Edit > Convert to Profile in Illustrator. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `place_image` | Place a raster or PDF image file (PNG, JPG, TIFF, PSD, PDF, etc.) into the document as a linked or embedded image. SVG is NOT supported here because PlacedItems produces a non-editable linked artwork — use import_svg_as_editable instead to bring SVG content in as editable paths/text. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `import_svg_as_editable` | Import an SVG file into the active document as editable Illustrator paths/text/groups (NOT as a linked image). Internally opens the SVG as a temporary document, duplicates its contents into the target document, then closes the source. Use this instead of place_image for SVG. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `resize_for_variation` | Create size variations from a source artboard. Duplicates all objects and scales/repositions them proportionally to fit target sizes. Limitations: no text reflow, effects/strokes scale with objects but may need manual adjustment, proportional placement only (not smart layout). |
| `align_objects` | Align and/or distribute multiple objects by their UUIDs |
| `replace_color` | Find and replace colors across the document or within a specific layer. Limitations: SpotColor and GrayColor matching not supported. Cross-colorspace matching (e.g. RGB→CMYK) not possible — from_color and to_color must use the same color type as the target objects. |
| `manage_layers` | Add, rename, show/hide, lock/unlock, reorder, or delete layers |
| `place_color_chips` | Extract all unique colors from the document and place color chip swatches with labels outside the artboard |
| `place_style_guide` | Place a visual style guide (color chips, font samples, spacing indicators) outside the artboard |
| `create_crop_marks` | Create crop marks (トンボ / trim marks) on the active artboard or selected objects. By default, creates marks for the artboard and expands the artboard to include all marks. With use_selection=true, creates marks for the currently selected object(s) without modifying the artboard. Automatically selects Japanese-style (日本式) or Western-style crop marks based on locale. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `create_document` | Create a new Illustrator document. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `close_document` | Close the active Illustrator document. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `save_document` | Save the active Illustrator document. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `open_document` | Open an Illustrator document from a file path. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `group_objects` | Group multiple objects into a single group. The first UUID in the array becomes the bottommost item, the last becomes the topmost. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `ungroup_objects` | Ungroup a group, releasing its children to the parent layer. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `duplicate_objects` | Duplicate one or more objects, optionally offsetting the copies. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `list_fonts` | List fonts available in Illustrator. Does not require an open document. |
| `manage_artboards` | Add, remove, resize, rename, fit, or rearrange artboards. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `set_z_order` | Change the stacking order of an object. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `move_to_layer` | Move one or more objects to a different layer. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `delete_objects` | Delete one or more objects by UUID (get UUIDs from find_objects / get_layers / get_selection). Locked objects are skipped unless force_unlock is true. Reversible with the undo tool. To delete a whole layer use manage_layers instead. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `apply_graphic_style` | Apply a graphic style to objects. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `list_graphic_styles` | List all graphic styles in the active document. |
| `manage_swatches` | Add, update, or delete swatches in the active document. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `apply_text_style` | Apply a character or paragraph style to a text frame. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `list_text_styles` | List all character and paragraph styles in the active document. |
| `create_gradient` | Create a gradient in the document and optionally apply it to objects. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `manage_linked_images` | Relink or embed a placed (linked) image. embed converts PlacedItem to RasterItem — the original UUID becomes invalid and a new UUID for the RasterItem is returned. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `undo` | Undo or redo actions in Illustrator. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `manage_datasets` | List variables/datasets, apply or create datasets, bind variables to objects, import CSV/XML. CSV headers are auto-bound to objects with matching names. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `place_symbol` | Place a new symbol instance or replace the symbol definition of an existing instance. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `create_path_text` | Create a text frame that flows along a path. Runs without activating Illustrator in default background mode; never invokes Computer Use. |
| `select_objects` | Select objects by UUID. Pass an empty array to deselect all. Selected objects can then be manipulated interactively in Illustrator. |
| `convert_coordinate` | Convert a point between artboard and document coordinate systems in the active document. |
