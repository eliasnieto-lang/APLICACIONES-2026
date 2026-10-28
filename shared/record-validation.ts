import type { Commitment, DisciplineType, Incident } from './types';

export const isValidRecordDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** Record verification and approval of the category's discount are separate decisions. */
export function incidentRequiredFields(
  record: Pick<Incident, 'typeId' | 'date' | 'description'>,
  disciplineTypes: readonly Pick<DisciplineType, 'id'>[],
): string[] {
  return [
    !disciplineTypes.some(type => type.id === record.typeId) ? 'categoría válida' : '',
    !isValidRecordDate(record.date) ? 'fecha válida' : '',
    !record.description.trim() ? 'descripción' : '',
  ].filter(Boolean);
}

/** Family and historical commitments share these minimum required fields. */
export function commitmentRequiredFields(record: Pick<Commitment, 'name' | 'date' | 'status'>): string[] {
  return [
    !record.name.trim() ? 'nombre de la actividad' : '',
    !isValidRecordDate(record.date) ? 'fecha válida' : '',
    !['fulfilled', 'missed', 'justified', 'na'].includes(record.status) ? 'estado' : '',
  ].filter(Boolean);
}
