-- Administrative deletion is explicit, previewed and scoped to one dataset.
-- The RPC authenticates and locks the dataset before invoking this helper.
create or replace function public.textos_cleanup_mentions(doc jsonb, ids jsonb) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(exists(select 1 from jsonb_path_query(coalesce(doc,'null'),'$.**') v where jsonb_typeof(v)='string' and coalesce(ids,'[]') ? (v#>>'{}')),false)
$$;
create or replace function public.textos_cleanup_without(s jsonb, collection text, ids jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select jsonb_set(s,array[collection],coalesce((select jsonb_agg(v) from jsonb_array_elements(coalesce(s->collection,'[]')) v where not(coalesce(ids,'[]') ? (v->>'id'))),'[]'))
$$;
create or replace function public.textos_cleanup_plan(s jsonb, payload jsonb) returns jsonb
language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare scope text:=payload->>'scope'; ids jsonb:=coalesce(payload->'ids','[]'); selected jsonb; removed jsonb:='{}'; allids jsonb:='[]'; names jsonb:='[]';
 nextstate jsonb:=s; catalogstate jsonb:=s; rewritten jsonb:='[]'; labels jsonb:='[]'; counts jsonb:='{}'; consequences jsonb:='[]'; affected jsonb:='[]'; publishers jsonb:='[]'; offerids jsonb:='[]';
 c text; col text; id text; area text; block text; v jsonb; q jsonb; more jsonb; before_rem jsonb; n integer; response_count integer:=0;
 clear_draw boolean:=false; clear_rank boolean:=false;
begin
 if coalesce(scope,'') not in ('all','publisher','teacher','presentationEvaluation','paperPoll','draw','ranking','historical','series','offer','book','section','incident','question') then perform public.textos_fail('Seleccione qué información desea eliminar.'); end if;
 if jsonb_typeof(ids) is distinct from 'array' or jsonb_array_length(ids)>2000 or exists(select 1 from jsonb_array_elements(ids) x where jsonb_typeof(x)<>'string' or nullif(trim(x#>>'{}'),'') is null) or (select count(distinct x) from jsonb_array_elements(ids) x)<>jsonb_array_length(ids) then perform public.textos_fail('Seleccione registros diferentes y válidos.'); end if;
 foreach c in array array['publishers','series','offers','books','teachers','assignments','evaluations','presentationEvaluations','presentationShortlists','reviews','shortlists','sections','rounds','incidents','presentationQuestions'] loop removed:=removed||jsonb_build_object(c,'[]'::jsonb); end loop;
 col:=case scope when 'publisher' then 'publishers' when 'teacher' then 'teachers' when 'presentationEvaluation' then 'presentationEvaluations' when 'paperPoll' then 'paperPolls' when 'series' then 'series' when 'offer' then 'offers' when 'book' then 'books' when 'section' then 'sections' when 'incident' then 'incidents' when 'question' then 'presentationQuestions' end;
 removed:=removed||jsonb_build_object('paperPolls','[]'::jsonb);
 if col is not null then
  if jsonb_array_length(ids)<1 then perform public.textos_fail('Seleccione al menos un registro.'); end if;
  for id in select jsonb_array_elements_text(ids) loop
   v:=public.textos_find(s,col,id); if v is null then perform public.textos_fail('Uno de los registros ya no existe. Actualice la información.','PT409'); end if;
   labels:=labels||jsonb_build_array(coalesce(v->>'name',v->>'title',case when scope='presentationEvaluation' then coalesce(public.textos_find(s,'teachers',v->>'teacherId')->>'name','Docente')||' · '||coalesce(public.textos_find(s,'publishers',v->>'publisherId')->>'name','Editorial')||' · '||(v->>'area')||'-'||(v->>'block') when scope='paperPoll' then 'Votación '||(v->>'block') when scope='question' then 'Pregunta · '||coalesce(public.textos_find(s,'publishers',v->>'publisherId')->>'name','Editorial') end,v->>'label',v->>'description',id));
  end loop;
  removed:=jsonb_set(removed,array[col],ids);
 elsif jsonb_array_length(ids)>0 then perform public.textos_fail('Esta opción no admite registros individuales.');
 end if;
 if scope='all' then
  labels:='["Todos los datos ingresados de esta jornada"]';
  nextstate:=public.textos_empty_state()||jsonb_build_object('version',s->'version','settings',jsonb_set(s->'settings','{rules,lockedAt}','null')||jsonb_build_object('version',coalesce((s#>>'{settings,version}')::int,0)+1,'editorsWithdrawn',false,'withdrawalReference',''),'paperPolls','[]'::jsonb,'presentationQuestions','[]'::jsonb);
  foreach c in array array['publishers','series','offers','books','teachers','assignments','evaluations','presentationEvaluations','presentationShortlists','reviews','shortlists','sections','rounds','incidents','presentationQuestions','paperPolls'] loop
   removed:=jsonb_set(removed,array[c],coalesce((select jsonb_agg(x->>'id') from jsonb_array_elements(coalesce(s->c,'[]')) x),'[]'));
  end loop;
  clear_draw:=s->'presentationDraw' is not null; clear_rank:=s->'presentationRanking' is not null;
  consequences:=consequences||jsonb_build_array('Se vaciarán los registros y votos de esta jornada. Se conservarán la configuración y el acceso de Subdirección.','Los accesos docentes emitidos para esta jornada dejarán de funcionar.');
 else
  if scope='historical' then
   labels:='["Archivo de evaluaciones y elecciones anteriores"]';
   foreach c in array array['books','assignments','evaluations','reviews','shortlists','sections','rounds'] loop removed:=jsonb_set(removed,array[c],coalesce((select jsonb_agg(x->>'id') from jsonb_array_elements(coalesce(s->c,'[]')) x),'[]')); end loop;
   consequences:=consequences||jsonb_build_array('Se eliminará el archivo por libro y grado; las editoriales, ofertas y evaluaciones de exposición se conservarán.');
  end if;
  if scope='draw' then clear_draw:=true; clear_rank:=true; end if;
  if scope='ranking' then clear_rank:=true; labels:='["Ranking / Top"]'; end if;
  if scope='draw' then labels:='["Sorteo y cronómetro"]'; end if;
  -- Catalog dependencies can span reviews and their additional assignments.
  loop
   before_rem:=removed;
   for v in select value from jsonb_array_elements(coalesce(s->'series','[]')) loop if removed->'publishers' ? (v->>'publisherId') then removed:=jsonb_set(removed,'{series}',(removed->'series')||case when removed->'series' ? (v->>'id') then '[]'::jsonb else jsonb_build_array(v->>'id') end); end if; end loop;
   for v in select value from jsonb_array_elements(coalesce(s->'offers','[]')) loop if removed->'series' ? (v->>'seriesId') and not(removed->'offers' ? (v->>'id')) then removed:=jsonb_set(removed,'{offers}',removed->'offers'||jsonb_build_array(v->>'id')); end if; end loop;
   for v in select value from jsonb_array_elements(coalesce(s->'books','[]')) loop if removed->'offers' ? (v->>'offerId') and not(removed->'books' ? (v->>'id')) then removed:=jsonb_set(removed,'{books}',removed->'books'||jsonb_build_array(v->>'id')); end if; end loop;
   for v in select value from jsonb_array_elements(coalesce(s->'reviews','[]')) loop if public.textos_cleanup_mentions(v,(removed->'offers')||(removed->'books')) and not(removed->'reviews' ? (v->>'id')) then removed:=jsonb_set(removed,'{reviews}',removed->'reviews'||jsonb_build_array(v->>'id')); end if; end loop;
   for v in select value from jsonb_array_elements(coalesce(s->'assignments','[]')) loop if ((removed->'books' ? (v->>'bookId')) or (removed->'teachers' ? (v->>'teacherId')) or (removed->'reviews' ? (v->>'reviewId'))) and not(removed->'assignments' ? (v->>'id')) then removed:=jsonb_set(removed,'{assignments}',removed->'assignments'||jsonb_build_array(v->>'id')); end if; end loop;
   for v in select value from jsonb_array_elements(coalesce(s->'evaluations','[]')) loop if ((removed->'books' ? (v->>'bookId')) or (removed->'teachers' ? (v->>'teacherId')) or (removed->'assignments' ? (v->>'assignmentId'))) and not(removed->'evaluations' ? (v->>'id')) then removed:=jsonb_set(removed,'{evaluations}',removed->'evaluations'||jsonb_build_array(v->>'id')); end if; end loop;
   exit when before_rem=removed;
  end loop;
  for v in select value from jsonb_array_elements(coalesce(s->'presentationEvaluations','[]')) loop
   if ((removed->'publishers' ? (v->>'publisherId')) or (removed->'teachers' ? (v->>'teacherId'))) and not(removed->'presentationEvaluations' ? (v->>'id')) then removed:=jsonb_set(removed,'{presentationEvaluations}',removed->'presentationEvaluations'||jsonb_build_array(v->>'id')); end if;
   if removed->'presentationEvaluations' ? (v->>'id') then affected:=affected||jsonb_build_array((v->>'area')||'-'||(v->>'block')); end if;
  end loop;
  for v in select value from jsonb_array_elements(coalesce(s->'teachers','[]')) loop if removed->'teachers' ? (v->>'id') then names:=names||jsonb_build_array(v->>'name'); for block in select jsonb_array_elements_text(coalesce(v->'categories','[]')) loop affected:=affected||jsonb_build_array((v->>'area')||'-'||block); end loop; end if; end loop;
  for v in select value from jsonb_array_elements(coalesce(s->'publishers','[]')) loop if removed->'publishers' ? (v->>'id') then publishers:=publishers||jsonb_build_array(v->>'id'); clear_draw:=true; end if; end loop;
  for v in select value from jsonb_array_elements(coalesce(s->'offers','[]')) loop if removed->'offers' ? (v->>'id') then q:=public.textos_find(s,'series',v->>'seriesId'); affected:=affected||jsonb_build_array((v->>'area')||'-'||(v->>'block')); publishers:=publishers||jsonb_build_array(q->>'publisherId'); end if; end loop;
  for v in select value from jsonb_array_elements(coalesce(s->'presentationQuestions','[]')) loop
   if removed->'publishers' ? (v->>'publisherId') and not(removed->'presentationQuestions' ? (v->>'id')) then removed:=jsonb_set(removed,'{presentationQuestions}',removed->'presentationQuestions'||jsonb_build_array(v->>'id')); end if;
  end loop;
  foreach c in array array['publishers','series','offers'] loop catalogstate:=public.textos_cleanup_without(catalogstate,c,removed->c); end loop;
  if jsonb_array_length(publishers)>0 then
   foreach area in array array['MAT','COM'] loop foreach block in array array['P1','P2','S1'] loop
    if exists(select 1 from jsonb_array_elements_text(publishers) p where public.textos_presentation_publisher_available(s,p,area,block) or public.textos_presentation_publisher_available(catalogstate,p,area,block)) then affected:=affected||jsonb_build_array(area||'-'||block); end if;
   end loop; end loop;
  end if;
  -- Published snapshots may mention a removed entry outside their finalist list.
  select coalesce(jsonb_agg(x),'[]') into allids from jsonb_each(removed) e cross join lateral jsonb_array_elements(e.value) x;
  select coalesce(jsonb_agg(distinct b->>'offerId'),'[]') into offerids from jsonb_array_elements(coalesce(s->'books','[]')) b where exists(select 1 from jsonb_array_elements(coalesce(s->'assignments','[]')) a where removed->'assignments' ? (a->>'id') and a->>'bookId'=b->>'id');
  for v in select value from jsonb_array_elements(coalesce(s->'shortlists','[]')) loop if (public.textos_cleanup_mentions(v,allids) or public.textos_cleanup_mentions(v->'offerIds',offerids)) and not(removed->'shortlists' ? (v->>'id')) then removed:=jsonb_set(removed,'{shortlists}',removed->'shortlists'||jsonb_build_array(v->>'id')); end if; end loop;
  for v in select value from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) loop if (affected ? ((v->>'area')||'-'||(v->>'block')) or public.textos_cleanup_mentions(v,allids)) and not(removed->'presentationShortlists' ? (v->>'id')) then removed:=jsonb_set(removed,'{presentationShortlists}',removed->'presentationShortlists'||jsonb_build_array(v->>'id')); end if; end loop;
  loop
   before_rem:=removed;
   for v in select value from jsonb_array_elements(coalesce(s->'rounds','[]')) loop if ((removed->'rounds' ? (v->>'parentId')) or public.textos_cleanup_mentions(v->'shortlistIds',removed->'shortlists') or exists(select 1 from jsonb_array_elements(coalesce(s->'sections','[]')) sec where removed->'sections' ? (sec->>'id') and sec->>'gradeId'=v->>'gradeId')) and not(removed->'rounds' ? (v->>'id')) then removed:=jsonb_set(removed,'{rounds}',removed->'rounds'||jsonb_build_array(v->>'id')); end if; end loop;
   exit when before_rem=removed;
  end loop;
  for v in select value from jsonb_array_elements(coalesce(s->'paperPolls','[]')) loop if exists(select 1 from jsonb_array_elements_text(v->'areas') a where affected ? (a||'-'||(v->>'block'))) or public.textos_cleanup_mentions(v,removed->'publishers') then if not(removed->'paperPolls' ? (v->>'id')) then removed:=jsonb_set(removed,'{paperPolls}',removed->'paperPolls'||jsonb_build_array(v->>'id')); end if; end if; end loop;
  clear_rank:=clear_rank or jsonb_array_length(affected)>0 or jsonb_array_length(removed->'publishers')>0 or jsonb_array_length(removed->'teachers')>0;
  select coalesce(jsonb_agg(x),'[]') into allids from jsonb_each(removed) e cross join lateral jsonb_array_elements(e.value) x;
  for v in select value from jsonb_array_elements(coalesce(s->'incidents','[]')) loop if allids ? (v->>'referenceId') and not(removed->'incidents' ? (v->>'id')) then removed:=jsonb_set(removed,'{incidents}',removed->'incidents'||jsonb_build_array(v->>'id')); end if; end loop;
  for c in select jsonb_object_keys(removed) loop nextstate:=public.textos_cleanup_without(nextstate,c,removed->c); end loop;
  nextstate:=jsonb_set(nextstate,'{deliveries}',coalesce((select jsonb_agg(v) from jsonb_array_elements(coalesce(s->'deliveries','[]')) v where not(removed->'rounds' ? (v->>'roundId')) and not(removed->'sections' ? (v->>'sectionId'))),'[]'));
  -- A removed book must not remain an unresolved supersedes reference.
  nextstate:=jsonb_set(nextstate,'{books}',coalesce((select jsonb_agg(case when removed->'books' ? (v->>'supersedesId') then v-'supersedesId' else v end) from jsonb_array_elements(coalesce(nextstate->'books','[]')) v),'[]'));
  if scope='question' then consequences:=consequences||jsonb_build_array('Se eliminará solo la confirmación; las fichas, sus puntajes, el sorteo y los resultados se conservarán.'); end if;
  if clear_draw then nextstate:=nextstate-'presentationDraw'; nextstate:=jsonb_set(nextstate,'{turn}',public.textos_empty_state()->'turn'); consequences:=consequences||jsonb_build_array('El sorteo y el cronómetro se reiniciarán.'); end if;
  if clear_rank then nextstate:=nextstate-'presentationRanking'; consequences:=consequences||jsonb_build_array('El ranking se eliminará y deberá generarse nuevamente.'); end if;
  select coalesce(jsonb_agg(x),'[]') into allids from jsonb_each(removed) e cross join lateral jsonb_array_elements(e.value) x;
  nextstate:=jsonb_set(nextstate,'{audit}',coalesce((select jsonb_agg(v) from jsonb_array_elements(coalesce(s->'audit','[]')) v where not(allids ? (v->>'referenceId')) and not(names ? (v->>'actor'))),'[]'));
 end if;
 for c in select jsonb_object_keys(removed) loop counts:=counts||jsonb_build_object(c,jsonb_array_length(removed->c)); end loop;
 counts:=counts||jsonb_build_object('deliveries',jsonb_array_length(coalesce(s->'deliveries','[]'))-jsonb_array_length(coalesce(nextstate->'deliveries','[]')),'presentationDraw',case when clear_draw and s->'presentationDraw' is not null then 1 else 0 end,'presentationRanking',case when clear_rank and s->'presentationRanking' is not null then 1 else 0 end,'responseScores',response_count);
 if jsonb_array_length(removed->'paperPolls')>0 then consequences:=consequences||jsonb_build_array('Se eliminarán las votaciones en papel afectadas, sus votos y los códigos de sus fichas.'); end if;
 if jsonb_array_length(removed->'rounds')>0 then consequences:=consequences||jsonb_build_array('Se eliminarán las rondas anteriores afectadas, sus conteos y códigos de voto.'); end if;
 if jsonb_array_length(removed->'teachers')>0 and scope<>'all' then consequences:=consequences||jsonb_build_array('Los accesos de los docentes eliminados dejarán de funcionar.'); end if;
 perform public.textos_validate_state(nextstate);
 select coalesce(jsonb_agg(x),'[]') into allids from jsonb_each(removed) e cross join lateral jsonb_array_elements(e.value) x;
 return jsonb_build_object('state',nextstate,'removed',removed,'allIds',allids||rewritten,'teacherNames',names,'preview',jsonb_build_object('stateVersion',(s->>'version')::int,'scope',scope,'ids',ids,'labels',labels,'counts',counts,'consequences',consequences,'requiresFullConfirmation',scope='all'));
end $$;

create or replace function public.textos_cleanup_action(s jsonb,p_action text,p_payload jsonb,actor_role text,actor_id text,actor_name text,p_dataset text,nowat timestamptz) returns jsonb
language plpgsql volatile set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare plan jsonb; preview jsonb; removed jsonb; scope text:=p_payload->>'scope'; n integer; col text; counts jsonb;
begin
 if actor_role is distinct from 'coordinator' then perform public.textos_fail('Solo Subdirección puede eliminar información.','PT403'); end if;
 if p_action not in ('data_delete_preview','data_delete_apply') then perform public.textos_fail('Operación de eliminación no reconocida.'); end if;
 plan:=public.textos_cleanup_plan(s,p_payload); preview:=plan->'preview'; removed:=plan->'removed'; counts:=preview->'counts';
 select count(*) into n from public.textos_access a where a.dataset=p_dataset and a.role='teacher' and (scope='all' or removed->'teachers' ? a.teacher_id); counts:=counts||jsonb_build_object('teacherAccesses',n);
 select count(*) into n from public.textos_ballots b where b.dataset=p_dataset and (scope='all' or removed->'rounds' ? b.round_id); counts:=counts||jsonb_build_object('ballots',n);
 select count(*) into n from public.textos_aggregates b where b.dataset=p_dataset and (scope='all' or removed->'rounds' ? b.round_id); counts:=counts||jsonb_build_object('voteAggregates',n);
 select count(*) into n from public.textos_paper_tokens b where b.dataset=p_dataset and (scope='all' or removed->'paperPolls' ? b.poll_id); counts:=counts||jsonb_build_object('paperTokens',n);
 select count(*) into n from public.textos_paper_evidence b where b.dataset=p_dataset and (scope='all' or removed->'paperPolls' ? b.poll_id); counts:=counts||jsonb_build_object('paperEvidence',n);
 select count(*) into n from public.textos_history h where h.dataset=p_dataset and (scope='all' or plan->'allIds' ? h.reference_id or plan->'teacherNames' ? h.actor or public.textos_cleanup_mentions(h.previous,plan->'allIds')); counts:=counts||jsonb_build_object('history',n);
 preview:=jsonb_set(preview,'{counts}',counts);
 if p_action='data_delete_preview' then return jsonb_build_object('state',s,'result',preview,'referenceId',scope,'reason','','history','[]'::jsonb); end if;
 if not public.textos_int(p_payload->'expectedVersion') or p_payload->'expectedVersion' is distinct from s->'version' then perform public.textos_fail('La información cambió. Revise nuevamente lo que se eliminará.','PT409'); end if;
 if p_payload->>'confirmation' is distinct from (case when scope='all' then 'ELIMINAR TODO' else 'ELIMINAR' end) then perform public.textos_fail('Confirme expresamente la eliminación seleccionada.'); end if;
 delete from public.textos_access a where a.dataset=p_dataset and a.role='teacher' and (scope='all' or removed->'teachers' ? a.teacher_id);
 delete from public.textos_ballots b where b.dataset=p_dataset and (scope='all' or removed->'rounds' ? b.round_id);
 delete from public.textos_aggregates b where b.dataset=p_dataset and (scope='all' or removed->'rounds' ? b.round_id);
 delete from public.textos_paper_tokens b where b.dataset=p_dataset and (scope='all' or removed->'paperPolls' ? b.poll_id);
 delete from public.textos_paper_evidence b where b.dataset=p_dataset and (scope='all' or removed->'paperPolls' ? b.poll_id);
 delete from public.textos_history h where h.dataset=p_dataset and (scope='all' or plan->'allIds' ? h.reference_id or plan->'teacherNames' ? h.actor or public.textos_cleanup_mentions(h.previous,plan->'allIds'));
 return jsonb_build_object('state',plan->'state','result',jsonb_build_object('deleted',true,'preview',preview),'referenceId',scope,'reason','Eliminación administrativa de información confirmada','history','[]'::jsonb);
end $$;
