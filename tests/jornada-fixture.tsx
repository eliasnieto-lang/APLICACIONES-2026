// Isolated browser UI fixture. The test runner intercepts every fixture request.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Api, Snapshot } from '../shared/types';
import PresentationEvaluations from '../src/views/PresentationEvaluations';
import TeacherProgress from '../src/views/TeacherProgress';
import PresentationRanking from '../src/views/PresentationRanking';
import '../src/styles.css';
const view = new URLSearchParams(location.search).get('jornadaView') ?? 'progress';
const api: Api = {
  dataset: 'demo', draftSecret: () => 'isolated-jornada-ui-secret',
  async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch('/api/jornada-fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload, view }) });
    const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.message), { status: response.status }); return value;
  },
};
function Fixture() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const refresh = async () => { setSnapshot(await api.call<Snapshot>('snapshot')); };
  useEffect(() => { void refresh(); }, []);
  const View = view === 'teacher' ? PresentationEvaluations : view === 'ranking' ? PresentationRanking : TeacherProgress;
  return <main className="main-content"><button type="button" onClick={() => void refresh()}>Actualizar datos de ensayo</button>{snapshot && <View snapshot={snapshot} api={api} refresh={refresh} notify={() => undefined} />}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
