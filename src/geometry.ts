/**
 * Procedural classic interlocking jigsaw piece geometry generator.
 * Generates randomized, non-overlapping cubic Bezier tabs and blanks for every interior edge,
 * builds Path2D outlines for exact hit-testing and clipping, and calculates optimal grid dimensions.
 */

export interface EdgeCurve {
  /** +1 or -1 indicating which side the tab protrudes toward (0 for flat outer border) */
  sign: -1 | 0 | 1;
  /** Slight horizontal shift of the tab neck center (-0.08 to +0.08 of edge length) */
  MidShift: number;
  /** Width of the neck waist */
  neckWidth: number;
  /** Width of the tab head */
  headWidth: number;
  /** Height/protrusion of the tab relative to min(pieceWidth, pieceHeight) */
  tabHeight: number;
  /** Slight asymmetry skew */
  skew: number;
}

export interface PieceEdges {
  top: EdgeCurve;
  right: EdgeCurve;
  bottom: EdgeCurve;
  left: EdgeCurve;
}

export interface GridDimensions {
  cols: number;
  rows: number;
  total: number;
}

/**
 * Calculates the optimal (cols, rows) grid that preserves the image's aspect ratio
 * so each puzzle piece is as close to square (1:1 aspect ratio) as possible.
 */
export function computeOptimalGrid(
  imageWidth: number,
  imageHeight: number,
  targetPieces: number
): GridDimensions {
  const aspect = imageWidth / Math.max(1, imageHeight);
  let bestCols = 4;
  let bestRows = 3;
  let bestScore = Infinity;

  const minDim = 2;
  const maxDim = Math.ceil(Math.sqrt(targetPieces * 3)) + 10;

  for (let cols = minDim; cols <= maxDim; cols++) {
    const idealRows = Math.max(minDim, Math.round(cols / aspect));
    for (let r = Math.max(minDim, idealRows - 1); r <= idealRows + 1; r++) {
      const count = cols * r;
      const countDiff = Math.abs(count - targetPieces) / targetPieces;
      const pieceAspect = (imageWidth / cols) / (imageHeight / r);
      const aspectDiff = Math.abs(Math.log(pieceAspect));
      // Combine closeness to target piece count and squareness of each piece
      const score = countDiff * 1.3 + aspectDiff * 0.85;
      if (score < bestScore) {
        bestScore = score;
        bestCols = cols;
        bestRows = r;
      }
    }
  }

  return {
    cols: bestCols,
    rows: bestRows,
    total: bestCols * bestRows,
  };
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function createRandomInteriorEdge(sign: -1 | 1): EdgeCurve {
  return {
    sign,
    MidShift: randomRange(-0.06, 0.06),
    neckWidth: randomRange(0.085, 0.11),
    headWidth: randomRange(0.17, 0.215),
    tabHeight: randomRange(0.21, 0.255),
    skew: randomRange(-0.025, 0.025),
  };
}

function invertEdge(edge: EdgeCurve): EdgeCurve {
  if (edge.sign === 0) {
    return { ...edge, sign: 0 };
  }
  // When traversing the shared edge in the opposite direction,
  // MidShift and skew invert horizontally, and sign flips relative to piece outward normal
  return {
    sign: (edge.sign * -1) as -1 | 1,
    MidShift: -edge.MidShift,
    neckWidth: edge.neckWidth,
    headWidth: edge.headWidth,
    tabHeight: edge.tabHeight,
    skew: -edge.skew,
  };
}

const FLAT_EDGE: EdgeCurve = {
  sign: 0,
  MidShift: 0,
  neckWidth: 0,
  headWidth: 0,
  tabHeight: 0,
  skew: 0,
};

/**
 * Generates a complete `rows × cols` matrix of matching PieceEdges.
 * Shared edges between adjacent pieces are exact mathematical inverses.
 */
export function generateGridEdges(cols: number, rows: number): PieceEdges[][] {
  // Horizontal interior seams: between (r, c) bottom and (r+1, c) top
  const horizSeams: EdgeCurve[][] = [];
  for (let r = 0; r < rows - 1; r++) {
    const rowSeams: EdgeCurve[] = [];
    for (let c = 0; c < cols; c++) {
      const sign: -1 | 1 = Math.random() < 0.5 ? 1 : -1;
      rowSeams.push(createRandomInteriorEdge(sign));
    }
    horizSeams.push(rowSeams);
  }

  // Vertical interior seams: between (r, c) right and (r, c+1) left
  const vertSeams: EdgeCurve[][] = [];
  for (let r = 0; r < rows; r++) {
    const colSeams: EdgeCurve[] = [];
    for (let c = 0; c < cols - 1; c++) {
      const sign: -1 | 1 = Math.random() < 0.5 ? 1 : -1;
      colSeams.push(createRandomInteriorEdge(sign));
    }
    vertSeams.push(colSeams);
  }

  const grid: PieceEdges[][] = [];
  for (let r = 0; r < rows; r++) {
    const rowArr: PieceEdges[] = [];
    for (let c = 0; c < cols; c++) {
      const top = r === 0 ? FLAT_EDGE : invertEdge(horizSeams[r - 1][c]);
      const right = c === cols - 1 ? FLAT_EDGE : vertSeams[r][c];
      // Note: bottom edge is traversed right-to-left (clockwise), so horizSeams[r][c] is used directly
      const bottom = r === rows - 1 ? FLAT_EDGE : horizSeams[r][c];
      const left = c === 0 ? FLAT_EDGE : invertEdge(vertSeams[r][c - 1]);

      rowArr.push({ top, right, bottom, left });
    }
    grid.push(rowArr);
  }

  return grid;
}

/**
 * Appends a single jigsaw edge from (x0, y0) to (x1, y1) onto a Path2D.
 * Positive `edge.sign` bulges outward (to the left of the directed vector from P0 to P1
 * when walking clockwise around the piece: Top L->R, Right T->B, Bottom R->L, Left B->T).
 */
export function appendEdgeToPath(
  path: Path2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  edge: EdgeCurve,
  tabScale: number
): void {
  if (edge.sign === 0) {
    path.lineTo(x1, y1);
    return;
  }

  const dx = x1 - x0;
  const dy = y1 - y0;
  // Outward unit normal for clockwise winding (Top: (0,-1), Right: (1,0), Bottom: (0,1), Left: (-1,0))
  const len = Math.hypot(dx, dy);
  const nx = (dy / len) * edge.sign;
  const ny = (-dx / len) * edge.sign;

  const h = tabScale * edge.tabHeight;
  const m = 0.5 + edge.MidShift;
  const nw = edge.neckWidth;
  const hw = edge.headWidth;
  const sk = edge.skew;

  // Helper to convert (t along edge [0..1], n along normal in pixels) to (x, y)
  const pt = (t: number, n: number): [number, number] => [
    x0 + dx * t + nx * n,
    y0 + dy * t + ny * n,
  ];

  // Classic 4-segment cubic Bezier jigsaw tab profile:
  // 1. Base shoulder from (0, 0) to neck left (m - nw, 0) with slight dip
  const [c1x, c1y] = pt(m - nw * 2.2, 0);
  const [c2x, c2y] = pt(m - nw * 1.45, -h * 0.12);
  const [p1x, p1y] = pt(m - nw, h * 0.08);
  path.bezierCurveTo(c1x, c1y, c2x, c2y, p1x, p1y);

  // 2. Left neck up to top-center of the tab head (m + sk, h)
  const [c3x, c3y] = pt(m - nw * 0.65, h * 0.35);
  const [c4x, c4y] = pt(m - hw * 1.35 + sk, h * 0.98);
  const [p2x, p2y] = pt(m + sk, h);
  path.bezierCurveTo(c3x, c3y, c4x, c4y, p2x, p2y);

  // 3. Top-center of tab head down to right neck (m + nw, h * 0.08)
  const [c5x, c5y] = pt(m + hw * 1.35 + sk, h * 0.98);
  const [c6x, c6y] = pt(m + nw * 0.65, h * 0.35);
  const [p3x, p3y] = pt(m + nw, h * 0.08);
  path.bezierCurveTo(c5x, c5y, c6x, c6y, p3x, p3y);

  // 4. Right neck back to corner (1, 0)
  const [c7x, c7y] = pt(m + nw * 1.45, -h * 0.12);
  const [c8x, c8y] = pt(m + nw * 2.2, 0);
  path.bezierCurveTo(c7x, c7y, c8x, c8y, x1, y1);
}

/**
 * Builds a complete closed Path2D for a piece in its local coordinate space
 * where the core rectangular cell is centered at (0, 0) spanning [-w/2..w/2, -h/2..h/2].
 */
export function buildPiecePath(
  pieceWidth: number,
  pieceHeight: number,
  edges: PieceEdges
): Path2D {
  const path = new Path2D();
  const hw = pieceWidth / 2;
  const hh = pieceHeight / 2;
  const tabScale = Math.min(pieceWidth, pieceHeight);

  path.moveTo(-hw, -hh);
  // Top: (-hw, -hh) -> (hw, -hh)
  appendEdgeToPath(path, -hw, -hh, hw, -hh, edges.top, tabScale);
  // Right: (hw, -hh) -> (hw, hh)
  appendEdgeToPath(path, hw, -hh, hw, hh, edges.right, tabScale);
  // Bottom: (hw, hh) -> (-hw, hh)
  appendEdgeToPath(path, hw, hh, -hw, hh, edges.bottom, tabScale);
  // Left: (-hw, hh) -> (-hw, -hh)
  appendEdgeToPath(path, -hw, hh, -hw, -hh, edges.left, tabScale);
  path.closePath();

  return path;
}

/**
 * Builds a Path2D containing only the unmerged exterior edges of a piece
 * so connected neighbors inside a cluster have seamless interior joins!
 */
export function buildUnmergedOutlinePath(
  pieceWidth: number,
  pieceHeight: number,
  edges: PieceEdges,
  mergedSides: { top: boolean; right: boolean; bottom: boolean; left: boolean }
): Path2D {
  const path = new Path2D();
  const hw = pieceWidth / 2;
  const hh = pieceHeight / 2;
  const tabScale = Math.min(pieceWidth, pieceHeight);

  if (!mergedSides.top) {
    path.moveTo(-hw, -hh);
    appendEdgeToPath(path, -hw, -hh, hw, -hh, edges.top, tabScale);
  }
  if (!mergedSides.right) {
    path.moveTo(hw, -hh);
    appendEdgeToPath(path, hw, -hh, hw, hh, edges.right, tabScale);
  }
  if (!mergedSides.bottom) {
    path.moveTo(hw, hh);
    appendEdgeToPath(path, hw, hh, -hw, hh, edges.bottom, tabScale);
  }
  if (!mergedSides.left) {
    path.moveTo(-hw, hh);
    appendEdgeToPath(path, -hw, hh, -hw, -hh, edges.left, tabScale);
  }

  return path;
}

