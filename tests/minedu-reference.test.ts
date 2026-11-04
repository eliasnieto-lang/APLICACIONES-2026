import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MINEDU_GUIDE_INDICATORS, MINEDU_SOURCE, getMineduIndicatorReference } from '../shared/minedu-reference.js';
import { MineduReference } from '../src/components/MineduReference.js';

test('MINEDU reference keeps the supplied forty-page document intact and its points total one hundred', async () => {
  const pdf = readFileSync(new URL('../public/referencias/guia-minedu-textos-2013.pdf', import.meta.url));
  assert.equal(createHash('sha256').update(pdf).digest('hex'), '565f1bf6ee8906ef19f6dcc7b1b31fa030934446e1e62499e088cd93d236db43');
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 40);
  assert.equal(MINEDU_GUIDE_INDICATORS.length, 27);
  assert.equal(MINEDU_GUIDE_INDICATORS.reduce((sum, item) => sum + item.pointsByLevel[2]!, 0), 100);
});

test('documentary weights distinguish disqualification, a partial zero and undefined intermediate levels', () => {
  const indicator = (id: number) => MINEDU_GUIDE_INDICATORS.find(item => item.id === id)!;
  assert.deepEqual(indicator(4).pointsByLevel, [null, 0, 3]);
  assert.deepEqual(indicator(4).disqualifyingLevels, [0]);
  for (const id of [5, 6, 11, 22, 26]) {
    assert.equal(indicator(id).pointsByLevel[1], null);
    assert.deepEqual(indicator(id).undefinedLevels, [1]);
  }
  assert.deepEqual(indicator(2).pointsByLevel, [0, 1.5, 2.5]);
  assert.deepEqual(indicator(3).pointsByLevel, [0, 1.5, 2.5]);
});

test('area references point to the correct primary or secondary matrix and keep coverage separate from PEI', () => {
  assert.deepEqual(getMineduIndicatorReference('I2', 'MAT', 'P1')?.pages, [31]);
  assert.deepEqual(getMineduIndicatorReference('I2', 'MAT', 'P2')?.pages, [31]);
  assert.deepEqual(getMineduIndicatorReference('I2', 'COM', 'P1')?.pages, [33]);
  assert.deepEqual(getMineduIndicatorReference('I2', 'MAT', 'S1')?.pages, [34]);
  assert.deepEqual(getMineduIndicatorReference('I2', 'COM', 'S1')?.pages, [36]);
  assert.deepEqual(getMineduIndicatorReference('I1')?.guideIds, [27]);
  assert.match(getMineduIndicatorReference('I1')?.qualification ?? '', /cobertura curricular.*pendiente/i);
  assert.equal(MINEDU_SOURCE.formalShortlistReference.page, 14);
  assert.deepEqual(MINEDU_SOURCE.curricularCoverageReference.pages, [15, 16, 22]);
});

test('families can see that the institutional score and informative seventy-point reference do not certify a formal review', () => {
  const html = renderToStaticMarkup(createElement(MineduReference, { compact: true }));
  assert.match(html, /0 a 4/);
  assert.match(html, /niveles 0, 1 y 2/);
  assert.match(html, /referencia informativa, sin bloquear la clasificación/);
  assert.match(html, /ficha formal por texto, edición y grado/);
  assert.match(html, /metadatos de 2013/);
  assert.match(html, /guia-minedu-textos-2013\.pdf#page=14/);
});
