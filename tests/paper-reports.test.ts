import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PDFDocument, PrintScaling } from 'pdf-lib';
import { emptyState } from '../shared/defaults';
import { PAPER_A5, type PaperBallotDefinition } from '../shared/paper-layout';
import { buildPaperVotingPdf } from '../src/paper-reports';
import { analyzePaperPixels } from '../src/paper-scan';

const poll: PaperBallotDefinition = { id: '9820f22c-3181-4a4d-8196-84e87dafdbca', block: 'P1', areas: ['MAT', 'COM'],
  options: { MAT: [{ id: 'publisher-a', name: 'Editorial Matemática uno' }, { id: 'publisher-b', name: 'Editorial Matemática dos' }],
    COM: [{ id: 'publisher-c', name: 'Editorial Comunicación uno' }, { id: 'publisher-d', name: 'Editorial Comunicación dos' }] } };
const firstCode = 'a6b241acb603b53c7c3709d14f5ab141d69fe8e45b630919b90ebabc0aa874f4';
const secondCode = 'b6b241acb603b53c7c3709d14f5ab141d69fe8e45b630919b90ebabc0aa874f4';

test('paper vote PDF has true A5 pages, both areas, anonymous unique codes and printable instructions', async () => {
  const state = emptyState(); state.teachers.push({ id: 'private-teacher', version: 1, name: 'DOCENTE PRIVADO NO IMPRIMIR', attended: true, attendanceEvidence: '' });
  const bytes = await buildPaperVotingPdf(state, poll, [firstCode, secondCode], { demo: true }); const document = await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(), 2);
  assert.equal(document.catalog.getOrCreateViewerPreferences().getPrintScaling(), PrintScaling.None);
  for (const page of document.getPages()) { assert(Math.abs(page.getWidth() - PAPER_A5.width) < .001); assert(Math.abs(page.getHeight() - PAPER_A5.height) < .001); }
  const dir = await mkdtemp(join(tmpdir(), 'textos-paper-a5-'));
  try {
    await writeFile(join(dir, 'ballots.pdf'), bytes);
    const process = spawnSync('pdftotext', ['-layout', join(dir, 'ballots.pdf'), join(dir, 'ballots.txt')], { encoding: 'utf8' }); assert.equal(process.status, 0, process.stderr);
    const text = await readFile(join(dir, 'ballots.txt'), 'utf8');
    assert.match(text, /MATEMÁTICA/); assert.match(text, /COMUNICACIÓN/); assert.match(text, /Marque UNA casilla/); assert.match(text, /Voto en blanco/);
    assert.match(text, /DEMOSTRACIÓN/); assert.match(text, new RegExp(firstCode)); assert.match(text, new RegExp(secondCode)); assert.doesNotMatch(text, /DOCENTE PRIVADO/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the generated PDF raster is recognized by the same photo pipeline with its actual QR and four marks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'textos-paper-raster-'));
  try {
    const bytes = await buildPaperVotingPdf(emptyState(), poll, [firstCode]); await writeFile(join(dir, 'ballot.pdf'), bytes);
    const process = spawnSync('pdftoppm', ['-r', '144', '-singlefile', join(dir, 'ballot.pdf'), join(dir, 'sheet')], { encoding: 'utf8' }); assert.equal(process.status, 0, process.stderr);
    const ppm = await readFile(join(dir, 'sheet.ppm')); const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.subarray(0, 150).toString('ascii'));
    assert(header); const width = Number(header[1]); const height = Number(header[2]); const offset = header[0].length; const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index++) { data[index * 4] = ppm[offset + index * 3]; data[index * 4 + 1] = ppm[offset + index * 3 + 1]; data[index * 4 + 2] = ppm[offset + index * 3 + 2]; data[index * 4 + 3] = 255; }
    const result = analyzePaperPixels({ width, height, data }, poll, 'real');
    assert.equal(result.code, firstCode); assert.equal(result.pollId, poll.id); assert.equal(result.needsReview, false, result.reasons.join(' ')); assert.deepEqual(result.choices, { MAT: null, COM: null });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('paper generation rejects duplicate codes and malformed polls instead of printing ambiguous ballots', async () => {
  await assert.rejects(buildPaperVotingPdf(emptyState(), poll, [firstCode, firstCode]), /distintas/);
  await assert.rejects(buildPaperVotingPdf(emptyState(), { ...poll, options: { ...poll.options, MAT: [] } }, [firstCode]), /dos o tres opciones/);
  await assert.rejects(buildPaperVotingPdf(emptyState(), poll, ['invalid-code']), /identificador anónimo/);
});

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'textos-classroom-pdf-'));
  try {
    await writeFile(join(dir, 'ballots.pdf'), bytes);
    const process = spawnSync('pdftotext', ['-layout', join(dir, 'ballots.pdf'), join(dir, 'ballots.txt')], { encoding: 'utf8' });
    assert.equal(process.status, 0, process.stderr);
    return await readFile(join(dir, 'ballots.txt'), 'utf8');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('classroom PDFs print exactly 10, 20 and 15 A5 ballots with complete classroom names and short folios', async () => {
  const { paperClassroomRoster } = await import('../shared/paper-vote');
  for (const [block, expected] of [['P1', 10], ['P2', 20], ['S1', 15]] as const) {
    const roster = paperClassroomRoster(block);
    const ballots = roster.map(classroom => ({ classroomId: classroom.id, classroomLabel: classroom.label, folio: classroom.folio }));
    const bytes = await buildPaperVotingPdf(emptyState(), { ...poll, block, rosterVersion: 1 }, ballots.map(item => item.folio), { demo: true, ballots });
    const document = await PDFDocument.load(bytes); const text = await extractPdfText(bytes);
    assert.equal(document.getPageCount(), expected);
    for (const page of document.getPages()) { assert(Math.abs(page.getWidth() - PAPER_A5.width) < .001); assert(Math.abs(page.getHeight() - PAPER_A5.height) < .001); }
    for (const classroom of roster) {
      assert.ok(text.includes(`Aula: ${classroom.label}`), classroom.label);
      assert.ok(text.includes(`Folio: ${classroom.folio}`), classroom.folio);
    }
    assert.equal((text.match(/FICHA DE VOTACIÓN FAMILIAR POR AULA/g) ?? []).length, expected);
    assert.equal((text.match(/MATEMÁTICA/g) ?? []).length, expected); assert.equal((text.match(/COMUNICACIÓN/g) ?? []).length, expected);
    assert.equal((text.match(/DEMOSTRACIÓN - SIN VALIDEZ/g) ?? []).length, expected);
    assert.doesNotMatch(text, /ANÓNIMA|Código anónimo|Código de ficha|Fotografíe|QR|cuatro marcas|[a-f0-9]{64}/);
    assert.match(document.getSubject() ?? '', /por aula/);
  }
});

test('personalized print batches reject duplicate, missing or misassigned classrooms and folios', async () => {
  const { paperClassroomRoster } = await import('../shared/paper-vote');
  const classroom = paperClassroomRoster('P1')[0]; const newPoll = { ...poll, rosterVersion: 1 as const };
  const ballot = { classroomId: classroom.id, classroomLabel: classroom.label, folio: classroom.folio };
  await assert.rejects(buildPaperVotingPdf(emptyState(), newPoll, [classroom.folio]), /aula/);
  await assert.rejects(buildPaperVotingPdf(emptyState(), newPoll, [classroom.folio], { ballots: [] }), /distintos/);
  await assert.rejects(buildPaperVotingPdf(emptyState(), newPoll, [classroom.folio], { ballots: [{ ...ballot, classroomId: 'SEC3-E' }] }), /distintos/);
  await assert.rejects(buildPaperVotingPdf(emptyState(), newPoll, [classroom.folio], { ballots: [{ ...ballot, folio: 'P1-02' }] }), /distintos/);
  await assert.rejects(buildPaperVotingPdf(emptyState(), newPoll, ['P1-01', 'P1-02'], { ballots: [ballot, { ...ballot, folio: 'P1-02' }] }), /distintos/);
  await assert.rejects(buildPaperVotingPdf(emptyState(), newPoll, [classroom.folio], { ballots: [{ ...ballot, classroomLabel: 'W'.repeat(120) }] }), /demasiado largo/);
});

test('a roster subset prints only the requested classrooms without exposing any internal recovery code', async () => {
  const { paperClassroomRoster } = await import('../shared/paper-vote');
  const selected = [paperClassroomRoster('P1')[1], paperClassroomRoster('P1')[9]];
  const ballots = selected.map((classroom, index) => ({ code: index ? secondCode : firstCode, classroomId: classroom.id, classroomLabel: classroom.label, folio: classroom.folio }));
  const text = await extractPdfText(await buildPaperVotingPdf(emptyState(), { ...poll, rosterVersion: 1 }, [firstCode, secondCode], { ballots }));
  assert.match(text, /Aula: 1\.º de primaria · B/); assert.match(text, /Aula: 2\.º de primaria · E/);
  assert.match(text, /Folio: P1-02/); assert.match(text, /Folio: P1-10/);
  assert.doesNotMatch(text, /Aula: 1\.º de primaria · A|DEMOSTRACIÓN|Fotografíe|QR/);
  assert.ok(!text.includes(firstCode) && !text.includes(secondCode));
});
