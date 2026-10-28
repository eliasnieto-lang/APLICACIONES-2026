# Opción 1: I25 %, II25 % y III50 %

El usuario eligió la opción 1 para dar mayor peso al III bimestre, ya que AD se habilitó recién en ese periodo. Esta política sustituye los promedios bimestrales iguales de versiones anteriores. No modifica las notas originales ni convierte las A de I–II en AD.

## Promedios ponderados

Se mantiene AD=4, A=3, B=2 y C=1. Cada bimestre promedia las competencias cursadas del área. El promedio del área usa:

`Promedio = 0,25 × I + 0,25 × II + 0,50 × III`.

El resultado se presenta sobre 100 multiplicándolo por 25. G y R se calculan desde esos promedios ponderados, sin aplicar otra vez el peso del III. Las áreas mantienen el mismo peso entre sí; Ciencias/Letras conservan su ponderación interna. Los cursos no cursados y la fila Indaga completamente vacía siguen excluidos; una competencia parcial sigue pendiente. IV permanece conservado y fuera de los cálculos.

Ejemplos por asignatura:

| Notas | Promedio sobre 100 |
|---|---:|
| A–A–A | 75,00 |
| A–A–AD | 87,50 |
| B–B–A | 62,50 |

La captura previa de Matemática tenía medias bimestrales2,50/2,75/3,00. Con la nueva regla, el resultado es **70,3125 puntos**, mostrado como **70,31**. No se redondean operaciones intermedias.

## Progresión con escala común

La progresión conserva el nivel real del III y evita añadir una bonificación solo porque ahora exista AD. Para comparar el cambio se usa una copia derivada de cada celda: C=1, B=2 y A/AD=3. Esta equivalencia se aplica exclusivamente a la comparación; el AD original sigue valiendo4 en el promedio ponderado y en el nivel actual del III.

`Δ comparable = promedio comparable III − promedio comparable I–II`.

`P = 25 × MIN(4; MAX(1; promedio real III + 0,50 × Δ comparable))`.

La equivalencia se aplica a cada nota antes de promediar; no se limita el promedio completo a3, porque eso ocultaría diferencias entre competencias. Se conservan los indicadores reales S1/S2 y se añaden los comparables para explicar el resultado.

Con A–A–AD, el cambio comparable es0 y P=100 por el logro actual AD, sin aumento adicional por progresión. Si todas las áreas tienen ese patrón, G=87,50, R=87,50 y el ámbito Académico completo es **90,00** por la combinación interna40 %G/40 %R/20 %P. El promedio87,50 de una asignatura y el puntaje90,00 del ámbito académico son medidas distintas.

## Aplicación y compatibilidad

Las fichas, métricas, rankings, exportaciones y restauraciones usan la misma función de cálculo. Parámetros y las tablas muestran los pesos25/25/50. El Excel añade los pesos y los promedios comparables, conservando las columnas anteriores.

`Settings.bimesterWeights` y `academicScoringPolicy` permiten reconocer la nueva política. La primera migración aplica25/25/50 y deja pendiente la aprobación institucional de la fórmula una sola vez. Conserva cierre, notas, PDF, historial, revisiones de lectura, B/C, ausencia de concursos y decisiones de permanencia. No obliga a escanear otra vez para recalcular. Los guardados antiguos que omiten los campos nuevos conservan los valores actuales.

Confirmar o retirar únicamente la aprobación de los criterios no cambia las notas ni borra sus revisiones: se registra ese acto en el historial y se conserva la validación de las dimensiones. Un cambio efectivo de pesos o catálogo continúa invalidando las revisiones afectadas según la regla de Parámetros.

Los pesos generales continúan en50 % Académico,25 % Desempeño y25 % Compromiso; la exclusión individual de C mantiene la proporción2/3A+1/3B. No se cambian asistencia, disciplina, participación, familia ni los controles de eliminación.
