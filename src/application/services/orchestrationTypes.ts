import { StemType } from '../../shared/enums';

export type SpecialistHealthStatus = 'unknown' | 'healthy' | 'failed' | 'unavailable';

export type SpecialistStatus =
  | 'not_configured'
  | 'runtime_unavailable'
  | 'health_failed'
  | 'skipped_by_policy'
  | 'selected'
  | 'failed'
  | 'fallback_to_baseline';

export type SpecialistStemTarget = StemType.Guitar | StemType.Keyboard;

export interface SpecialistDescriptor {
  specialistId: 'guitar_specialist' | 'piano_specialist';
  targetStem: SpecialistStemTarget;
  modelId: string;
  runtimeProfileId: string;
  requiredEnv: string[];
  healthStatus: SpecialistHealthStatus;
  selectionPriority: number;
  supportsFallback: boolean;
}

export interface StemSelectionPolicy {
  policyId: string;
  baselineStemTypes: StemType[];
  specialistStemTypes: SpecialistStemTarget[];
  fallbackToBaselineOnFailure: boolean;
}

export interface SpecialistExecutionPlan {
  orchestratedResultSetId: string;
  baselineModelId: string;
  baselineRuntimeProfileId: string;
  specialists: SpecialistDescriptor[];
  selectionPolicy: StemSelectionPolicy;
}

export interface SpecialistPassReport {
  specialistId: 'guitar_specialist' | 'piano_specialist';
  targetStem: SpecialistStemTarget;
  modelId: string;
  runtimeProfileId: string;
  resultSetId: string;
  status: SpecialistStatus;
  healthStatus: SpecialistHealthStatus;
  reason: string | null;
  warningCount: number;
  jobStatus: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  selected: boolean;
  fallbackUsed: boolean;
  selectionReason: string | null;
  sourceResultSetId: string | null;
  passStatusBeforeFallback: SpecialistStatus | null;
}
