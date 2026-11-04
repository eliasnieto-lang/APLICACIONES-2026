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
  state.presentationQuestions = state.publishers.map(publisher => ({ id: `question-${publisher.id}`, publisherId: publisher.id, version: 1, representativeName: 'Representante docente', area: 'MAT', question: '¿Cómo se apoya la comprensión?', answer: 'Con representaciones y explicaciones verificables.', status: 'answered', askedAt: '2026-11-05T21:45:00.000Z', answeredAt: '2026-11-05T21:46:00.000Z', updatedAt: '2026-11-05T21:46:00.000Z' }));
  for (const publisher of state.publishers) for (const [index, teacher] of state.teachers.entries()) {
    state.presentationEvaluations.push({ ...newPresentationEvaluation({ publisherId: publisher.id, teacherId: teacher.id, area: 'MAT', block: 'P1' }),
      id: `${publisher.id}-${teacher.id}`, version: 2, scores: Array(10).fill(3), rubricVersion: 2, responseScore: 3, questionVersion: 1,
      notes: Array(10).fill(index ? 'OBSERVACIÓN SECRETA DEL COLEGA' : 'Actividad observada durante la exposición'),
      generalObservation: index ? 'COMENTARIO PRIVADO DE OTRA PERSONA' : 'Adecuado para las situaciones explicadas',
      physicalText: 'Texto físico en mano, muestra del bloque P1', status: 'closed', closedAt: '2026-11-05T22:00:00.000Z', updatedAt: '2026-11-05T22:00:00.000Z' });
  }
  const assessment = presentationCategoryAssessment(state, 'MAT', 'P1');
  state.presentationShortlists.push({ id: 'live-shortlist', version: 1, categoryId: 'MAT-P1', area: 'MAT', block: 'P1', publisherIds: state.publishers.map(publisher => publisher.id),
    status: 'published', statement: 'Apreciación pública del portavoz', folio: 'EXP-001', directorApproved: true, publishedAt: '2026-11-05T22:30:00.000Z', rulesVersion: 1,
    snapshot: { assessment: structuredClone(assessment), publishers: state.publishers.map(({ id, name }) => ({ id, name })), threshold: 0, scaleMax: 4, rubricVersion: 2 } });
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

test('live A4 teacher PDF contains eleven scores and own observations without a dossier or peer data', async () => {
  const state = fixture();
  assert.deepEqual(state.books, []); assert.deepEqual(state.assignments, []);
  const text = await pdfText(await buildPresentationTeacherPdf(state, { publisherId: 'publisher-0', area: 'MAT', block: 'P1', evaluationId: 'publisher-0-teacher-0' }, { demo: true }));
  assert.match(text, /exposición editorial/); assert.match(text, /DOCENTE AUTOR/); assert.match(text, /Texto físico en mano/);
  assert.match(text, /I10\./); assert.match(text, /I11\./); assert.match(text, /75\.00/); assert.match(text, /33 \/ 44/); assert.match(text, /once criterios x 100 \/ 44/);
  assert.match(text, /3 - Logrado/); assert.match(text, /Cómo se apoya la comprensión/); assert.match(text, /representaciones y explicaciones verificables/); assert.doesNotMatch(text, /A:|B:/); assert.match(text, /Actividad observada/);
  assert.match(text, /Adecuado para las situaciones/); assert.match(text, /Firma y nombre - Docente evaluador/); assert.match(text, /DATOS FICTICIOS/);
  assert.doesNotMatch(text, /COLEGA RESERVADO|SECRETA DEL COLEGA|COMENTARIO PRIVADO DE OTRA|OBNATE|Versión de expediente/);
});

test('blank live A4 form keeps scores pending and rejects a sheet from another scope', async () => {
  const state = fixture();
  const text = await pdfText(await buildPresentationTeacherPdf(state, { publisherId: 'publisher-0', area: 'COM', block: 'S1' }));
  assert.match(text, /Comunicación/); assert.match(text, /Ficha en blanco/);
  assert.equal((text.match(/Puntaje 0 \/ 1 \/ 2 \/ 3 \/ 4: Pendiente/g) ?? []).length, 11);
  assert.match(text, /máximo 44 puntos/); assert.match(text, /Sin valoración/); assert.match(text, /Destacado/);
  assert.match(text, /once respuestas necesarias/); assert.doesNotMatch(text, /DOCENTE AUTOR|COLEGA RESERVADO/);
  await assert.rejects(buildPresentationTeacherPdf(state, { publisherId: 'publisher-1', area: 'MAT', block: 'P1', evaluationId: 'publisher-0-teacher-0' }), /no corresponde/);
  await assert.rejects(buildPresentationTeacherPdf(state, { publisherId: 'publisher-0', area: 'MAT', block: 'P1', evaluationId: 'publisher-0-teacher-0', teacherId: 'teacher-1' }), /no corresponde/);
});

test('live shortlist A4 preserves its aggregate snapshot and omits all individual teacher data', async () => {
  const state = fixture(); state.publishers[0].name = 'Nombre posterior que no pertenece al acuerdo';
  state.presentationEvaluations.forEach(evaluation => { evaluation.scores = Array(10).fill(0); });
  const text = await pdfText(await buildPresentationShortlistPdf(state, 'live-shortlist'));
  assert.match(text, /Editorial de exposición 1/); assert.doesNotMatch(text, /Nombre posterior/);
  assert.match(text, /75\.00/); assert.match(text, /5 \/ 15 \/ 0/); assert.match(text, /EXP-001/);
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


test('live shortlist PDF states the advisory role and family choice without imposing a threshold', async () => {
  const state = fixture(); state.presentationShortlists[0].snapshot.threshold = 100;
  const text = await pdfText(await buildPresentationShortlistPdf(state, 'live-shortlist'));
  assert.match(text, /sin puntaje mínimo/); assert.match(text, /padres eligen/); assert.match(text, /no determina la elección/);
  assert.doesNotMatch(text, /Umbral \/100 utilizado/);
});

test('historical live teacher PDF preserves the original A/B rubric and 14/20 as 70', async () => {
  const state = fixture(); const legacy = state.presentationEvaluations[0];
  delete legacy.scaleMax; delete legacy.rubricVersion; delete legacy.responseScore; delete legacy.questionVersion; legacy.scores = [2, 2, 2, 2, 1, 1, 1, 1, 1, 1];
  const before = JSON.stringify(legacy);
  const text = await pdfText(await buildPresentationTeacherPdf(state, { publisherId: legacy.publisherId, area: 'MAT', block: 'P1', evaluationId: legacy.id }));
  assert.match(text, /HISTÓRICA/); assert.match(text, /14 \/ 20/); assert.match(text, /70\.00/); assert.match(text, /resultado original conservado/);
  const normalized = text.replace(/\s+/g, ' ');
  assert.match(normalized, /Rúbrica histórica 0-2/);
  assert.match(normalized, /A: La exposición relaciona la propuesta con los aprendizajes del área y bloque\./);
  assert.match(normalized, /B: En el ejemplar se reconoce una actividad pertinente para el trabajo del colegio\./);
  assert.match(normalized, /A: Presenta una situación que el estudiante debe resolver\./);
  assert.match(normalized, /B: Invita a representar, explicar, comparar o justificar su procedimiento\./);
  assert.doesNotMatch(normalized, /La propuesta y las actividades del ejemplar desarrollan aprendizajes pertinentes|Las situaciones del texto promueven resolver problemas y representar/);
  assert.doesNotMatch(text, /2\.5 x suma|4 - Destacado|3 - Logrado/); assert.equal(JSON.stringify(legacy), before);
});

test('an explicit zero is printed as a current response and keeps a zero total', async () => {
  const state = fixture(); const form = state.presentationEvaluations[0]; form.scores = Array(10).fill(0); form.responseScore = 0;
  const text = await pdfText(await buildPresentationTeacherPdf(state, { publisherId: form.publisherId, area: 'MAT', block: 'P1', evaluationId: form.id }));
  assert.equal((text.match(/0 - Sin valoración/g) ?? []).length, 11); assert.match(text, /0 \/ 44/); assert.match(text, /Puntaje \/100: 0\.00/);
  assert.doesNotMatch(text, /Pendiente - diez respuestas necesarias/);
});

test('historical shortlist PDF preserves its frozen score and old I2 scale', async () => {
  const state = fixture(); const shortlist = state.presentationShortlists[0]; delete shortlist.snapshot.scaleMax; delete shortlist.snapshot.rubricVersion;
  shortlist.snapshot.assessment.ranked.forEach(item => { item.score = 70; item.i2 = 2; });
  state.presentationEvaluations.forEach(form => { form.scores = Array(10).fill(4); });
  const text = await pdfText(await buildPresentationShortlistPdf(state, shortlist.id));
  assert.match(text, /HISTÓRICA/); assert.match(text, /Puntaje agregado \/100: 70\.00/); assert.match(text, /I2 promedio \(escala 0-2\)/);
  assert.doesNotMatch(text, /Puntaje agregado \/100: 100\.00/);
});

test('private XLSX retains each scale, raw sum and original score without mixing legacy forms', async () => {
  const state = fixture(); const legacy = state.presentationEvaluations[0]; delete legacy.scaleMax; delete legacy.rubricVersion; delete legacy.responseScore; delete legacy.questionVersion;
  legacy.scores = [2, 2, 2, 2, 1, 1, 1, 1, 1, 1];
  state.presentationEvaluations[2].scores = Array(10).fill(0); state.presentationEvaluations[2].responseScore = 0;
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await buildPrivateWorkbook(state) as never);
  const sheet = workbook.getWorksheet('Exposiciones PRIVADAS')!; const headers = sheet.getRow(1).values as string[];
  const cell = (row: number, header: string) => sheet.getRow(row).getCell(headers.indexOf(header)).value;
  assert.equal(cell(2, 'Escala máxima'), 2); assert.equal(cell(2, 'Suma'), 14); assert.equal(cell(2, 'Máximo'), 20); assert.equal(cell(2, 'Nota /100'), 70);
  assert.match(String(cell(2, 'Uso de la escala')), /Histórica/);
  assert.equal(cell(3, 'Escala máxima'), 4); assert.equal(cell(3, 'Suma'), 33); assert.equal(cell(3, 'Máximo'), 44); assert.equal(cell(3, 'Nota /100'), 75);
  assert.equal(cell(4, 'Suma'), 0); assert.equal(cell(4, 'Máximo'), 44); assert.equal(cell(4, 'Nota /100'), 0);
  const summary = workbook.getWorksheet('Resumen exposiciones')!; const summaryHeaders = summary.getRow(1).values as string[];
  const current = summary.getRows(2, summary.rowCount - 1)!.find(row => row.getCell(summaryHeaders.indexOf('Editorial')).value === 'Editorial de exposición 1'
    && row.getCell(summaryHeaders.indexOf('Área')).value === 'MAT' && row.getCell(summaryHeaders.indexOf('Categoría')).value === 'P1')!;
  assert.equal(current.getCell(summaryHeaders.indexOf('Cerrados')).value, 4);
  assert.equal(current.getCell(summaryHeaders.indexOf('Pendientes')).value, 1); assert.equal(current.getCell(summaryHeaders.indexOf('Promedio /100')).value, 56.25);
  assert.equal(current.getCell(summaryHeaders.indexOf('Pendientes de actualizar escala')).value, 1);
});


test('old ten-criterion 0–4 PDF retains 30/40 = 75 and never attaches an eleventh grade', async () => {
  const state = fixture(); const form = state.presentationEvaluations[0];
  delete form.rubricVersion; delete form.responseScore; delete form.questionVersion;
  const before = JSON.stringify(form);
  const text = await pdfText(await buildPresentationTeacherPdf(state, { publisherId: form.publisherId, area: 'MAT', block: 'P1', evaluationId: form.id }));
  assert.match(text, /HISTÓRICA/); assert.match(text, /30 \/ 40/); assert.match(text, /75\.00/); assert.doesNotMatch(text, /I11\.|Pregunta formulada/);
  assert.equal(JSON.stringify(form), before);
});

test('answer grades 0 and 4 retain the fixed maximum of 44 in PDF and XLSX', async () => {
  const state = fixture(); const form = state.presentationEvaluations[0]; form.scores = Array(10).fill(4); form.responseScore = 0;
  const zero = await pdfText(await buildPresentationTeacherPdf(state, { publisherId: form.publisherId, area: 'MAT', block: 'P1', evaluationId: form.id }));
  assert.match(zero, /40 \/ 44/); assert.match(zero, /90\.91/); assert.match(zero, /Puntaje 0 \/ 1 \/ 2 \/ 3 \/ 4: 0 - Sin valoración/);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await buildPrivateWorkbook(state) as never);
  const sheet = workbook.getWorksheet('Exposiciones PRIVADAS')!; const headers = sheet.getRow(1).values as string[];
  const value = (name: string) => sheet.getRow(2).getCell(headers.indexOf(name)).value;
  assert.equal(value('I11 respuesta'), 0); assert.equal(value('Versión de pregunta'), 1); assert.equal(value('Versión de rúbrica'), 2); assert.equal(value('Suma'), 40); assert.equal(value('Máximo'), 44); assert.equal(value('Nota /100'), 4000 / 44);
  form.responseScore = 4;
  const full = await pdfText(await buildPresentationTeacherPdf(state, { publisherId: form.publisherId, area: 'MAT', block: 'P1', evaluationId: form.id }));
  assert.match(full, /44 \/ 44/); assert.match(full, /Puntaje \/100: 100\.00/);
});

test('a PDF never attributes an old answer score to a newly changed question', async () => {
  const state = fixture(); const form = state.presentationEvaluations[0];
  state.presentationQuestions![0].version = 2; state.presentationQuestions![0].question = 'PREGUNTA NUEVA NO VALORADA'; state.presentationQuestions![0].answer = 'RESPUESTA NUEVA NO VALORADA';
  const text = await pdfText(await buildPresentationTeacherPdf(state, { publisherId: form.publisherId, area: 'MAT', block: 'P1', evaluationId: form.id }));
  assert.match(text, /Versión de pregunta valorada: 1/); assert.match(text, /historial/); assert.doesNotMatch(text, /PREGUNTA NUEVA NO VALORADA|RESPUESTA NUEVA NO VALORADA/); assert.match(text, /33 \/ 44/);
});
