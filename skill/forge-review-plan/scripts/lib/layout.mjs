// Deterministic tidy-tree layout shared by the Excalidraw scene builder and the
// generated viewer (the viewer renders precomputed positions, so both outputs
// always agree and node boxes never overlap).

const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

export const LAYOUT_DEFAULTS = Object.freeze({
  fontSize: 17,
  lineHeight: 25,
  padX: 18,
  padY: 15,
  minWidth: 152,
  maxWidth: 340,
  minHeight: 54,
  gapX: 42,
  gapY: 92,
  maxLines: 6,
});

export function charWidth(ch, fontSize) {
  return CJK_RE.test(ch) ? fontSize * 1.0 : fontSize * 0.56;
}

export function estimateTextWidth(text, fontSize) {
  let width = 0;
  for (const ch of String(text)) width += charWidth(ch, fontSize);
  return width;
}

export function wrapText(text, maxWidth, fontSize, maxLines = Infinity) {
  const source = String(text ?? '').trim();
  if (source === '') return [''];
  const lines = [];
  let current = '';
  let currentWidth = 0;
  const push = () => {
    if (current !== '') lines.push(current);
    current = '';
    currentWidth = 0;
  };
  for (const ch of source) {
    if (ch === '\n') { push(); continue; }
    const w = charWidth(ch, fontSize);
    if (currentWidth + w > maxWidth && current !== '') {
      // prefer breaking after a space when one exists near the end
      const spaceIndex = current.lastIndexOf(' ');
      if (spaceIndex > 0 && currentWidth > maxWidth * 0.6) {
        const head = current.slice(0, spaceIndex);
        const tail = current.slice(spaceIndex + 1);
        lines.push(head);
        current = tail;
        currentWidth = estimateTextWidth(tail, fontSize);
      } else {
        push();
      }
    }
    current += ch;
    currentWidth += w;
  }
  push();
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/.$/u, '…');
    return kept;
  }
  return lines;
}

export function measureNode(text, opts = {}) {
  const o = { ...LAYOUT_DEFAULTS, ...opts };
  const longLine = Math.max(...String(text ?? '').split('\n').map((line) => estimateTextWidth(line, o.fontSize)), 0);
  const width = Math.min(o.maxWidth, Math.max(o.minWidth, Math.ceil(longLine + o.padX * 2 + 10)));
  const lines = wrapText(text, width - o.padX * 2, o.fontSize, o.maxLines);
  const height = Math.max(o.minHeight, lines.length * o.lineHeight + o.padY * 2);
  return { width, height, lines };
}

/**
 * Layout a model's concept tree.
 * Returns nodes keyed by concept id with absolute x/y/width/height and the
 * depth level. Sibling subtrees receive disjoint horizontal ranges, so boxes
 * never overlap regardless of tree size or depth.
 */
export function layoutTree(model, opts = {}) {
  const o = { ...LAYOUT_DEFAULTS, ...opts };
  // The caller may supply effective (learner-revised) titles so the generated
  // boxes are measured against what is actually rendered, never the raw model
  // title. Without this a long learner title is drawn into a box sized for the
  // author title and overflows.
  const resolveTitle = typeof o.resolveTitle === 'function' ? o.resolveTitle : null;
  const metrics = new Map();
  for (const concept of model.concepts) {
    const title = resolveTitle ? resolveTitle(concept) : concept.title;
    metrics.set(concept.id, measureNode(title, o));
  }

  const subtreeWidth = new Map();
  const computeWidth = (conceptId) => {
    const children = model.childrenById.get(conceptId) ?? [];
    if (children.length === 0) {
      subtreeWidth.set(conceptId, metrics.get(conceptId).width);
    } else {
      let total = 0;
      children.forEach((childId, index) => {
        total += computeWidth(childId);
        if (index > 0) total += o.gapX;
      });
      subtreeWidth.set(conceptId, Math.max(metrics.get(conceptId).width, total));
    }
    return subtreeWidth.get(conceptId);
  };
  const rootId = model.roots[0].id;
  computeWidth(rootId);

  // depth heights decide y positions
  const depthMaxHeight = [];
  for (const concept of model.concepts) {
    const depth = model.depthById.get(concept.id);
    depthMaxHeight[depth] = Math.max(depthMaxHeight[depth] ?? 0, metrics.get(concept.id).height);
  }
  const depthY = [];
  let y = 0;
  for (let depth = 0; depth < depthMaxHeight.length; depth += 1) {
    depthY[depth] = y;
    y += depthMaxHeight[depth] + o.gapY;
  }

  const nodes = Object.create(null);
  const place = (conceptId, left) => {
    const metric = metrics.get(conceptId);
    const total = subtreeWidth.get(conceptId);
    const x = Math.round(left + (total - metric.width) / 2);
    const depth = model.depthById.get(conceptId);
    nodes[conceptId] = {
      x,
      y: Math.round(depthY[depth]),
      width: metric.width,
      height: metric.height,
      depth,
      lines: metric.lines,
    };
    let childLeft = left;
    for (const childId of model.childrenById.get(conceptId) ?? []) {
      place(childId, childLeft);
      childLeft += subtreeWidth.get(childId) + o.gapX;
    }
  };
  place(rootId, 0);

  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const box of Object.values(nodes)) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  return {
    nodes,
    order: model.order.slice(),
    bounds: { minX, minY, maxX, maxY },
    depthCount: depthMaxHeight.length,
  };
}
