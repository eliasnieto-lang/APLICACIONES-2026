# Live presentation contract

The live form is unique per teacher + publisher + area (MAT/COM) + block (P1/P2/S1). It observes the current presentation and the physical text in hand. Historical books, assignments, evaluations and shortlists remain separate. No imported dossier, OBNATE, price, annual workload, evidence array or preloaded book is required to close a live form.

`Teacher` optionally adds `firstNames`, `lastNames`, `area`, `categories: Block[]` and `selfRegistered`. Registered scope requires the selected area and at least one selected block. There is no limit on the number of teachers. `state.turn.publisherId` identifies the room's current publisher, while teachers may select another accessible publisher.

`PresentationEvaluation` has `id`, `version`, `publisherId`, `teacherId`, `area`, `block`, `scores: Score[10]`, `notes: string[10]`, `generalObservation`, `physicalText`, optional `materialViewed`, `status: draft|closed`, `closedAt`, `updatedAt`, `rulesVersion`. All ten scores start `null`. Closing requires ten integers 0/1/2; brief notes and physical text identification are optional. Score = 5 × sum. Scores and observations remain private to their author and coordination; public published snapshots contain aggregate results only.

`state.presentationEvaluations` and `state.presentationShortlists` are independent arrays. `settings.evaluationMode = 'presentation'` signals the new live workflow. Missing arrays on older snapshots are treated as empty; no historical score is transferred.

## Client exports from shared/presentation.ts

- `PRESENTATION_INDICATORS`: ten indicators with `id`, `label`, `a`, `b`, optional `variants` (same shape as historical Indicator).
- `newPresentationEvaluation({publisherId,teacherId,area,block,rulesVersion?})`: empty local form, `id:''`, `version:0`.
- `presentationEvaluationIssues(evaluation): string[]`: completion issues; no dossier requirements.
- `presentationScore(scoresOrEvaluation): number|null`: null while incomplete, error for malformed values.
- `presentationTeacherInScope(teacher,area,block): boolean`.
- `presentationPublisherAvailable(state,publisherId,area,block): boolean`: a publisher with explicit offers is available only in currently offered scopes; a publisher without any offers is available in all registered scopes.
- `presentationPublisherAssessment(state,publisherId,area,block)` returns `{publisherId,area,block,registered,closed,pending,drafts,score,i2,state:'pending'|'eligible'|'ineligible'}`. Registered is the entire scope roster; pending is registered minus valid closed forms; score averages every valid closed form, including 3/4/5 or more teachers. A provisional score can exist while pending remains.
- `presentationCategoryAssessment(state,area,block)` returns `{categoryId,area,block,state:'pending'|'ready'|'tie'|'less_than_three'|'published',registered,closed,pending,ranked,finalists,tied,reasons}`. Category registered counts teachers; closed/pending count all publisher forms. `ranked` contains publisher assessments; finalists/tied contain publisher IDs. Rank by mean score, then mean I2. A tie crossing the third place remains unresolved and blocks publication. Below threshold and incomplete publishers are excluded. Fewer than three eligible publishers are shown as a warning and cannot form a formal published shortlist through this action; a future documented article 11.3 procedure must remain separate.
- `presentationSummary(state)` returns the six area/block category assessments.

## API actions

- `presentation_save {publisherId,area,block,scores,notes,generalObservation,physicalText,expectedVersion,materialViewed?}` → saved PresentationEvaluation. `teacherId` is always the authenticated actor. Initial CAS version is 0; updates require the current version. Closed forms are immutable.
- `presentation_close {evaluationId,expectedVersion}` → closed PresentationEvaluation; only the author may close it.
- `presentation_reopen {evaluationId,reason}` → reopened PresentationEvaluation; coordination only. History preserves the prior closed form and published shortlists in its category become superseded.
- `presentation_summary {}` → category assessments; coordination/secretary only (clients may also derive these from their authorized snapshot).
- `presentation_shortlist_publish {area,block,directorApproved,statement,folio}` → published PresentationShortlist; coordination only, no pending forms, exactly three eligible finalists, no unresolved cutoff tie, and the publishers' withdrawal recorded in `settings.editorsWithdrawn` with `withdrawalReference`. `snapshot` contains aggregate assessment, public publisher records and threshold; no personal observations or individual score sheets.

`PresentationShortlist` has `id`, `version`, `categoryId`, `area`, `block`, `publisherIds`, `status:published|superseded`, `statement`, `folio`, `directorApproved`, `publishedAt`, `rulesVersion`, `snapshot:{assessment,publishers,threshold}`. It does not invent per-grade evaluations or feed historical grade rounds automatically.

## SQL integration

`textos_presentation_api(s jsonb,p_action text,p_payload jsonb,actor_role text,actor_id text,actor_name text,nowat timestamptz)` returns `{state,result,history?}` for the canonical API to persist. Canonical authorization and transaction locking remain in `textos_api`; the wrapper also checks actor role, ownership, registered scope, tuple identity and version. `history` entries preserve a reopened closed form for canonical history storage. Teacher snapshots expose only their own forms and clear presentation shortlists. Public snapshots expose only published aggregate shortlists and no live forms. The fragment is integrated by the schema owner.
