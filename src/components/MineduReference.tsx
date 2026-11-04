import type { Area, Block } from '../../shared/types';
import { getMineduIndicatorReference, MINEDU_PENDING_VERIFICATIONS, MINEDU_SOURCE, mineduSourceUrl } from '../../shared/minedu-reference';

export function MineduReference({ compact = false }: { compact?: boolean }) {
  return <section aria-label="Referencia documental MINEDU" style={{ border: '1px solid var(--line, #dce4ef)', borderRadius: 10, padding: compact ? 12 : 16, background: 'var(--surface, #fff)', fontSize: compact ? 12 : 13, lineHeight: 1.6 }}>
    <details>
      <summary style={{ cursor: 'pointer', color: 'var(--navy, #173e6d)', fontWeight: 700 }}>Ficha adaptada con referencia a la guía MINEDU</summary>
      <div style={{ paddingTop: 10 }}>
        <p>Este registro recoge la exposición y una muestra del ejemplar físico. Es una valoración orientativa del colegio; la ficha formal por texto, edición y grado y sus verificaciones se documentan aparte.</p>
        <ul style={{ paddingLeft: 20 }}>
          <li><strong>Colegio:</strong> escala de 0 a 4, con diez criterios de exposición y la respuesta a la pregunta obligatoria. Máximo 44 puntos, convertido a una nota orientativa sobre 100.</li>
          <li><strong>Guía:</strong> niveles 0, 1 y 2, con puntajes propios para sus indicadores y un máximo de 100. Las referencias de esta ficha no convierten las notas institucionales en una calificación oficial de la guía.</li>
        </ul>
        <p>La guía cita 70 puntos para la terna formal (<a href={mineduSourceUrl(14)} target="_blank" rel="noreferrer">página 14</a>). En el ranking orientativo de esta jornada se muestran como <strong>referencia informativa, sin bloquear la clasificación</strong>. La elección final corresponde a las familias entre las tres propuestas clasificadas.</p>
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Verificaciones que se completan aparte</summary>
          <ul style={{ paddingLeft: 20 }}>
            {MINEDU_PENDING_VERIFICATIONS.map(item => <li key={item.id} style={{ marginTop: 8 }}><strong>{item.label}.</strong> {item.detail} <a href={mineduSourceUrl(item.pages[0])} target="_blank" rel="noreferrer">Ver guía</a>.</li>)}
          </ul>
          <p>Las verificaciones que no se realizaron quedan pendientes. Una valoración institucional de cero no acredita por sí sola el incumplimiento de un indicador oficial, y una muestra no acredita el cumplimiento del texto completo.</p>
        </details>
        <p style={{ marginBottom: 0 }}><a href={MINEDU_SOURCE.path} target="_blank" rel="noreferrer">Consultar la guía adjunta completa (PDF, 40 páginas)</a><br /><span style={{ color: 'var(--muted, #64748b)' }}>Archivo proporcionado por el centro, con metadatos de 2013. La vigencia normativa debe cotejarse por el comité.</span></p>
      </div>
    </details>
  </section>;
}

/** A source hint for one institutional observation; it never adds a second rating control. */
export function MineduIndicatorReference({ indicatorId, area, block }: { indicatorId: string; area?: Area; block?: Block }) {
  const reference = getMineduIndicatorReference(indicatorId, area, block);
  if (!reference) return null;
  const pageLabel = `${reference.pages.length === 1 ? 'p.' : 'pp.'} ${reference.pages.join(', ')}`;
  return <aside aria-label={`Referencia MINEDU de ${indicatorId}`} style={{ borderLeft: '2px solid var(--line, #dce4ef)', paddingLeft: 9, color: 'var(--muted, #64748b)', fontSize: 12, lineHeight: 1.5 }}>
    <div><a href={mineduSourceUrl(reference.pages[0])} target="_blank" rel="noreferrer">Referencia de la guía: {reference.guideIds.length === 1 ? 'indicador' : 'indicadores'} {reference.guideIds.join(', ')} · {pageLabel}</a></div>
    <details>
      <summary style={{ cursor: 'pointer' }}>Qué observar según la guía</summary>
      <div>{reference.observation}{reference.qualification ? ` ${reference.qualification}` : ''}</div>
    </details>
  </aside>;
}

export default MineduReference;
