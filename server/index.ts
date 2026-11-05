import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:https';
import { resolve } from 'node:path';
const app = express();
app.disable('x-powered-by');
const port = Number(process.env.PORT || 8788);
const databaseApi = process.env.POSTGREST_URL || 'http://127.0.0.1:3000';
const dist = resolve('dist');
const actions = new Set('paper_attendance_save paper_manual_cast paper_manual_correct paper_evidence_add paper_evidence_list paper_evidence_get paper_evidence_delete presentation_enable_question presentation_question_save data_delete_preview data_delete_apply presentation_draw presentation_ranking_generate paper_poll_create paper_ballots_generate paper_scan_cast paper_poll_close director_login teacher_register presentation_save presentation_close presentation_reopen presentation_restart_scale presentation_shortlist_publish presentation_summary snapshot public_snapshot vote_preview vote_cast settings_save publisher_save series_save offer_save book_save teacher_save assignment_save section_save attendance_save access_create evaluation_save evaluation_close evaluation_reopen review_request turn_control shortlist_publish shortlist_exception shortlist_reopen round_create round_open delivery_mark paper_tally_save round_close runoff_open ballots_generate round_reconcile incident_save import_preview import_apply backup_get restore_preview restore_apply demo_reset'.split(' '));
app.use((_request,response,next)=>{
  response.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src blob:; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"});next();
});
app.get('/health',async(_req,res)=>{
  try { const r=await fetch(databaseApi,{signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error();res.json({service:'seleccion-textos-2027',database:'ready'}); }
  catch {res.status(503).json({service:'seleccion-textos-2027',database:'unavailable'});}
});
app.get('/config.json',(_req,res)=>res.set('Cache-Control','no-store').json({mode:'local',url:'',publishableKey:'',coordinatorEmail:''}));
app.use('/api',express.json({limit:'16mb'}));
app.post('/api/rpc',async(req,res)=>{
  res.set('Cache-Control','no-store');
  // No access log or request/body/IP logging: ballots contain a private bearer code.
  const body=req.body;
  if(!body||typeof body!=='object'||!actions.has(body.p_action)||!['real','demo'].includes(body.p_dataset)||body.p_code!==null&&typeof body.p_code!=='string'||body.p_code?.length>250||!body.p_payload||typeof body.p_payload!=='object'||Array.isArray(body.p_payload)){
    res.status(400).json({code:'PT400',message:'Solicitud no válida.'});return;
  }
  const origin=req.get('origin');
  if(origin){try{if(new URL(origin).host!==req.get('host')){res.status(403).json({code:'PT403',message:'Origen de la solicitud no autorizado.'});return;}}catch{res.sendStatus(403);return;}}
  try {
    const result=await fetch(`${databaseApi}/rpc/textos_api`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_action:body.p_action,p_payload:body.p_payload,p_code:body.p_code,p_dataset:body.p_dataset}),signal:AbortSignal.timeout(45000)});
    const data=await result.text();res.status(result.status).type('json').send(data);
  } catch {res.status(503).json({code:'PT423',message:'La base no confirmó la operación. Conserva el borrador y vuelve a intentar.'});}
});
app.use('/api',(_req,res)=>res.status(404).json({code:'PT404',message:'Ruta no disponible.'}));
if(existsSync(dist)){
  app.use(express.static(dist,{index:false,maxAge:'1h',setHeaders:(res,path)=>{if(path.endsWith('.html'))res.setHeader('Cache-Control','no-cache')}}));
  app.get('/{*path}',(_req,res)=>res.set('Cache-Control','no-cache').sendFile(resolve(dist,'index.html')));
}
app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(400).json({code:'PT400',message:'La solicitud no se pudo interpretar.'});});
if(process.env.TLS_CERT_FILE&&process.env.TLS_KEY_FILE){
  createServer({cert:readFileSync(process.env.TLS_CERT_FILE),key:readFileSync(process.env.TLS_KEY_FILE)},app).listen(port,'0.0.0.0',()=>console.log(`Selección de textos: HTTPS en puerto ${port}`));
}else app.listen(port,'0.0.0.0',()=>console.log(`Selección de textos: HTTP en puerto ${port}`));
