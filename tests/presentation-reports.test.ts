import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import ExcelJS from 'exceljs';
import { emptyState } from '../shared/defaults';
import { newPresentationEvaluation, presentationCategoryAssessment } from '../shared/presentation';
import { A4, buildPresentationShortlistPdf, buildPresentationTeacherPdf, buildPrivateWorkbook } from '../src/reports';

function fixture() {
  const state = emptyState();
  state.publishers = Array.from({ length: 3 }, (_, index) => ({ id: `publisher-${index}`, version: 1, name: `Editorial de exposición ${index + 1}`, samplesReceived: false, sampleNote: '' }));
  state.teachers = Array.from({ length: 5 }, (_, index) => ({ id: `teacher-${index}`, version: 1, name: index ? `COLEGA RESERVADO ${index}` : 'DOCENTE AUTOR', firstNames: `Nombres ${index}`, lastNames: `Apellidos ${index}`, area: 'MAT' as const, categories: ['P1' as const], selfRegistered: true, attended: false, attendanceEvidence: '' }));
  for (const publisher of state.publishers) for (const [index, teacher] of state.teachers.entries()) {
    state.presentationEvaluations.push({ ...newPresentationEvaluation({ publisherId: publisher.id, teacherId: teacher.id, area: 'MAT', block: 'P1' }),
      id: `${publisher.id}-${teacher.id}`, version: 2, scores: [2, 2, 2, 2, 1, 1, 1, 1, 1, 1],
      notes: Array(10).fill(index ? 'OBSERVACIÓN SECRETA DEL COLEGA' : 'Actividad observada durante la exposición'),
      generalObservation: index ? 'COMENTARIO PRIVADO DE OTRA PERSONA' : 'Adecuado para las situaciones explicadas',
      physicalText: 'Texto físico en mano, muestra del bloque P1', status: 'closed', closedAt: '2026-11-05T22:00:00.000Z', updatedAt: '2026-11-05T22:00:00.000Z' });
  }
  const assessment = presentationCategoryAssessment(state, 'MAT', 'P1');
  state.presentationShortlists.push({ id: 'live-shortlist', version: 1, categoryId: 'MAT-P1', area: 'MAT', block: 'P1', publisherIds: state.publishers.map(publisher => publisher.id),
    status: 'published', statement: 'Apreciación pública del portavoz', folio: 'EXP-001', directorApproved: true, publishedAt: '2026-11-05T22:30:00.000Z', rulesVersion: 1,
    snapshot: { assessment: structuredClone(assessment), publishers: state.publishers.map(({ id, name }) => ({ id, name })), threshold: 70 } });
  return state;
}

async function pdfText(bytes: Uint8Array) {
  const document = await PDFDocument.load(bytes);
  for (const page of document.getPages()) {
    assert.ok(Math.abs(page.getWidth() - A4.width) < .01);
    assert.ok(Math.abs(page.getHeight() - A4.height) < .01);
  }
  const directory = await mkdtemp(join(tmpdir(), 'textos-live-pdf-'));
  try {
    const input = join(directory, 'input.pdf'); const output = join(directory, 'output.txt'); await writeFile(input, bytes);
    const result = spawnSync('pdftotext', ['-layout', input, output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return await readFile(output, 'utf8');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('live A4 teacher PDF contains ten scores and own observations without a dossier or peer data', async () => {
  const state = fixture();
  assert.deepEqual(state.books, []); assert.deepEqual(state.assignments, []);
  const text = await pdfText(await buildPresentationTeacherPdf(state, { publisherId: 'publisher-0', area: 'MAT', block: 'P1', evaluationId: 'publisher-0-teacher-0' }, { demo: true }));
  assert.match(text, /exposición editorial/); assert.match(text, /DOCENTE AUTOR/); assert.match(text, /Texto físico en mano/);
  assert.match(text, /I10\./); assert.match(text, /70\.00/); assert.match(text, /Actividad observada/);
  assert.match(text, /Adecuado para las situaciones/); assert.match(text, /Firma y nombre - Docente evaluador/); assert.match(text, /DATOS FICTICIOS/);
  assert.doesNotMatch(text, /COLEGA RESERVADO|SECRETA DEL COLEGA|COMENTARIO PRIVADO DE OTRA|OBNATE|Versión de expediente/);
});

test('blank live A4 form keeps scores pending and rejects a sheet from another scope', async () => {
  const state = fixture();
  const text = await pdfText(await buildPresentationTeacherPdf(state, { publisherId: 'publisher-0', area: 'COM', block: 'S1' }));
  assert.match(text, /Comunicación/); assert.match(text, /Ficha en blanco/);
  assert.equal((text.match(/Puntaje 0 \/ 1 \/ 2: Pendiente/g) ?? []).length, 10);
  assert.match(text, /diez respuestas necesarias/); assert.doesNotMatch(text, /DOCENTE AUTOR|COLEGA RESERVADO/);
  await assert.rejects(buildPresentationTeacherPdf(state, { publisherId: 'publisher-1', area: 'MAT', block: 'P1', evaluationId: 'publisher-0-teacher-0' }), /no corresponde/);
  await assert.rejects(buildPresentationTeacherPdf(state, { publisherId: 'publisher-0', area: 'MAT', block: 'P1', evaluationId: 'publisher-0-teacher-0', teacherId: 'teacher-1' }), /no corresponde/);
});

test('live shortlist A4 preserves its aggregate snapshot and omits all individual teacher data', async () => {
  const state = fixture(); state.publishers[0].name = 'Nombre posterior que no pertenece al acuerdo';
  state.presentationEvaluations.forEach(evaluation => { evaluation.scores = Array(10).fill(0); });
  const text = await pdfText(await buildPresentationShortlistPdf(state, 'live-shortlist'));
  assert.match(text, /Editorial de exposición 1/); assert.doesNotMatch(text, /Nombre posterior/);
  assert.match(text, /70\.00/); assert.match(text, /5 \/ 15 \/ 0/); assert.match(text, /EXP-001/);
  assert.match(text, /no\s+asigna notas individuales por grado/);
  assert.doesNotMatch(text, /DOCENTE AUTOR|COLEGA RESERVADO|SECRETA|Adecuado para las situaciones|Texto físico en mano/);
});

test('private XLSX exports unlimited live profiles and own sheet data with historical collections labeled', async () => {
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await buildPrivateWorkbook(fixture()) as never);
  assert.equal(workbook.getWorksheet('Docentes registrados')?.rowCount, 6);
  assert.equal(workbook.getWorksheet('Exposiciones PRIVADAS')?.rowCount, 16);
  assert.equal(workbook.getWorksheet('Resumen exposiciones')?.rowCount, 19);
  assert.match(JSON.stringify(workbook.getWorksheet('Exposiciones PRIVADAS')?.getRow(2).values), /DOCENTE AUTOR|Actividad observada/);
  assert.match(JSON.stringify(workbook.getWorksheet('LEEME PRIVADO')?.getSheetValues()), /histórico por libro y grado/);
  assert.doesNotMatch(JSON.stringify(workbook.getWorksheet('Resumen exposiciones')?.getSheetValues()), /DOCENTE AUTOR|SECRETA|teacher-0/);
  assert.doesNotMatch(JSON.stringify(workbook.getWorksheet('Docentes registrados')?.getSheetValues()), /password|code_hash|salt/i);
  assert.equal(workbook.getWorksheet('Evaluaciones PRIVADAS')?.rowCount, 1);
});
