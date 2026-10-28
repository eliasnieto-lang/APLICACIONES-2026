import type { DimensionWeights, Settings, Student } from './types';

export const DEFAULT_DIMENSION_WEIGHTS: Readonly<DimensionWeights> = Object.freeze({ academic: .5, performance: .25, commitment: .25 });

export const isCommitmentEnabled = (student?: Pick<Student, 'commitmentEnabled'>): boolean => student?.commitmentEnabled !== false;

/** Missing fields in older records keep Compromiso enabled and use the current weights. */
export function getDimensionWeights(settings?: Pick<Settings, 'dimensionWeights'>): DimensionWeights {
  return { ...(settings?.dimensionWeights ?? DEFAULT_DIMENSION_WEIGHTS) };
}

/** Excluding C preserves the approved A:B ratio rather than adding an unmeasured score. */
export function getEffectiveDimensionWeights(settings?: Pick<Settings, 'dimensionWeights'>, student?: Pick<Student, 'commitmentEnabled'>): DimensionWeights {
  const weights = getDimensionWeights(settings);
  if (isCommitmentEnabled(student)) return weights;
  const denominator = weights.academic + weights.performance;
  return denominator > 0 && Number.isFinite(denominator)
    ? { academic: weights.academic / denominator, performance: weights.performance / denominator, commitment: 0 }
    : { academic: 0, performance: 0, commitment: 0 };
}
