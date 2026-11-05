import type { Area, Block, Dataset } from './types';

/** Coordinates use PDF points from the top left, shared by print and recognition. */
export const PAPER_A5 = { width: 148 * 72 / 25.4, height: 210 * 72 / 25.4 } as const;
export const PAPER_MARKER_SIZE = 10;
export const PAPER_MARKERS = [
  { x: 22, y: 22 }, { x: PAPER_A5.width - 22, y: 22 },
  { x: PAPER_A5.width - 22, y: PAPER_A5.height - 22 }, { x: 22, y: PAPER_A5.height - 22 },
] as const;
export const PAPER_QR = { x: PAPER_A5.width - 113, y: PAPER_A5.height - 116, size: 82, quietModules: 4 } as const;
export interface PaperBallotDefinition {
  id: string; block: Block; areas: Area[];
  options: Partial<Record<Area, { id: string; name: string }[]>>;
  rosterVersion?: 1;
}
export interface PaperPoint { x: number; y: number }
export interface PaperChoiceBox { area: Area; optionId: string | null; name: string; x: number; y: number; size: number }

export function validatePaperDefinition(poll: PaperBallotDefinition) {
  if (!poll.id || poll.id.includes('|') || poll.id.length > 100) throw new Error('La ficha no tiene una votación válida.');
  if (!['P1', 'P2', 'S1'].includes(poll.block)) throw new Error('La categoría de la ficha no es válida.');
  if (poll.areas.length < 1 || poll.areas.length > 2 || new Set(poll.areas).size !== poll.areas.length
    || poll.areas.some(area => area !== 'MAT' && area !== 'COM')) throw new Error('Seleccione una o las dos áreas de la ficha.');
  for (const area of poll.areas) {
    const options = poll.options[area];
    if (!options || options.length < 2 || options.length > 3 || new Set(options.map(option => option.id)).size !== options.length
      || options.some(option => !option.id || option.id === '__invalid__' || !option.name?.trim())) {
      throw new Error('Cada área debe tener dos o tres opciones distintas para imprimir.');
    }
  }
}

export function paperChoiceBoxes(poll: PaperBallotDefinition): PaperChoiceBox[] {
  validatePaperDefinition(poll);
  return poll.areas.flatMap((area, section) => [...poll.options[area]!, { id: null, name: 'Voto en blanco' }]
    .map((option, row) => ({ area, optionId: option.id, name: option.name, x: 43, y: 184 + section * 143 + row * 27, size: 15 })));
}

export function paperQrPayload(dataset: Dataset, pollId: string, code: string) {
  if (!['real', 'demo'].includes(dataset) || !pollId || pollId.includes('|') || !/^[A-Za-z0-9_-]{20,128}$/.test(code)) {
    throw new Error('No se puede generar el identificador anónimo de esta ficha.');
  }
  return `AE27|${dataset}|${pollId}|${code}`;
}

export function parsePaperQr(value: string): { dataset: Dataset; pollId: string; code: string } | null {
  const parts = value.split('|');
  if (parts.length !== 4 || parts[0] !== 'AE27' || !['real', 'demo'].includes(parts[1]) || !parts[2]
    || parts[2].length > 100 || !/^[A-Za-z0-9_-]{20,128}$/.test(parts[3])) return null;
  return { dataset: parts[1] as Dataset, pollId: parts[2], code: parts[3] };
}
