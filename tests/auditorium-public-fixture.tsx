import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Snapshot } from '../shared/types';
import PresentationPublicView from '../src/views/PresentationPublicView';
import '../src/styles.css';
function Fixture() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const refresh = async () => { const response = await fetch('/api/auditorium-public-fixture'); if (!response.ok) throw Error('No se pudo actualizar.'); setSnapshot(await response.json()); };
  useEffect(() => { void refresh(); }, []);
  return snapshot ? <PresentationPublicView data={snapshot} refresh={refresh} /> : <p>Cargando pantalla pública…</p>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
