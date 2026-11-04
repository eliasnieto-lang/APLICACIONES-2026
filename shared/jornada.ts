import type { Area, Block, PresentationCategoryAssessment, Publisher, State, Teacher } from './types.js';
import { AREAS, BLOCKS } from './domain.js';
import { presentationQuestionForPublisher, isQuestionAnswered } from './questions.js';
import { presentationPublisherAvailable, presentationScore, presentationUsesCurrentScale, presentationUsesCurrentRubric } from './presentation.js';

/** Frozen names and order from one server-side draw; completion follows the live-room controls. */
export interface PresentationDraw {
  id: string; version: number; publishers: Pick<Publisher, 'id' | 'name'>[];
  completedPublisherIds: string[]; createdAt: string; createdBy: string;
}
/** A dated ranking is a consultation snapshot, separate from the formal published shortlist. */
export interface PresentationRanking {
  id: string; version: number; createdAt: string; drawId: string;
  categories: PresentationCategoryAssessment[]; provisional: boolean; sourceFingerprint?: string; stale?: boolean;
}
export type JornadaState = State & { presentationDraw?: PresentationDraw; presentationRanking?: PresentationRanking };
export interface OrderedPresentationPublisher extends Publisher {
  participationOrder: number | null; drawn: boolean; completed: boolean; current: boolean;
}

/** Preserve the frozen draw order; late registrations remain visible after it without an invented position. */
export function presentationOrderedPublishers(state: JornadaState, area?: Area, block?: Block): OrderedPresentationPublisher[] {
  const draw = state.presentationDraw;
  const positions = new Map((draw?.publishers ?? []).map((publisher, index) => [publisher.id, index + 1]));
  return state.publishers.filter(publisher => !area || !block || presentationPublisherAvailable(state, publisher.id, area, block))
    .map((publisher, index) => ({
      ...publisher, participationOrder: positions.get(publisher.id) ?? null,
      drawn: positions.has(publisher.id), completed: !!draw?.completedPublisherIds.includes(publisher.id),
      current: state.turn.publisherId === publisher.id && (state.turn.status === 'running' || state.turn.status === 'paused'),
      originalIndex: index,
    }))
    .sort((left, right) => (left.participationOrder ?? Number.MAX_SAFE_INTEGER) - (right.participationOrder ?? Number.MAX_SAFE_INTEGER) || left.originalIndex - right.originalIndex)
    .map(({ originalIndex: _, ...publisher }) => publisher);
}

export type TeacherProgressStatus = 'waiting' | 'not_started' | 'in_progress' | 'complete';
export interface TeacherProgress {
  teacher: Teacher; categories: Block[]; expectedSheets: number; closedSheets: number;
  startedSheets: number; pendingSheets: number; markedCriteria: number; expectedCriteria: number;
  percentage: number; historicalSheets: number; conflictingSheets: number; status: TeacherProgressStatus;
}
export interface ProgressScope { area?: Area; block?: Block }

/** Count responses, including zero, once per expected teacher/publisher/area/category unit. */
export function teacherProgress(state: JornadaState, scope: ProgressScope = {}): TeacherProgress[] {
  return state.teachers.filter(teacher => (!scope.area || teacher.area === scope.area)
    && (!scope.block || teacher.categories?.includes(scope.block)))
    .map(teacher => {
      const validArea = AREAS.some(area => area.id === teacher.area) ? teacher.area : undefined;
      const categories = BLOCKS.filter(block => teacher.categories?.includes(block.id) && (!scope.block || scope.block === block.id)).map(block => block.id);
      let expectedSheets = 0, closedSheets = 0, markedCriteria = 0, startedSheets = 0, historicalSheets = 0, conflictingSheets = 0;
      if (validArea) for (const block of categories) {
        for (const publisher of state.publishers.filter(item => presentationPublisherAvailable(state, item.id, validArea, block))) {
          expectedSheets += 1;
          const forms = (state.presentationEvaluations ?? []).filter(form => form.teacherId === teacher.id && form.publisherId === publisher.id && form.area === validArea && form.block === block);
          if (forms.some(form => !presentationUsesCurrentRubric(form))) historicalSheets += 1;
          if (forms.length > 1) { conflictingSheets += 1; continue; }
          const form = forms[0];
          if (!form || !presentationUsesCurrentScale(form)) continue;
          startedSheets += 1;
          // Invalid restored or duplicate data must not produce 100% progress.
          let completeScore: number | null;
          try { completeScore = presentationScore(form); } catch { conflictingSheets += 1; continue; }
          markedCriteria += form.scores.filter(score => score !== null).length;
          const currentResponse = presentationUsesCurrentRubric(form) && form.responseScore !== null && form.responseScore !== undefined;
          if (currentResponse) markedCriteria += 1;
          if (form.status === 'closed' && completeScore !== null && currentResponse) closedSheets += 1;
        }
      }
      const expectedCriteria = expectedSheets * 11;
      return { teacher, categories, expectedSheets, closedSheets, startedSheets, pendingSheets: expectedSheets - closedSheets,
        markedCriteria, expectedCriteria, percentage: expectedCriteria ? Math.round(markedCriteria / expectedCriteria * 1000) / 10 : 0,
        historicalSheets, conflictingSheets,
        status: expectedSheets === 0 ? 'waiting' : closedSheets === expectedSheets ? 'complete'
          : startedSheets === 0 && markedCriteria === 0 ? 'not_started' : 'in_progress',
      };
    });
}

export function presentationDrawFinished(state: JornadaState): boolean {
  const draw = state.presentationDraw;
  return !!draw && draw.publishers.length > 0 && draw.publishers.every(publisher => draw.completedPublisherIds.includes(publisher.id) && (state.settings.evaluationMode !== 'presentation' || isQuestionAnswered(presentationQuestionForPublisher(state, publisher.id))));
}

export interface RankedPresentationRow {
  assessment: PresentationCategoryAssessment['ranked'][number]; position: number | null; tied: boolean;
}
/** Equal scores and I2 share a position; a Top includes every editorial tied at its boundary. */
export function presentationRankingRows(category: PresentationCategoryAssessment, top: number | null = null): RankedPresentationRow[] {
  const ranked = category.ranked.slice().sort((left, right) => (right.score ?? -1) - (left.score ?? -1)
    || (right.i2 ?? -1) - (left.i2 ?? -1) || left.publisherId.localeCompare(right.publisherId));
  let previousPosition = 0;
  return ranked.map((assessment, index) => {
    if (assessment.score === null) return { assessment, position: null, tied: false };
    const same = (other: typeof assessment | undefined) => !!other && other.score === assessment.score && other.i2 === assessment.i2;
    const position = same(ranked[index - 1]) ? previousPosition : index + 1;
    previousPosition = position;
    return { assessment, position, tied: same(ranked[index - 1]) || same(ranked[index + 1]) };
  }).filter(row => top === null || row.position !== null && row.position <= top);
}
