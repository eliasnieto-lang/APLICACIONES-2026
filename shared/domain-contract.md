# Cálculos y valores iniciales

`shared/domain.ts` exporta:

- `AREAS`: `{id: Area, label: string}[]`; `BLOCKS`: `{id: Block, label: string, gradeIds: GradeId[]}[]`; `GRADES`: `{id: GradeId, label: string, level: string, number: number, block: Block}[]`.
- `INDICATORS`: `{id: string, label: string, a: string, b: string, variants?: {MAT:{a,b},COM:{a,b}}}[]`. I2 ofrece ambas variantes; el docente debe ver solo la de su área.
- `CHECKS`: `{id: string, label: string}[]`, en el orden de los ocho filtros.
- `scoreEvaluation(scoresOrEvaluation): number | null`. Rechaza con error valores fuera de 0/1/2/null; una ficha incompleta devuelve null.
- `assessBook(state, bookOrId): BookAssessment`, `assessOffer(state, offerOrId): OfferAssessment`, `assessCategory(state, categoryId): CategoryAssessment`. Categoría: `MAT-P1`, `COM-S1`, etc. No redondean puntajes. Ofertas incompletas bloquean la publicación de su categoría.
- `workloadSummary(book)`: `{source:'quick'|'detailed', bimesters:(number|null)[], total:number|null, chapters:{name,count:number|null}[], uniqueTopics:Topic[], samplePositions:number[], complete:boolean, discrepancies:string[], reasons:string[]}`. El detalle sustituye la carga rápida. Un tema retomado no suma salvo lección distinta.
- `practiceSummary(book)`: `{positions:number[], samples:PracticeSample[], complete:boolean, size:number, mean:number|null, min:number|null, max:number|null, allTopicsMean:number|null, allTopicsKind:'verified'|'declared'|null, reasons:string[]}`. Muestra solo del material base, no extrapolada; cero cuenta y null mantiene pendiente.
- `supportScoreConstraints(book)`: `{pending:boolean, maximum:0|1|2|null, required:0|1|null, teacher:boolean|null, student:boolean|null, reasons:string[]}`. `required:0` para ausencia confirmada, `required:1` para exactamente un perfil funcional con ausencia del otro confirmada; `maximum:null` indica pendiente. El resto conserva el juicio docente hasta el máximo verificable.
- `basePrice(book): number|null`: respeta precio conjunto declarado; si falta desglose no presume cero.
- `sourceToTargetGrade(source:string): GradeId|null`: promoción de origen 2026 a destino 2027.

`shared/defaults.ts`: `defaultBook(overrides?:Partial<Book>):Book`, `emptyState():State`, `demoState():State`. La jornada real queda vacía; demo es ficticia y reproducible.

`shared/imports.ts`: `validateImport(kind:'titles'|'topics'|'practice'|'sections', rows:Record<string,unknown>[], state:State): {valid:boolean, errors:{row:number,field:string,message:string}[], warnings:{row:number,field:string,message:string}[], rows:Record<string,unknown>[]}`. Números de fila comienzan en 2 (cabecera CSV). No muta el estado ni aplica datos. Los nombres canónicos de columna se describen en ese módulo; admite encabezados españoles de las plantillas.
