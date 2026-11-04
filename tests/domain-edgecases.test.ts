import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultBook } from '../shared/defaults';
import { practiceSummary, sourceToTargetGrade, supportScoreConstraints } from '../shared/domain';
import type { Book, SupportProfile } from '../shared/types';

function support(action: string, included = true): SupportProfile {
  return {
    access: 'Acceso de prueba sin credenciales almacenadas', devices: 'Celular', connection: 'Internet', mobile: 'Sí',
    offline: 'No', validity: '2027', included, extraCost: included ? null : 15, renewal: 'Anual', support: 'Mesa editorial',
    action, evidence: 'Prueba presencial folio 12', testedAt: '2026-11-05', status: 'verified',
  };
}
function book(): Book {
  return defaultBook({
    topics: Array.from({ length: 3 }, (_, index) => ({
      id: `t${index + 1}`, code: `T${index + 1}`, order: index + 1,
      chapter: `Unidad ${index + 1}`, bimester: (index + 1) as 1 | 2 | 3, name: `Tema ${index + 1}`, pages: `${index + 10}`,
    })),
    bimesters: [1, 1, 1, 0], chapters: [], workloadMode: 'detailed', workloadSource: 'Índice p. 3', workloadNote: 'B4 dedicado a repaso.',
    practice: [8, 12, 10].map((count, index) => ({
      topicId: `t${index + 1}`, topicName: `Tema ${index + 1}`, position: index + 1, pages: `${index + 10}`,
      baseCount: count, workbookCount: null, optionalCount: 99, verified: true, evidence: 'Conteo presencial', workType: 'Problema',
    })),
    supportKind: 'platform', supportStatus: 'verified', equivalentAuthorized: false,
    teacherSupport: support('Localizar guía y planificar una sesión'), studentSupport: support('Realizar una actividad del grado'),
  });
}

test('índice con orden anual duplicado mantiene pendiente la muestra aunque existan tres recuentos', () => {
  const invalid = book();
  invalid.topics[1].order = 1;
  const result = practiceSummary(invalid);
  assert.equal(result.complete, false);
  assert.equal(result.mean, null);
  assert.equal(result.allTopicsMean, null);
});

test('I10 no acredita una acción pedagógica por el solo ingreso descrito en una frase', () => {
  const invalid = book();
  invalid.teacherSupport.action = 'Ingresar a la plataforma';
  invalid.studentSupport.action = 'Acceder con el código';
  const result = supportScoreConstraints(invalid);
  assert.equal(result.pending, true);
  assert.equal(result.maximum, null);
});

test('funcionalidad opcional no acredita el perfil base y la media nunca suma práctica opcional', () => {
  const value = book();
  value.studentSupport = support('Realizar una actividad del grado', false);
  const resource = supportScoreConstraints(value);
  assert.equal(resource.pending, false);
  assert.equal(resource.maximum, 1);
  assert.equal(resource.required, 1);
  const practice = practiceSummary(value);
  assert.equal(practice.mean, 10);
  assert.equal(practice.min, 8);
  assert.equal(practice.max, 12);
});

test('promoción de inicial admite el texto habitual usado en padrón y plantilla', () => {
  assert.equal(sourceToTargetGrade('Inicial 5 años'), 'PRI1');
  assert.equal(sourceToTargetGrade('Inicial de 5 años'), 'PRI1');
  assert.equal(sourceToTargetGrade('6.º de primaria'), 'SEC1');
});
