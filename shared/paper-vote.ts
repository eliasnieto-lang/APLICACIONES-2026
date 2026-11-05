import type { Area, AreaCount, AreaResult, Block, GradeId } from './types.js';
import { BLOCKS, GRADES } from './domain.js';

export interface PaperVoteOption { id: string; name: string }
export type PaperAttendance = 'pending' | 'present' | 'absent';
export type PaperClassroomSection = 'A' | 'B' | 'C' | 'D' | 'E';
export interface PaperClassroom {
  id: string; gradeId: GradeId; section: PaperClassroomSection; label: string; folio: string;
  attendance: PaperAttendance; ballotIssued: boolean; received: boolean;
  choices?: PaperChoices; voteVersion?: number; recordedAt?: string | null; correctedAt?: string | null;
}
export interface PaperClassroomBallot { code?: string; classroomId: string; classroomLabel: string; folio: string }

/** One representative ballot per classroom; legacy anonymous polls remain readable. */
export interface PaperPoll {
  id: string; version: number; block: Block; areas: Area[];
  options: Partial<Record<Area, PaperVoteOption[]>>;
  status: 'open' | 'closed'; rankingId: string; rankingVersion: number;
  createdAt: string; closedAt: string | null; generated: number; received: number;
  counts: Partial<Record<Area, AreaCount>>; results: Partial<Record<Area, AreaResult>>;
  rosterVersion?: 1; classrooms?: PaperClassroom[];
}
export type PaperChoices = Partial<Record<Area, string | null>>;
export interface PaperBallotsGenerated { poll: PaperPoll; codes: string[]; ballots?: PaperClassroomBallot[] }
export interface PaperScanAccepted { poll: PaperPoll; accepted: true }
export const PAPER_INVALID_CHOICE = '__invalid__';

/** Fresh attendance rows for all five sections of each grade in the category. */
export function paperClassroomRoster(block: Block): PaperClassroom[] {
  if (!BLOCKS.some(item => item.id === block)) throw new Error('La categoría del padrón de aulas no es válida.');
  const sections: PaperClassroomSection[] = ['A', 'B', 'C', 'D', 'E'];
  return GRADES.filter(grade => grade.block === block).flatMap(grade => sections.map(section => ({
    id: `${grade.id}-${section}`, gradeId: grade.id, section, label: `${grade.label} · ${section}`,
    attendance: 'pending' as const, ballotIssued: false, received: false,
  }))).map((classroom, index) => ({ ...classroom, folio: `${block}-${String(index + 1).padStart(2, '0')}` }));
}
