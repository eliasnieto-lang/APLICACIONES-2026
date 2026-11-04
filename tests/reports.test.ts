import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import ExcelJS from 'exceljs';
import { defaultBook, emptyState } from '../shared/defaults';
import type { State } from '../shared/types';
import { A4, buildComparisonPdf, buildMinutesPdf, buildPaperBallotPdf, buildPrivateWorkbook, buildShortlistPdf, buildTeacherPdf } from '../src/reports';

function fixture(): State {
  const state = emptyState();
  state.publishers = [{ id: 'publisher', version: 1, name: 'Editorial Pública', samplesReceived: true, sampleNote: '' }];
  state.series = ['A', 'B', 'C'].map(id => ({ id: `series-${id}`, version: 1, publisherId: 'publisher', name: `Serie ${id}` }));
  state.offers = ['A', 'B', 'C'].map(id => ({ id, version: 1, seriesId: `series-${id}`, area: 'MAT', block: 'P1', edition: '2027', status: 'offered', withdrawalReason: '' }));
  state.books = ['A', 'B', 'C'].map(id => defaultBook({ id: `book-${id}`, code: `CODE-${id}`, offerId: id, title: `Libro ${id}`, edition: '2027', declaredBasePrice: 100, priceSource: 'Cotización 001', priceValidity: '31/03/2027', bimesters: [4, 3, 5, 4], chapters: [{ name: 'Unidad única', topicCount: 16, source: 'Índice' }], workloadSource: 'Índice del libro', workloadNote: 'Requiere reservar una semana de repaso.', components: [{ id: 'optional', name: 'Cuaderno opcional', kind: 'workbook', quantity: 1, unitPrice: null, optional: true }], teacherSupport: { ...defaultBook().teacherSupport, access: 'Acceso docente demostrado', action: 'Planificar unidad', evidence: 'Prueba docente folio 4' } }));
  state.teachers = [{ id: 'teacher-one', version: 1, name: 'DOCENTE PRIVADO UNO', attended: true, attendanceEvidence: 'Lista' }, { id: 'teacher-two', version: 1, name: 'COLEGA CONFIDENCIAL DOS', attended: true, attendanceEvidence: 'Lista' }];
  state.evaluations = state.teachers.map((teacher, index) => ({ id: `evaluation-${index}`, version: 1, assignmentId: `assignment-${index}`, bookId: 'book-A', teacherId: teacher.id, bookVersion: 1, rulesVersion: 1, scores: [2, 2, 2, 2, 1, 1, 1, 1, 1, 1], evidence: Array.from({ length: 10 }, (_, indicator) => index ? 'EVIDENCIA SECRETA DEL COLEGA' : `Página ${indicator + 10}`), notes: Array(10).fill(index ? 'NOTA SECRETA DEL COLEGA' : 'Práctica contrastada'), objection: false, objectionDetail: '', status: 'closed', closedAt: '2026-11-05T23:00:00Z', updatedAt: '2026-11-05T23:00:00Z' }));
  state.sections = [{ id: 'section-secret', version: 1, label: 'SECCIÓN PRIVADA 2026', sourceGrade: 'INI5', gradeId: 'PRI1', representative: 'REPRESENTANTE CONFIDENCIAL', replacement: false, accredited: true, accreditationEvidence: 'ACTA PRIVADA' }];
  state.shortlists = [{ id: 'shortlist', version: 2, categoryId: 'MAT-P1', gradeIds: ['PRI1', 'PRI2'], offerIds: ['A', 'B', 'C'], status: 'published', scope: 'block', statement: 'Apreciación pedagógica pública', folio: 'FOLIO-027', reason: '', directorApproved: true, article113: false, publishedAt: '2026-11-05T23:00:00Z', rulesVersion: 1, snapshot: { books: structuredClone(state.books), offers: structuredClone(state.offers), publishers: structuredClone(state.publishers), series: structuredClone(state.series), rules: structuredClone(state.settings.rules), assessment: { ranked: [{ offerId: 'A', score: 82.5, grades: [{ bookId: 'book-A', score: 80 }] }] } } }];
  state.rounds = [{ id: 'round-private-id', version: 1, gradeId: 'PRI1', number: 1, areas: ['MAT', 'COM'], mode: 'paper', status: 'closed', shortlistIds: { MAT: 'shortlist', COM: 'shortlist' }, options: { MAT: ['A', 'B', 'C'], COM: ['A', 'B', 'C'] }, physicalReviewConfirmed: true, minimumRequired: 1, delivered: 4, deposited: 4, counts: { MAT: { options: { A: 2, B: 1, C: 0 }, blank: 0, invalid: 1 }, COM: { options: { A: 1, B: 2, C: 1 }, blank: 0, invalid: 0 } }, results: { MAT: { state: 'winner', winnerId: 'A', tiedIds: [] }, COM: { state: 'winner', winnerId: 'B', tiedIds: [] } }, parentId: null, openedAt: '2026-11-05T23:00:00Z', closedAt: '2026-11-05T23:30:00Z', reconciliationReason: '' }];
  state.incidents = [{ id: 'incident', version: 1, scope: 'ronda', referenceId: 'round-private-id', description: 'Recuento solicitado', resolution: 'Recuento conciliado', folio: 'INC-001', actor: 'coordinator', createdAt: '2026-11-05T23:10:00Z' }];
  return state;
}

async function extractPdf(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() > 0);
  for (const page of doc.getPages()) { assert.ok(Math.abs(page.getWidth() - A4.width) < .01); assert.ok(Math.abs(page.getHeight() - A4.height) < .01); }
  const directory = await mkdtemp(join(tmpdir(), 'textos-pdf-'));
  try {
    const file = join(directory, 'report.pdf'); const output = join(directory, 'report.txt'); await writeFile(file, bytes);
    const result = spawnSync('pdftotext', ['-layout', file, output], { encoding: 'utf8' });
    assert.equal(result.status, 0, `pdftotext debe leer el PDF: ${result.stderr}`);
    return await readFile(output, 'utf8');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('ficha docente PDF A4 conserva diez indicadores, evidencia, 70/100 y firmas sin la valoración del colega', async () => {
  const text = await extractPdf(await buildTeacherPdf(fixture(), 'book-A', 'evaluation-0', { demo: true }));
  assert.match(text, /I10\./); assert.match(text, /Página 19/); assert.match(text, /70\.00/); assert.match(text, /Firma y nombre - Docente evaluador/); assert.match(text, /Dirección/); assert.match(text, /DOCENTE PRIVADO UNO/); assert.match(text, /DATOS FICTICIOS/);
  assert.doesNotMatch(text, /COLEGA CONFIDENCIAL|EVIDENCIA SECRETA|NOTA SECRETA/);
});

test('cédula A4 incluye dos áreas y opciones públicas sin padrón, fichas ni identificador individual', async () => {
  const state = fixture(); const text = await extractPdf(await buildPaperBallotPdf(state, state.rounds[0].id));
  assert.match(text, /Matemática/); assert.match(text, /Comunicación/); assert.match(text, /Serie A/); assert.match(text, /Libro C/);
  assert.doesNotMatch(text, /REPRESENTANTE CONFIDENCIAL|SECCIÓN PRIVADA|DOCENTE PRIVADO|COLEGA CONFIDENCIAL|ACTA PRIVADA|round-private-id|evaluation-/);
  state.rounds[0].mode = 'digital'; await assert.rejects(buildPaperBallotPdf(state, state.rounds[0].id), /digital/);
});

test('acta A4 muestra ganadores distintos, conciliación, blancos, nulos, incidencia y firmas; rechaza ronda abierta', async () => {
  const state = fixture(); const text = await extractPdf(await buildMinutesPdf(state, state.rounds[0].id));
  assert.match(text, /Serie A/); assert.match(text, /Serie B/); assert.match(text, /Ganador por voto familiar/); assert.match(text, /Votos blancos: 0/); assert.match(text, /Votos nulos: 1/); assert.match(text, /4 = 4 depositadas/); assert.match(text, /INC-001/); assert.match(text, /Recuento conciliado/); assert.match(text, /Representación de familias/);
  assert.doesNotMatch(text, /REPRESENTANTE CONFIDENCIAL|SECCIÓN PRIVADA|NOTA SECRETA/);
  state.rounds[0].status = 'open'; await assert.rejects(buildMinutesPdf(state, state.rounds[0].id), /cerrada/);
});

test('tarjetas y constancia usan expediente histórico y distinguen precio opcional desconocido', async () => {
  const state = fixture(); state.books[0].title = 'Título nuevo que no pertenece a la terna';
  const cards = await extractPdf(await buildComparisonPdf(state, state.rounds[0].id));
  assert.match(cards, /Libro A/); assert.doesNotMatch(cards, /Título nuevo/); assert.match(cards, /80\.00/); assert.match(cards, /sin desglose unitario/); assert.match(cards, /Acceso docente demostrado/);
  assert.doesNotMatch(cards, /DOCENTE PRIVADO|REPRESENTANTE CONFIDENCIAL|NOTA SECRETA/);
  const shortlist = await extractPdf(await buildShortlistPdf(state, 'shortlist'));
  assert.match(shortlist, /FOLIO-027/); assert.match(shortlist, /82\.50/); assert.match(shortlist, /Libro A/); assert.doesNotMatch(shortlist, /Título nuevo/);
});

test('XLSX privado mantiene notas y padrón separados de conteos agregados, sin códigos de acceso', async () => {
  const bytes = await buildPrivateWorkbook(fixture()); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as never);
  assert.equal(workbook.getWorksheet('Evaluaciones PRIVADAS')?.rowCount, 3);
  assert.match(JSON.stringify(workbook.getWorksheet('Padron PRIVADO')?.getRow(2).values), /REPRESENTANTE CONFIDENCIAL/);
  assert.doesNotMatch(JSON.stringify(workbook.getWorksheet('Resultados agregados')?.getSheetValues()), /REPRESENTANTE|section-secret|teacher-one|Código/);
  assert.equal(workbook.getWorksheet('Resultados agregados')?.rowCount, 7);
});
