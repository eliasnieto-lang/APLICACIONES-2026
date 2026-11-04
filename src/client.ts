import type { Api, Dataset } from '../shared/types';
export interface Config { mode: 'cloud' | 'local'; url: string; publishableKey: string; coordinatorEmail?: string }
interface Session { access_token: string; refresh_token: string; expires_at: number }
export class ApiError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); this.name = 'ApiError'; }
}
const sessionKey = 'textos-coordinator-session-v1';
let currentSession: Session | null = null;
try { currentSession = JSON.parse(sessionStorage.getItem(sessionKey) || 'null'); } catch { /* fresh session */ }
function remember(session: Session | null) {
  currentSession = session;
  try { session ? sessionStorage.setItem(sessionKey, JSON.stringify(session)) : sessionStorage.removeItem(sessionKey); } catch { /* memory session works */ }
}
async function parseResponse(response: Response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = result.error && typeof result.error === 'object' ? result.error : result;
    const code = String(detail.code || result.code || result.error_code || response.status);
    let message = 'No se pudo completar la operación. Inténtalo de nuevo.';
    if (code === 'invalid_credentials' || result.error === 'invalid_grant') message = 'El correo o la contraseña de coordinación no son correctos.';
    else if (code === 'email_not_confirmed') message = 'Confirma el correo de coordinación en Supabase antes de entrar.';
    else if (/^PT(400|401|403|404|409|413|423|429)$/.test(code) && typeof detail.message === 'string') message = detail.message.slice(0, 900);
    else if (response.status === 429) message = 'Se han realizado muchos intentos. Espera unos minutos antes de volver a entrar.';
    else if (code === 'PGRST202') message = 'Falta instalar la base de datos de Selección de textos. Sigue el paso de instalación indicado para Supabase.';
    else if (response.status === 401) message = 'El acceso no es válido o caducó. Vuelve a entrar con tu código individual.';
    else if (response.status === 403) message = 'Tu acceso no permite esta operación.';
    else if (response.status >= 500) message = 'El servidor no pudo confirmar la operación. Conserva tu borrador y vuelve a intentarlo.';
    throw new ApiError(message, code, response.status);
  }
  return result;
}
async function auth(config: Config, grant: string, body: object): Promise<Session> {
  const response = await fetch(`${config.url}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST', headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
  });
  const value = await parseResponse(response);
  return { access_token: value.access_token, refresh_token: value.refresh_token, expires_at: Date.now() + Number(value.expires_in || 3600) * 1000 };
}
export async function signInCoordinator(config: Config, email: string, password: string) {
  remember(await auth(config, 'password', { email: email.trim(), password }));
}
export async function signOut(config: Config) {
  const token = currentSession?.access_token;
  remember(null);
  if (token && config.mode === 'cloud') await fetch(`${config.url}/auth/v1/logout`, { method: 'POST', headers: { apikey: config.publishableKey, Authorization: `Bearer ${token}` } }).catch(() => undefined);
}
export function hasCoordinatorSession() { return !!currentSession; }
let renewal: Promise<void> | null = null;
async function jwt(config: Config) {
  if (!currentSession) throw new ApiError('Vuelve a entrar como coordinación.', 'PT401', 401);
  if (currentSession.expires_at < Date.now() + 45000) {
    if (!renewal) renewal = auth(config, 'refresh_token', { refresh_token: currentSession.refresh_token }).then(remember).catch(error => { remember(null); throw error; }).finally(() => { renewal = null; });
    await renewal;
  }
  return currentSession!.access_token;
}
export function createApi(config: Config, dataset: Dataset, credential: { code?: string; coordinator?: boolean } = {}): Api {
  const code = credential.code?.trim() || null;
  return {
    dataset,
    draftSecret: () => code || '',
    async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
      const publicAction = ['public_snapshot', 'vote_preview', 'vote_cast', 'teacher_register', 'director_login'].includes(action);
      const requestCode = ['public_snapshot', 'director_login'].includes(action) ? null : code;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.mode === 'cloud') {
        headers.apikey = config.publishableKey;
        if (credential.coordinator && !publicAction) headers.Authorization = `Bearer ${await jwt(config)}`;
      }
      let response: Response;
      try {
        response = await fetch(config.mode === 'local' ? '/api/rpc' : `${config.url}/rest/v1/rpc/textos_api`, {
          method: 'POST', headers, body: JSON.stringify({ p_action: action, p_payload: payload, p_code: requestCode, p_dataset: dataset }), cache: 'no-store', referrerPolicy: 'no-referrer',
        });
      } catch { throw new ApiError('Sin conexión. La operación todavía no está confirmada por el servidor.', 'NETWORK', 0); }
      return await parseResponse(response) as T;
    },
  };
}
