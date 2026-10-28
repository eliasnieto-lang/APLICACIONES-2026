import type { Commitment } from './types';

export const ACADEMIC_CONTEST_TYPE = 'academic_contest' as const;
export const ACADEMIC_CONTEST_LABEL = 'CONCURSOS ACADÉMICOS';
export const CONTEST_SCOPE_OPTIONS = [
  { value: 'local', label: 'Local', points: 40 },
  { value: 'regional', label: 'Regional', points: 70 },
  { value: 'national', label: 'Nacional', points: 100 },
] as const;
export type ContestScope = typeof CONTEST_SCOPE_OPTIONS[number]['value'];

export const isAcademicContest = (record: Pick<Commitment, 'eventType'>): boolean => record.eventType === ACADEMIC_CONTEST_TYPE;
export const isContestScope = (scope: unknown): scope is ContestScope => CONTEST_SCOPE_OPTIONS.some(option => option.value === scope);
export const isValidContestDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
};

/** The fixed event category and its scope occupy the same classification control. */
export function contestRequiredFields(record: Pick<Commitment, 'eventType' | 'scope' | 'date' | 'placement'>): string[] {
  const missing: string[] = [];
  if (!isAcademicContest(record) || !isContestScope(record.scope)) missing.push('tipo de evento (local, regional o nacional)');
  if (!isValidContestDate(record.date)) missing.push('fecha válida');
  if (!record.placement?.trim()) missing.push('ubicación / puesto');
  return missing;
}

export function contestPoints(record: Pick<Commitment, 'scope'>): number | null {
  return CONTEST_SCOPE_OPTIONS.find(option => option.value === record.scope)?.points ?? null;
}
