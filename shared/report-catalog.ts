import type { AreaDefinition } from './types';

/** Additional report subjects are captured without changing the approved scoring catalog. */
export const SUPPLEMENTAL_REPORT_AREAS: readonly AreaDefinition[] = [
  {
    id: 'ingles', name: 'Inglés', group: 'other', eligible: false,
    competencies: [
      'Se comunica oralmente en inglés como lengua extranjera',
      'Lee diversos tipos de textos escritos en inglés como lengua extranjera',
      'Escribe diversos tipos de textos en inglés como lengua extranjera',
    ],
  },
  {
    id: 'educacion-fisica', name: 'Educación Física', group: 'other', eligible: false,
    competencies: [
      'Se desenvuelve de manera autónoma a través de su motricidad',
      'Asume una vida saludable',
      'Interactúa a través de sus habilidades sociomotrices',
    ],
  },
  {
    id: 'arte-cultura', name: 'Arte y Cultura', group: 'other', eligible: false,
    competencies: [
      'Aprecia de manera crítica manifestaciones artístico-culturales',
      'Crea proyectos desde los lenguajes artísticos',
    ],
  },
  {
    id: 'educacion-religiosa', name: 'Educación Religiosa', group: 'other', eligible: false,
    competencies: [
      'Construye su identidad como persona humana, amada por Dios, digna, libre y trascendente, comprendiendo la doctrina de su propia religión, abierto al diálogo con las que le son cercanas',
      'Asume la experiencia del encuentro personal y comunitario con Dios en su proyecto de vida en coherencia con su creencia religiosa',
    ],
  },
  {
    id: 'educacion-trabajo', name: 'Educación para el Trabajo', group: 'other', eligible: false,
    competencies: ['Gestiona proyectos de emprendimiento económico o social'],
  },
];
