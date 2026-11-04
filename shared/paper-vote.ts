import type { Area, AreaCount, AreaResult, Block } from './types.js';

export interface PaperVoteOption { id: string; name: string }
/** Anonymous paper election based on the final presentation ranking, not the historical book ballots. */
export interface PaperPoll {
  id: string; version: number; block: Block; areas: Area[];
  options: Partial<Record<Area, PaperVoteOption[]>>;
  status: 'open' | 'closed'; rankingId: string; rankingVersion: number;
  createdAt: string; closedAt: string | null; generated: number; received: number;
  counts: Partial<Record<Area, AreaCount>>; results: Partial<Record<Area, AreaResult>>;
}
export type PaperChoices = Partial<Record<Area, string | null>>;
export interface PaperBallotsGenerated { poll: PaperPoll; codes: string[] }
export interface PaperScanAccepted { poll: PaperPoll; accepted: true }
export const PAPER_INVALID_CHOICE = '__invalid__';
