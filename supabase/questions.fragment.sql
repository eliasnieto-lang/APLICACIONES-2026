-- BEGIN REQUIRED QUESTION HELPERS
-- Subdirección records a single confirmation that the required exchange occurred.
-- Each evaluator scores I11 independently; this record never authorizes a grade.

create or replace function public.textos_question_find(s jsonb,publisher_id text) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select q from jsonb_array_elements(coalesce(s->'presentationQuestions','[]')) q
 where q->>'publisherId'=publisher_id and q->>'status'='answered' limit 1
$$;

create or replace function public.textos_question_validate(s jsonb) returns void
language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare q jsonb; key text; asked timestamptz; answered timestamptz; updated timestamptz;
begin
 if s->'presentationQuestions' is null then return; end if;
 if jsonb_typeof(s->'presentationQuestions') is distinct from 'array' then perform public.textos_fail('El registro de preguntas debe ser una lista.'); end if;
 if exists(select 1 from jsonb_array_elements(s->'presentationQuestions') x group by x->>'id' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(s->'presentationQuestions') x group by x->>'publisherId' having count(*)>1) then
  perform public.textos_fail('Solo corresponde una confirmación de pregunta por editorial.');
 end if;
 for q in select value from jsonb_array_elements(s->'presentationQuestions') loop
  if jsonb_typeof(q) is distinct from 'object' or nullif(trim(q->>'id'),'') is null
   or public.textos_find(s,'publishers',q->>'publisherId') is null
   or not public.textos_int(q->'version') or (q->>'version')::int<1
   or coalesce(q->>'status','') not in ('draft','answered')
   or jsonb_typeof(q->'updatedAt') is distinct from 'string' then
   perform public.textos_fail('Registro de confirmación de pregunta inválido.');
  end if;
  if q ? 'confirmed' and (jsonb_typeof(q->'confirmed') is distinct from 'boolean'
   or (q->'confirmed'='true'::jsonb) is distinct from (q->>'status'='answered')) then
   perform public.textos_fail('La confirmación de pregunta debe coincidir con su estado.');
  end if;
  -- The former detailed fields remain valid in existing records and backups.
  foreach key in array array['representativeName','question','answer'] loop
   if q ? key and jsonb_typeof(q->key) is distinct from 'string' then perform public.textos_fail('Los datos anteriores de la pregunta deben ser texto.'); end if;
  end loop;
  if q ? 'area' and q->'area'<>'null'::jsonb and coalesce(q->>'area','') not in ('MAT','COM') then perform public.textos_fail('Área de pregunta inválida.'); end if;
  if length(q->>'representativeName')>160 or length(q->>'question')>2000 or length(q->>'answer')>3000 then perform public.textos_fail('El registro de pregunta supera la longitud permitida.'); end if;
  begin
   if nullif(q->>'updatedAt','') is null then perform public.textos_fail('La confirmación requiere fecha de actualización.'); end if;
   updated:=(q->>'updatedAt')::timestamptz;
   asked:=nullif(q->>'askedAt','')::timestamptz;
   answered:=nullif(q->>'answeredAt','')::timestamptz;
   if not isfinite(updated) or asked is not null and not isfinite(asked) or answered is not null and not isfinite(answered) then perform public.textos_fail('La fecha de confirmación no es válida.'); end if;
  exception when invalid_datetime_format or datetime_field_overflow then perform public.textos_fail('La fecha de pregunta o respuesta no es válida.'); end;
  if q->>'status'='answered' and (asked is null or answered is null or answered<asked or updated<answered) then
   perform public.textos_fail('La confirmación requiere fechas coherentes.');
  end if;
  if q->>'status'='answered' and not(q ? 'confirmed') and (nullif(trim(q->>'representativeName'),'') is null
   or coalesce(q->>'area','') not in ('MAT','COM') or nullif(trim(q->>'question'),'') is null or nullif(trim(q->>'answer'),'') is null) then
   perform public.textos_fail('El registro anterior requiere conservar el representante, la pregunta y la respuesta.');
  end if;
 end loop;
end $$;

create or replace function public.textos_question_can_finish(s jsonb,publisher_id text) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
 select exists(select 1 from jsonb_array_elements(coalesce(s->'presentationQuestions','[]')) q
  where q->>'publisherId'=publisher_id and q->>'status'='answered'
  and nullif(q->>'askedAt','') is not null and nullif(q->>'answeredAt','') is not null
  and (q->'confirmed'='true'::jsonb or not(q ? 'confirmed') and q->>'area' in ('MAT','COM')
   and nullif(trim(q->>'representativeName'),'') is not null and nullif(trim(q->>'question'),'') is not null and nullif(trim(q->>'answer'),'') is not null))
$$;

-- Enumerate projections so restored private fields cannot become public.
create or replace function public.textos_question_public(questions jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',q->>'id','publisherId',q->>'publisherId','version',q->'version',
  'confirmed',coalesce(q->'confirmed','true'::jsonb),'representativeName','','area',q->>'area','question',q->>'question','answer',q->>'answer','status',q->>'status',
  'askedAt',q->'askedAt','answeredAt',q->'answeredAt','updatedAt',q->>'updatedAt')) order by ord),'[]'::jsonb)
 from jsonb_array_elements(coalesce(questions,'[]')) with ordinality item(q,ord) where q->>'status'='answered'
$$;

create or replace function public.textos_question_teacher(questions jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',q->>'id','publisherId',q->>'publisherId','version',q->'version',
  'confirmed',coalesce(q->'confirmed','true'::jsonb),'representativeName',q->>'representativeName','area',q->>'area','question',q->>'question','answer',q->>'answer','status',q->>'status',
  'askedAt',q->'askedAt','answeredAt',q->'answeredAt','updatedAt',q->>'updatedAt')) order by ord),'[]'::jsonb)
 from jsonb_array_elements(coalesce(questions,'[]')) with ordinality item(q,ord) where q->>'status'='answered'
$$;

create or replace function public.textos_question_action(s jsonb,p_action text,p_payload jsonb,actor_role text,actor_id text,actor_name text,p_dataset text,nowat timestamptz) returns jsonb
language plpgsql volatile set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare publisher_id text:=p_payload->>'publisherId'; old jsonb; entity jsonb; reason text:=trim(coalesce(p_payload->>'reason',''));
 history jsonb:='[]'; status text; key text; finished boolean; changed boolean;
begin
 if actor_role is distinct from 'coordinator' then perform public.textos_fail('Solo Subdirección confirma la pregunta y respuesta de la editorial.','PT403'); end if;
 if p_action is distinct from 'presentation_question_save' then perform public.textos_fail('Operación de preguntas desconocida.','PT404'); end if;
 if public.textos_find(s,'publishers',publisher_id) is null then perform public.textos_fail('La editorial no existe en esta jornada.','PT404'); end if;
 if p_payload ? 'confirmed' then
  if jsonb_typeof(p_payload->'confirmed') is distinct from 'boolean' then perform public.textos_fail('La confirmación debe ser una casilla válida.'); end if;
  status:=case when p_payload->'confirmed'='true'::jsonb then 'answered' else 'draft' end;
  if p_payload ? 'status' and p_payload->>'status' is distinct from status then perform public.textos_fail('La confirmación y el estado no coinciden.'); end if;
 else
  status:=p_payload->>'status';
  if coalesce(status,'') not in ('draft','answered') then perform public.textos_fail('Confirme que la pregunta fue formulada y respondida.'); end if;
 end if;
 foreach key in array array['representativeName','question','answer'] loop
  if p_payload ? key and jsonb_typeof(p_payload->key) is distinct from 'string' then perform public.textos_fail('Los datos anteriores de la pregunta deben ser texto.'); end if;
 end loop;
 if p_payload ? 'area' and coalesce(p_payload->>'area','') not in ('MAT','COM') then perform public.textos_fail('Área de pregunta inválida.'); end if;
 if length(p_payload->>'representativeName')>160 or length(p_payload->>'question')>2000 or length(p_payload->>'answer')>3000 or length(reason)>1000 then perform public.textos_fail('El registro de pregunta supera la longitud permitida.'); end if;
 select q into old from jsonb_array_elements(coalesce(s->'presentationQuestions','[]')) q where q->>'publisherId'=publisher_id;
 if not public.textos_int(p_payload->'expectedVersion') or (p_payload->>'expectedVersion')::int<>coalesce((old->>'version')::int,0) then
  perform public.textos_fail('La confirmación cambió en otra pantalla. Actualice antes de guardar.','PT409');
 end if;
 -- Checkbox-only requests preserve former transcripts without requiring them again.
 entity:=coalesce(old,'{}');
 foreach key in array array['representativeName','area','question','answer'] loop
  if p_payload ? key then entity:=entity||jsonb_build_object(key,case when key='area' then p_payload->>key else trim(p_payload->>key) end); end if;
 end loop;
 changed:=old is null or old->>'status' is distinct from status
  or (entity-'confirmed') is distinct from (old-'confirmed');
 finished:=coalesce(s#>'{presentationDraw,completedPublisherIds}' ? publisher_id,false)
  or coalesce(s#>>'{turn,publisherId}'=publisher_id and s#>>'{turn,status}'='finished',false);
 -- A deleted confirmation can be restored after finalization without altering grades.
 if old->>'status'='answered' and changed and finished then perform public.textos_fail('La exposición ya finalizó; su confirmación se conserva.','PT423'); end if;
 if not changed then return jsonb_build_object('state',s,'result',old,'referenceId',old->>'id','reason','Confirmación ya registrada sin cambios','history',history); end if;
 entity:=entity||jsonb_build_object('id',coalesce(old->>'id',gen_random_uuid()::text),'publisherId',publisher_id,
  'version',case when old is null then (s->>'version')::int+1 else (old->>'version')::int+1 end,'confirmed',status='answered','status',status,
  'askedAt',case when status='answered' then coalesce(nullif(old->'askedAt','null'::jsonb),to_jsonb(nowat)) else 'null'::jsonb end,
  'answeredAt',case when status='answered' then coalesce(nullif(old->'answeredAt','null'::jsonb),to_jsonb(nowat)) else 'null'::jsonb end,'updatedAt',nowat);
 if old is not null then history:=jsonb_build_array(jsonb_build_object('entity','presentationQuestions','referenceId',old->>'id','previous',old,'reason',coalesce(nullif(reason,''),'Actualización de la confirmación de pregunta obligatoria'))); end if;
 s:=public.textos_put(s,'presentationQuestions',entity);
 perform public.textos_question_validate(s);
 return jsonb_build_object('state',s,'result',entity,'referenceId',entity->>'id',
  'reason',case when status='answered' then 'Pregunta del representante y respuesta de la editorial confirmadas' else 'Confirmación de pregunta desmarcada' end,'history',history);
end $$;
-- END REQUIRED QUESTION HELPERS
