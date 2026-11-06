/**
 * Shared ExtendScript for copying SVG content into an open document as native, editable art.
 *
 * Rules learned from production failures (see MCP复盘, 2026-11-03):
 *  - Document.pageItems contains nested items too. Copy only items whose parent is a Layer,
 *    otherwise every nested path/group is duplicated again beside its parent.
 *  - Never duplicate into a GroupItem of another document: on Illustrator 30.2.1 that fails with
 *    error MRAP whichever document is active. Duplicate into a Layer, then group inside the target.
 *    The target is still made active first so later calls operate on it.
 *  - Document.pathItems.length is not refreshed right after a cross-document duplicate within the
 *    same script (it read +0 for 33 copied paths). Count by walking the copied items instead.
 *  - Glow and other overflow make geometric bounds a poor anchor. With anchor "source_artboard",
 *    an invisible rectangle matching the SVG artboard is copied along and measured *after* the
 *    copy, so the result lands exactly on the target artboard regardless of document origins.
 *
 * Functions (ES3):
 *   mcpSvgImport(targetDoc, targetLayer, svgPath, opts) -> { copies, frameCopy, source, pathsAdded }
 *     source.paths counts the opened SVG document; source.topLevelPaths and pathsAdded walk the
 *     top-level items before and after copying, so they compare like for like.
 *     opts: { anchor: "geometric_bounds" | "source_artboard", requirePureVector: boolean }
 *   mcpSvgPlace(imported, targetLayer, opts) -> placement summary
 *     opts: { group, clip, name, targetRect, fit, padding, point: [x, y] | null }
 */
export const SVG_IMPORT_JSX = `
function mcpSvgCountPaths(item) {
  if (item.typename === "PathItem") return 1;
  if (item.typename === "CompoundPathItem") return item.pathItems.length;
  if (item.typename !== "GroupItem") return 0;
  var n = 0;
  for (var i = 0; i < item.pageItems.length; i++) n += mcpSvgCountPaths(item.pageItems[i]);
  return n;
}

function mcpSvgImport(targetDoc, targetLayer, svgPath, opts) {
  var svgFile = new File(svgPath);
  if (!svgFile.exists) throw new Error("SVG file not found: " + svgPath);
  var src = app.open(svgFile);
  var result = null;
  try {
    var source = {
      pageItems: src.pageItems.length, paths: src.pathItems.length, compoundPaths: src.compoundPathItems.length,
      groups: src.groupItems.length, textFrames: src.textFrames.length,
      rasterItems: src.rasterItems.length, placedItems: src.placedItems.length, pluginItems: src.pluginItems.length,
      meshItems: src.meshItems.length, artboard: src.artboards[0].artboardRect
    };
    if (opts.requirePureVector && (source.rasterItems || source.placedItems || source.pluginItems || source.meshItems)) {
      throw new Error("SVG_NOT_PURE_VECTOR: " + svgPath + " has raster " + source.rasterItems + ", placed " + source.placedItems + ", plugin " + source.pluginItems + ", mesh " + source.meshItems + " items");
    }
    var tops = [];
    for (var i = 0; i < src.pageItems.length; i++) {
      if (src.pageItems[i].parent.typename === "Layer") tops.push(src.pageItems[i]);
    }
    if (tops.length === 0) throw new Error("SVG contains no importable items: " + svgPath);
    source.topLevel = tops.length;
    source.topLevelPaths = 0;
    for (var t = 0; t < tops.length; t++) source.topLevelPaths += mcpSvgCountPaths(tops[t]);
    var frame = null;
    if (opts.anchor === "source_artboard") {
      var r = source.artboard;
      frame = src.layers[0].pathItems.rectangle(r[1], r[0], r[2] - r[0], r[1] - r[3]);
      frame.filled = false; frame.stroked = false; frame.name = "__mcp_svg_frame";
    }
    app.activeDocument = targetDoc;
    var copies = [];
    for (var j = 0; j < tops.length; j++) copies.push(tops[j].duplicate(targetLayer, ElementPlacement.PLACEATEND));
    var frameCopy = frame ? frame.duplicate(targetLayer, ElementPlacement.PLACEATEND) : null;
    var pathsAdded = 0;
    for (var k = 0; k < copies.length; k++) pathsAdded += mcpSvgCountPaths(copies[k]);
    result = { copies: copies, frameCopy: frameCopy, source: source, pathsAdded: pathsAdded };
  } finally {
    try { src.close(SaveOptions.DONOTSAVECHANGES); } catch (closeError) {}
    try { app.activeDocument = targetDoc; } catch (activateError) {}
  }
  return result;
}

function mcpSvgBoundsOf(items) {
  var b = items[0].geometricBounds.slice(0);
  for (var k = 1; k < items.length; k++) {
    var g = items[k].geometricBounds;
    if (g[0] < b[0]) b[0] = g[0];
    if (g[1] > b[1]) b[1] = g[1];
    if (g[2] > b[2]) b[2] = g[2];
    if (g[3] < b[3]) b[3] = g[3];
  }
  return b;
}

function mcpSvgPlace(imported, targetLayer, opts) {
  var copies = imported.copies, frame = imported.frameCopy;
  // Always transform as one group so loose items keep their relative positions; released at the end if asked.
  var root = targetLayer.groupItems.add();
  for (var i = copies.length - 1; i >= 0; i--) copies[i].moveToBeginning(root);
  if (frame) frame.moveToBeginning(root);
  var anchorBounds = function () { return frame ? frame.geometricBounds : mcpSvgBoundsOf(copies); };
  var before = anchorBounds();
  var scale = 100, dx = 0, dy = 0;
  var rect = opts.targetRect;
  if (opts.fit && rect) {
    var pad = opts.padding || 0;
    var w = before[2] - before[0], h = before[1] - before[3];
    var availW = rect[2] - rect[0] - pad * 2, availH = rect[1] - rect[3] - pad * 2;
    if (w > 0 && h > 0 && availW > 0 && availH > 0) {
      scale = Math.min(availW / w, availH / h) * 100;
      root.resize(scale, scale);
    }
    var scaled = anchorBounds();
    dx = rect[0] + ((rect[2] - rect[0]) - (scaled[2] - scaled[0])) / 2 - scaled[0];
    dy = rect[1] - ((rect[1] - rect[3]) - (scaled[1] - scaled[3])) / 2 - scaled[1];
  } else if (opts.point) {
    dx = opts.point[0] - before[0]; dy = opts.point[1] - before[1];
  } else if (frame && rect) {
    dx = rect[0] - before[0]; dy = rect[1] - before[1];
  }
  var placement = (opts.fit && rect) ? "fit_to_artboard" : opts.point ? "point" : (frame && rect) ? "source_artboard_on_target" : "kept_source_coordinates";
  if (dx !== 0 || dy !== 0) root.translate(dx, dy);
  var frameBounds = frame ? frame.geometricBounds : null;
  var clipped = false;
  if (frame && opts.clip) {
    frame.name = "画幅裁切";
    frame.clipping = true;
    root.clipped = true;
    clipped = true;
  } else if (frame) {
    frame.remove();
  }
  if (opts.name) root.name = opts.name;
  var released = false;
  if (opts.group === false && !clipped) {
    while (root.pageItems.length) root.pageItems[0].move(root, ElementPlacement.PLACEBEFORE);
    root.remove();
    root = null;
    released = true;
  }
  return {
    root: root, released: released, clipped: clipped, placement: placement, scalePercent: scale, translate: [dx, dy],
    anchorBoundsBefore: before, frameBounds: frameBounds,
    bounds: root ? root.geometricBounds : mcpSvgBoundsOf(copies),
    visibleBounds: root ? root.visibleBounds : null
  };
}
`;
