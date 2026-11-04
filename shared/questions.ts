import type { Area, State, Versioned } from './types';

/** Confirmation of the question and answer; older transcriptions remain available in saved records. */
export interface PresentationQuestion extends Versioned {
  publisherId: string; confirmed?: boolean; representativeName?: string; area?: Area;
  question?: string; answer?: string; status: 'draft' | 'answered';
  askedAt: string | null; answeredAt: string | null; updatedAt: string;
}
export type QuestionState = Pick<State, 'publishers'> & { presentationQuestions?: PresentationQuestion[] };

export function presentationQuestionForPublisher(state: QuestionState, publisherId: string): PresentationQuestion | undefined {
  return (state.presentationQuestions ?? []).find(question => question.publisherId === publisherId);
}
export const questionForPublisher = presentationQuestionForPublisher;

export function isQuestionAnswered(question: PresentationQuestion | undefined): boolean {
  return Boolean(question && question.status === 'answered' && question.askedAt && question.answeredAt
    && (question.confirmed === true || question.confirmed === undefined && question.representativeName?.trim()
      && question.area && ['MAT', 'COM'].includes(question.area) && question.question?.trim() && question.answer?.trim()));
}
