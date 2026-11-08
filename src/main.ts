import { computeOptimalGrid } from './geometry';
import { PuzzleEngine } from './engine';
import { SoundEngine } from './audio';

// DOM Elements
const hud = document.getElementById('hud')!;
const canvas = document.getElementById('puzzle-canvas') as HTMLCanvasElement;
const setupModal = document.getElementById('setup-modal')!;
const victoryModal = document.getElementById('victory-modal')!;
const pauseOverlay = document.getElementById('pause-overlay')!;
const controlsHint = document.getElementById('controls-hint')!;
const rotationHintItem = document.getElementById('rotation-hint-item')!;

// Setup Modal Elements
const btnCloseSetup = document.getElementById('btn-close-setup')!;
const dropzone = document.getElementById('dropzone')!;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const dropzoneEmpty = document.getElementById('dropzone-empty')!;
const dropzonePreview = document.getElementById('dropzone-preview')!;
const setupPreviewImg = document.getElementById('setup-preview-img') as HTMLImageElement;
const setupGridOverlay = document.getElementById('setup-grid-overlay') as HTMLCanvasElement;
const imageDimensionsBadge = document.getElementById('image-dimensions-badge')!;
const btnChangeImage = document.getElementById('btn-change-image')!;
const gridSummaryBadge = document.getElementById('grid-summary-badge')!;
const tierButtons = document.querySelectorAll<HTMLButtonElement>('.tier-btn');
const pieceCountSlider = document.getElementById('piece-count-slider') as HTMLInputElement;
const rotationToggle = document.getElementById('rotation-toggle') as HTMLInputElement;
const btnStartPuzzle = document.getElementById('btn-start-puzzle') as HTMLButtonElement;

// HUD Elements
const btnNewPuzzle = document.getElementById('btn-new-puzzle')!;
const progressFill = document.getElementById('progress-fill')!;
const progressText = document.getElementById('progress-text')!;
const timerPill = document.getElementById('timer-pill')!;
const timerDisplay = document.getElementById('timer-display')!;
const btnPauseTimer = document.getElementById('btn-pause-timer')!;
const iconPause = document.getElementById('icon-pause')!;
const iconPlay = document.getElementById('icon-play')!;
const btnHideTimer = document.getElementById('btn-hide-timer')!;
const btnResumeOverlay = document.getElementById('btn-resume-overlay')!;

const btnGhostToggle = document.getElementById('btn-ghost-toggle')!;
const ghostOpacitySlider = document.getElementById('ghost-opacity-slider') as HTMLInputElement;
const btnPreviewToggle = document.getElementById('btn-preview-toggle')!;
const btnFitView = document.getElementById('btn-fit-view')!;
const btnSoundToggle = document.getElementById('btn-sound-toggle')!;
const iconSoundOn = document.getElementById('icon-sound-on')!;
const iconSoundOff = document.getElementById('icon-sound-off')!;

// Floating Reference Preview Window
const referenceWindow = document.getElementById('reference-window')!;
const referenceHeader = document.getElementById('reference-header')!;
const referenceImg = document.getElementById('reference-img') as HTMLImageElement;
const btnRefSize = document.getElementById('btn-ref-size')!;
const btnRefClose = document.getElementById('btn-ref-close')!;

// Victory Modal Elements
const victoryPieces = document.getElementById('victory-pieces')!;
const victoryTime = document.getElementById('victory-time')!;
const victoryRotation = document.getElementById('victory-rotation')!;
const btnVictoryAdmire = document.getElementById('btn-victory-admire')!;
const btnVictoryReplay = document.getElementById('btn-victory-replay')!;
const btnVictoryNew = document.getElementById('btn-victory-new')!;

// State
let loadedImage: HTMLImageElement | null = null;
let targetPieceCount = 60;
let computedCols = 10;
let computedRows = 6;
let hasActiveGame = false;

// Timer State
let elapsedSeconds = 0;
let timerInterval: number | null = null;
let isTimerPaused = false;

const sound = new SoundEngine();

const engine = new PuzzleEngine(canvas, sound, {
  onProgressChange: (connected, total, percent) => {
    progressFill.style.width = `${percent}%`;
    progressText.textContent = `${percent}% (${connected}/${total})`;
  },
  onPuzzleComplete: () => {
    stopTimer();
    victoryPieces.textContent = `${computedCols * computedRows}`;
    victoryTime.textContent = formatTime(elapsedSeconds);
    victoryRotation.textContent = rotationToggle.checked ? '90° On' : 'Off';
    victoryModal.classList.remove('hidden');
  },
});

function formatTime(sec: number): string {
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function startTimer(): void {
  stopTimer();
  elapsedSeconds = 0;
  isTimerPaused = false;
  engine.isPaused = false;
  timerDisplay.textContent = '00:00';
  pauseOverlay.classList.add('hidden');
  iconPause.classList.remove('hidden');
  iconPlay.classList.add('hidden');

  timerInterval = window.setInterval(() => {
    if (!isTimerPaused) {
      elapsedSeconds++;
      timerDisplay.textContent = formatTime(elapsedSeconds);
    }
  }, 1000);
}

function stopTimer(): void {
  if (timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function togglePauseGame(): void {
  if (!hasActiveGame) return;
  isTimerPaused = !isTimerPaused;
  engine.isPaused = isTimerPaused;

  if (isTimerPaused) {
    pauseOverlay.classList.remove('hidden');
    iconPause.classList.add('hidden');
    iconPlay.classList.remove('hidden');
  } else {
    pauseOverlay.classList.add('hidden');
    iconPause.classList.remove('hidden');
    iconPlay.classList.add('hidden');
  }
}

/**
 * Updates the calculated (cols × rows) grid preview whenever the image or difficulty slider changes.
 */
function updateGridCalculation(): void {
  const imgW = loadedImage ? loadedImage.naturalWidth : 1600;
  const imgH = loadedImage ? loadedImage.naturalHeight : 1000;

  const grid = computeOptimalGrid(imgW, imgH, targetPieceCount);
  computedCols = grid.cols;
  computedRows = grid.rows;

  gridSummaryBadge.textContent = `${grid.total} Pieces (${grid.cols} × ${grid.rows})`;

  // Highlight matching preset tier button if close
  tierButtons.forEach((btn) => {
    const tierVal = Number(btn.dataset.pieces);
    btn.classList.toggle('active', Math.abs(tierVal - targetPieceCount) <= 4);
  });

  if (loadedImage) {
    btnStartPuzzle.disabled = false;
    btnStartPuzzle.innerHTML = `<span>Start ${grid.total}-Piece Puzzle</span>`;
    drawSetupGridPreview();
  }
}

/**
 * Draws a subtle grid overlay on the setup modal's image preview so the user can see the piece density.
 */
function drawSetupGridPreview(): void {
  if (!loadedImage) return;
  const rect = setupPreviewImg.getBoundingClientRect();
  const w = rect.width || setupPreviewImg.clientWidth || 300;
  const h = rect.height || setupPreviewImg.clientHeight || 200;

  setupGridOverlay.width = w;
  setupGridOverlay.height = h;
  const gctx = setupGridOverlay.getContext('2d')!;
  gctx.clearRect(0, 0, w, h);

  gctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  gctx.lineWidth = 1;

  for (let c = 1; c < computedCols; c++) {
    const x = (c / computedCols) * w;
    gctx.beginPath();
    gctx.moveTo(x, 0);
    gctx.lineTo(x, h);
    gctx.stroke();
  }

  for (let r = 1; r < computedRows; r++) {
    const y = (r / computedRows) * h;
    gctx.beginPath();
    gctx.moveTo(0, y);
    gctx.lineTo(w, y);
    gctx.stroke();
  }
}

/**
 * Loads an image File/Blob from drag-and-drop, file picker, or clipboard paste.
 */
function handleImageFile(file: File): void {
  if (!file.type.startsWith('image/')) return;

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    loadedImage = img;
    setupPreviewImg.src = url;
    referenceImg.src = url;
    imageDimensionsBadge.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;

    dropzoneEmpty.classList.add('hidden');
    dropzonePreview.classList.remove('hidden');

    // Wait a frame for preview img layout before drawing overlay lines
    requestAnimationFrame(() => {
      updateGridCalculation();
    });
  };
  img.src = url;
}

// Setup Modal Event Listeners
dropzone.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('#btn-change-image')) {
    fileInput.click();
    return;
  }
  if (!loadedImage) {
    fileInput.click();
  }
});

btnChangeImage.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files[0]) {
    handleImageFile(fileInput.files[0]);
  }
});

// Drag & Drop support on both modal dropzone and entire window
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) {
    dropzone.classList.remove('dragover');
  }
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
    const file = e.dataTransfer.files[0];
    if (file.type.startsWith('image/')) {
      setupModal.classList.remove('hidden');
      handleImageFile(file);
    }
  }
});

// Clipboard Paste (Ctrl+V) support
window.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith('image/')) {
      const file = items[i].getAsFile();
      if (file) {
        setupModal.classList.remove('hidden');
        handleImageFile(file);
        break;
      }
    }
  }
});

// Difficulty Presets & Slider
tierButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    targetPieceCount = Number(btn.dataset.pieces);
    pieceCountSlider.value = String(targetPieceCount);
    updateGridCalculation();
  });
});

pieceCountSlider.addEventListener('input', () => {
  targetPieceCount = Number(pieceCountSlider.value);
  updateGridCalculation();
});

function launchPuzzle(): void {
  if (!loadedImage) return;

  hasActiveGame = true;
  setupModal.classList.add('hidden');
  victoryModal.classList.add('hidden');
  btnCloseSetup.classList.remove('hidden');

  hud.classList.remove('hidden');
  controlsHint.classList.remove('hidden');
  rotationHintItem.classList.toggle('hidden', !rotationToggle.checked);

  if (btnPreviewToggle.classList.contains('active')) {
    referenceWindow.classList.remove('hidden');
  }

  engine.startNewPuzzle(
    loadedImage,
    computedCols,
    computedRows,
    rotationToggle.checked
  );
  startTimer();
}

btnStartPuzzle.addEventListener('click', launchPuzzle);

btnCloseSetup.addEventListener('click', () => {
  if (hasActiveGame) {
    setupModal.classList.add('hidden');
  }
});

// HUD Controls
btnNewPuzzle.addEventListener('click', () => {
  setupModal.classList.remove('hidden');
  requestAnimationFrame(() => updateGridCalculation());
});

btnPauseTimer.addEventListener('click', togglePauseGame);
btnResumeOverlay.addEventListener('click', togglePauseGame);

btnHideTimer.addEventListener('click', () => {
  timerPill.classList.toggle('timer-hidden');
});

btnGhostToggle.addEventListener('click', () => {
  engine.showGhost = !engine.showGhost;
  btnGhostToggle.classList.toggle('active', engine.showGhost);
  ghostOpacitySlider.classList.toggle('hidden', !engine.showGhost);
});

ghostOpacitySlider.addEventListener('input', () => {
  engine.ghostOpacity = Number(ghostOpacitySlider.value) / 100;
});

btnPreviewToggle.addEventListener('click', () => {
  const isHidden = referenceWindow.classList.toggle('hidden');
  btnPreviewToggle.classList.toggle('active', !isHidden);
});

btnFitView.addEventListener('click', () => {
  engine.fitViewToPuzzle();
});

btnSoundToggle.addEventListener('click', () => {
  sound.enabled = !sound.enabled;
  btnSoundToggle.classList.toggle('active', sound.enabled);
  iconSoundOn.classList.toggle('hidden', !sound.enabled);
  iconSoundOff.classList.toggle('hidden', sound.enabled);
});

// Keyboard shortcuts for HUD tools
window.addEventListener('keydown', (e) => {
  if (!hasActiveGame || !setupModal.classList.contains('hidden')) return;
  if (e.key === 'g' || e.key === 'G') {
    btnGhostToggle.click();
  } else if (e.key === 'p' || e.key === 'P') {
    btnPreviewToggle.click();
  } else if (e.key === 'f' || e.key === 'F') {
    engine.fitViewToPuzzle();
  } else if (e.key === 'm' || e.key === 'M') {
    btnSoundToggle.click();
  }
});

// Floating Reference Window Dragging & Sizing
btnRefSize.addEventListener('click', () => {
  referenceWindow.classList.toggle('large');
});

btnRefClose.addEventListener('click', () => {
  referenceWindow.classList.add('hidden');
  btnPreviewToggle.classList.remove('active');
});

let isDraggingRef = false;
let refDragOffsetX = 0;
let refDragOffsetY = 0;

referenceHeader.addEventListener('pointerdown', (e) => {
  if ((e.target as HTMLElement).closest('button')) return;
  isDraggingRef = true;
  const rect = referenceWindow.getBoundingClientRect();
  refDragOffsetX = e.clientX - rect.left;
  refDragOffsetY = e.clientY - rect.top;
  referenceHeader.setPointerCapture(e.pointerId);
});

referenceHeader.addEventListener('pointermove', (e) => {
  if (!isDraggingRef) return;
  const x = Math.max(8, Math.min(window.innerWidth - referenceWindow.offsetWidth - 8, e.clientX - refDragOffsetX));
  const y = Math.max(68, Math.min(window.innerHeight - referenceWindow.offsetHeight - 8, e.clientY - refDragOffsetY));
  referenceWindow.style.left = `${x}px`;
  referenceWindow.style.top = `${y}px`;
  referenceWindow.style.right = 'auto';
});

referenceHeader.addEventListener('pointerup', () => {
  isDraggingRef = false;
});

// Victory Modal Actions
btnVictoryAdmire.addEventListener('click', () => {
  victoryModal.classList.add('hidden');
  engine.fitViewToPuzzle();
});

btnVictoryReplay.addEventListener('click', () => {
  launchPuzzle();
});

btnVictoryNew.addEventListener('click', () => {
  victoryModal.classList.add('hidden');
  setupModal.classList.remove('hidden');
});

// Initialize default grid summary
updateGridCalculation();

