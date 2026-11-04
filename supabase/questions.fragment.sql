-- BEGIN REQUIRED QUESTION HELPERS
-- The coordinator records one representative's question and the editorial's answer.
-- Grades, when applicable, remain in each evaluator's private rubric.

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
  perform public.textos_fail('Solo corresponde una pregunta obligatoria por editorial.');
 end if;
 for q in select value from jsonb_array_elements(s->'presentationQuestions') loop
  if jsonb_typeof(q) is distinct from 'object' or nullif(trim(q->>'id'),'') is null
   or public.textos_find(s,'publishers',q->>'publisherId') is null
   or not public.textos_int(q->'version') or (q->>'version')::int<1
   or coalesce(q->>'area','') not in ('MAT','COM') or coalesce(q->>'status','') not in ('draft','answered') then
   perform public.textos_fail('Registro de pregunta obligatorio inválido.');
  end if;
  foreach key in array array['representativeName','question','answer','updatedAt'] loop
   if jsonb_typeof(q->key) is distinct from 'string' then perform public.textos_fail('El representante, la pregunta, la respuesta y su fecha deben ser texto.'); end if;
  end loop;
  if length(q->>'representativeName')>160 or length(q->>'question')>2000 or length(q->>'answer')>3000 then perform public.textos_fail('El registro de pregunta supera la longitud permitida.'); end if;
  begin
   if nullif(q->>'updatedAt','') is null then perform public.textos_fail('La pregunta requiere fecha de actualización.'); end if;
   updated:=(q->>'updatedAt')::timestamptz;
   asked:=nullif(q->>'askedAt','')::timestamptz;
   answered:=nullif(q->>'answeredAt','')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then perform public.textos_fail('La fecha de pregunta o respuesta no es válida.'); end;
  if q->>'status'='answered' and (nullif(trim(q->>'representativeName'),'') is null or nullif(trim(q->>'question'),'') is null
   or nullif(trim(q->>'answer'),'') is null or asked is null or answered is null or answered<asked or updated<answered) then
   perform public.textos_fail('La confirmación requiere representante, pregunta, respuesta y fechas coherentes.');
  end if;
 end loop;
end $$;

create or replace function public.textos_question_can_finish(s jsonb,publisher_id text) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
 select exists(select 1 from jsonb_array_elements(coalesce(s->'presentationQuestions','[]')) q
  where q->>'publisherId'=publisher_id and q->>'status'='answered' and q->>'area' in ('MAT','COM')
  and nullif(trim(q->>'representativeName'),'') is not null and nullif(trim(q->>'question'),'') is not null
  and nullif(trim(q->>'answer'),'') is not null and nullif(q->>'askedAt','') is not null and nullif(q->>'answeredAt','') is not null)
$$;

-- Public projection has no representative's identity, private grades or restored extra fields.
create or replace function public.textos_question_public(questions jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',q->>'id','publisherId',q->>'publisherId','version',q->'version',
  'representativeName','','area',q->>'area','question',q->>'question','answer',q->>'answer','status',q->>'status',
  'askedAt',q->'askedAt','answeredAt',q->'answeredAt','updatedAt',q->>'updatedAt') order by ord),'[]'::jsonb)
 from jsonb_array_elements(coalesce(questions,'[]')) with ordinality item(q,ord) where q->>'status'='answered'
$$;

-- Evaluators see the common question and its representative, never restored private extras.
create or replace function public.textos_question_teacher(questions jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',q->>'id','publisherId',q->>'publisherId','version',q->'version',
  'representativeName',q->>'representativeName','area',q->>'area','question',q->>'question','answer',q->>'answer','status',q->>'status',
  'askedAt',q->'askedAt','answeredAt',q->'answeredAt','updatedAt',q->>'updatedAt') order by ord),'[]'::jsonb)
 from jsonb_array_elements(coalesce(questions,'[]')) with ordinality item(q,ord) where q->>'status'='answered'
$$;

create or replace function public.textos_question_action(s jsonb,p_action text,p_payload jsonb,actor_role text,actor_id text,actor_name text,p_dataset text,nowat timestamptz) returns jsonb
language plpgsql volatile set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare publisher_id text:=p_payload->>'publisherId'; old jsonb; entity jsonb; reason text:=trim(coalesce(p_payload->>'reason',''));
 history jsonb:='[]'; status text:=p_payload->>'status'; representative text:=trim(coalesce(p_payload->>'representativeName',''));
 key text; area text:=p_payload->>'area'; question text:=trim(coalesce(p_payload->>'question','')); answer text:=trim(coalesce(p_payload->>'answer',''));
 finished boolean; changed boolean;
begin
 if actor_role is distinct from 'coordinator' then perform public.textos_fail('Solo Subdirección registra la pregunta del representante docente.','PT403'); end if;
 if p_action is distinct from 'presentation_question_save' then perform public.textos_fail('Operación de preguntas desconocida.','PT404'); end if;
 if public.textos_find(s,'publishers',publisher_id) is null then perform public.textos_fail('La editorial no existe en esta jornada.','PT404'); end if;
 foreach key in array array['representativeName','question','answer'] loop
  if p_payload ? key and jsonb_typeof(p_payload->key) is distinct from 'string' then perform public.textos_fail('El nombre, la pregunta y la respuesta deben ser texto.'); end if;
 end loop;
 if coalesce(area,'') not in ('MAT','COM') or coalesce(status,'') not in ('draft','answered') then perform public.textos_fail('Seleccione el área y estado de la pregunta.'); end if;
 if length(representative)>160 or length(question)>2000 or length(answer)>3000 or length(reason)>1000 then perform public.textos_fail('El texto de la pregunta o respuesta supera la longitud permitida.'); end if;
 select q into old from jsonb_array_elements(coalesce(s->'presentationQuestions','[]')) q where q->>'publisherId'=publisher_id;
 if not public.textos_int(p_payload->'expectedVersion') or (p_payload->>'expectedVersion')::int<>coalesce((old->>'version')::int,0) then
  perform public.textos_fail('La pregunta cambió en otra pantalla. Actualice antes de guardar.','PT409');
 end if;
 changed:=old is null or old->>'representativeName' is distinct from representative or old->>'area' is distinct from area
  or old->>'question' is distinct from question or old->>'answer' is distinct from answer or old->>'status' is distinct from status;
 if old->>'status'='answered' and changed then
  finished:=coalesce(s#>'{presentationDraw,completedPublisherIds}' ? publisher_id,false)
   or (s#>>'{turn,publisherId}'=publisher_id and s#>>'{turn,status}'='finished')
   or exists(select 1 from jsonb_array_elements(coalesce(s->'presentationEvaluations','[]')) e where e->>'publisherId'=publisher_id
    and e->>'status'='closed' and e->'rubricVersion'='2'::jsonb and e->'questionVersion'=old->'version' and e->'responseScore' is not null and e->'responseScore'<>'null'::jsonb);
  if finished then perform public.textos_fail('La respuesta ya pertenece a una exposición finalizada o valorada. Conserve su registro; una corrección requiere revisar primero sus valoraciones.','PT423'); end if;
  if status='draft' then perform public.textos_fail('Una respuesta confirmada no vuelve a borrador. Corrija su registro antes de finalizar.','PT423'); end if;
  if length(reason)<8 then perform public.textos_fail('Explique el motivo de la corrección de la pregunta y respuesta.'); end if;
 end if;
 if status='answered' then
  if representative='' or question='' or answer='' then perform public.textos_fail('Registre el representante, la pregunta y un resumen de la respuesta antes de confirmar.'); end if;
  if s#>>'{turn,publisherId}' is distinct from publisher_id or coalesce(s#>>'{turn,status}','') not in ('running','paused','finished') then
   perform public.textos_fail('Confirme la pregunta durante la exposición de esta editorial o al finalizarla.','PT423');
  end if;
 end if;
 if not changed then return jsonb_build_object('state',s,'result',old,'referenceId',old->>'id','reason','Pregunta ya confirmada sin cambios','history',history); end if;
 -- New question versions start above the dataset revision, so deleting and recreating
 -- a question cannot make an old I11 grade match a different answer's version.
 entity:=jsonb_build_object('id',coalesce(old->>'id',gen_random_uuid()::text),'publisherId',publisher_id,'version',case when old is null then (s->>'version')::int+1 else (old->>'version')::int+1 end,
  'representativeName',representative,'area',area,'question',question,'answer',answer,'status',status,
  'askedAt',case when status='answered' then coalesce(old->'askedAt',to_jsonb(nowat)) else 'null'::jsonb end,
  'answeredAt',case when status='answered' then to_jsonb(nowat) else 'null'::jsonb end,'updatedAt',nowat);
 -- json null is not SQL null; a first draft's askedAt must become a real timestamp on confirmation.
 if status='answered' and (entity->'askedAt' is null or entity->'askedAt'='null'::jsonb) then entity:=jsonb_set(entity,'{askedAt}',to_jsonb(nowat)); end if;
 if old is not null then history:=jsonb_build_array(jsonb_build_object('entity','presentationQuestions','referenceId',old->>'id','previous',old,'reason',coalesce(nullif(reason,''),'Actualización del registro de pregunta obligatoria'))); end if;
 s:=public.textos_put(s,'presentationQuestions',entity);
 perform public.textos_question_validate(s);
 return jsonb_build_object('state',s,'result',entity,'referenceId',entity->>'id',
  'reason',case when status='answered' then 'Pregunta del representante y respuesta de la editorial confirmadas' else 'Borrador de pregunta guardado' end,'history',history);
end $$;
-- END REQUIRED QUESTION HELPERS
