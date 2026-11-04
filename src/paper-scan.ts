import jsQR, { type QRCode } from 'jsqr';
import type { Area, Dataset } from '../shared/types';
import { PAPER_MARKERS, PAPER_MARKER_SIZE, PAPER_QR, paperChoiceBoxes, parsePaperQr, validatePaperDefinition, type PaperBallotDefinition, type PaperPoint } from '../shared/paper-layout';

export interface PaperScanResult {
  code: string | null; pollId: string | null;
  choices: Partial<Record<Area, string | null | '__invalid__'>>;
  needsReview: boolean; reasons: string[];
}
export interface PaperPixels { data: Uint8ClampedArray; width: number; height: number }
export type PaperTransform = readonly number[];

/** Four correspondence pairs determine a planar transform, including rotation. */
export function paperHomography(from: readonly PaperPoint[], to: readonly PaperPoint[]): PaperTransform {
  if (from.length !== 4 || to.length !== 4) throw new Error('Se necesitan cuatro marcas de registro.');
  const matrix: number[][] = [];
  for (let index = 0; index < 4; index++) {
    const { x, y } = from[index]; const u = to[index].x; const v = to[index].y;
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let column = 0; column < 8; column++) {
    let pivot = column;
    for (let row = column + 1; row < 8; row++) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    if (Math.abs(matrix[pivot][column]) < 1e-9) throw new Error('Las marcas de la foto no forman una ficha reconocible.');
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column]; for (let j = column; j <= 8; j++) matrix[column][j] /= divisor;
    for (let row = 0; row < 8; row++) if (row !== column) {
      const factor = matrix[row][column]; for (let j = column; j <= 8; j++) matrix[row][j] -= factor * matrix[column][j];
    }
  }
  return [...matrix.map(row => row[8]), 1];
}

export function projectPaperPoint(transform: PaperTransform, point: PaperPoint): PaperPoint {
  const denominator = transform[6] * point.x + transform[7] * point.y + 1;
  return { x: (transform[0] * point.x + transform[1] * point.y + transform[2]) / denominator,
    y: (transform[3] * point.x + transform[4] * point.y + transform[5]) / denominator };
}

function grayPixels(image: PaperPixels) {
  const gray = new Uint8Array(image.width * image.height);
  for (let index = 0; index < gray.length; index++) {
    const offset = index * 4; const alpha = image.data[offset + 3] / 255;
    gray[index] = Math.round((.2126 * image.data[offset] + .7152 * image.data[offset + 1] + .0722 * image.data[offset + 2]) * alpha + 255 * (1 - alpha));
  }
  return gray;
}

function median(values: number[]) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? 255; }
function distance(a: PaperPoint, b: PaperPoint) { return Math.hypot(a.x - b.x, a.y - b.y); }
function polygonArea(points: PaperPoint[]) { return Math.abs(points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y; }, 0)) / 2; }

interface Component extends PaperPoint { area: number; width: number; height: number; fill: number }
function markerCandidates(gray: Uint8Array, width: number, height: number): Component[] {
  const background: number[] = [];
  for (let index = 0; index < gray.length; index += Math.max(1, Math.floor(gray.length / 3000))) background.push(gray[index]);
  background.sort((a, b) => a - b);
  const white = background[Math.floor(background.length * .8)] ?? 255;
  const threshold = Math.max(35, Math.min(170, white * .58));
  const visited = new Uint8Array(gray.length); const queue = new Int32Array(gray.length); const result: Component[] = [];
  const maximum = Math.max(width, height) * .13;
  for (let origin = 0; origin < gray.length; origin++) {
    if (visited[origin] || gray[origin] > threshold) continue;
    let head = 0, tail = 1; queue[0] = origin; visited[origin] = 1;
    let minX = width, maxX = 0, minY = height, maxY = 0, sumX = 0, sumY = 0;
    while (head < tail) {
      const pixel = queue[head++]; const x = pixel % width; const y = Math.floor(pixel / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); sumX += x; sumY += y;
      const neighbors = [x ? pixel - 1 : -1, x < width - 1 ? pixel + 1 : -1, y ? pixel - width : -1, y < height - 1 ? pixel + width : -1];
      for (const neighbor of neighbors) if (neighbor >= 0 && !visited[neighbor] && gray[neighbor] <= threshold) { visited[neighbor] = 1; queue[tail++] = neighbor; }
    }
    const w = maxX - minX + 1; const h = maxY - minY + 1; const fill = tail / (w * h);
    let centralDark = 0;
    for (let row = 0; row < 5; row++) for (let column = 0; column < 5; column++) {
      const x = Math.min(maxX, Math.round(minX + w * (.3 + column * .1)));
      const y = Math.min(maxY, Math.round(minY + h * (.3 + row * .1)));
      if (gray[y * width + x] <= threshold) centralDark++;
    }
    if (tail >= 18 && w >= 4 && h >= 4 && w <= maximum && h <= maximum && w / h > .28 && w / h < 3.5 && fill >= .39 && centralDark >= 23) {
      result.push({ x: sumX / tail, y: sumY / tail, area: tail, width: w, height: h, fill });
    }
  }
  return result;
}

function qrLogicalCorners(qr: QRCode): PaperPoint[] {
  const modules = 21 + 4 * (qr.version - 1); const unit = PAPER_QR.size / (modules + PAPER_QR.quietModules * 2);
  const startX = PAPER_QR.x + PAPER_QR.quietModules * unit; const startY = PAPER_QR.y + PAPER_QR.quietModules * unit;
  return [{ x: startX, y: startY }, { x: startX + modules * unit, y: startY }, { x: startX + modules * unit, y: startY + modules * unit }, { x: startX, y: startY + modules * unit }];
}

function alignPaper(qr: QRCode, image: PaperPixels, gray: Uint8Array): PaperTransform | null {
  const logicalQr = qrLogicalCorners(qr);
  const actualQr = [qr.location.topLeftCorner, qr.location.topRightCorner, qr.location.bottomRightCorner, qr.location.bottomLeftCorner];
  const approximate = paperHomography(logicalQr, actualQr);
  const candidates = markerCandidates(gray, image.width, image.height);
  // A small QR alone cannot safely extrapolate the far corners of a tilted page.
  // Search plausible solid marks, then choose the four-marker transform that also
  // matches the independently decoded QR. Never use the QR estimate to read votes.
  const radius = Math.max(18, Math.hypot(image.width, image.height) * .25);
  const groups: Component[][] = [];
  for (const marker of PAPER_MARKERS) {
    const predicted = projectPaperPoint(approximate, marker);
    if (!Number.isFinite(predicted.x) || !Number.isFinite(predicted.y)) return null;
    const half = PAPER_MARKER_SIZE / 2;
    const corners = [{ x: marker.x - half, y: marker.y - half }, { x: marker.x + half, y: marker.y - half },
      { x: marker.x + half, y: marker.y + half }, { x: marker.x - half, y: marker.y + half }].map(point => projectPaperPoint(approximate, point));
    const expectedArea = polygonArea(corners);
    const choices = candidates.filter(item => distance(item, predicted) <= radius && item.area / expectedArea > .25 && item.area / expectedArea < 4)
      .sort((a, b) => (distance(a, predicted) / radius + Math.abs(Math.log(a.area / expectedArea)) * .16) - (distance(b, predicted) / radius + Math.abs(Math.log(b.area / expectedArea)) * .16)).slice(0, 8);
    if (!choices.length) return null;
    groups.push(choices);
  }
  let best: { transform: PaperTransform; error: number } | null = null;
  function search(selected: Component[]) {
    if (selected.length < 4) { for (const candidate of groups[selected.length]) if (!selected.includes(candidate)) search([...selected, candidate]); return; }
    const areaRatio = polygonArea(selected) / polygonArea(actualQr);
    if (areaRatio < 10 || areaRatio > 140) return;
    let transform: PaperTransform;
    try { transform = paperHomography(PAPER_MARKERS, selected); } catch { return; }
    const error = Math.sqrt(logicalQr.reduce((sum, point, index) => sum + distance(projectPaperPoint(transform, point), actualQr[index]) ** 2, 0) / 4);
    if (!best || error < best.error) best = { transform, error };
  }
  search([]);
  const found = best as { transform: PaperTransform; error: number } | null;
  return found && found.error <= Math.max(6, Math.hypot(image.width, image.height) * .008) ? found.transform : null;
}

function sample(gray: Uint8Array, image: PaperPixels, transform: PaperTransform, point: PaperPoint) {
  const projected = projectPaperPoint(transform, point); const x = Math.round(projected.x); const y = Math.round(projected.y);
  return x >= 0 && y >= 0 && x < image.width && y < image.height ? gray[y * image.width + x] : NaN;
}

/** Pure image analysis, shared by browser capture and synthetic perspective/rotation regressions. */
export function analyzePaperPixels(image: PaperPixels, poll: PaperBallotDefinition, dataset: Dataset): PaperScanResult {
  validatePaperDefinition(poll);
  const result: PaperScanResult = { code: null, pollId: null, choices: {}, needsReview: true, reasons: [] };
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 180 || image.height < 180
    || image.width > 2500 || image.height > 2500 || image.data.length !== image.width * image.height * 4) {
    result.reasons.push('La imagen debe mostrar una ficha completa y tener resolución suficiente.'); return result;
  }
  const qr = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
  const identity = qr ? parsePaperQr(qr.data) : null;
  if (!qr || !identity) { result.reasons.push('No se reconoce el QR de una ficha de esta aplicación. Vuelva a fotografiarla completa.'); return result; }
  result.pollId = identity.pollId;
  if (identity.dataset !== dataset || identity.pollId !== poll.id) { result.reasons.push('Esta ficha pertenece a otra votación o a otro modo de jornada.'); return result; }
  result.code = identity.code;
  const gray = grayPixels(image);
  let transform: PaperTransform | null = null;
  try { transform = alignPaper(qr, image, gray); } catch { /* A damaged or cropped sheet is a review, never a count. */ }
  if (!transform) { result.reasons.push('No se reconocen las cuatro marcas de registro. Incluya toda la ficha sin recortar sus esquinas.'); return result; }
  result.needsReview = false;
  const boxes = paperChoiceBoxes(poll);
  for (const area of poll.areas) {
    const strong: (string | null)[] = []; let doubtful = false;
    for (const box of boxes.filter(item => item.area === area)) {
      const surrounding = [{ x: box.x - 4, y: box.y + box.size / 2 }, { x: box.x + box.size + 4, y: box.y + box.size / 2 },
        { x: box.x + box.size / 2, y: box.y - 4 }, { x: box.x + box.size / 2, y: box.y + box.size + 4 }].map(point => sample(gray, image, transform!, point));
      const background = median(surrounding.filter(Number.isFinite)); let dark = 0, weak = 0, total = 0;
      for (let row = 0; row < 15; row++) for (let column = 0; column < 15; column++) {
        const value = sample(gray, image, transform, { x: box.x + 2.5 + (column + .5) * (box.size - 5) / 15, y: box.y + 2.5 + (row + .5) * (box.size - 5) / 15 });
        if (!Number.isFinite(value)) { doubtful = true; continue; }
        total++; if (value < background - Math.max(28, background * .2)) dark++;
        if (value < background - Math.max(15, background * .09)) weak++;
      }
      const density = dark / Math.max(total, 1); const faint = weak / Math.max(total, 1);
      if (background < 85 || total < 220) doubtful = true;
      if (density >= .085) strong.push(box.optionId);
      else if (density > .022 || faint > .05) doubtful = true;
    }
    result.choices[area] = strong.length > 1 ? '__invalid__' : strong.length === 1 ? strong[0] : null;
    if (doubtful || strong.length > 1) {
      result.needsReview = true;
      result.reasons.push(`${area === 'MAT' ? 'Matemática' : 'Comunicación'}: ${strong.length > 1 ? 'hay más de una casilla marcada; revise el voto nulo.' : 'hay una marca tenue, sombra o borrado; confirme la lectura.'}`);
    }
  }
  return result;
}

/** Read locally; neither the photograph nor its pixel data leaves this browser. */
export async function scanPaperBallot(file: File, poll: PaperBallotDefinition, dataset: Dataset): Promise<PaperScanResult> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Use una fotografía JPG, PNG o WebP.');
  if (file.size > 12 * 1024 * 1024) throw new Error('La fotografía supera 12 MB. Reduzca su tamaño o vuelva a tomarla.');
  if (!file.size) throw new Error('La fotografía está vacía.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('No se puede abrir esta fotografía. Pruebe con otro archivo JPG o PNG.'); }
  try {
    const ratio = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * ratio); canvas.height = Math.round(bitmap.height * ratio);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Este navegador no permite leer la imagen.');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return analyzePaperPixels(context.getImageData(0, 0, canvas.width, canvas.height), poll, dataset);
  } finally { bitmap.close(); }
}
