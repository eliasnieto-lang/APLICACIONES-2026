export interface EditorialAgendaItem {
  label: string;
  range: string;
  startSeconds: number;
  endSeconds: number;
}

function validDuration(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 1) throw new Error('El tiempo de exposición debe ser un número entero de segundos mayor que cero.');
  return seconds;
}

/** Human-readable wording follows the configured clock, including short demonstration turns. */
export function editorialDurationText(seconds: number): string {
  validDuration(seconds);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return [minutes ? `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}` : '', rest ? `${rest} ${rest === 1 ? 'segundo' : 'segundos'}` : ''].filter(Boolean).join(' y ');
}

const clock = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

/** Suggested distribution only: it never adds time to the editorial's shared turn. */
export function editorialAgendaSegments(seconds: number): EditorialAgendaItem[] {
  validDuration(seconds);
  if (seconds < 60) return [{ label: 'Presentación de la propuesta y cierre', range: `00:00–${clock(seconds)}`, startSeconds: 0, endSeconds: seconds }];
  const parts = [
    { boundary: 0.1, label: 'Identificación de la propuesta y cobertura' },
    { boundary: 0.3, label: 'Propuesta de Matemática' },
    { boundary: 0.5, label: 'Propuesta de Comunicación' },
    { boundary: 0.7, label: 'Ejemplar físico, actividades y recursos de apoyo' },
    { boundary: 0.9, label: 'Año de edición, precios de los packs y beneficios' },
    { boundary: 1, label: 'Cierre y pregunta del representante docente' },
  ];
  let startSeconds = 0;
  return parts.map(part => {
    const endSeconds = Math.round(seconds * part.boundary);
    const item = { label: part.label, range: `${clock(startSeconds)}–${clock(endSeconds)}`, startSeconds, endSeconds };
    startSeconds = endSeconds;
    return item;
  });
}

export function editorialAgenda(seconds: number): readonly (readonly [string, string])[] {
  return editorialAgendaSegments(seconds).map(item => [item.range, item.label] as const);
}
