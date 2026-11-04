# Live presentation contract

The live form is unique per teacher + publisher + area (MAT/COM) + block (P1/P2/S1). It observes the presentation and the physical text in hand. Historical books, assignments, evaluations and shortlists remain separate. No imported dossier, OBNATE, price, annual workload, evidence array or preloaded book is required to close a live form.

`Teacher` optionally adds `firstNames`, `lastNames`, `area`, `categories: Block[]` and `selfRegistered`. Registered scope requires the selected area and at least one block. Any number of teachers can evaluate. `state.turn.publisherId` identifies the room's current publisher, while teachers may select another accessible publisher.

`PresentationScore = 0|1|2|3|4|null`, with labels 0 Sin valoración, 1 En inicio, 2 En proceso, 3 Logrado, 4 Destacado. An explicit 0 is an intentional answer contributing zero; it is never excluded from the total or mean. `null` is unanswered and prevents closure. Ten current indicators have a raw maximum of 40; percentage = sum × 2.5. Nine values 4 and one value 0 produce 90/100.

`PresentationEvaluation` stores `id`, `version`, `publisherId`, `teacherId`, `area`, `block`, `scores: PresentationScore[10]`, `notes: string[10]`, `generalObservation`, `physicalText`, optional `materialViewed`, optional `scaleMax:2|4`, `status:draft|closed`, `closedAt`, `updatedAt`, `rulesVersion`. New forms always set `scaleMax:4` and ten `null` values. Closing requires ten integers 0–4; notes and physical text identification are optional. Scores and observations remain private to the author and coordination.

Missing `scaleMax` always identifies the historical 0–2 live rubric. Its stored marks are never inferred, multiplied or reinterpreted. Historical percentage remains sum × 5: ten historical values 2 mean 100/100, while ten current values 2 mean 50/100. Historical forms remain visible as pending a scale update and cannot enter current consolidation. Each author explicitly restarts the rubric before rescoring; the original remains in history.

`state.presentationEvaluations` and `state.presentationShortlists` are independent arrays. `settings.evaluationMode='presentation'` and `settings.presentationScaleMax=4` identify the current workflow. Missing arrays on old snapshots are empty. Book evaluation `Score` and its 0–2 rules remain unchanged.

## Client exports from shared/presentation.ts

- `PRESENTATION_SCALE`, `presentationScaleLabel(score)`: the five current response values and their labels; `null` is Pendiente.
- `PRESENTATION_INDICATORS`: ten indicators with `id`, `label`, one `description` and optional area `variants` containing `description`; no separate A/B point columns.
- `newPresentationEvaluation({publisherId,teacherId,area,block,rulesVersion?})`: new scale-4 local form with `id:''`, `version:0`, ten unanswered values.
- `presentationEvaluationScaleMax(evaluation):2|4`: absent metadata means 2; invalid metadata fails.
- `presentationUsesCurrentScale(evaluation):boolean`: true only when explicitly marked 4.
- `presentationEvaluationIssues(evaluation):string[]`: completion issues; historical forms require a scale update. No dossier requirements.
- `presentationScore(evaluation)` honors its stored scale. `presentationScore(scores,arrayScaleMax=4)` supports an explicit historical maximum 2. Incomplete marks return `null`; malformed values fail.
- `presentationTeacherInScope(teacher,area,block):boolean`.
- `presentationPublisherAvailable(state,publisherId,area,block):boolean`: explicit offers restrict availability to their currently offered scopes; a publisher without offers is available in every registered scope.
- `presentationPublisherAssessment(state,publisherId,area,block)` returns `{publisherId,area,block,registered,closed,pending,drafts,pendingScaleUpdate,score,i2,state:'pending'|'eligible'|'ineligible'}`. The roster includes every registered teacher in scope. Closed counts only valid current-scale forms; historical forms count in `pendingScaleUpdate` and remain pending. Score averages every current valid closure, including zero-scoring forms and any number of teachers.
- `presentationCategoryAssessment(state,area,block)` returns `{categoryId,area,block,state:'pending'|'ready'|'tie'|'less_than_three'|'published',registered,closed,pending,pendingScaleUpdate,ranked,finalists,tied,reasons}`. Registered counts teachers; closed/pending count publisher forms. Rank by mean percentage then mean I2, using current-scale closures only. A cutoff tie after I2 blocks publication. Fewer than three eligible publishers produces a warning and cannot form a formal published shortlist. A current published marker requires `snapshot.scaleMax:4`.
- `presentationSummary(state)` returns the six area/block assessments.

## API actions

- `presentation_save {publisherId,area,block,scaleMax:4,scores,notes,generalObservation,physicalText,expectedVersion,materialViewed?}` → saved `PresentationEvaluation`. The teacher id is always the authenticated actor. Initial CAS version is 0; updates require its current version. Closed forms are immutable. Historical forms require explicit restart rather than a direct save.
- `presentation_close {evaluationId,expectedVersion,scaleMax:4}` → closed current-scale form; only its author may close it.
- `presentation_restart_scale {evaluationId,expectedVersion,scaleMax:4}` → same historical unit/id with version incremented, scale 4, ten `null` marks, draft status and no close date. Only its author in the registered scope can restart; historical open or closed forms are eligible, current scale-4 forms are not. The exact original is archived and notes/observations are retained. No numerical conversion occurs.
- A missing/wrong `scaleMax:4` in save/close/restart returns PT409 so an old browser cannot accidentally save its 0–2 controls as current marks.
- `presentation_reopen {evaluationId,reason}` → reopened form; coordination only. Preserves the prior closed form and its scale; current shortlists in its category become superseded.
- `presentation_summary {}` → six category assessments; coordination/secretary only. An optional valid area/block pair returns one category.
- `presentation_shortlist_publish {area,block,directorApproved,statement,folio}` → aggregate `PresentationShortlist`; coordination only. Requires all current-scale forms complete, exactly three eligible finalists, no unresolved cutoff tie, and documented publisher withdrawal through `settings.editorsWithdrawn` plus `withdrawalReference`.

`PresentationShortlist` stores id/version/category/area/block, publisher ids, `status:published|superseded`, statement/folio/approval, publication time, rules version and `snapshot:{assessment,publishers,threshold,scaleMax?:2|4}`. New snapshots store scale 4; missing historical metadata means 2. Snapshots contain aggregate results and publisher id/name only, never personal observations or individual forms. Current published snapshots must use scale 4. Historical book rounds are not generated from these category results.

A newly registered teacher or a change of area/category scope supersedes affected current publications while preserving their snapshots and history. Reentry with the same scope preserves the publication. All current participants must complete the new cohort before a replacement can be published.

## SQL and migration

`textos_presentation_api(s,p_action,p_payload,actor_role,actor_id,actor_name,nowat)` returns `{state,result,history?}`. `textos_api` persists this under the dataset transaction lock and records history. The helper also verifies role, ownership, scope and CAS. `textos_presentation_scores(scores,scale_max=4,complete=false)` implements scale-aware validation independently of the historical book helper.

`migrations/003-escala-y-filtros.sql` equals the current full `schema.sql`; 002 remains immutable. 003 marks prior live rows as scale 2 and retires prior live publications to historical snapshots, preserving exact originals in history without numeric conversion. It activates the scale-4 setting once. Reapplying it does not change versions or append history. Old backups follow the same metadata upgrade before restore validation; current/public consolidation never mixes scales.

Teacher snapshots expose only their own forms and clear presentation shortlists. Public snapshots expose only current published scale-4 aggregates. Historical scales, notes, access codes and individual forms remain private.
