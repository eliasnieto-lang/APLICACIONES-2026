export type DataCleanupScope = 'all' | 'publisher' | 'teacher' | 'presentationEvaluation' | 'paperPoll' | 'draw' | 'ranking' | 'historical' | 'series' | 'offer' | 'book' | 'section' | 'incident' | 'question';
export interface DataCleanupPreview {
  stateVersion: number; scope: DataCleanupScope; ids: string[]; labels: string[];
  counts: Record<string, number>; consequences: string[]; requiresFullConfirmation: boolean;
}
export interface DataCleanupResult { deleted: true; preview: DataCleanupPreview }
