import assert from 'node:assert/strict';
import test from 'node:test';
import { validateImport } from '../shared/imports';
import type { Book, State } from '../shared/types';

function blankState(): State {
  return { books: [], publishers: [], series: [], offers: [], sections: [] } as unknown as State;
}
function sampleBook(overrides: Partial<Book> = {}): Book {
  return { id: 'b1', code: 'MAT-PRI1', active: true, topics: [], practice: [], dossierClosed: false, ...overrides } as Book;
}
const title = { code: 'MAT-PRI1', publisher: 'Editorial de prueba', series: 'Nueva serie', area: 'MAT', gradeId: 'PRI1', title: 'Matemática 1', edition: '2027' };
const topic = { bookCode: 'MAT-PRI1', code: 'T1', order: 1, chapter: 'Unidad 1', bimester: 'I', name: 'Números', pages: '10–12' };

test('precio total declarado sin desglose: conserva el total y no inventa precios unitarios', () => {
  const state = blankState();
  const result = validateImport('titles', [{ ...title, declaredBasePrice: 'S/ 120,50', priceSource: 'Cotización 1' }], state);
  assert.equal(result.valid, true);
  assert.equal(result.rows[0].declaredBasePrice, 120.5);
  assert.equal(result.rows[0].block, 'P1');
  assert.equal(Object.hasOwn(result.rows[0], 'unitPrice'), false);
  assert.equal(Object.hasOwn(result.rows[0], 'components'), false);
  assert.deepEqual(state, blankState());
});

test('precio desconocido sigue nulo, cero real se conserva y cantidades negativas se rechazan', () => {
  assert.equal(validateImport('titles', [{ ...title, declaredBasePrice: '' }], blankState()).rows[0].declaredBasePrice, null);
  const free = validateImport('titles', [{ ...title, declaredBasePrice: 0 }], blankState());
  assert.equal(free.valid, true);
  assert.equal(free.rows[0].declaredBasePrice, 0);
  const negative = validateImport('titles', [{ ...title, declaredBasePrice: -10 }], blankState());
  assert.equal(negative.valid, false);
  assert.ok(negative.errors.some(error => error.field === 'declaredBasePrice' && error.row === 2));
});

test('catálogo con tema duplicado y cantidad negativa identifica ambas filas y no muta el estado', () => {
  const state = blankState(); state.books.push(sampleBook());
  const before = structuredClone(state);
  const duplicate = validateImport('topics', [topic, { ...topic, order: 2 }], state);
  assert.equal(duplicate.valid, false);
  assert.ok(duplicate.errors.some(error => error.row === 3 && error.field === 'code'));
  const count = validateImport('practice', [{ bookCode: 'MAT-PRI1', position: 1, topicName: 'Números', pages: '10', baseCount: -1 }], state);
  assert.equal(count.valid, false);
  assert.ok(count.errors.some(error => error.field === 'baseCount'));
  assert.deepEqual(state, before);
});

test('rechaza duplicados preexistentes y cruces de área/bloque/grado', () => {
  const state = blankState(); state.books.push(sampleBook());
  assert.equal(validateImport('titles', [title], state).valid, false);
  assert.equal(validateImport('titles', [{ ...title, block: 'S1' }], blankState()).valid, false);
  assert.equal(validateImport('titles', [{ ...title, area: 'Historia' }], blankState()).valid, false);
  assert.equal(validateImport('topics', [{ ...topic, bookCode: 'INEXISTENTE' }], state).valid, false);
});

test('un tema retomado debe referir al mismo texto y las referencias no pueden formar ciclos', () => {
  const state = blankState(); state.books.push(sampleBook());
  assert.equal(validateImport('topics', [topic, { ...topic, code: 'T2', order: 2, revisitOf: 'T1' }], state).valid, true);
  const missing = validateImport('topics', [{ ...topic, revisitOf: 'OTRO' }], state);
  assert.equal(missing.valid, false);
  const cycle = validateImport('topics', [{ ...topic, revisitOf: 'T2' }, { ...topic, code: 'T2', order: 2, revisitOf: 'T1' }], state);
  assert.equal(cycle.valid, false);
  assert.ok(cycle.errors.some(error => error.message.includes('ciclo')));
});

test('muestra verificada exige recuento base y evidencia; admite cero y separa componentes opcionales', () => {
  const state = blankState(); state.books.push(sampleBook());
  const row = { bookCode: 'MAT-PRI1', position: 1, topicName: 'Números', pages: '10', baseCount: 0, optionalCount: 8, verified: 'sí', evidence: 'Conteo en p. 10' };
  const result = validateImport('practice', [row], state);
  assert.equal(result.valid, true);
  assert.equal(result.rows[0].baseCount, 0);
  assert.equal(result.rows[0].optionalCount, 8);
  assert.equal(result.rows[0].workbookCount, null);
  assert.equal(validateImport('practice', [{ ...row, baseCount: null }], state).valid, false);
  assert.equal(validateImport('practice', [{ ...row, evidence: '' }], state).valid, false);
  assert.equal(validateImport('practice', [{ ...row, baseCount: 1.2 }], state).valid, false);
});

test('padrón deriva promociones de inicial y sexto y rechaza destino incoherente y doble sección', () => {
  const state = blankState();
  const rows = [{ label: 'A', sourceGrade: 'Inicial 5 años' }, { label: 'B', sourceGrade: '6.º de primaria' }, { label: 'C', sourceGrade: 'Inicial de 5 años' }];
  const result = validateImport('sections', rows, state);
  assert.equal(result.valid, true);
  assert.deepEqual(result.rows.map(row => row.gradeId), ['PRI1', 'SEC1', 'PRI1']);
  assert.equal(validateImport('sections', [{ ...rows[0], gradeId: 'PRI2' }], state).valid, false);
  assert.equal(validateImport('sections', [rows[0], rows[0]], state).valid, false);
  assert.equal(validateImport('sections', [{ ...rows[0], accredited: true }], state).valid, false);
});

test('acepta encabezados españoles, bimestre pendiente y rechaza expedientes cerrados', () => {
  const result = validateImport('titles', [{ Código: 'C1', Editorial: 'E', Serie: 'S', Área: 'Comunicación', Grado: '1.º primaria', Título: 'Lecturas', Edición: 2027, 'Precio total': '' }], blankState());
  assert.equal(result.valid, true);
  assert.equal(result.rows[0].area, 'COM');
  assert.equal(result.rows[0].gradeId, 'PRI1');
  assert.equal(result.rows[0].declaredBasePrice, null);
  const state = blankState(); state.books.push(sampleBook());
  const pending = validateImport('topics', [{ ...topic, bimester: '' }], state);
  assert.equal(pending.valid, true);
  assert.equal(pending.rows[0].bimester, null);
  assert.equal(pending.warnings.some(warning => warning.field === 'bimester'), true);
  state.books[0].dossierClosed = true;
  assert.equal(validateImport('topics', [topic], state).valid, false);
});

test('tipo inválido y columnas duplicadas devuelven errores revisables', () => {
  assert.equal(validateImport('__proto__' as never, [title], blankState()).valid, false);
  assert.equal(validateImport('titles', [{ ...title, Código: 'OTRO' }], blankState()).valid, false);
});
