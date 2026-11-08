import {
  PieceEdges,
  buildPiecePath,
  buildUnmergedOutlinePath,
  generateGridEdges,
} from './geometry';
import { SoundEngine } from './audio';

export interface PuzzlePiece {
  id: number;
  row: number;
  col: number;
  /** Group ID — pieces in the same group move and rotate as a single connected cluster */
  groupId: number;
  /** World X of the piece center */
  x: number;
  /** World Y of the piece center */
  y: number;
  /** Target World X on the solved board */
  targetX: number;
  /** Target World Y on the solved board */
  targetY: number;
  /** Current rotation in quarter turns: 0 (0°), 1 (90°), 2 (180°), 3 (270°) */
  rotation: 0 | 1 | 2 | 3;
  /** Whether this piece's group is locked onto its final board location */
  lockedToBoard: boolean;
  /** Render order index (higher = drawn on top) */
  zIndex: number;
  edges: PieceEdges;
  /** Closed Path2D centered at (0,0) in local piece coordinates */
  path: Path2D;
  /** Pre-rendered offscreen sprite containing clipped image + 3D bevels for unmerged sides */
  sprite: HTMLCanvasElement;
  /** Track which neighbors are currently merged so we only re-bake the sprite when a new neighbor joins */
  mergedNeighbors: {
    top: boolean;
    right: boolean;
    bottom: boolean;
    left: boolean;
  };
  /** Visual snap flash timestamp (performance.now()) for bright pulse animation */
  snapFlashUntil: number;
}

interface ConfettiParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  angle: number;
  vAngle: number;
  life: number;
}

export interface EngineCallbacks {
  onProgressChange: (lockedConnections: number, totalPieces: number, percent: number) => void;
  onPuzzleComplete: () => void;
}

export class PuzzleEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private hitCtx: CanvasRenderingContext2D;
  private sound: SoundEngine;
  private callbacks: EngineCallbacks;

  private sourceImage: HTMLImageElement | null = null;
  private cols = 0;
  private rows = 0;
  private pieceWidth = 100;
  private pieceHeight = 100;
  /** Margin around each piece sprite to accommodate protruding tabs + bevels */
  private spriteMargin = 40;
  private boardWidth = 800;
  private boardHeight = 600;
  private rotationEnabled = false;

  public pieces: PuzzlePiece[] = [];
  private maxZIndex = 1;

  // Camera state (world to screen transform: screen = world * zoom + pan)
  private panX = 0;
  private panY = 0;
  private zoom = 1;

  // Ghost image settings
  public showGhost = false;
  public ghostOpacity = 0.25;

  // Interaction state
  private activeGroupId: number | null = null;
  private hoveredPieceId: number | null = null;
  private isPanning = false;
  private isSpaceDown = false;
  private lastPointerWorldX = 0;
  private lastPointerWorldY = 0;
  private lastPointerScreenX = 0;
  private lastPointerScreenY = 0;
  private pointerMovedDistance = 0;
  private activePointers: Map<number, { x: number; y: number }> = new Map();
  private lastPinchDist = 0;

  // Celebration confetti
  private confetti: ConfettiParticle[] = [];
  private isCompleted = false;
  public isPaused = false;

  constructor(
    canvas: HTMLCanvasElement,
    sound: SoundEngine,
    callbacks: EngineCallbacks
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context not supported');
    this.ctx = ctx;

    // Tiny 1x1 offscreen canvas used purely for Path2D hit-testing
    const hitCanvas = document.createElement('canvas');
    hitCanvas.width = 1;
    hitCanvas.height = 1;
    this.hitCtx = hitCanvas.getContext('2d')!;

    this.sound = sound;
    this.callbacks = callbacks;

    this.setupEventListeners();
    this.handleResize();
    requestAnimationFrame(() => this.renderLoop());
  }

  /**
   * Initializes a new puzzle from an uploaded HTMLImageElement and difficulty settings.
   */
  public startNewPuzzle(
    image: HTMLImageElement,
    cols: number,
    rows: number,
    rotationEnabled: boolean
  ): void {
    this.sourceImage = image;
    this.cols = cols;
    this.rows = rows;
    this.rotationEnabled = rotationEnabled;
    this.isCompleted = false;
    this.confetti = [];
    this.activeGroupId = null;

    // Normalize board world dimensions so max board dimension is ~1000 world units
    const aspect = image.naturalWidth / Math.max(1, image.naturalHeight);
    if (aspect >= 1) {
      this.boardWidth = 1000;
      this.boardHeight = Math.round(1000 / aspect);
    } else {
      this.boardHeight = 1000;
      this.boardWidth = Math.round(1000 * aspect);
    }

    this.pieceWidth = this.boardWidth / cols;
    this.pieceHeight = this.boardHeight / rows;
    this.spriteMargin = Math.ceil(Math.max(this.pieceWidth, this.pieceHeight) * 0.36);

    const gridEdges = generateGridEdges(cols, rows);
    this.pieces = [];
    this.maxZIndex = 1;

    // Board is centered at world (0, 0), so top-left of board is (-boardWidth/2, -boardHeight/2)
    const boardLeft = -this.boardWidth / 2;
    const boardTop = -this.boardHeight / 2;

    let idCounter = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const id = idCounter++;
        const edges = gridEdges[r][c];
        const path = buildPiecePath(this.pieceWidth, this.pieceHeight, edges);

        const targetX = boardLeft + (c + 0.5) * this.pieceWidth;
        const targetY = boardTop + (r + 0.5) * this.pieceHeight;

        const rotation: 0 | 1 | 2 | 3 = rotationEnabled
          ? ((Math.floor(Math.random() * 4) as 0 | 1 | 2 | 3))
          : 0;

        const mergedNeighbors = { top: false, right: false, bottom: false, left: false };
        const sprite = this.bakePieceSprite(r, c, edges, path, mergedNeighbors);

        this.pieces.push({
          id,
          row: r,
          col: c,
          groupId: id,
          x: targetX,
          y: targetY,
          targetX,
          targetY,
          rotation,
          lockedToBoard: false,
          zIndex: this.maxZIndex++,
          edges,
          path,
          sprite,
          mergedNeighbors,
          snapFlashUntil: 0,
        });
      }
    }

    this.scatterPiecesAroundBoard();
    this.fitViewToPuzzle();
    this.notifyProgress();
  }

  /**
   * Scatters all unlocked pieces in a neat, non-overlapping perimeter ring around the central target board.
   */
  public scatterPiecesAroundBoard(): void {
    const total = this.pieces.length;
    // Shuffle indices so neighbors don't spawn next to each other
    const indices = this.pieces.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    const pad = Math.max(this.pieceWidth, this.pieceHeight) * 0.95;
    const step = Math.max(this.pieceWidth, this.pieceHeight) * 1.28;

    // Distribute pieces in concentric rectangular rings outside the board frame
    let placed = 0;
    let ringIndex = 0;

    while (placed < total) {
      const rx = this.boardWidth / 2 + pad + ringIndex * step;
      const ry = this.boardHeight / 2 + pad + ringIndex * step;

      const topCount = Math.max(2, Math.floor((rx * 2) / step));
      const sideCount = Math.max(1, Math.floor((ry * 2) / step) - 1);

      const slots: Array<{ x: number; y: number }> = [];

      // Top & Bottom rows of the ring
      for (let i = 0; i <= topCount; i++) {
        const t = i / topCount;
        const x = -rx + t * (rx * 2);
        slots.push({ x, y: -ry });
        slots.push({ x, y: ry });
      }
      // Left & Right columns of the ring (excluding corners already added)
      for (let i = 1; i <= sideCount; i++) {
        const t = i / (sideCount + 1);
        const y = -ry + t * (ry * 2);
        slots.push({ x: -rx, y });
        slots.push({ x: rx, y });
      }

      for (const slot of slots) {
        if (placed >= total) break;
        const piece = this.pieces[indices[placed]];
        const jitterX = (Math.random() - 0.5) * step * 0.22;
        const jitterY = (Math.random() - 0.5) * step * 0.22;
        piece.x = slot.x + jitterX;
        piece.y = slot.y + jitterY;
        placed++;
      }

      ringIndex++;
    }
  }

  /**
   * Pre-renders a single puzzle piece onto an offscreen canvas sprite.
   * Includes high-res source image clipping plus 3D bevel highlights & shadows on unmerged edges.
   */
  private bakePieceSprite(
    row: number,
    col: number,
    edges: PieceEdges,
    path: Path2D,
    mergedSides: { top: boolean; right: boolean; bottom: boolean; left: boolean }
  ): HTMLCanvasElement {
    const sprite = document.createElement('canvas');
    const w = Math.ceil(this.pieceWidth + this.spriteMargin * 2);
    const h = Math.ceil(this.pieceHeight + this.spriteMargin * 2);
    sprite.width = w;
    sprite.height = h;

    const sctx = sprite.getContext('2d')!;
    const cx = w / 2;
    const cy = h / 2;

    sctx.save();
    sctx.translate(cx, cy);

    // 1. Clip to the exact jigsaw piece shape
    sctx.clip(path);

    // 2. Draw the corresponding slice of the source image
    // Expand clip slightly by 0.6px on merged sides to prevent hairline anti-aliasing gaps
    if (this.sourceImage) {
      const boardLeft = -(col + 0.5) * this.pieceWidth;
      const boardTop = -(row + 0.5) * this.pieceHeight;
      sctx.drawImage(
        this.sourceImage,
        0,
        0,
        this.sourceImage.naturalWidth,
        this.sourceImage.naturalHeight,
        boardLeft,
        boardTop,
        this.boardWidth,
        this.boardHeight
      );
    }

    // 3. Draw 3D beveled edge lighting ONLY along unmerged edges
    const unmergedPath = buildUnmergedOutlinePath(
      this.pieceWidth,
      this.pieceHeight,
      edges,
      mergedSides
    );

    const bevelWidth = Math.max(1.5, Math.min(this.pieceWidth, this.pieceHeight) * 0.032);

    // Top-left inner specular highlight
    sctx.save();
    sctx.translate(-bevelWidth * 0.35, -bevelWidth * 0.35);
    sctx.strokeStyle = 'rgba(255, 255, 255, 0.38)';
    sctx.lineWidth = bevelWidth;
    sctx.lineCap = 'round';
    sctx.lineJoin = 'round';
    sctx.stroke(unmergedPath);
    sctx.restore();

    // Bottom-right inner bevel shadow
    sctx.save();
    sctx.translate(bevelWidth * 0.35, bevelWidth * 0.35);
    sctx.strokeStyle = 'rgba(0, 0, 0, 0.42)';
    sctx.lineWidth = bevelWidth;
    sctx.lineCap = 'round';
    sctx.lineJoin = 'round';
    sctx.stroke(unmergedPath);
    sctx.restore();

    // Crisp outer definition stroke on unmerged edges
    sctx.strokeStyle = 'rgba(15, 20, 28, 0.55)';
    sctx.lineWidth = 1.1;
    sctx.stroke(unmergedPath);

    sctx.restore();
    return sprite;
  }

  /**
   * Centers and zooms the camera so the board and all scattered pieces fit comfortably in the viewport.
   */
  public fitViewToPuzzle(): void {
    if (this.pieces.length === 0) return;

    let minX = -this.boardWidth / 2;
    let maxX = this.boardWidth / 2;
    let minY = -this.boardHeight / 2;
    let maxY = this.boardHeight / 2;

    const r = Math.max(this.pieceWidth, this.pieceHeight);
    for (const p of this.pieces) {
      minX = Math.min(minX, p.x - r);
      maxX = Math.max(maxX, p.x + r);
      minY = Math.min(minY, p.y - r);
      maxY = Math.max(maxY, p.y + r);
    }

    const worldW = maxX - minX;
    const worldH = maxY - minY;
    const hudOffsetTop = 68;
    const availW = Math.max(200, this.canvas.clientWidth - 64);
    const availH = Math.max(200, this.canvas.clientHeight - hudOffsetTop - 48);

    this.zoom = Math.min(availW / worldW, availH / worldH, 1.5);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    this.panX = this.canvas.clientWidth / 2 - centerX * this.zoom;
    this.panY = hudOffsetTop + availH / 2 - centerY * this.zoom;
  }

  private screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.panX) / this.zoom,
      y: (sy - this.panY) / this.zoom,
    };
  }

  /**
   * Exact Path2D hit-testing from top-most zIndex to bottom-most.
   * Ignores transparent bounding-box corners so clicks only grab actual piece/tab geometry.
   */
  private findPieceAtWorld(wx: number, wy: number): PuzzlePiece | null {
    // Sort candidates by descending zIndex (unlocked pieces prioritized above locked board pieces)
    const sorted = [...this.pieces].sort((a, b) => {
      if (a.lockedToBoard !== b.lockedToBoard) {
        return a.lockedToBoard ? -1 : 1;
      }
      return b.zIndex - a.zIndex;
    });

    const maxRadius = Math.hypot(
      this.pieceWidth / 2 + this.spriteMargin,
      this.pieceHeight / 2 + this.spriteMargin
    );

    for (const p of sorted) {
      const dx = wx - p.x;
      const dy = wy - p.y;
      if (Math.abs(dx) > maxRadius || Math.abs(dy) > maxRadius) continue;

      // Transform world delta into local unrotated piece coordinates
      const angle = (-p.rotation * Math.PI) / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;

      if (this.hitCtx.isPointInPath(p.path, localX, localY)) {
        return p;
      }
    }

    return null;
  }

  private bringGroupToFront(groupId: number): void {
    this.maxZIndex++;
    for (const p of this.pieces) {
      if (p.groupId === groupId) {
        p.zIndex = this.maxZIndex;
      }
    }
  }

  /**
   * Rotates a piece's entire connected group by 90° clockwise around the reference piece's center.
   */
  public rotateGroup(pivotPiece: PuzzlePiece): void {
    if (!this.rotationEnabled || pivotPiece.lockedToBoard || this.isPaused) return;

    const groupId = pivotPiece.groupId;
    const px = pivotPiece.x;
    const py = pivotPiece.y;

    for (const p of this.pieces) {
      if (p.groupId === groupId) {
        const dx = p.x - px;
        const dy = p.y - py;
        // 90 degrees clockwise in screen/world coords (Y down): (dx, dy) -> (-dy, dx)
        p.x = px - dy;
        p.y = py + dx;
        p.rotation = ((p.rotation + 1) % 4) as 0 | 1 | 2 | 3;
      }
    }

    this.sound.playRotate();

    // If not currently dragging, check if rotation caused it to align and snap
    if (this.activeGroupId === null) {
      this.checkAndSnapGroup(groupId);
    }
  }

  /**
   * Checks whether the specified group is within snapping tolerance of:
   * 1. Its final target position on the board (when rotation === 0)
   * 2. Any adjacent neighbor piece anywhere on the table (when both have identical rotation)
   */
  private checkAndSnapGroup(groupId: number): void {
    const groupPieces = this.pieces.filter((p) => p.groupId === groupId);
    if (groupPieces.length === 0) return;

    const snapTolerance = Math.min(this.pieceWidth, this.pieceHeight) * 0.28;
    let snappedAny = false;
    let lockedBoardNow = false;
    const now = performance.now();

    // 1. Check target board snap (requires upright rotation === 0)
    const sample = groupPieces[0];
    if (sample.rotation === 0) {
      const errX = sample.targetX - sample.x;
      const errY = sample.targetY - sample.y;
      if (Math.hypot(errX, errY) <= snapTolerance) {
        for (const p of groupPieces) {
          p.x += errX;
          p.y += errY;
          p.lockedToBoard = true;
          p.snapFlashUntil = now + 420;
        }
        snappedAny = true;
        lockedBoardNow = true;
      }
    }

    // 2. Check neighbor-to-neighbor snapping across all 4 cardinal directions
    const neighborOffsets = [
      { dr: -1, dc: 0, side: 'top' as const, opp: 'bottom' as const },
      { dr: 0, dc: 1, side: 'right' as const, opp: 'left' as const },
      { dr: 1, dc: 0, side: 'bottom' as const, opp: 'top' as const },
      { dr: 0, dc: -1, side: 'left' as const, opp: 'right' as const },
    ];

    // Keep checking until no more transitive neighbor merges occur
    let mergedInPass = true;
    while (mergedInPass) {
      mergedInPass = false;
      const currentGroup = this.pieces.filter((p) => p.groupId === groupId);

      for (const p of currentGroup) {
        const angle = (p.rotation * Math.PI) / 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        for (const nb of neighborOffsets) {
          const nr = p.row + nb.dr;
          const nc = p.col + nb.dc;
          if (nr < 0 || nr >= this.rows || nc < 0 || nc >= this.cols) continue;

          const neighbor = this.pieces[nr * this.cols + nc];
          if (neighbor.groupId === groupId) continue;
          if (neighbor.rotation !== p.rotation) continue;

          // Expected offset from `p` to `neighbor` in current rotation
          const unrotatedDx = nb.dc * this.pieceWidth;
          const unrotatedDy = nb.dr * this.pieceHeight;
          const expectedDx = unrotatedDx * cos - unrotatedDy * sin;
          const expectedDy = unrotatedDx * sin + unrotatedDy * cos;

          const idealPx = neighbor.x - expectedDx;
          const idealPy = neighbor.y - expectedDy;
          const dist = Math.hypot(idealPx - p.x, idealPy - p.y);

          if (dist <= snapTolerance) {
            const shiftX = idealPx - p.x;
            const shiftY = idealPy - p.y;
            const targetGroupId = neighbor.groupId;
            const targetLocked = neighbor.lockedToBoard || p.lockedToBoard;

            // Shift all pieces in `groupId` to align with `neighbor` and unify groupId
            for (const gp of this.pieces) {
              if (gp.groupId === groupId || gp.groupId === targetGroupId) {
                if (gp.groupId === groupId && !p.lockedToBoard) {
                  gp.x += shiftX;
                  gp.y += shiftY;
                } else if (gp.groupId === targetGroupId && p.lockedToBoard && !neighbor.lockedToBoard) {
                  gp.x -= shiftX;
                  gp.y -= shiftY;
                }
                gp.groupId = groupId;
                gp.lockedToBoard = targetLocked;
                gp.snapFlashUntil = now + 420;
              }
            }

            snappedAny = true;
            if (targetLocked) lockedBoardNow = true;
            mergedInPass = true;
            break;
          }
        }
        if (mergedInPass) break;
      }
    }

    if (snappedAny) {
      this.updateMergedSpritesForGroup(groupId);
      this.sound.playSnap(lockedBoardNow);
      this.notifyProgress();
    }
  }

  /**
   * Re-bakes sprites for any piece in the group that gained a newly merged cardinal neighbor
   * so interior seams disappear seamlessly.
   */
  private updateMergedSpritesForGroup(groupId: number): void {
    for (const p of this.pieces) {
      if (p.groupId !== groupId) continue;

      const topNb = p.row > 0 ? this.pieces[(p.row - 1) * this.cols + p.col] : null;
      const rightNb = p.col < this.cols - 1 ? this.pieces[p.row * this.cols + (p.col + 1)] : null;
      const bottomNb = p.row < this.rows - 1 ? this.pieces[(p.row + 1) * this.cols + p.col] : null;
      const leftNb = p.col > 0 ? this.pieces[p.row * this.cols + (p.col - 1)] : null;

      const nextMerged = {
        top: Boolean(topNb && topNb.groupId === p.groupId),
        right: Boolean(rightNb && rightNb.groupId === p.groupId),
        bottom: Boolean(bottomNb && bottomNb.groupId === p.groupId),
        left: Boolean(leftNb && leftNb.groupId === p.groupId),
      };

      if (
        nextMerged.top !== p.mergedNeighbors.top ||
        nextMerged.right !== p.mergedNeighbors.right ||
        nextMerged.bottom !== p.mergedNeighbors.bottom ||
        nextMerged.left !== p.mergedNeighbors.left
      ) {
        p.mergedNeighbors = nextMerged;
        p.sprite = this.bakePieceSprite(p.row, p.col, p.edges, p.path, nextMerged);
      }
    }
  }

  /**
   * Computes puzzle progress based on connected clusters and board locks,
   * and triggers victory when all pieces are locked in place on the board.
   */
  private notifyProgress(): void {
    const total = this.pieces.length;
    if (total === 0) return;

    // Count how many pieces are either locked to the board or connected to a neighbor
    const uniqueGroups = new Set<number>();
    let lockedCount = 0;
    for (const p of this.pieces) {
      uniqueGroups.add(p.groupId);
      if (p.lockedToBoard) lockedCount++;
    }

    // Connections made = (total - uniqueGroups) + (1 if any group is locked to board)
    const connectedSteps = total - uniqueGroups.size + (lockedCount > 0 ? 1 : 0);
    const percent = Math.min(100, Math.round((connectedSteps / total) * 100));

    this.callbacks.onProgressChange(connectedSteps, total, percent);

    // Check if all pieces are in a single group and upright (if they assembled the whole puzzle off-board, snap it to board or complete!)
    if (!this.isCompleted && uniqueGroups.size === 1 && this.pieces[0].rotation === 0) {
      // Lock all to board if assembled into 1 complete image
      for (const p of this.pieces) {
        p.lockedToBoard = true;
      }
      this.isCompleted = true;
      this.callbacks.onProgressChange(total, total, 100);
      this.sound.playVictory();
      this.spawnConfetti();
      setTimeout(() => {
        this.callbacks.onPuzzleComplete();
      }, 650);
    }
  }

  private spawnConfetti(): void {
    const colors = ['#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#f87171'];
    this.confetti = [];
    for (let i = 0; i < 130; i++) {
      this.confetti.push({
        x: this.canvas.clientWidth * (0.2 + Math.random() * 0.6),
        y: -20 - Math.random() * 140,
        vx: (Math.random() - 0.5) * 7,
        vy: 3 + Math.random() * 5.5,
        size: 6 + Math.random() * 7,
        color: colors[Math.floor(Math.random() * colors.length)],
        angle: Math.random() * Math.PI * 2,
        vAngle: (Math.random() - 0.5) * 0.2,
        life: 1,
      });
    }
  }

  private setupEventListeners(): void {
    window.addEventListener('resize', () => this.handleResize());

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        this.isSpaceDown = true;
      }
      if ((e.key === 'r' || e.key === 'R') && this.rotationEnabled && !this.isPaused) {
        if (this.activeGroupId !== null) {
          const piece = this.pieces.find((p) => p.groupId === this.activeGroupId);
          if (piece) this.rotateGroup(piece);
        } else if (this.hoveredPieceId !== null) {
          const piece = this.pieces.find((p) => p.id === this.hoveredPieceId);
          if (piece) this.rotateGroup(piece);
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.isSpaceDown = false;
      }
    });

    // Prevent right-click context menu on canvas; use right-click to rotate piece!
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.rotationEnabled || this.isPaused) return;
      const rect = this.canvas.getBoundingClientRect();
      const world = this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const hit = this.findPieceAtWorld(world.x, world.y);
      if (hit && !hit.lockedToBoard) {
        this.bringGroupToFront(hit.groupId);
        this.rotateGroup(hit);
      }
    });

    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    window.addEventListener('pointercancel', (e) => this.onPointerUp(e));

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.isPaused) return;
        const rect = this.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const zoomFactor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        this.zoomAtScreenPoint(sx, sy, zoomFactor);
      },
      { passive: false }
    );
  }

  private zoomAtScreenPoint(sx: number, sy: number, factor: number): void {
    const prevZoom = this.zoom;
    const nextZoom = Math.min(3.5, Math.max(0.18, prevZoom * factor));
    const worldX = (sx - this.panX) / prevZoom;
    const worldY = (sy - this.panY) / prevZoom;

    this.zoom = nextZoom;
    this.panX = sx - worldX * nextZoom;
    this.panY = sy - worldY * nextZoom;
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.isPaused) return;
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    this.activePointers.set(e.pointerId, { x: sx, y: sy });

    // Multi-touch pinch-to-zoom check
    if (this.activePointers.size === 2) {
      this.activeGroupId = null;
      this.isPanning = true;
      const pts = Array.from(this.activePointers.values());
      this.lastPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      this.lastPointerScreenX = (pts[0].x + pts[1].x) / 2;
      this.lastPointerScreenY = (pts[0].y + pts[1].y) / 2;
      return;
    }

    if (e.button === 2) return; // Right click handled by contextmenu

    this.lastPointerScreenX = sx;
    this.lastPointerScreenY = sy;
    this.pointerMovedDistance = 0;

    const world = this.screenToWorld(sx, sy);
    this.lastPointerWorldX = world.x;
    this.lastPointerWorldY = world.y;

    // Middle-click or Spacebar held => Pan camera
    if (e.button === 1 || this.isSpaceDown) {
      this.isPanning = true;
      this.canvas.classList.add('panning');
      return;
    }

    const hit = this.findPieceAtWorld(world.x, world.y);
    if (hit && !hit.lockedToBoard) {
      this.activeGroupId = hit.groupId;
      this.bringGroupToFront(hit.groupId);
      this.sound.playPickup();
      this.canvas.classList.add('dragging-piece');
    } else {
      this.isPanning = true;
      this.canvas.classList.add('panning');
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (this.activePointers.has(e.pointerId)) {
      this.activePointers.set(e.pointerId, { x: sx, y: sy });
    }

    // Handle 2-finger pinch zoom + pan
    if (this.activePointers.size === 2) {
      const pts = Array.from(this.activePointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;

      this.panX += midX - this.lastPointerScreenX;
      this.panY += midY - this.lastPointerScreenY;

      if (this.lastPinchDist > 10 && dist > 10) {
        this.zoomAtScreenPoint(midX, midY, dist / this.lastPinchDist);
      }

      this.lastPinchDist = dist;
      this.lastPointerScreenX = midX;
      this.lastPointerScreenY = midY;
      return;
    }

    const world = this.screenToWorld(sx, sy);

    if (this.activeGroupId !== null) {
      const dx = world.x - this.lastPointerWorldX;
      const dy = world.y - this.lastPointerWorldY;
      this.pointerMovedDistance += Math.hypot(sx - this.lastPointerScreenX, sy - this.lastPointerScreenY);

      for (const p of this.pieces) {
        if (p.groupId === this.activeGroupId) {
          p.x += dx;
          p.y += dy;
        }
      }

      this.lastPointerWorldX = world.x;
      this.lastPointerWorldY = world.y;
      this.lastPointerScreenX = sx;
      this.lastPointerScreenY = sy;
      return;
    }

    if (this.isPanning) {
      this.panX += sx - this.lastPointerScreenX;
      this.panY += sy - this.lastPointerScreenY;
      this.lastPointerScreenX = sx;
      this.lastPointerScreenY = sy;
      return;
    }

    // Update hover state for cursor and R-key rotation
    const hit = this.findPieceAtWorld(world.x, world.y);
    this.hoveredPieceId = hit && !hit.lockedToBoard ? hit.id : null;
  }

  private onPointerUp(e: PointerEvent): void {
    this.activePointers.delete(e.pointerId);

    if (this.activeGroupId !== null) {
      const groupId = this.activeGroupId;
      this.activeGroupId = null;
      this.canvas.classList.remove('dragging-piece');

      // Check for snap on drop
      this.checkAndSnapGroup(groupId);
    }

    if (this.activePointers.size === 0) {
      this.isPanning = false;
      this.canvas.classList.remove('panning');
    }
  }

  public handleResize(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
  }

  private renderLoop(): void {
    this.render();
    requestAnimationFrame(() => this.renderLoop());
  }

  private render(): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.width / dpr;
    const height = this.canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. Tabletop background with subtle radial vignette
    const grad = ctx.createRadialGradient(
      width / 2,
      height / 2,
      Math.min(width, height) * 0.1,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.75
    );
    grad.addColorStop(0, '#161f2c');
    grad.addColorStop(1, '#0c1118');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    if (this.pieces.length > 0) {
      ctx.save();
      ctx.translate(this.panX, this.panY);
      ctx.scale(this.zoom, this.zoom);

      // 2. Draw Recessed Target Board Frame
      this.drawTargetBoard(ctx);

      // 3. Draw Puzzle Pieces in Z-Order:
      //    a) Board-locked pieces first
      //    b) Loose pieces sorted by zIndex
      //    c) Currently dragged group on top with elevated drop shadow & slight lift
      const lockedPieces: PuzzlePiece[] = [];
      const loosePieces: PuzzlePiece[] = [];
      const draggedPieces: PuzzlePiece[] = [];

      for (const p of this.pieces) {
        if (this.activeGroupId !== null && p.groupId === this.activeGroupId) {
          draggedPieces.push(p);
        } else if (p.lockedToBoard) {
          lockedPieces.push(p);
        } else {
          loosePieces.push(p);
        }
      }

      loosePieces.sort((a, b) => a.zIndex - b.zIndex);

      const now = performance.now();

      for (const p of lockedPieces) {
        this.drawPiece(ctx, p, false, now);
      }

      // Draw subtle drop shadow for loose pieces
      for (const p of loosePieces) {
        this.drawPiece(ctx, p, false, now);
      }

      // Draw elevated dragged group on very top
      if (draggedPieces.length > 0) {
        for (const p of draggedPieces) {
          this.drawPiece(ctx, p, true, now);
        }
      }

      ctx.restore();
    }

    // 4. Confetti celebration particles in screen space
    if (this.confetti.length > 0) {
      this.updateAndDrawConfetti(ctx, height);
    }

    ctx.restore();
  }

  private drawTargetBoard(ctx: CanvasRenderingContext2D): void {
    const bx = -this.boardWidth / 2;
    const by = -this.boardHeight / 2;

    // Recessed board mat
    ctx.save();
    ctx.fillStyle = 'rgba(9, 13, 19, 0.72)';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.24)';
    ctx.lineWidth = 2 / this.zoom;

    ctx.beginPath();
    ctx.roundRect(bx - 6, by - 6, this.boardWidth + 12, this.boardHeight + 12, 8);
    ctx.fill();
    ctx.stroke();

    // Inner target boundary line
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.22)';
    ctx.lineWidth = 1.2 / this.zoom;
    ctx.strokeRect(bx, by, this.boardWidth, this.boardHeight);

    // Optional Ghost Image Overlay
    if (this.showGhost && this.sourceImage) {
      ctx.globalAlpha = this.ghostOpacity;
      ctx.drawImage(this.sourceImage, bx, by, this.boardWidth, this.boardHeight);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  private drawPiece(
    ctx: CanvasRenderingContext2D,
    p: PuzzlePiece,
    isDragged: boolean,
    now: number
  ): void {
    ctx.save();
    ctx.translate(p.x, p.y);
    if (p.rotation !== 0) {
      ctx.rotate((p.rotation * Math.PI) / 2);
    }

    if (isDragged) {
      ctx.scale(1.025, 1.025);
      ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
      ctx.shadowBlur = 18;
      ctx.shadowOffsetX = 4;
      ctx.shadowOffsetY = 8;
    } else if (!p.lockedToBoard) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetX = 1.5;
      ctx.shadowOffsetY = 2.5;
    }

    const sw = p.sprite.width;
    const sh = p.sprite.height;
    ctx.drawImage(p.sprite, -sw / 2, -sh / 2);

    // Snap pulse/flash animation when pieces connect
    if (p.snapFlashUntil > now) {
      const progress = (p.snapFlashUntil - now) / 420;
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = `rgba(56, 189, 248, ${progress * 0.9})`;
      ctx.lineWidth = 3.5;
      ctx.stroke(p.path);
    }

    ctx.restore();
  }

  private updateAndDrawConfetti(ctx: CanvasRenderingContext2D, screenHeight: number): void {
    for (let i = this.confetti.length - 1; i >= 0; i--) {
      const c = this.confetti[i];
      c.x += c.vx;
      c.y += c.vy;
      c.vy += 0.11; // gravity
      c.angle += c.vAngle;

      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.angle);
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.size / 2, -c.size / 2, c.size, c.size * 0.6);
      ctx.restore();

      if (c.y > screenHeight + 40) {
        this.confetti.splice(i, 1);
      }
    }
  }
}

