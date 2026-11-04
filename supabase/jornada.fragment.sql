-- BEGIN JORNADA HELPERS
-- Only textos_api holds the dataset lock, authenticates the actor and persists
-- these pure state transitions. Helpers are not public RPC entry points.

-- Enumerate the schedule projection: restored custom fields never become public.
create or replace function public.textos_jornada_draw_public(d jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select case when d is null or d='null'::jsonb then null else jsonb_build_object(
  'id',d->>'id','version',d->'version',
  'publishers',coalesce((select jsonb_agg(jsonb_build_object('id',p->>'id','name',p->>'name') order by ord)
   from jsonb_array_elements(d->'publishers') with ordinality q(p,ord)),'[]'::jsonb),
  'completedPublisherIds',d->'completedPublisherIds','createdAt',d->>'createdAt','createdBy','Subdirección'
 ) end
$$;

create or replace function public.textos_jornada_fingerprint(s jsonb) returns text
language sql immutable set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to(jsonb_build_object(
  'publishers',coalesce(s->'publishers','[]'),
  'series',coalesce(s->'series','[]'),'offers',coalesce(s->'offers','[]'),
  'teachers',coalesce(s->'teachers','[]'),
  'evaluations',coalesce(s->'presentationEvaluations','[]'),
  'rules',s#>'{settings,rules}',
  'draw',s->'presentationDraw'
 )::text,'UTF8')),'hex')
$$;

create or replace function public.textos_jornada_ranking_current(s jsonb) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(s#>>'{presentationRanking,sourceFingerprint}'=public.textos_jornada_fingerprint(s),false)
$$;

create or replace function public.textos_jornada_validate(s jsonb) returns void
language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare d jsonb; r jsonb; p jsonb; c jsonb; item jsonb; i integer; n integer;
begin
 d:=s->'presentationDraw'; r:=s->'presentationRanking';
 if d is not null and d<>'null'::jsonb then
  if jsonb_typeof(d) is distinct from 'object' or nullif(trim(d->>'id'),'') is null
   or not public.textos_int(d->'version') or (d->>'version')::int<1
   or jsonb_typeof(d->'publishers') is distinct from 'array'
   or jsonb_typeof(d->'completedPublisherIds') is distinct from 'array'
   or jsonb_typeof(d->'createdAt') is distinct from 'string'
   or jsonb_typeof(d->'createdBy') is distinct from 'string' then
   perform public.textos_fail('Sorteo de participación inválido.');
  end if;
  n:=jsonb_array_length(d->'publishers');
  if n<1 or n<>(select count(distinct q->>'id') from jsonb_array_elements(d->'publishers') q) then
   perform public.textos_fail('El sorteo requiere editoriales distintas.');
  end if;
  for p in select value from jsonb_array_elements(d->'publishers') loop
   if jsonb_typeof(p) is distinct from 'object' or nullif(trim(p->>'id'),'') is null
    or nullif(trim(p->>'name'),'') is null or public.textos_find(s,'publishers',p->>'id') is null then
    perform public.textos_fail('El sorteo contiene una editorial desconocida.');
   end if;
  end loop;
  if jsonb_array_length(d->'completedPublisherIds')>n then perform public.textos_fail('Avance de exposiciones inválido.'); end if;
  for i in 0..jsonb_array_length(d->'completedPublisherIds')-1 loop
   if d#>array['completedPublisherIds',i::text] is distinct from d#>array['publishers',i::text,'id'] then
    perform public.textos_fail('Las exposiciones deben seguir el orden sorteado.');
   end if;
  end loop;
  begin perform (d->>'createdAt')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then perform public.textos_fail('Fecha de sorteo inválida.'); end;
 end if;
 if r is not null and r<>'null'::jsonb then
  if d is null or d='null'::jsonb or jsonb_typeof(r) is distinct from 'object'
   or nullif(trim(r->>'id'),'') is null or not public.textos_int(r->'version') or (r->>'version')::int<1
   or r->>'drawId' is distinct from d->>'id'
   or jsonb_typeof(r->'categories') is distinct from 'array'
   or jsonb_array_length(r->'categories')<>6 or jsonb_typeof(r->'provisional') is distinct from 'boolean'
   or jsonb_typeof(r->'createdAt') is distinct from 'string' or coalesce(r->>'sourceFingerprint','') !~ '^[0-9a-f]{64}$' then
   perform public.textos_fail('Ranking de exposiciones inválido.');
  end if;
  if (select count(distinct q->>'categoryId') from jsonb_array_elements(r->'categories') q)<>6 then perform public.textos_fail('Categorías de ranking duplicadas.'); end if;
  for c in select value from jsonb_array_elements(r->'categories') loop
   if c->>'categoryId' !~ '^(MAT|COM)-(P1|P2|S1)$' or c->>'categoryId' is distinct from (c->>'area')||'-'||(c->>'block')
    or not public.textos_int(c->'registered') or not public.textos_int(c->'closed') or not public.textos_int(c->'pending')
    or jsonb_typeof(c->'ranked') is distinct from 'array' then perform public.textos_fail('Categoría de ranking inválida.'); end if;
   for item in select value from jsonb_array_elements(c->'ranked') loop
    if public.textos_find(s,'publishers',item->>'publisherId') is null or not public.textos_int(item->'registered')
     or not public.textos_int(item->'closed') or not public.textos_int(item->'pending')
     or not (item ? 'score')
     or (item->'score'<>'null'::jsonb and (jsonb_typeof(item->'score') is distinct from 'number' or (item->>'score')::numeric not between 0 and 100)) then
     perform public.textos_fail('Puntaje del ranking inválido.');
    end if;
   end loop;
   -- Formal publication can change category.state without changing any score.
   if public.textos_jornada_ranking_current(s) and (c-'state') is distinct from (public.textos_presentation_category(s,c->>'area',c->>'block')-'state') then
    perform public.textos_fail('El ranking no coincide con las fichas cerradas de su versión.');
   end if;
  end loop;
  if (r->>'provisional')::boolean is distinct from exists(select 1 from jsonb_array_elements(r->'categories') q where (q->>'pending')::int>0) then
   perform public.textos_fail('La condición provisional del ranking no coincide con sus pendientes.');
  end if;
  begin perform (r->>'createdAt')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then perform public.textos_fail('Fecha de ranking inválida.'); end;
 end if;
end $$;

create or replace function public.textos_jornada_action(s jsonb,p_action text,p_payload jsonb,actor_role text,actor_id text,actor_name text,p_dataset text,nowat timestamptz) returns jsonb
language plpgsql volatile set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare old jsonb; entity jsonb; history jsonb:='[]'; publishers jsonb; categories jsonb:='[]'; assessment jsonb;
 area text; block text; reason text:=coalesce(p_payload->>'reason',''); provisional boolean:=false;
begin
 if actor_role is distinct from 'coordinator' then perform public.textos_fail('Operación reservada a Subdirección.','PT403'); end if;
 if p_action='presentation_draw' then
  old:=s->'presentationDraw';
  if old='null'::jsonb then old:=null; end if;
  if not public.textos_int(p_payload->'expectedVersion') or (p_payload->>'expectedVersion')::int<>coalesce((old->>'version')::int,0) then
   perform public.textos_fail('El sorteo cambió. Actualice la información antes de continuar.','PT409');
  end if;
  if p_payload->'confirmArrivals' is distinct from 'true'::jsonb then perform public.textos_fail('Confirme el cierre del registro de editoriales antes de sortear.'); end if;
  if jsonb_array_length(s->'publishers')<1 then perform public.textos_fail('Registre las editoriales que llegaron antes de sortear.','PT423'); end if;
  if s#>>'{turn,status}'='running' then perform public.textos_fail('Pause o finalice el reloj antes de sortear.','PT423'); end if;
  if old is not null then
   if jsonb_array_length(old->'completedPublisherIds')>0 or s#>>'{turn,startedAt}' is not null then
    perform public.textos_fail('El orden ya se utilizó. No puede repetirse el sorteo después de iniciar las exposiciones.','PT423');
   end if;
   if length(trim(reason))<8 then perform public.textos_fail('Documente el motivo para repetir el sorteo (mínimo ocho caracteres).'); end if;
   history:=history||jsonb_build_array(jsonb_build_object('entity','presentationDraw','referenceId',old->>'id','previous',old,'reason',reason));
  else reason:='Sorteo del orden de participación'; end if;
  -- Random ordering is produced by the server; clients cannot supply a seed or order.
  select jsonb_agg(jsonb_build_object('id',p->>'id','name',p->>'name') order by gen_random_uuid()) into publishers from jsonb_array_elements(s->'publishers') p;
  entity:=jsonb_build_object('id',gen_random_uuid()::text,'version',coalesce((old->>'version')::int,0)+1,
   'publishers',publishers,'completedPublisherIds','[]'::jsonb,'createdAt',nowat,'createdBy',actor_name);
  if s#>>'{turn,startedAt}' is not null or s#>>'{turn,publisherId}' is not null then
   history:=history||jsonb_build_array(jsonb_build_object('entity','turn','referenceId',coalesce(s#>>'{turn,publisherId}','legacy'),'previous',s->'turn','reason','Preparación del primer orden sorteado; reloj anterior conservado'));
  end if;
  s:=jsonb_set(s,'{presentationDraw}',entity);
  s:=s-'presentationRanking';
  s:=jsonb_set(s,'{turn}',jsonb_build_object('publisherId',publishers#>>'{0,id}','status','ready','startedAt',null,'pausedAt',null,'pausedMilliseconds',0));
 elsif p_action='presentation_ranking_generate' then
  old:=s->'presentationRanking';
  if old='null'::jsonb then old:=null; end if;
  if not public.textos_int(p_payload->'expectedVersion') or (p_payload->>'expectedVersion')::int<>coalesce((old->>'version')::int,0) then
   perform public.textos_fail('El ranking cambió. Actualice la información antes de continuar.','PT409');
  end if;
  if s->'presentationDraw' is null or s->'presentationDraw'='null'::jsonb
   or jsonb_array_length(s#>'{presentationDraw,publishers}')<1
   or jsonb_array_length(s#>'{presentationDraw,completedPublisherIds}')<>jsonb_array_length(s#>'{presentationDraw,publishers}')
   or s#>>'{turn,status}'<>'finished' then
   perform public.textos_fail('Finalice todas las exposiciones del orden sorteado antes de generar el ranking.','PT423');
  end if;
  if exists(select 1 from jsonb_array_elements(s->'publishers') p where not exists(select 1 from jsonb_array_elements(s#>'{presentationDraw,publishers}') q where q->>'id'=p->>'id')) then
   perform public.textos_fail('Hay editoriales nuevas que no participaron en el sorteo. Revise el registro de la jornada.','PT423');
  end if;
  if s#>>'{settings,evaluationMode}'='presentation' and exists(select 1 from jsonb_array_elements(s#>'{presentationDraw,publishers}') p where not public.textos_question_can_finish(s,p->>'id')) then perform public.textos_fail('Registre la pregunta obligatoria y la respuesta de cada editorial antes de generar el ranking.','PT423'); end if;
  foreach area in array array['MAT','COM'] loop
   foreach block in array array['P1','P2','S1'] loop
    assessment:=public.textos_presentation_category(s,area,block);
    categories:=categories||jsonb_build_array(assessment);
    if (assessment->>'pending')::int>0 then provisional:=true; end if;
   end loop;
  end loop;
  entity:=jsonb_build_object('id',gen_random_uuid()::text,'version',coalesce((old->>'version')::int,0)+1,
   'createdAt',nowat,'drawId',s#>>'{presentationDraw,id}','categories',categories,'provisional',provisional,
   'sourceFingerprint',public.textos_jornada_fingerprint(s),'stale',false);
  reason:='Ranking de exposiciones calculado con fichas cerradas de la escala vigente';
  if old is not null then history:=history||jsonb_build_array(jsonb_build_object('entity','presentationRanking','referenceId',old->>'id','previous',old,'reason',reason)); end if;
  s:=jsonb_set(s,'{presentationRanking}',entity);
 else perform public.textos_fail('Operación de jornada desconocida.','PT404'); end if;
 perform public.textos_jornada_validate(s);
 return jsonb_build_object('state',s,'result',entity,'referenceId',entity->>'id','reason',reason,'history',history);
end $$;

-- Call before changing the clock. This updates completion atomically with finish.
-- With no draw, legacy manual turns keep their original behavior.
create or replace function public.textos_jornada_turn(s jsonb,command text,publisherid text,expected_turn jsonb default null) returns jsonb
language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare d jsonb:=s->'presentationDraw'; nextid text; currentid text:=s#>>'{turn,publisherId}'; n integer;
begin
 if expected_turn is not null and expected_turn is distinct from s->'turn' then
  perform public.textos_fail('El turno cambió en otra pantalla. Actualice antes de controlar el reloj.','PT409');
 end if;
 if d is null or d='null'::jsonb then return s; end if;
 perform public.textos_jornada_validate(s);
 if expected_turn is distinct from s->'turn' then
  perform public.textos_fail('El turno cambió en otra pantalla. Actualice antes de controlar el reloj.','PT409');
 end if;
 n:=jsonb_array_length(d->'completedPublisherIds'); nextid:=d#>>array['publishers',n::text,'id'];
 if command in ('start','next') then
  if s#>>'{turn,status}' not in ('ready','finished') then perform public.textos_fail('Finalice el turno actual antes de iniciar el siguiente.','PT423'); end if;
  if nextid is null then perform public.textos_fail('Todas las exposiciones sorteadas ya finalizaron.','PT423'); end if;
  if publisherid is distinct from nextid then perform public.textos_fail('Inicie la siguiente editorial del orden sorteado.','PT409'); end if;
  if exists(select 1 from jsonb_array_elements(s->'publishers') p where not exists(select 1 from jsonb_array_elements(d->'publishers') q where q->>'id'=p->>'id')) then
   perform public.textos_fail('El registro de editoriales cambió después del sorteo. Actualice el sorteo antes de iniciar.','PT423');
  end if;
 elsif command='finish' then
  if s#>>'{turn,status}' not in ('running','paused') or currentid is distinct from nextid then
   perform public.textos_fail('Solo puede finalizar la exposición activa del orden sorteado.','PT409');
  end if;
  d:=jsonb_set(d,'{completedPublisherIds}',d->'completedPublisherIds'||jsonb_build_array(currentid));
  d:=jsonb_set(d,'{version}',to_jsonb((d->>'version')::int+1));
  s:=jsonb_set(s,'{presentationDraw}',d);
 end if;
 return s;
end $$;

-- END JORNADA HELPERS
