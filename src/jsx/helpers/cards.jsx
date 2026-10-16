// Direct Illustrator object operations. ES3; no menus, clipboard or window activation.
function cardDocument(filePath) {
  var wanted = new File(filePath).fsName;
  for (var i = 0; i < app.documents.length; i++) {
    try { if (app.documents[i].fullName.fsName === wanted) return app.documents[i]; } catch (ignore) {}
  }
  throw new Error("DOCUMENT_NOT_OPEN: " + wanted);
}

function cardLayer(root, segments) {
  var layer = root;
  for (var i = 0; i < segments.length; i++) {
    var matches = [];
    for (var j = 0; j < layer.layers.length; j++) if (layer.layers[j].name === segments[i]) matches.push(layer.layers[j]);
    if (matches.length !== 1) throw new Error("LAYER_NOT_UNIQUE: " + segments.join(" / "));
    layer = matches[0];
  }
  return layer;
}

function cardChildren(parent) {
  var result = [], i;
  if (parent.typename === "Document" || parent.typename === "Layer") {
    for (i = 0; i < parent.layers.length; i++) result.push(parent.layers[i]);
  }
  if (parent.typename !== "Document") {
    for (i = 0; i < parent.pageItems.length; i++) if (parent.pageItems[i].parent === parent) result.push(parent.pageItems[i]);
  }
  // 30.2.1 can throw Internal error for zOrderPosition on valid paths. The
  // absolute property works for both sublayers and items; larger is in front.
  result.sort(function(a,b) { return b.absoluteZOrderPosition - a.absoluteZOrderPosition; });
  return result;
}

function cardWalk(root, visit) {
  var children = cardChildren(root);
  for (var i = 0; i < children.length; i++) {
    var item = children[i]; visit(item);
    if (item.typename === "Layer" || item.typename === "GroupItem") cardWalk(item, visit);
  }
}

function cardItem(root, name) {
  var found = [];
  cardWalk(root, function(item) { if (item.typename !== "Layer" && item.name === name) found.push(item); });
  if (found.length !== 1) throw new Error("OBJECT_NOT_UNIQUE: " + name + " (" + found.length + ")");
  return found[0];
}

function cardUnlock(item, fn) {
  var states = [], node = item, targetLayer = null;
  while (node && node.typename !== "Document" && node.typename !== "Application") {
    if (!targetLayer && node.typename === "Layer") targetLayer = node;
    var state = { item: node, locked: node.locked, visible: null, hidden: null };
    if (node.typename === "Layer") state.visible = node.visible; else state.hidden = node.hidden;
    states.push(state); node = node.parent;
  }
  var ownerDoc = node && node.typename === "Document" ? node : null;
  var previousLayer = ownerDoc ? ownerDoc.activeLayer : null;
  for (var i = states.length - 1; i >= 0; i--) {
    states[i].item.locked = false;
    if (states[i].visible !== null) states[i].item.visible = true;
    else states[i].item.hidden = false;
  }
  // PlacedItem.file consults activeLayer even when the item has an explicit
  // unlocked parent. Selecting a document layer does not activate the app.
  if (ownerDoc && targetLayer) ownerDoc.activeLayer = targetLayer;
  try { return fn(); }
  finally {
    if (ownerDoc && previousLayer) try { ownerDoc.activeLayer = previousLayer; } catch (removedLayer) {}
    for (var j = 0; j < states.length; j++) {
      try {
        if (states[j].visible !== null) states[j].item.visible = states[j].visible;
        else states[j].item.hidden = states[j].hidden;
        states[j].item.locked = states[j].locked;
      } catch (removed) {}
    }
  }
}

function cardResetIDs(item) {
  function reset(one) {
    try {
      var note = one.note;
      if (extractUUIDFromNote(note)) one.note = generateUUID() + note.substring(36);
    } catch (ignore) {}
  }
  reset(item);
  if (item.typename === "Layer" || item.typename === "GroupItem") cardWalk(item, reset);
}

function cardCloneLayer(source, destination, dx, dy) {
  return cardUnlock(source, function() {
    var copy = destination.layers.add(); copy.name = source.name;
    var children = cardChildren(source);
    for (var i = children.length - 1; i >= 0; i--) {
      var child = children[i];
      if (child.typename === "Layer") cardCopyLayer(child, copy, dx, dy);
      else {
        (function(original) {
          var wasLocked = original.locked, wasHidden = original.hidden;
          cardUnlock(original, function() {
            var duplicate = original.duplicate(copy, ElementPlacement.PLACEATBEGINNING);
            duplicate.translate(dx, dy); cardResetIDs(duplicate);
            duplicate.hidden = wasHidden; duplicate.locked = wasLocked;
          });
        })(child);
      }
    }
    try { copy.opacity = source.opacity; } catch (ignoreOpacity) {}
    try { copy.blendingMode = source.blendingMode; } catch (ignoreBlend) {}
    return copy;
  });
}

function cardCopyLayer(source, destination, dx, dy) {
  var locked = source.locked, visible = source.visible;
  var copy = cardCloneLayer(source, destination, dx, dy);
  // Recursive clone restores child state separately; restore outer layer after copy.
  copy.visible = visible; copy.locked = locked;
  return copy;
}

function cardBounds(item) {
  var b = item.geometricBounds; return [b[0],b[1],b[2],b[3]];
}

// PDF page clipping paths have page-sized geometry even when only a short name
// is painted. Fit the artwork, while keeping the original clipping structure.
function cardArtworkBounds(item) {
  if (item.typename === "PathItem") return !item.clipping && (item.filled || item.stroked) ? cardBounds(item) : null;
  var children = item.typename === "CompoundPathItem" ? item.pathItems : cardChildren(item);
  var bounds = null, clip = null;
  for (var i = 0; i < children.length; i++) {
    var child = children[i];
    if (child.typename === "PathItem" && child.clipping) { clip = cardBounds(child); continue; }
    var b = cardArtworkBounds(child);
    if (!b) continue;
    if (!bounds) bounds = b;
    else bounds = [Math.min(bounds[0],b[0]),Math.max(bounds[1],b[1]),Math.max(bounds[2],b[2]),Math.min(bounds[3],b[3])];
  }
  if (bounds && item.typename === "GroupItem" && item.clipped && clip) {
    bounds = [Math.max(bounds[0],clip[0]),Math.min(bounds[1],clip[1]),Math.min(bounds[2],clip[2]),Math.max(bounds[3],clip[3])];
  }
  return bounds;
}

function cardFit(item, bounds, artworkOnly) {
  var b = artworkOnly ? cardArtworkBounds(item) : cardBounds(item);
  if (!b) throw new Error("EMPTY_GEOMETRY");
  var w = b[2]-b[0], h = b[1]-b[3];
  if (w <= 0 || h <= 0) throw new Error("EMPTY_GEOMETRY");
  var ratio = Math.min((bounds[2]-bounds[0])/w, (bounds[1]-bounds[3])/h);
  item.resize(ratio*100, ratio*100, true, true, true, true, ratio*100);
  b = artworkOnly ? cardArtworkBounds(item) : cardBounds(item);
  item.translate((bounds[0]+bounds[2]-b[0]-b[2])/2, (bounds[1]+bounds[3]-b[1]-b[3])/2);
}

function cardPathStats(root) {
  var stats = { paths: 0, compounds: 0, anchors: 0, rasters: 0, links: 0, texts: 0 };
  function count(item) {
    if (item.typename === "PathItem") { stats.paths++; stats.anchors += item.pathPoints.length; }
    else if (item.typename === "CompoundPathItem") {
      stats.compounds++;
      for (var p = 0; p < item.pathItems.length; p++) count(item.pathItems[p]);
    } else if (item.typename === "RasterItem") stats.rasters++;
    else if (item.typename === "PlacedItem") stats.links++;
    else if (item.typename === "TextFrame") stats.texts++;
  }
  count(root); if (root.typename === "GroupItem" || root.typename === "Layer" || root.typename === "Document") cardWalk(root,count);
  return stats;
}

function cardImportPDF(doc, options, target) {
  var file = new File(options.pdf_path);
  if (!file.exists) throw new Error("PDF_NOT_FOUND: " + file.fsName);
  for (var di = 0; di < app.documents.length; di++) {
    try { if (app.documents[di].fullName.fsName === file.fsName) throw new Error("PDF_ALREADY_OPEN: Close the source PDF before importing; existing user documents are preserved."); }
    catch (e) { if (String(e.message).indexOf("PDF_ALREADY_OPEN") >= 0) throw e; }
  }
  var previousPage = app.preferences.PDFFileOptions.pageToOpen, source = null, group = null, imported = [];
  try {
    app.preferences.PDFFileOptions.pageToOpen = options.page || 1;
    source = app.open(file);
    var before = cardPathStats(source);
    if (!before.paths || before.links || before.rasters || before.texts) throw new Error("PDF_NOT_OUTLINED_PATHS: Supply an outlined vector PDF without linked/raster/text substitutes.");
    app.activeDocument = doc;
    group = target.groupItems.add(); group.name = options.group_name;
    function transfer(layer) {
      var children = cardChildren(layer);
      for (var i = 0; i < children.length; i++) {
        if (children[i].typename === "Layer") transfer(children[i]);
        else cardUnlock(children[i], (function(original) { return function() {
          // Illustrator 30.2.1 rejects cross-document duplication directly into
          // a GroupItem (MRAP). Copy into the target layer, then group locally.
          var copy = original.duplicate(target, ElementPlacement.PLACEATEND);
          imported.push(copy);
          copy.move(group, ElementPlacement.PLACEATEND);
          copy.locked = false; copy.hidden = false; cardResetIDs(copy);
        }; })(children[i]));
      }
    }
    for (var li = 0; li < source.layers.length; li++) transfer(source.layers[li]);
    var after = cardPathStats(group);
    if (before.paths !== after.paths || before.compounds !== after.compounds || before.anchors !== after.anchors) throw new Error("PDF_PATH_STRUCTURE_CHANGED");
    if (options.fit_bounds) cardFit(group, options.fit_bounds, true);
    group.note = "pdf-source:" + file.fsName + "#page=" + (options.page || 1);
    return { group: group, source: before, imported: after };
  } catch (e) {
    for (var orphan = imported.length - 1; orphan >= 0; orphan--) try { imported[orphan].remove(); } catch (ignoreOrphan) {}
    if (group) try { group.remove(); } catch (ignoreRemove) {}
    throw e;
  } finally {
    app.preferences.PDFFileOptions.pageToOpen = previousPage;
    if (source) try { source.close(SaveOptions.DONOTSAVECHANGES); } catch (ignoreClose) {}
    app.activeDocument = doc;
  }
}

function cardImageMatrix(item) {
  var m = item.matrix;
  return [m.mValueA,m.mValueB,m.mValueC,m.mValueD,m.mValueTX,m.mValueTY];
}

function cardReplaceImage(doc, root, options) {
  var old = cardItem(root,options.item_name);
  if (old.typename !== "PlacedItem" && old.typename !== "RasterItem") throw new Error("TARGET_NOT_IMAGE: " + options.item_name);
  var parent = old.parent;
  if (options.require_clipping !== false && (parent.typename !== "GroupItem" || !parent.clipped)) throw new Error("TARGET_NOT_INSIDE_CLIPPING_GROUP");
  // Rotated/sheared frames require an explicit template script; bounding-box sizing
  // would silently distort them. Reject before changing the original.
  var matrix = cardImageMatrix(old);
  if (Math.abs(matrix[1]) > 0.0001 || Math.abs(matrix[2]) > 0.0001 || Math.abs(matrix[0]) < 0.0001 || Math.abs(matrix[3]) < 0.0001) throw new Error("TRANSFORM_UNSUPPORTED: Use a verified template script for rotated or sheared images.");
  var source = new File(options.file_path);
  if (!source.exists || /\.(pdf|ai|eps|svg)$/i.test(source.name)) throw new Error("INVALID_RASTER_SOURCE");
  var frame = options.bounds || cardBounds(old), opacity = old.opacity, wasHidden = old.hidden, wasLocked = old.locked;
  return cardUnlock(old,function() {
    // Create inside the known unlocked parent, not doc.activeLayer, which may
    // be a hidden/locked sublayer restored during template cloning.
    var placed = parent.placedItems.add(), result = null;
    try {
      placed.file = source;
      // Raster files have a negative native Y scale in Illustrator 30.2.1.
      // Compare to a newly placed image rather than assuming positive diagonals.
      var natural=cardImageMatrix(placed);
      if(matrix[0]*natural[0]<0 || matrix[3]*natural[3]<0)throw new Error("TRANSFORM_UNSUPPORTED: Mirrored image needs a verified template script.");
      var sourceRatio = placed.width / placed.height, frameRatio = (frame[2]-frame[0])/(frame[1]-frame[3]);
      if (Math.abs(sourceRatio/frameRatio - 1) > 0.01) throw new Error("IMAGE_ASPECT_MISMATCH: Provide same-proportion art or explicit template sizing; the image was not stretched.");
      placed.width = frame[2]-frame[0]; placed.height = frame[1]-frame[3];
      placed.position = [frame[0],frame[1]];
      placed.opacity = opacity;
      try { placed.blendingMode = old.blendingMode; } catch (ignoreBlend) {}
      placed.move(old, ElementPlacement.PLACEBEFORE);
      var tag = "__card_embed_" + generateUUID(); placed.name = options.embed ? tag : options.item_name;
      result = placed;
      if (options.embed) {
        placed.embed(); result = null;
        for (var ri=0;ri<doc.rasterItems.length;ri++) if (doc.rasterItems[ri].name === tag) { result=doc.rasterItems[ri]; break; }
        if (!result) throw new Error("EMBED_RESULT_NOT_FOUND");
      }
      result.name = options.item_name;
      result.note = "card-image-source:" + source.fsName;
      old.remove();
      result.hidden = wasHidden; result.locked = wasLocked;
      return { name:result.name, type:result.typename, bounds:cardBounds(result), source:source.fsName, embedded:!!options.embed };
    } catch (e) {
      try { if (result) result.remove(); else placed.remove(); } catch (ignoreRemove) {}
      throw e;
    }
  });
}

function cardRGB(values) { var c=new RGBColor();c.red=values[0];c.green=values[1];c.blue=values[2];return c; }

function cardBacking(doc, root, options) {
  var face = cardItem(root,options.face_name);
  var stats = cardPathStats(face);
  if (!stats.paths || stats.links || stats.rasters || stats.texts) throw new Error("FACE_NOT_PATHS");
  // Resolve every dependency before duplicating the face.
  var gradient = null;
  if (options.gradient_name) {
    try { gradient=doc.gradients.getByName(options.gradient_name); } catch (missing) { throw new Error("GRADIENT_NOT_FOUND: "+options.gradient_name); }
  } else if (!options.stops || options.stops.length < 2) throw new Error("GRADIENT_REQUIRED");
  var duplicateName = options.backing_name || options.face_name + " 衬边";
  var collision=false; cardWalk(root,function(it){if(it.name===duplicateName)collision=true;});
  if(collision) throw new Error("BACKING_ALREADY_EXISTS");
  return cardUnlock(face,function() {
    if(!gradient) {
      // This host rejects long gradient names with "the name was not found".
      gradient=doc.gradients.add(); gradient.name="card-"+generateUUID().substring(0,8); gradient.type=GradientType.LINEAR;
      while(gradient.gradientStops.length < options.stops.length) gradient.gradientStops.add();
      for(var si=0;si<options.stops.length;si++) {
        gradient.gradientStops[si].rampPoint=options.stops[si].position;
        gradient.gradientStops[si].color=cardRGB(options.stops[si].rgb);
      }
    }
    var backing=face.duplicate(face,ElementPlacement.PLACEAFTER);backing.name=duplicateName;cardResetIDs(backing);
    try {
      var bounds=cardArtworkBounds(face) || cardBounds(face);
      var fill=new GradientColor();fill.gradient=gradient;
      fill.origin=[bounds[0],(bounds[1]+bounds[3])/2];fill.length=bounds[2]-bounds[0];
      fill.matrix=app.getRotationMatrix(options.angle || 0);
      function paint(item) {
        if(item.typename==="PathItem" && !item.clipping) {item.filled=true;item.fillColor=fill;item.stroked=false;}
        else if(item.typename==="CompoundPathItem") for(var pi=0;pi<item.pathItems.length;pi++) paint(item.pathItems[pi]);
      }
      paint(backing);if(backing.typename==="GroupItem")cardWalk(backing,paint);
      backing.applyEffect('<LiveEffect name="Adobe Offset Path"><Dict data="R mlim 4 R ofst '+options.offset_pt+' I jntp 2 "/></LiveEffect>');
      backing.note="card-backing-offset:"+options.offset_pt;
      return {name:backing.name,offset_pt:options.offset_pt,gradient:gradient.name,face:stats,backing:cardPathStats(backing)};
    } catch(e) {try{backing.remove();}catch(ignoreRemove){}throw e;}
  });
}

function cardWriteStatus(path, data) {
  if(!path)return;
  var file=new File(path);file.encoding="UTF-8";
  if(!file.open("w"))throw new Error("CANNOT_WRITE_PROGRESS");
  file.write(jsonStringify(data));file.close();
}

function cardSave(doc) {
  var options=new IllustratorSaveOptions();
  options.pdfCompatible=true;options.compressed=true;options.embedLinkedFiles=false;
  doc.saveAs(doc.fullName,options);
}

function cardBatch(plan) {
  var output=new File(plan.output_path), doc=null, completed=[], phase="open", current=null;
  var beforeDoc=app.documents.length ? app.activeDocument : null;
  try {
    doc=app.open(output);
    var templateRect=doc.artboards[plan.template_artboard || 0].artboardRect;
    var width=templateRect[2]-templateRect[0],height=templateRect[1]-templateRect[3];
    var sources=[], originalArtboards=doc.artboards.length;
    for(var li=0;li<doc.layers.length;li++)sources.push(doc.layers[li]);
    // Preflight every selector before generating the first card.
    for(var ci=0;ci<plan.cards.length;ci++) {
      var pre=plan.cards[ci];
      for(var ti=0;ti<(pre.texts || []).length;ti++) if(cardItem(doc,pre.texts[ti].item_name).typename!=="TextFrame")throw new Error("TEXT_TARGET_INVALID");
      for(var ii=0;ii<(pre.images || []).length;ii++)cardItem(doc,pre.images[ii].item_name);
      for(var linked=0;linked<doc.placedItems.length;linked++) {
        var mapped=false;
        for(ii=0;ii<(pre.images || []).length;ii++)if(pre.images[ii].item_name===doc.placedItems[linked].name)mapped=true;
        if(!mapped)throw new Error("UNMAPPED_TEMPLATE_LINK: Include every linked template image in each card image plan: "+doc.placedItems[linked].name);
      }
      if(pre.name_art)cardLayer(doc,pre.name_art.layer_path);
    }
    for(ci=0;ci<plan.cards.length;ci++) {
      current=plan.cards[ci];phase="generate";
      cardWriteStatus(plan.progress_path,{state:"running",phase:phase,current:current.id,completed:completed});
      var label=current.id+" "+current.name;
      var parent=doc.layers.add();parent.name=label;
      var col=ci % (plan.columns || 4),row=Math.floor(ci/(plan.columns || 4));
      var gap=plan.gap_pt === undefined ? 20 : plan.gap_pt;
      var dx=col*(width+gap),dy=-row*(height+gap);
      // New artboards are appended; original template artboards are removed at end.
      var board=doc.artboards.add([templateRect[0]+dx,templateRect[1]+dy,templateRect[2]+dx,templateRect[3]+dy]);board.name=label;
      for(li=sources.length-1;li>=0;li--)cardCopyLayer(sources[li],parent,dx,dy);
      for(ti=0;ti<(current.texts || []).length;ti++) {
        var textSpec=current.texts[ti],text=cardItem(parent,textSpec.item_name);
        cardUnlock(text,(function(tf,spec){return function(){
          tf.contents=spec.contents;
          if(spec.font_size)tf.textRange.characterAttributes.size=spec.font_size;
        };})(text,textSpec));
      }
      for(ii=0;ii<(current.images || []).length;ii++)cardReplaceImage(doc,parent,current.images[ii]);
      if(current.name_art) {
        var art=current.name_art,target=cardLayer(parent,art.layer_path);
        var box=[art.fit_bounds[0]+dx,art.fit_bounds[1]+dy,art.fit_bounds[2]+dx,art.fit_bounds[3]+dy];
        cardUnlock(target,(function(a,t,b){return function(){
          if(a.replace_item_name)cardUnlock(cardItem(parent,a.replace_item_name),function(){cardItem(parent,a.replace_item_name).remove();});
          cardImportPDF(doc,{pdf_path:a.pdf_path,page:a.page,group_name:a.group_name,fit_bounds:b},t);
          if(a.backing) {
            var opts=a.backing;opts.face_name=a.group_name;cardBacking(doc,parent,opts);
          }
        };})(art,target,box));
      }
      phase="save_checkpoint";cardSave(doc);completed.push(current.id);
      cardWriteStatus(plan.progress_path,{state:"running",phase:phase,current:current.id,completed:completed});
    }
    phase="remove_template";
    for(li=0;li<sources.length;li++)cardUnlock(sources[li],(function(layer){return function(){layer.remove();};})(sources[li]));
    for(var ai=originalArtboards-1;ai>=0;ai--)doc.artboards[ai].remove();
    cardSave(doc);doc.close(SaveOptions.DONOTSAVECHANGES);doc=null;
    var result={state:"generated",completed:completed,output_path:output.fsName,visual_verified:false};
    cardWriteStatus(plan.progress_path,result);return result;
  } catch(e) {
    var problem={state:"failed",phase:phase,current:current ? current.id : null,completed:completed,output_path:output.fsName,error:String(e.message || e),line:e.line};
    try{cardWriteStatus(plan.progress_path,problem);}catch(ignoreLog){}
    // Do not save a half-written card over the latest checkpoint or discard its
    // live document: preserve both for inspection; never replay automatically.
    throw new Error(jsonStringify(problem));
  } finally {if(beforeDoc)try{app.activeDocument=beforeDoc;}catch(ignoreDoc){}}
}

function cardValidate(plan) {
  var file=new File(plan.output_path),doc=null,previous=app.documents.length ? app.activeDocument : null;
  for(var i=0;i<app.documents.length;i++) {
    try {if(app.documents[i].fullName.fsName===file.fsName)throw new Error("VALIDATION_REQUIRES_CLOSED_FILE: Save and close the output first.");}
    catch(e){if(String(e.message).indexOf("VALIDATION_REQUIRES")>=0)throw e;}
  }
  var errors=[],cards=[],previews=[];
  try {
    doc=app.open(file);
    if(doc.artboards.length!==plan.cards.length)errors.push("Artboard count mismatch");
    if(doc.layers.length!==plan.cards.length)errors.push("Parent layer count mismatch");
    for(var ci=0;ci<plan.cards.length;ci++) {
      var spec=plan.cards[ci],label=spec.id+" "+spec.name,issues=[],root=null;
      try {
        root=cardLayer(doc,[label]);
        if(doc.artboards[ci].name!==label)issues.push("Artboard/name mismatch");
        if(plan.expected_sublayers) {
          var sub=[];for(var li=0;li<root.layers.length;li++)sub.push(root.layers[li].name);
          if(jsonStringify(sub)!==jsonStringify(plan.expected_sublayers))issues.push("Sublayer names/order mismatch");
        }
        for(var ti=0;ti<(spec.texts || []).length;ti++) if(cardItem(root,spec.texts[ti].item_name).contents!==spec.texts[ti].contents)issues.push("Text mismatch: "+spec.texts[ti].item_name);
        for(var ii=0;ii<(spec.images || []).length;ii++) {
          var imageSpec=spec.images[ii],image=cardItem(root,imageSpec.item_name);
          if(imageSpec.embed && image.typename!=="RasterItem")issues.push("Image not embedded: "+image.name);
          if(!imageSpec.embed && (image.typename!=="PlacedItem" || !image.file.exists || image.file.fsName!==new File(imageSpec.file_path).fsName))issues.push("Image link mismatch: "+image.name);
          if(imageSpec.require_clipping!==false && (image.parent.typename!=="GroupItem" || !image.parent.clipped))issues.push("Clipping mask missing: "+image.name);
        }
        for(var pi=0;pi<(spec.aligned_image_pairs || []).length;pi++) {
          var pair=spec.aligned_image_pairs[pi],a=cardBounds(cardItem(root,pair[0])),b=cardBounds(cardItem(root,pair[1]));
          for(var bi=0;bi<4;bi++)if(Math.abs(a[bi]-b[bi])>0.02) {issues.push("Image pair misaligned: "+pair.join(" / "));break;}
        }
        if(spec.name_art) {
          var face=cardItem(root,spec.name_art.group_name),stats=cardPathStats(face);
          if(!stats.paths || stats.texts || stats.rasters || stats.links)issues.push("Name is not editable paths");
          if(spec.name_art.backing) {
            var back=cardItem(root,spec.name_art.backing.backing_name || spec.name_art.group_name+" 衬边");
            if(back===face)issues.push("Name face/backing not separate");
          }
        }
      }catch(e){issues.push(String(e.message||e));}
      cards.push({id:spec.id,passed:issues.length===0,issues:issues});
      if(issues.length)errors.push(label+": "+issues.join("; "));
      if(plan.preview_directory) {
        doc.artboards.setActiveArtboardIndex(ci);
        var png=new ExportOptionsPNG24();png.artBoardClipping=true;png.transparency=true;png.horizontalScale=100;png.verticalScale=100;
        var preview=new File(plan.preview_directory+"/"+spec.id+".png");doc.exportFile(preview,ExportType.PNG24,png);previews.push(preview.fsName);
      }
    }
    // All linked images, including untouched template decorations, must resolve.
    var linksRoot=new Folder(file.parent.fsName+"/Links").fsName+"/";
    for(var lp=0;lp<doc.placedItems.length;lp++) {
      if(!doc.placedItems[lp].file.exists)errors.push("Missing link: "+doc.placedItems[lp].name);
      if(doc.placedItems[lp].file.fsName.indexOf(linksRoot)!==0)errors.push("Link outside delivery directory: "+doc.placedItems[lp].name);
    }
    return {structural_passed:errors.length===0,cards:cards,errors:errors,previews:previews,visual_verified:false,output_path:file.fsName};
  }finally{if(doc)doc.close(SaveOptions.DONOTSAVECHANGES);if(previous)try{app.activeDocument=previous;}catch(ignoreDoc){}}
}
