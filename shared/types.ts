export type Area = 'MAT' | 'COM';
export type Block = 'P1' | 'P2' | 'S1';
export type GradeId = 'PRI1' | 'PRI2' | 'PRI3' | 'PRI4' | 'PRI5' | 'PRI6' | 'SEC1' | 'SEC2' | 'SEC3';
export type Dataset = 'real' | 'demo';
export type Role = 'coordinator' | 'secretary' | 'teacher' | 'public';
export type Score = 0 | 1 | 2 | null;
export type CheckStatus = 'pending' | 'pass' | 'fail';
export type Verification = 'declared' | 'verified' | 'pending' | 'not_offered';
export interface Versioned { id: string; version: number }
export interface Rules {
  version: number; threshold: number; teacherCount: 2; indicatorCount: 10;
  presentationSeconds: number; transitionSeconds: number;
  representationMode: 'count' | 'percentage'; minimumRepresentation: number | null;
  practiceGuidelines: Record<string, string>; lockedAt: string | null;
}
export interface Settings {
  version: number; school: string; title: string; eventAt: string; timezone: 'America/Lima';
  venue: string; organizers: string; rules: Rules; editorsWithdrawn: boolean;
  withdrawalReference: string; directorName: string;
  evaluationMode?: 'presentation';
}
export interface Publisher extends Versioned { name: string; contact?: string; samplesReceived: boolean; sampleNote: string }
export interface Series extends Versioned { publisherId: string; name: string }
export interface Offer extends Versioned {
  seriesId: string; area: Area; block: Block; edition: string;
  status: 'offered' | 'withdrawn'; withdrawalReason: string; withdrawnAt?: string;
}
export interface Check { status: CheckStatus; evidence: string; note: string }
export interface PriceComponent { id: string; name: string; kind: 'text' | 'workbook' | 'license' | 'other'; quantity: number; unitPrice: number | null; optional: boolean }
export interface Topic { id: string; code: string; order: number; chapter: string; bimester: 1 | 2 | 3 | 4 | null; name: string; pages: string; revisitOf?: string; distinctLesson?: boolean }
export interface Chapter { name: string; topicCount: number | null; source: string }
export interface PracticeSample {
  topicId: string; topicName: string; position: number; pages: string;
  baseCount: number | null; workbookCount: number | null; optionalCount: number | null;
  verified: boolean; evidence: string; workType: string;
}
export interface SupportProfile {
  access: string; devices: string; connection: string; mobile: string; offline: string;
  validity: string; included: boolean; extraCost: number | null; renewal: string; support: string;
  action: string; evidence: string; testedAt: string; status: Verification;
}
export interface Book extends Versioned {
  code: string; offerId: string; gradeId: GradeId; title: string; edition: string; authors: string;
  active: boolean; obnate: string; obnateSource: string; ministerialReference: string;
  checks: Check[]; sampleTable: string; sampleQuantity: number; familyAvailability: string;
  components: PriceComponent[]; declaredBasePrice: number | null; priceSource: string;
  priceValidity: string; priceStatus: Verification;
  workloadMode: 'quick' | 'detailed'; bimesters: (number | null)[]; chapters: Chapter[];
  topics: Topic[]; workloadSource: string; mappingOrigin: 'editorial' | 'school';
  workloadStatus: Verification; workloadNote: string; availableWeeks: number | null;
  practice: PracticeSample[]; practiceStatus: Verification;
  supportKind: 'platform' | 'equivalent' | 'none'; equivalentAuthorized: boolean;
  supportStatus: Verification; supportNote: string;
  teacherSupport: SupportProfile; studentSupport: SupportProfile;
  dossierClosed: boolean; dossierReference: string; supersedesId?: string;
}
export interface Teacher extends Versioned {
  name: string; attended: boolean; attendanceEvidence: string;
  firstNames?: string; lastNames?: string; area?: Area; categories?: Block[]; selfRegistered?: boolean;
}
export interface Assignment extends Versioned { bookId: string; teacherId: string; kind: 'initial' | 'additional'; reviewId?: string }
export interface Evaluation extends Versioned {
  assignmentId: string; bookId: string; teacherId: string; bookVersion: number; rulesVersion: number;
  scores: Score[]; evidence: string[]; notes: string[]; objection: boolean; objectionDetail: string;
  status: 'draft' | 'closed'; closedAt: string | null; updatedAt: string;
  legacyIndicatorCount?: number;
}
/** Live observations are independent of historical book/assignment evaluations. */
export interface PresentationEvaluation extends Versioned {
  publisherId: string; teacherId: string; area: Area; block: Block;
  scores: Score[]; notes: string[]; generalObservation: string; physicalText: string;
  materialViewed?: boolean;
  status: 'draft' | 'closed'; closedAt: string | null; updatedAt: string; rulesVersion: number;
}
export interface PresentationPublisherAssessment {
  publisherId: string; area: Area; block: Block; registered: number; closed: number; pending: number;
  drafts: number; score: number | null; i2: number | null; state: 'pending' | 'eligible' | 'ineligible';
}
export interface PresentationCategoryAssessment {
  categoryId: string; area: Area; block: Block;
  state: 'pending' | 'ready' | 'tie' | 'less_than_three' | 'published';
  registered: number; closed: number; pending: number;
  ranked: PresentationPublisherAssessment[]; finalists: string[]; tied: string[]; reasons: string[];
}
export interface PresentationShortlist extends Versioned {
  categoryId: string; area: Area; block: Block; publisherIds: string[];
  status: 'published' | 'superseded'; statement: string; folio: string;
  directorApproved: boolean; publishedAt: string; rulesVersion: number;
  snapshot: { assessment: PresentationCategoryAssessment; publishers: Pick<Publisher, 'id' | 'name'>[]; threshold: number };
}
export interface Review extends Versioned { categoryId: string; offerIds: string[]; unitReference: string; reason: string }
export interface Turn {
  publisherId: string | null; status: 'ready' | 'running' | 'paused' | 'finished';
  startedAt: string | null; pausedAt: string | null; pausedMilliseconds: number;
}
export interface Shortlist extends Versioned {
  categoryId: string; gradeIds: GradeId[]; offerIds: string[];
  status: 'draft' | 'published' | 'superseded'; scope: 'block' | 'grade';
  statement: string; folio: string; reason: string; directorApproved: boolean;
  article113: boolean; publishedAt: string | null; rulesVersion: number;
  snapshot: unknown;
}
export interface Section extends Versioned {
  label: string; sourceGrade: string; gradeId: GradeId; representative: string;
  replacement: boolean; accredited: boolean; accreditationEvidence: string;
}
export interface Delivery { roundId: string; sectionId: string; delivered: boolean }
export interface AreaCount { options: Record<string, number>; blank: number; invalid: number }
export interface AreaResult { state: 'winner' | 'tie' | 'no_valid_votes' | 'insufficient_representation' | 'pending'; winnerId: string | null; tiedIds: string[] }
export interface Round extends Versioned {
  gradeId: GradeId; number: number; areas: Area[]; mode: 'paper' | 'digital';
  status: 'draft' | 'open' | 'closed' | 'suspended' | 'void';
  shortlistIds: Partial<Record<Area, string>>; options: Partial<Record<Area, string[]>>;
  physicalReviewConfirmed: boolean; minimumRequired: number;
  delivered: number; deposited: number; counts: Partial<Record<Area, AreaCount>>;
  results: Partial<Record<Area, AreaResult>>; parentId: string | null;
  openedAt: string | null; closedAt: string | null; reconciliationReason: string;
}
export interface Incident extends Versioned { scope: string; referenceId: string; description: string; resolution: string; folio: string; actor: string; createdAt: string }
export interface AuditEntry { id: string; actor: string; action: string; referenceId: string; reason: string; at: string; summary: string }
export interface State {
  schemaVersion: number; version: number; settings: Settings;
  publishers: Publisher[]; series: Series[]; offers: Offer[]; books: Book[];
  teachers: Teacher[]; assignments: Assignment[]; evaluations: Evaluation[];
  presentationEvaluations: PresentationEvaluation[]; presentationShortlists: PresentationShortlist[];
  reviews: Review[]; turn: Turn; shortlists: Shortlist[];
  sections: Section[]; deliveries: Delivery[]; rounds: Round[];
  incidents: Incident[]; audit: AuditEntry[];
}
export interface Actor { id: string; name: string; role: Role }
export interface Snapshot { state: State; actor: Actor; serverNow: string; dataset: Dataset }
export interface Api {
  call<T = unknown>(action: string, payload?: Record<string, unknown>): Promise<T>;
  dataset: Dataset;
  draftSecret(): string;
}
export interface ViewProps { snapshot: Snapshot; api: Api; refresh(): Promise<void>; notify(message: string, error?: boolean): void }
export interface BookAssessment { bookId: string; state: 'pending' | 'eligible' | 'ineligible' | 'not_offered'; score: number | null; i2: number | null; reasons: string[] }
export interface OfferAssessment { offerId: string; state: 'pending' | 'eligible' | 'ineligible' | 'withdrawn'; score: number | null; i2: number | null; additional: number | null; reasons: string[]; grades: BookAssessment[] }
export interface CategoryAssessment { categoryId: string; state: 'review' | 'ready' | 'tie' | 'less_than_three' | 'published'; ranked: OfferAssessment[]; finalists: string[]; tied: string[]; reasons: string[] }
