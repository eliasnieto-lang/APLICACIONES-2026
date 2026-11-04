import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { PAPER_A5, PAPER_MARKERS, PAPER_MARKER_SIZE, PAPER_QR, paperChoiceBoxes, paperQrPayload, type PaperBallotDefinition, type PaperPoint } from '../shared/paper-layout';
import { analyzePaperPixels, paperHomography, projectPaperPoint, type PaperPixels } from '../src/paper-scan';

export const paperFixture: PaperBallotDefinition = {
  id: '9820f22c-3181-4a4d-8196-84e87dafdbca', block: 'P1', areas: ['MAT', 'COM'],
  options: { MAT: [{ id: 'math-a', name: 'Editorial Matemática A' }, { id: 'math-b', name: 'Editorial Matemática B' }, { id: 'math-c', name: 'Editorial Matemática C' }],
    COM: [{ id: 'com-a', name: 'Editorial Comunicación A' }, { id: 'com-b', name: 'Editorial Comunicación B' }] },
};
export const paperCode = 'a6b241acb603b53c7c3709d14f5ab141d69fe8e45b630919b90ebabc0aa874f4';
interface SyntheticOptions {
  corners?: PaperPoint[]; width?: number; height?: number; omitQr?: boolean; omitMarker?: number;
  marks?: { optionId: string | null; area: string; kind?: 'x' | 'fill'; gray?: number }[];
}
const logical = [{ x: 0, y: 0 }, { x: PAPER_A5.width, y: 0 }, { x: PAPER_A5.width, y: PAPER_A5.height }, { x: 0, y: PAPER_A5.height }];

function synthetic(options: SyntheticOptions = {}): PaperPixels {
  const width = options.width ?? 1000; const height = options.height ?? 1350;
  const corners = options.corners ?? [{ x: 80, y: 80 }, { x: 920, y: 80 }, { x: 920, y: 1270 }, { x: 80, y: 1270 }];
  const inverse = paperHomography(corners, logical); const data = new Uint8ClampedArray(width * height * 4);
  const qr = QRCode.create(paperQrPayload('real', paperFixture.id, paperCode), { errorCorrectionLevel: 'M' });
  const module = PAPER_QR.size / (qr.modules.size + 8); const boxes = paperChoiceBoxes(paperFixture);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const point = projectPaperPoint(inverse, { x, y }); let value = 190;
    if (point.x >= 0 && point.y >= 0 && point.x <= PAPER_A5.width && point.y <= PAPER_A5.height) {
      value = 250;
      if (PAPER_MARKERS.some((marker, index) => index !== options.omitMarker && Math.abs(point.x - marker.x) <= PAPER_MARKER_SIZE / 2 && Math.abs(point.y - marker.y) <= PAPER_MARKER_SIZE / 2)) value = 8;
      if (!options.omitQr && point.x >= PAPER_QR.x && point.x < PAPER_QR.x + PAPER_QR.size && point.y >= PAPER_QR.y && point.y < PAPER_QR.y + PAPER_QR.size) {
        const column = Math.floor((point.x - PAPER_QR.x) / module) - 4; const row = Math.floor((point.y - PAPER_QR.y) / module) - 4;
        if (column >= 0 && row >= 0 && column < qr.modules.size && row < qr.modules.size && qr.modules.get(row, column)) value = 8;
      }
      for (const box of boxes) {
        const u = point.x - box.x; const v = point.y - box.y;
        if (u < 0 || v < 0 || u > box.size || v > box.size) continue;
        if (u < .9 || v < .9 || u > box.size - .9 || v > box.size - .9) value = 8;
        const mark = options.marks?.find(mark => mark.area === box.area && mark.optionId === box.optionId);
        if (mark && u > 2 && v > 2 && u < box.size - 2 && v < box.size - 2 && (mark.kind === 'fill' || Math.abs(u - v) < .8 || Math.abs(u + v - box.size) < .8)) value = mark.gray ?? 8;
      }
      // Non-marker print components near the top must not displace corner registration.
      if (point.x > 75 && point.x < 340 && point.y > 80 && point.y < 84) value = 8;
    }
    const index = (y * width + x) * 4; data[index] = data[index + 1] = data[index + 2] = value; data[index + 3] = 255;
  }
  return { width, height, data };
}

test('paper photo recognition reads an X and a pencil fill without sending pixels to a service', () => {
  const result = analyzePaperPixels(synthetic({ marks: [{ area: 'MAT', optionId: 'math-b', kind: 'x' }, { area: 'COM', optionId: 'com-a', kind: 'fill', gray: 155 }] }), paperFixture, 'real');
  assert.equal(result.code, paperCode); assert.equal(result.pollId, paperFixture.id);
  assert.deepEqual(result.choices, { MAT: 'math-b', COM: 'com-a' }); assert.equal(result.needsReview, false, result.reasons.join(' '));
});

test('perspective correction recognizes both areas on a skewed photograph', () => {
  const result = analyzePaperPixels(synthetic({ width: 1100, height: 1400, corners: [{ x: 90, y: 75 }, { x: 970, y: 140 }, { x: 900, y: 1320 }, { x: 135, y: 1250 }],
    marks: [{ area: 'MAT', optionId: 'math-c', kind: 'fill' }, { area: 'COM', optionId: 'com-b', kind: 'x' }] }), paperFixture, 'real');
  assert.deepEqual(result.choices, { MAT: 'math-c', COM: 'com-b' }); assert.equal(result.needsReview, false, result.reasons.join(' '));
});

test('QR orientation aligns a ninety-degree photograph before recognizing marks', () => {
  const result = analyzePaperPixels(synthetic({ width: 1400, height: 1050, corners: [{ x: 1320, y: 80 }, { x: 1280, y: 920 }, { x: 80, y: 940 }, { x: 110, y: 120 }],
    marks: [{ area: 'MAT', optionId: 'math-a', kind: 'x' }, { area: 'COM', optionId: null, kind: 'x' }] }), paperFixture, 'real');
  assert.deepEqual(result.choices, { MAT: 'math-a', COM: null }); assert.equal(result.needsReview, false, result.reasons.join(' '));
});

test('empty and explicit blank areas are recognized as blank, not an editorial', () => {
  const result = analyzePaperPixels(synthetic({ marks: [{ area: 'COM', optionId: null, kind: 'fill' }] }), paperFixture, 'real');
  assert.deepEqual(result.choices, { MAT: null, COM: null }); assert.equal(result.needsReview, false, result.reasons.join(' '));
});

test('double marks and faint marks are held for review instead of silently deciding a vote', () => {
  const result = analyzePaperPixels(synthetic({ marks: [{ area: 'MAT', optionId: 'math-a', kind: 'x' }, { area: 'MAT', optionId: 'math-c', kind: 'x' },
    { area: 'COM', optionId: 'com-b', kind: 'fill', gray: 224 }] }), paperFixture, 'real');
  assert.equal(result.needsReview, true); assert.equal(result.choices.MAT, '__invalid__'); assert.equal(result.reasons.length, 2);
});

test('a missing registration mark prevents automatic recognition even when its QR is valid', () => {
  const result = analyzePaperPixels(synthetic({ omitMarker: 0, marks: [{ area: 'MAT', optionId: 'math-a', kind: 'x' }] }), paperFixture, 'real');
  assert.equal(result.code, paperCode); assert.equal(result.needsReview, true); assert.deepEqual(result.choices, {});
  assert.match(result.reasons.join(' '), /cuatro marcas/);
});

test('unknown QR, another poll and demo sheets never become real votes automatically', () => {
  const noQr = analyzePaperPixels(synthetic({ omitQr: true }), paperFixture, 'real'); assert.equal(noQr.code, null); assert.equal(noQr.needsReview, true);
  const pixels = synthetic();
  for (const [poll, dataset] of [[{ ...paperFixture, id: 'another-poll' }, 'real'], [paperFixture, 'demo']] as const) {
    const result = analyzePaperPixels(pixels, poll, dataset); assert.equal(result.code, null); assert.equal(result.needsReview, true); assert.deepEqual(result.choices, {});
  }
});

test('malformed image buffers and degenerate transformations fail safely', () => {
  const result = analyzePaperPixels({ width: 200, height: 200, data: new Uint8ClampedArray(5) }, paperFixture, 'real');
  assert.equal(result.needsReview, true); assert.equal(result.code, null);
  assert.throws(() => paperHomography(Array(4).fill({ x: 0, y: 0 }), Array(4).fill({ x: 0, y: 0 })), /no forman/);
});
