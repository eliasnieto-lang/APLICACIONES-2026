import type { Area, State, Versioned } from './types';

/** One required question and the observed answer are shared by the editorial's evaluators. */
export interface PresentationQuestion extends Versioned {
  publisherId: string; representativeName: string; area: Area;
  question: string; answer: string; status: 'draft' | 'answered';
  askedAt: string | null; answeredAt: string | null; updatedAt: string;
}
export type QuestionState = Pick<State, 'publishers'> & { presentationQuestions?: PresentationQuestion[] };

export function presentationQuestionForPublisher(state: QuestionState, publisherId: string): PresentationQuestion | undefined {
  return (state.presentationQuestions ?? []).find(question => question.publisherId === publisherId);
}
export const questionForPublisher = presentationQuestionForPublisher;

export function isQuestionAnswered(question: PresentationQuestion | undefined): boolean {
  return Boolean(question && question.status === 'answered' && question.representativeName.trim()
    && ['MAT', 'COM'].includes(question.area) && question.question.trim() && question.answer.trim()
    && question.askedAt && question.answeredAt);
}
