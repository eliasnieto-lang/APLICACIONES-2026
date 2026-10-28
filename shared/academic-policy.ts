import { ACTIVE_BIMESTERS } from './policy';
import type { AcademicArea, AreaDefinition, Settings, Student } from './types';

/** A course is taken only when the active I–III periods contain a grade. */
export function hasActiveGrades(input?: Pick<AcademicArea, 'grades'>): boolean {
  return Boolean(input?.grades.some(row => ACTIVE_BIMESTERS.some((_, index) => ['AD', 'A', 'B', 'C'].includes(row[index] ?? ''))));
}

/** Keep configured criteria intact while selecting the courses taken by this student. */
export function activeAreas(student: Pick<Student, 'academic'>, settings: Pick<Settings, 'areas'>): AreaDefinition[] {
  return settings.areas.filter(area => area.eligible && hasActiveGrades(student.academic.find(input => input.areaId === area.id)));
}

export function isAreaComplete(definition: AreaDefinition, input?: Pick<AcademicArea, 'grades'>): boolean {
  return definition.competencies.length > 0 && definition.competencies.every((_, competency) =>
    ACTIVE_BIMESTERS.every((__, bimester) => ['AD', 'A', 'B', 'C'].includes(input?.grades[competency]?.[bimester] ?? '')));
}
