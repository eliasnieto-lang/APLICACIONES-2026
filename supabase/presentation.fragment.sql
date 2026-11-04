-- Live presentations: independent of historical book dossiers and two-review assignments.
-- Insert before textos_api; only textos_api is granted to application roles.
create or replace function public.textos_presentation_teacher_matches(t jsonb, area text, block text) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(t->>'area'=area and jsonb_typeof(t->'categories')='array' and t->'categories' ? block,false)
$$;

create or replace function public.textos_presentation_publisher_available(s jsonb, publisher_id text, area text, block text) returns boolean
language sql stable set search_path=pg_catalog,public as $$
 select public.textos_find(s,'publishers',publisher_id) is not null and (
  not exists(select 1 from jsonb_array_elements(coalesce(s->'offers','[]')) o join jsonb_array_elements(coalesce(s->'series','[]')) r on r->>'id'=o->>'seriesId' where r->>'publisherId'=publisher_id)
  or exists(select 1 from jsonb_array_elements(coalesce(s->'offers','[]')) o join jsonb_array_elements(coalesce(s->'series','[]')) r on r->>'id'=o->>'seriesId' where r->>'publisherId'=publisher_id and o->>'status'='offered' and o->>'area'=area and o->>'block'=block)
 )
$$;

create or replace function public.textos_presentation_validate(s jsonb) returns void
language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare e jsonb; q jsonb; t jsonb; c text;
begin
 foreach c in array array['presentationEvaluations','presentationShortlists'] loop
  if s ? c and jsonb_typeof(s->c) is distinct from 'array' then perform public.textos_fail('Colección de exposición inválida.'); end if;
 end loop;
 for t in select value from jsonb_array_elements(coalesce(s->'teachers','[]')) loop
  if t ? 'area' or t ? 'categories' or t->'selfRegistered'='true'::jsonb then
   if coalesce(t->>'area','') not in ('MAT','COM') or jsonb_typeof(t->'categories') is distinct from 'array' then perform public.textos_fail('Seleccione área y al menos una categoría docente.'); end if;
   if jsonb_array_length(t->'categories')<1 or exists(select 1 from jsonb_array_elements(t->'categories') q where q not in ('"P1"'::jsonb,'"P2"'::jsonb,'"S1"'::jsonb))
    or jsonb_array_length(t->'categories')<>(select count(distinct q) from jsonb_array_elements(t->'categories') q) then perform public.textos_fail('Categorías docentes inválidas.'); end if;
  end if;
 end loop;
 for e in select value from jsonb_array_elements(coalesce(s->'presentationEvaluations','[]')) loop
  if jsonb_typeof(e) is distinct from 'object' or nullif(e->>'id','') is null or not public.textos_int(e->'version') or (e->>'version')::int<1
   or public.textos_find(s,'teachers',e->>'teacherId') is null or public.textos_find(s,'publishers',e->>'publisherId') is null
   or coalesce(e->>'area','') not in ('MAT','COM') or coalesce(e->>'block','') not in ('P1','P2','S1')
   or coalesce(e->>'status','') not in ('draft','closed') or not public.textos_int(e->'rulesVersion') or (e->>'rulesVersion')::int<1
   or jsonb_typeof(e->'notes') is distinct from 'array' or jsonb_typeof(e->'generalObservation') is distinct from 'string'
   or jsonb_typeof(e->'physicalText') is distinct from 'string' or jsonb_typeof(e->'updatedAt') is distinct from 'string'
   or (e ? 'materialViewed' and jsonb_typeof(e->'materialViewed') is distinct from 'boolean') then perform public.textos_fail('Ficha de exposición inválida.'); end if;
  if jsonb_array_length(e->'notes')<>10 or exists(select 1 from jsonb_array_elements(e->'notes') q where jsonb_typeof(q)<>'string') then perform public.textos_fail('Las diez observaciones pueden quedar vacías, pero deben ser texto.'); end if;
  perform public.textos_scores(e->'scores',e->>'status'='closed');
  if (e->>'status'='closed' and (jsonb_typeof(e->'closedAt') is distinct from 'string' or nullif(e->>'closedAt','') is null))
   or (e->>'status'='draft' and e->'closedAt' is distinct from 'null'::jsonb) then perform public.textos_fail('Fecha de cierre de exposición inválida.'); end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(coalesce(s->'presentationEvaluations','[]')) e group by e->>'id' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(coalesce(s->'presentationEvaluations','[]')) e group by e->>'teacherId',e->>'publisherId',e->>'area',e->>'block' having count(*)>1) then perform public.textos_fail('Una ficha de exposición por docente, editorial, área y categoría.'); end if;
 for e in select value from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) loop
  if jsonb_typeof(e) is distinct from 'object' or nullif(e->>'id','') is null or not public.textos_int(e->'version') or (e->>'version')::int<1
   or coalesce(e->>'area','') not in ('MAT','COM') or coalesce(e->>'block','') not in ('P1','P2','S1')
   or e->>'categoryId' is distinct from (e->>'area')||'-'||(e->>'block') or coalesce(e->>'status','') not in ('draft','published','superseded')
   or jsonb_typeof(e->'publisherIds') is distinct from 'array' or jsonb_typeof(e->'snapshot') is distinct from 'object' then perform public.textos_fail('Preselección de exposición inválida.'); end if;
  if jsonb_array_length(e->'publisherIds') not between 1 and 3 or (e->>'status'='published' and jsonb_array_length(e->'publisherIds')<>3) or jsonb_array_length(e->'publisherIds')<>(select count(distinct q) from jsonb_array_elements(e->'publisherIds') q)
   or exists(select 1 from jsonb_array_elements_text(e->'publisherIds') q where public.textos_find(s,'publishers',q) is null) then perform public.textos_fail('Preselección: una a tres editoriales distintas.'); end if;
  if e->>'status'='published' then
   if e->'directorApproved' is distinct from 'true'::jsonb or jsonb_typeof(e->'statement') is distinct from 'string' or nullif(trim(e->>'statement'),'') is null
    or jsonb_typeof(e->'folio') is distinct from 'string' or nullif(trim(e->>'folio'),'') is null
    or not public.textos_int(e->'rulesVersion') or (e->>'rulesVersion')::int<1
    or jsonb_typeof(e->'publishedAt') is distinct from 'string' or nullif(trim(e->>'publishedAt'),'') is null then perform public.textos_fail('La terna publicada requiere aprobación, apreciación, folio, reglas y fecha válidos.'); end if;
   begin
    if not isfinite((e->>'publishedAt')::timestamptz) then perform public.textos_fail('Fecha de publicación inválida.'); end if;
   exception when invalid_datetime_format or datetime_field_overflow then perform public.textos_fail('Fecha de publicación inválida.');
   end;
  end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) e group by e->>'id' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) e where e->>'status'='published' group by e->>'categoryId' having count(*)>1) then perform public.textos_fail('Versiones de preselección duplicadas.'); end if;
end $$;

create or replace function public.textos_presentation_publisher_summary(s jsonb, publisher_id text, area text, block text) returns jsonb
language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare registered integer; closed integer; drafts integer; score numeric; i2 numeric; threshold numeric; available boolean;
begin
 available:=public.textos_presentation_publisher_available(s,publisher_id,area,block);
 with registered_teachers as (
  select t from jsonb_array_elements(coalesce(s->'teachers','[]')) t where public.textos_presentation_teacher_matches(t,area,block)
 ), forms as (
  select t,e from registered_teachers left join lateral (
   select e from jsonb_array_elements(coalesce(s->'presentationEvaluations','[]')) e
   where e->>'teacherId'=t->>'id' and e->>'publisherId'=publisher_id and e->>'area'=area and e->>'block'=block
   order by (e->>'version')::int desc limit 1
  ) x on true
 ) select count(*),count(*) filter(where e->>'status'='closed'),count(*) filter(where e->>'status'='draft'),
  avg(public.textos_scores(e->'scores',true)) filter(where e->>'status'='closed'),avg((e#>>'{scores,1}')::numeric) filter(where e->>'status'='closed')
 into registered,closed,drafts,score,i2 from forms;
 threshold:=coalesce((s#>>'{settings,rules,threshold}')::numeric,70);
 if not available then registered:=0; closed:=0; drafts:=0; score:=null; i2:=null; end if;
 return jsonb_build_object('publisherId',publisher_id,'area',area,'block',block,'registered',registered,'closed',closed,'drafts',drafts,'pending',registered-closed,'score',score,'i2',i2,
  'state',case when registered=0 or closed<registered then 'pending' when score>=threshold then 'eligible' else 'ineligible' end);
end $$;

create or replace function public.textos_presentation_category(s jsonb, area text, block text) returns jsonb
language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare ranked jsonb; eligible jsonb; finalists jsonb:='[]'; tied jsonb:='[]'; reasons jsonb:='[]'; item jsonb; boundary jsonb;
 registered integer; closed integer; pending integer; n integer; state text; published boolean;
begin
 if coalesce(area,'') not in ('MAT','COM') or coalesce(block,'') not in ('P1','P2','S1') then perform public.textos_fail('Área o categoría de exposición inválida.'); end if;
 select count(*) into registered from jsonb_array_elements(coalesce(s->'teachers','[]')) t where public.textos_presentation_teacher_matches(t,area,block);
 select coalesce(jsonb_agg(q order by (q->>'score')::numeric desc nulls last,(q->>'i2')::numeric desc nulls last,q->>'publisherId'),'[]') into ranked
 from (select public.textos_presentation_publisher_summary(s,p->>'id',area,block) q from jsonb_array_elements(coalesce(s->'publishers','[]')) p where public.textos_presentation_publisher_available(s,p->>'id',area,block)) summaries;
 select coalesce(sum((q->>'closed')::int),0),coalesce(sum((q->>'pending')::int),0) into closed,pending from jsonb_array_elements(ranked) q;
 select coalesce(jsonb_agg(q order by ord),'[]') into eligible from jsonb_array_elements(ranked) with ordinality x(q,ord) where q->>'state'='eligible';
 n:=jsonb_array_length(eligible);
 for item in select value from jsonb_array_elements(eligible) limit 3 loop finalists:=finalists||jsonb_build_array(item->>'publisherId'); end loop;
 if n>3 then
  boundary:=eligible->2;
  if boundary->'score'=eligible#>'{3,score}' and boundary->'i2'=eligible#>'{3,i2}' then
   select coalesce(jsonb_agg(q->>'publisherId'),'[]') into tied from jsonb_array_elements(eligible) q where q->'score'=boundary->'score' and q->'i2'=boundary->'i2';
  end if;
 end if;
 published:=exists(select 1 from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) q where q->>'area'=area and q->>'block'=block and q->>'status'='published');
 state:=case when registered=0 or pending>0 or jsonb_array_length(ranked)=0 then 'pending' when jsonb_array_length(tied)>0 then 'tie' when n<3 then 'less_than_three' else 'ready' end;
 if registered=0 then reasons:=reasons||jsonb_build_array('No hay docentes registrados en esta área y categoría.'); end if;
 if pending>0 then reasons:=reasons||jsonb_build_array('Quedan '||pending||' fichas por cerrar.'); end if;
 if n<3 then reasons:=reasons||jsonb_build_array('Hay '||n||' editoriales que alcanzan el puntaje mínimo; se recomienda un máximo de tres.'); end if;
 if jsonb_array_length(tied)>0 then reasons:=reasons||jsonb_build_array('Persiste un empate en el corte después de comparar I2.'); end if;
 if jsonb_array_length(tied)>0 then finalists:='[]'; end if;
 return jsonb_build_object('categoryId',area||'-'||block,'area',area,'block',block,'state',case when published and state in ('ready','less_than_three') and n>0 then 'published' else state end,'registered',registered,'closed',closed,'pending',pending,'ranked',ranked,'finalists',finalists,'tied',tied,'reasons',reasons);
end $$;

create or replace function public.textos_presentation_teacher_state(s jsonb, actor_id text) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select jsonb_set(jsonb_set(s,'{presentationEvaluations}',coalesce((select jsonb_agg(e) from jsonb_array_elements(coalesce(s->'presentationEvaluations','[]')) e where e->>'teacherId'=actor_id),'[]')),
  '{presentationShortlists}','[]')
$$;

-- Enumerate the public projection, including restored snapshots: custom fields and raw
-- teacher sheets must never become public merely because they were in a backup.
create or replace function public.textos_presentation_public_shortlist(e jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare a jsonb:=e#>'{snapshot,assessment}'; ranked jsonb; publishers jsonb;
begin
 select coalesce(jsonb_agg(jsonb_build_object('publisherId',q->>'publisherId','area',q->>'area','block',q->>'block',
  'registered',case when public.textos_int(q->'registered') then q->'registered' else '0'::jsonb end,
  'closed',case when public.textos_int(q->'closed') then q->'closed' else '0'::jsonb end,
  'pending',case when public.textos_int(q->'pending') then q->'pending' else '0'::jsonb end,
  'drafts',case when public.textos_int(q->'drafts') then q->'drafts' else '0'::jsonb end,
  'score',case when jsonb_typeof(q->'score')='number' then q->'score' else 'null'::jsonb end,
  'i2',case when jsonb_typeof(q->'i2')='number' then q->'i2' else 'null'::jsonb end,'state',q->>'state')),'[]') into ranked
 from jsonb_array_elements(case when jsonb_typeof(a->'ranked')='array' then a->'ranked' else '[]'::jsonb end) q;
 select coalesce(jsonb_agg(jsonb_build_object('id',q->>'id','name',q->>'name')),'[]') into publishers
 from jsonb_array_elements(case when jsonb_typeof(e#>'{snapshot,publishers}')='array' then e#>'{snapshot,publishers}' else '[]'::jsonb end) q;
 a:=jsonb_build_object('categoryId',a->>'categoryId','area',a->>'area','block',a->>'block','state',a->>'state',
  'registered',case when public.textos_int(a->'registered') then a->'registered' else '0'::jsonb end,
  'closed',case when public.textos_int(a->'closed') then a->'closed' else '0'::jsonb end,
  'pending',case when public.textos_int(a->'pending') then a->'pending' else '0'::jsonb end,
  'ranked',ranked,'finalists',case when jsonb_typeof(a->'finalists')='array' then (select coalesce(jsonb_agg(q),'[]') from jsonb_array_elements(a->'finalists') q where jsonb_typeof(q)='string') else '[]'::jsonb end,
  'tied',case when jsonb_typeof(a->'tied')='array' then (select coalesce(jsonb_agg(q),'[]') from jsonb_array_elements(a->'tied') q where jsonb_typeof(q)='string') else '[]'::jsonb end,
  'reasons',case when jsonb_typeof(a->'reasons')='array' then (select coalesce(jsonb_agg(q),'[]') from jsonb_array_elements(a->'reasons') q where jsonb_typeof(q)='string') else '[]'::jsonb end);
 return jsonb_build_object('id',e->>'id','version',e->'version','categoryId',e->>'categoryId','area',e->>'area','block',e->>'block',
  'publisherIds',e->'publisherIds','status','published','statement',e->>'statement','folio',e->>'folio',
  'directorApproved',e->'directorApproved','publishedAt',e->'publishedAt','rulesVersion',e->'rulesVersion',
  'snapshot',jsonb_build_object('assessment',a,'publishers',publishers,'threshold',case when jsonb_typeof(e#>'{snapshot,threshold}')='number' then e#>'{snapshot,threshold}' else 'null'::jsonb end));
end $$;

create or replace function public.textos_presentation_public_state(s jsonb) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select jsonb_set(jsonb_set(s,'{presentationEvaluations}','[]'),'{presentationShortlists}',coalesce((select jsonb_agg(public.textos_presentation_public_shortlist(e)) from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) e where e->>'status'='published'),'[]'))
$$;

create or replace function public.textos_presentation_api(s jsonb, p_action text, p_payload jsonb, actor_role text, actor_id text, actor_name text, nowat timestamptz) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare ev jsonb; entity jsonb; t jsonb; q jsonb; assessment jsonb; notes jsonb; history jsonb:='[]'; result jsonb;
 area text; block text; publisher_id text; reason text; expected integer; v integer;
begin
 if coalesce(p_action,'') not in ('presentation_save','presentation_close','presentation_reopen','presentation_summary','presentation_shortlist_publish') then perform public.textos_fail('Operación de exposición desconocida.','PT404'); end if;
 if jsonb_typeof(p_payload) is distinct from 'object' then perform public.textos_fail('Petición de exposición inválida.'); end if;
 if p_action in ('presentation_save','presentation_close') then
  if actor_role is distinct from 'teacher' then perform public.textos_fail('Solo el docente puede emitir su propia ficha de exposición.','PT403'); end if;
  t:=public.textos_find(s,'teachers',actor_id);
  if t is null then perform public.textos_fail('Perfil docente no encontrado.','PT403'); end if;
 elsif p_action='presentation_summary' then
  if coalesce(actor_role,'') not in ('coordinator','secretary') then perform public.textos_fail('Operación reservada a coordinación o mesa.','PT403'); end if;
 else
  if actor_role is distinct from 'coordinator' then perform public.textos_fail('Operación reservada a coordinación.','PT403'); end if;
 end if;
 if p_action='presentation_save' then
  area:=p_payload->>'area'; block:=p_payload->>'block'; publisher_id:=p_payload->>'publisherId';
  if not public.textos_presentation_teacher_matches(t,area,block) then perform public.textos_fail('La ficha no corresponde al área y las categorías de su perfil.','PT403'); end if;
  if not public.textos_presentation_publisher_available(s,publisher_id,area,block) then perform public.textos_fail('La editorial no participa en esta área y categoría.','PT403'); end if;
  select e into ev from jsonb_array_elements(coalesce(s->'presentationEvaluations','[]')) e where e->>'teacherId'=actor_id and e->>'publisherId'=publisher_id and e->>'area'=area and e->>'block'=block;
 elsif p_action in ('presentation_close','presentation_reopen') then
  ev:=public.textos_find(s,'presentationEvaluations',p_payload->>'evaluationId');
  if ev is null then perform public.textos_fail('Ficha de exposición no encontrada.','PT404'); end if;
  area:=ev->>'area'; block:=ev->>'block'; publisher_id:=ev->>'publisherId';
  if p_action='presentation_close' and (ev->>'teacherId'<>actor_id or not public.textos_presentation_teacher_matches(t,area,block)) then perform public.textos_fail('Solo puede cerrar su propia ficha dentro de su perfil.','PT403'); end if;
  if p_action='presentation_close' and not public.textos_presentation_publisher_available(s,publisher_id,area,block) then perform public.textos_fail('La editorial ya no participa en esta área y categoría.','PT403'); end if;
 end if;
 if p_action in ('presentation_save','presentation_close') then
  if not public.textos_int(p_payload->'expectedVersion') then perform public.textos_fail('La ficha requiere su versión para evitar sobrescrituras.','PT409'); end if;
  expected:=(p_payload->>'expectedVersion')::int;
  if expected<>coalesce((ev->>'version')::int,0) then perform public.textos_fail('La ficha cambió en otra pestaña; conserve su borrador y recargue.','PT409'); end if;
  if ev->>'status'='closed' then perform public.textos_fail('La ficha está cerrada; coordinación puede reabrir con motivo.','PT423'); end if;
 end if;
 if p_action='presentation_save' then
  perform public.textos_scores(p_payload->'scores');
  notes:=coalesce(p_payload->'notes','["","","","","","","","","",""]'::jsonb);
  if jsonb_typeof(notes) is distinct from 'array' then perform public.textos_fail('Observaciones inválidas.'); end if;
  if jsonb_array_length(notes)<>10 or exists(select 1 from jsonb_array_elements(notes) q where jsonb_typeof(q)<>'string') then perform public.textos_fail('Las diez observaciones son opcionales y deben ser texto.'); end if;
  if (p_payload ? 'generalObservation' and jsonb_typeof(p_payload->'generalObservation') is distinct from 'string') or (p_payload ? 'physicalText' and jsonb_typeof(p_payload->'physicalText') is distinct from 'string')
   or (p_payload ? 'materialViewed' and jsonb_typeof(p_payload->'materialViewed') is distinct from 'boolean') then perform public.textos_fail('Datos de observación inválidos.'); end if;
  entity:=coalesce(ev,'{}')||jsonb_build_object('id',coalesce(ev->>'id',gen_random_uuid()::text),'version',coalesce((ev->>'version')::int,0)+1,'publisherId',publisher_id,'teacherId',actor_id,'area',area,'block',block,'scores',p_payload->'scores','notes',notes,'generalObservation',coalesce(p_payload->>'generalObservation',''),'physicalText',coalesce(p_payload->>'physicalText',''),'status','draft','closedAt',null,'updatedAt',nowat,'rulesVersion',s#>'{settings,rules,version}');
  if p_payload ? 'materialViewed' then entity:=entity||jsonb_build_object('materialViewed',p_payload->'materialViewed'); end if;
  if nullif(s#>>'{settings,rules,lockedAt}','') is null then
   s:=jsonb_set(s,'{settings,rules,lockedAt}',to_jsonb(nowat));
   s:=jsonb_set(s,'{settings,version}',to_jsonb(coalesce((s#>>'{settings,version}')::int,0)+1));
  end if;
 elsif p_action='presentation_close' then
  perform public.textos_scores(ev->'scores',true);
  entity:=ev||jsonb_build_object('status','closed','closedAt',nowat,'updatedAt',nowat,'version',(ev->>'version')::int+1);
 elsif p_action='presentation_reopen' then
  reason:=trim(coalesce(p_payload->>'reason',''));
  if reason='' or jsonb_typeof(p_payload->'reason') is distinct from 'string' then perform public.textos_fail('Indique el motivo de la reapertura.'); end if;
  if ev->>'status'<>'closed' then perform public.textos_fail('La ficha ya está abierta.','PT409'); end if;
  entity:=ev||jsonb_build_object('status','draft','closedAt',null,'updatedAt',nowat,'version',(ev->>'version')::int+1);
  for q in select e from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) e where e->>'area'=area and e->>'block'=block and e->>'status'='published' loop
   history:=history||jsonb_build_array(jsonb_build_object('entity','presentationShortlists','referenceId',q->>'id','previous',q,'reason',reason));
   s:=public.textos_put(s,'presentationShortlists',q||jsonb_build_object('status','superseded','version',(q->>'version')::int+1));
  end loop;
 elsif p_action='presentation_summary' then
  if p_payload ? 'area' or p_payload ? 'block' then result:=public.textos_presentation_category(s,p_payload->>'area',p_payload->>'block');
  else
   select jsonb_agg(public.textos_presentation_category(s,a,b) order by a,b) into result from unnest(array['MAT','COM']) a cross join unnest(array['P1','P2','S1']) b;
  end if;
  return jsonb_build_object('state',s,'result',result,'history',history);
 elsif p_action='presentation_shortlist_publish' then
  area:=p_payload->>'area'; block:=p_payload->>'block'; assessment:=public.textos_presentation_category(s,area,block);
  if p_payload->'directorApproved' is distinct from 'true'::jsonb or jsonb_typeof(p_payload->'statement') is distinct from 'string' or jsonb_typeof(p_payload->'folio') is distinct from 'string' or nullif(trim(p_payload->>'statement'),'') is null or nullif(trim(p_payload->>'folio'),'') is null then perform public.textos_fail('La publicación requiere aprobación de Dirección, apreciación y folio.'); end if;
  if s#>'{settings,editorsWithdrawn}' is distinct from 'true'::jsonb or nullif(trim(s#>>'{settings,withdrawalReference}'),'') is null then perform public.textos_fail('La publicación requiere el retiro documentado de las editoriales y su referencia.','PT423'); end if;
  if assessment->>'state' not in ('ready','published') or jsonb_array_length(assessment->'finalists')<>3 then perform public.textos_fail('La publicación formal requiere tres editoriales elegibles, todas las fichas cerradas y ningún empate pendiente.','PT423'); end if;
  for q in select e from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) e where e->>'area'=area and e->>'block'=block and e->>'status'='published' loop
   history:=history||jsonb_build_array(jsonb_build_object('entity','presentationShortlists','referenceId',q->>'id','previous',q,'reason','Nueva publicación de la preselección de exposición'));
   s:=public.textos_put(s,'presentationShortlists',q||jsonb_build_object('status','superseded','version',(q->>'version')::int+1));
  end loop;
  select coalesce(max((e->>'version')::int),0)+1 into v from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) e where e->>'area'=area and e->>'block'=block;
  entity:=jsonb_build_object('id',gen_random_uuid()::text,'version',v,'categoryId',area||'-'||block,'area',area,'block',block,'publisherIds',assessment->'finalists','status','published','statement',p_payload->>'statement','folio',p_payload->>'folio','directorApproved',true,'publishedAt',nowat,'rulesVersion',s#>'{settings,rules,version}','snapshot',jsonb_build_object('assessment',assessment,'threshold',s#>'{settings,rules,threshold}','publishers',coalesce((select jsonb_agg(jsonb_build_object('id',p->>'id','name',p->>'name')) from jsonb_array_elements(coalesce(s->'publishers','[]')) p where assessment->'finalists' ? (p->>'id')),'[]')));
  s:=public.textos_put(s,'presentationShortlists',entity);
  return jsonb_build_object('state',s,'result',entity,'history',history);
 end if;
 if ev is not null then history:=history||jsonb_build_array(jsonb_build_object('entity','presentationEvaluations','referenceId',ev->>'id','previous',ev,'reason',coalesce(nullif(reason,''),p_action))); end if;
 s:=public.textos_put(s,'presentationEvaluations',entity);
 return jsonb_build_object('state',s,'result',entity,'history',history);
end $$;
