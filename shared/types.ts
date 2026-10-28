export type Grade = 'AD' | 'A' | 'B' | 'C' | '';
export type AreaGroup = 'math' | 'science' | 'communication' | 'social' | 'dpcc' | 'other';
export interface AreaDefinition { id: string; name: string; group: AreaGroup; competencies: string[]; eligible: boolean }
export interface SupplementalArea { definition: AreaDefinition; grades: Grade[][] }
export interface AcademicArea { areaId: string; grades: Grade[][]; validated: boolean }
export interface Attendance { required: number | null; attended: number | null; punctual: number | null; exempted: number | null; validated: boolean }
export interface Incident { id: string; typeId: string; date: string; description: string; measure: string; evidence: string; verified: boolean }
export type RecordStatus = 'pending' | 'fulfilled' | 'missed' | 'justified' | 'na';
export interface Commitment { id: string; catalogId?: string; name: string; date: string; required: boolean; status: RecordStatus; justification: string; evidence: string; validated: boolean; placement?: string; representingSchool?: boolean; eventType?: 'academic_contest'; scope?: 'local' | 'regional' | 'national' }
export interface CohortRecord { id: string; kind: 'institutional' | 'family'; name: string; date: string; grade: string; section: string; required: boolean }
export interface HistoryEntry { id: string; date: string; field: string; before: string; after: string }
export interface Student {
  id: string; code: string; name: string; grade: string; section: string;
  academic: AcademicArea[]; attendance: Attendance;
  discipline: { confirmed: boolean; incidents: Incident[] };
  institutional: Commitment[]; family: Commitment[];
  validated: { academic: boolean; performance: boolean; commitment: boolean };
  history: HistoryEntry[]; pdfIds: string[]; createdAt: string; updatedAt: string;
  reportApproval?: { pdfId: string; approvedAt: string };
}
export interface DisciplineType { id: string; name: string; discount: number | null; punctuality: boolean }
export interface Settings {
  year: number; version: string; areas: AreaDefinition[];
  academicWeights: { general: number; specialized: number; progress: number };
  scienceWeight: number;
  performanceWeights: { attendance: number; discipline: number };
  commitmentWeights: { participation: number; family: number };
  criteriaApproved: boolean; naPolicy: 'pending' | 'other_component'; naPolicyApproved: boolean;
  disciplineTypes: DisciplineType[]; activityTypes: string[]; familyTypes: string[]; cohortRecords?: CohortRecord[]; closed: boolean;
  workflowVersion?: 2;
  progressionComparison?: 'first_two_vs_third';
}
export interface PdfRecord {
  id: string; name: string; hash: string; size: number; uploadedAt: string;
  status: 'pending' | 'review' | 'validated' | 'failed' | 'duplicate' | 'replaced';
  studentId: string | null; extractedCode: string; extractedName: string;
  extractedGrade: string; extractedSection: string; period: string;
  text: string; ocr: boolean; warnings: string[];
  areas: AcademicArea[]; supplementalAreas?: SupplementalArea[]; replacesId?: string;
  manualName?: string;
  confirmedIdentity?: { code: string; name: string; grade: string; section: string };
}
export type Dataset = 'real' | 'demo';
export interface AppState { students: Student[]; settings: Settings; pdfs: PdfRecord[] }
