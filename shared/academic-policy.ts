import { ACTIVE_BIMESTERS, normalizeCohort } from './policy';
import type { AcademicArea, AreaDefinition, Settings, Student } from './types';

/** A course is taken only when the active I–III periods contain a grade. */
export function hasActiveGrades(input?: Pick<AcademicArea, 'grades'>): boolean {
  return Boolean(input?.grades.some(row => ACTIVE_BIMESTERS.some((_, index) => ['AD', 'A', 'B', 'C'].includes(row[index] ?? ''))));
}

/** Keep configured criteria intact while selecting the courses taken by this student. */
export function activeAreas(student: Pick<Student, 'academic'>, settings: Pick<Settings, 'areas'>): AreaDefinition[] {
  return settings.areas.filter(area => area.eligible && hasActiveGrades(student.academic.find(input => input.areaId === area.id)));
}

/** A wholly blank Indaga row is not evaluated for any admitted secondary classroom. */
export function omittedCompetencyIndexes(definition: AreaDefinition, input?: Pick<AcademicArea, 'grades'>, cohort?: Pick<Student, 'grade' | 'section'>): number[] {
  const normalized = cohort && normalizeCohort(cohort.grade, cohort.section);
  if (definition.group !== 'science' || !normalized) return [];
  return definition.competencies.flatMap((competency, index) => {
    const label = competency.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const isIndaga = /^indaga mediante metodos cientificos(?:\s|$)/.test(label);
    const blank = ACTIVE_BIMESTERS.every((_, period) => (input?.grades[index]?.[period] ?? '') === '');
    return isIndaga && blank ? [index] : [];
  });
}

/** Without a cohort context, automatic PDF validation always requires every note. */
export function isAreaComplete(definition: AreaDefinition, input?: Pick<AcademicArea, 'grades'>, cohort?: Pick<Student, 'grade' | 'section'>): boolean {
  const omitted = new Set(omittedCompetencyIndexes(definition, input, cohort));
  const required = definition.competencies.map((_, index) => index).filter(index => !omitted.has(index));
  return required.length > 0 && required.every(competency =>
    ACTIVE_BIMESTERS.every((_, bimester) => ['AD', 'A', 'B', 'C'].includes(input?.grades[competency]?.[bimester] ?? '')));
}
