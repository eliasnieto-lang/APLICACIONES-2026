import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAreaComplete, omittedCompetencyIndexes } from '../shared/academic-policy';
import { defaultSettings } from '../shared/defaults';
import type { AcademicArea, AreaDefinition } from '../shared/types';

const science = (): AreaDefinition => structuredClone(defaultSettings.areas.find(area => area.group === 'science')!);
const grades = (): AcademicArea => ({ areaId: 'ciencia', grades: [['', '', ''], ['A', 'A', 'A'], ['A', 'A', 'A']], validated: false });

test('Indaga totalmente vacía se omite solo para Ciencia de 4.º F y 5.º F', () => {
  for (const grade of ['4', '5', '4to de secundaria', 'quinto grado de secundaria']) {
    const definition = science(), input = grades(), cohort = { grade, section: ' f ' };
    assert.deepEqual(omittedCompetencyIndexes(definition, input, cohort), [0], grade);
    assert.equal(isAreaComplete(definition, input, cohort), true, grade);
    assert.equal(isAreaComplete(definition, input), false, 'La lectura automática sin contexto sigue exigiendo todas las notas.');
    assert.equal(input.validated, false, 'La excepción no confirma la revisión automáticamente.');
  }
});

test('Las demás aulas, áreas y competencias conservan sus notas obligatorias', () => {
  const definition = science(), input = grades();
  for (const cohort of [{ grade: '2', section: 'F' }, { grade: '3', section: 'F' }, { grade: '4', section: 'G' }, { grade: '5', section: 'G' }, { grade: '6', section: 'F' }]) {
    assert.deepEqual(omittedCompetencyIndexes(definition, input, cohort), []);
    assert.equal(isAreaComplete(definition, input, cohort), false);
  }
  assert.deepEqual(omittedCompetencyIndexes({ ...definition, group: 'other' }, input, { grade: '4', section: 'F' }), []);
  definition.competencies[0] = 'Explica un método científico';
  assert.deepEqual(omittedCompetencyIndexes(definition, input, { grade: '4', section: 'F' }), []);
  assert.equal(isAreaComplete(definition, input, { grade: '4', section: 'F' }), false);
});

test('Indaga parcial y cualquier otra nota faltante siguen bloqueando la validación', () => {
  const definition = science(), cohort = { grade: '4', section: 'F' };
  const partial = grades(); partial.grades[0][1] = 'A';
  assert.deepEqual(omittedCompetencyIndexes(definition, partial, cohort), []);
  assert.equal(isAreaComplete(definition, partial, cohort), false);
  const otherMissing = grades(); otherMissing.grades[2][2] = '';
  assert.deepEqual(omittedCompetencyIndexes(definition, otherMissing, cohort), [0]);
  assert.equal(isAreaComplete(definition, otherMissing, cohort), false);
  const noRequired = { ...definition, competencies: [definition.competencies[0]] };
  assert.equal(isAreaComplete(noRequired, { grades: [['', '', '']] }, cohort), false);
});

test('La exención mantiene filas y notas de IV sin transformar los datos fuente', () => {
  const definition = science(), input = grades(); input.grades[0].push('AD');
  const original = structuredClone(input);
  assert.deepEqual(omittedCompetencyIndexes(definition, input, { grade: '4', section: 'F' }), [0]);
  assert.equal(isAreaComplete(definition, input, { grade: '4', section: 'F' }), true);
  assert.deepEqual(input, original);
  definition.competencies[0] = '  INDAGA mediante MÉTODOS científicos para construir sus conocimientos. ';
  assert.deepEqual(omittedCompetencyIndexes(definition, input, { grade: '4', section: 'F' }), [0]);
});
