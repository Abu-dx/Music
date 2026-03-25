import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectStatus, StemStatus, StemType } from '../../shared/enums';
import type { ManifestResultSetEntry, ManifestStemEntry, StemFile } from '../../domain/entities';
import type { IProjectRepository, IStemFileRepository } from '../../domain/repositories';
import type { IParseJobService } from './parseJobService';
import type {
  SpecialistDescriptor,
  SpecialistExecutionPlan,
  SpecialistPassReport,
  SpecialistStatus,
  SpecialistStemTarget,
} from './orchestrationTypes';

const ORCH_SOURCE_KIND = 'orchestrated';
const ORCH_RESULT_MODEL_ID = 'orchestrated_6s';
const ORCH_RESULT_RUNTIME_PROFILE_ID = 'orchestrator_main';
const GUITAR_SPECIALIST_MODEL_ID = 'mel_roformer_guitar';
const SUPPORTED_WORKER_MODEL_OVERRIDES = new Set(['htdemucs', 'htdemucs_6s', GUITAR_SPECIALIST_MODEL_ID]);

const ORCH_STEM_FILENAME: Record<string, string> = {
  [StemType.Vocal]: 'vocals',
  [StemType.Drums]: 'drums',
  [StemType.Bass]: 'bass',
  [StemType.Guitar]: 'guitar',
  [StemType.Keyboard]: 'piano',
  [StemType.Other]: 'other',
};

export type OrchestrationPassStatus = 'success' | 'failed' | 'skipped';

export interface OrchestrationPassReport {
  passId: 'baseline_6s' | 'guitar_specialist' | 'piano_specialist';
  resultSetId: string;
  modelId: string;
  runtimeProfileId: string;
  executionStatus: OrchestrationPassStatus;
  specialistStatus: SpecialistStatus | null;
  reason: string | null;
  warningCount: number;
  jobStatus: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

type SelectedStemPlan = {
  stemType: StemType;
  selectedStem: StemFile;
  selectedFromResultSetId: string;
  selectionReason: string;
  fallbackUsed: boolean;
};

export interface StartOrchestrationParams {
  projectId: string;
  sourceFilePath: string;
  projectDir: string;
  executionPlan: SpecialistExecutionPlan;
}

export interface OrchestrationResult {
  orchestratedResultSetId: string;
  baselineResultSetId: string;
  passReports: OrchestrationPassReport[];
  specialistReports: SpecialistPassReport[];
  warnings: string[];
  stemFiles: StemFile[];
  manifestEntries: ManifestStemEntry[];
  resultSetEntry: ManifestResultSetEntry;
  debugReportRelativePath: string;
  debugReport: {
    orchestratedResultSetId: string;
    baselineResultSetId: string;
    generatedAt: number;
    baselinePassStatus: OrchestrationPassStatus;
    specialistReports: SpecialistPassReport[];
    passReports: OrchestrationPassReport[];
    stemSelections: Array<{
      stemType: StemType;
      modelId: string;
      runtimeProfileId: string;
      selectionReason: string;
      fallbackUsed: boolean;
      sourceResultSetId: string;
      sourceSignature: string;
    }>;
  };
}

type RunPassInput = {
  projectId: string;
  sourceFilePath: string;
  projectDir: string;
  resultSetId: string;
  passId: OrchestrationPassReport['passId'];
  modelId: string;
  runtimeProfileId: string;
};

type RunPassOutput = {
  report: OrchestrationPassReport;
  stems: StemFile[];
};

function classifySpecialistFailureStatus(report: OrchestrationPassReport): SpecialistStatus {
  const merged = `${report.reason ?? ''} ${report.errorCode ?? ''} ${report.errorMessage ?? ''}`.toLowerCase();
  if (merged.includes('runtime profile unavailable') || merged.includes('runtime_health_unavailable')) {
    return 'runtime_unavailable';
  }
  if (
    merged.includes('required_modules_missing')
    || merged.includes('no module named')
    || merged.includes('health_check_failed')
    || merged.includes('runtime_health_failed')
  ) {
    return 'health_failed';
  }
  return 'failed';
}

function normalizeResultSetId(value: string | null | undefined): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : 'main';
}

function filterStemsForResultSet(stems: StemFile[], resultSetId: string): StemFile[] {
  const target = normalizeResultSetId(resultSetId);
  return stems.filter((stem) => normalizeResultSetId(stem.parentResultId) === target);
}

function findStemByType(stems: StemFile[], stemType: StemType): StemFile | null {
  return stems.find((stem) => stem.stemType === stemType) ?? null;
}

function sanitizeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
}

function buildResultSetId(baseResultSetId: string, suffix: string): string {
  return `${baseResultSetId}__${sanitizeToken(suffix)}`;
}

function buildOrchestratedSourceSignature(
  projectId: string,
  orchestratedResultSetId: string,
  selections: SelectedStemPlan[],
): string {
  const hash = crypto.createHash('sha1');
  hash.update(projectId);
  hash.update('|');
  hash.update(orchestratedResultSetId);
  const ordered = selections.slice().sort((a, b) => a.stemType.localeCompare(b.stemType));
  for (const selection of ordered) {
    hash.update('|');
    hash.update(selection.stemType);
    hash.update('|');
    hash.update(selection.selectedFromResultSetId);
    hash.update('|');
    hash.update(selection.selectedStem.modelId ?? '');
    hash.update('|');
    hash.update(selection.selectedStem.runtimeProfileId ?? '');
    hash.update('|');
    hash.update(selection.selectedStem.sourceSignature ?? '');
    hash.update('|');
    hash.update(selection.selectionReason);
  }
  return hash.digest('hex');
}

function fallbackReasonFromStatus(status: SpecialistStatus): string {
  switch (status) {
    case 'not_configured':
      return 'fallback:not_configured';
    case 'runtime_unavailable':
      return 'fallback:runtime_unavailable';
    case 'health_failed':
      return 'fallback:health_failed';
    case 'skipped_by_policy':
      return 'fallback:skipped_by_policy';
    case 'failed':
      return 'fallback:specialist_failed';
    case 'fallback_to_baseline':
      return 'fallback:already_baseline';
    case 'selected':
      return 'fallback:selected_impossible';
    default:
      return 'fallback:unknown';
  }
}

function toPassId(specialistId: SpecialistDescriptor['specialistId']): OrchestrationPassReport['passId'] {
  return specialistId;
}

export class OrchestratedSeparationService {
  constructor(
    private readonly parseJobService: IParseJobService,
    private readonly projectRepo: IProjectRepository,
    private readonly stemFileRepo: IStemFileRepository,
  ) {}

  async start(params: StartOrchestrationParams): Promise<OrchestrationResult> {
    const warnings: string[] = [];
    const passReports: OrchestrationPassReport[] = [];
    const specialistReports = new Map<SpecialistDescriptor['specialistId'], SpecialistPassReport>();
    const baselineResultSetId = buildResultSetId(params.executionPlan.orchestratedResultSetId, 'base_6s');
    const baselinePass = await this.runPass({
      projectId: params.projectId,
      sourceFilePath: params.sourceFilePath,
      projectDir: params.projectDir,
      resultSetId: baselineResultSetId,
      passId: 'baseline_6s',
      modelId: params.executionPlan.baselineModelId,
      runtimeProfileId: params.executionPlan.baselineRuntimeProfileId,
    });
    passReports.push(baselinePass.report);
    if (baselinePass.report.executionStatus !== 'success' || baselinePass.stems.length === 0) {
      throw new Error(
        `ORCH_BASELINE_REQUIRED: baseline 6stem pass failed (status="${baselinePass.report.executionStatus}" reason="${baselinePass.report.reason ?? 'unknown'}")`,
      );
    }
    if (baselinePass.report.warningCount > 0) {
      warnings.push(`baseline warning count=${baselinePass.report.warningCount}`);
    }
    const baselineStemMap = new Map<StemType, StemFile>();
    for (const stem of baselinePass.stems) {
      baselineStemMap.set(stem.stemType, stem);
    }

    const sortedSpecialists = params.executionPlan.specialists
      .slice()
      .sort((a, b) => a.selectionPriority - b.selectionPriority);
    const specialistOutputs = new Map<SpecialistDescriptor['specialistId'], RunPassOutput>();
    for (const descriptor of sortedSpecialists) {
      const specialistResultSetId = buildResultSetId(
        params.executionPlan.orchestratedResultSetId,
        descriptor.specialistId,
      );
      const skippedByConfig = this.evaluateSpecialistConfig(descriptor);
      if (skippedByConfig) {
        const report = this.createSpecialistReport({
          descriptor,
          resultSetId: specialistResultSetId,
          status: skippedByConfig.status,
          reason: skippedByConfig.reason,
          executionStatus: 'skipped',
        });
        specialistReports.set(descriptor.specialistId, report);
        passReports.push({
          passId: toPassId(descriptor.specialistId),
          resultSetId: specialistResultSetId,
          modelId: descriptor.modelId,
          runtimeProfileId: descriptor.runtimeProfileId,
          executionStatus: 'skipped',
          specialistStatus: report.status,
          reason: report.reason,
          warningCount: 0,
          jobStatus: null,
          errorCode: null,
          errorMessage: null,
        });
        continue;
      }

      const specialistPass = await this.runPass({
        projectId: params.projectId,
        sourceFilePath: params.sourceFilePath,
        projectDir: params.projectDir,
        resultSetId: specialistResultSetId,
        passId: toPassId(descriptor.specialistId),
        modelId: descriptor.modelId,
        runtimeProfileId: descriptor.runtimeProfileId,
      });
      passReports.push({
        ...specialistPass.report,
        specialistStatus: specialistPass.report.executionStatus === 'success' ? 'selected' : 'failed',
      });
      if (specialistPass.report.executionStatus !== 'success') {
        const failureStatus = classifySpecialistFailureStatus(specialistPass.report);
        const report = this.createSpecialistReport({
          descriptor,
          resultSetId: specialistResultSetId,
          status: failureStatus,
          reason: specialistPass.report.reason ?? specialistPass.report.errorMessage ?? 'specialist_pass_failed',
          executionStatus: 'failed',
          warningCount: specialistPass.report.warningCount,
          jobStatus: specialistPass.report.jobStatus,
          errorCode: specialistPass.report.errorCode,
          errorMessage: specialistPass.report.errorMessage,
        });
        specialistReports.set(descriptor.specialistId, report);
        await this.projectRepo.updateStatus(params.projectId, ProjectStatus.Ready);
        continue;
      }

      const report = this.createSpecialistReport({
        descriptor,
        resultSetId: specialistResultSetId,
        status: 'selected',
        reason: 'specialist_pass_success',
        executionStatus: 'success',
        warningCount: specialistPass.report.warningCount,
        jobStatus: specialistPass.report.jobStatus,
        errorCode: specialistPass.report.errorCode,
        errorMessage: specialistPass.report.errorMessage,
      });
      specialistReports.set(descriptor.specialistId, report);
      specialistOutputs.set(descriptor.specialistId, specialistPass);
    }

    const selections: SelectedStemPlan[] = [];
    for (const stemType of params.executionPlan.selectionPolicy.baselineStemTypes) {
      const baselineStem = baselineStemMap.get(stemType);
      if (!baselineStem) {
        warnings.push(`orchestrated_result_missing_stem:${stemType}`);
        continue;
      }
      selections.push({
        stemType,
        selectedStem: baselineStem,
        selectedFromResultSetId: baselineResultSetId,
        selectionReason: 'baseline_6s_primary',
        fallbackUsed: false,
      });
    }

    for (const targetStem of params.executionPlan.selectionPolicy.specialistStemTypes) {
      const descriptor = sortedSpecialists.find((item) => item.targetStem === targetStem) ?? null;
      const baselineStem = baselineStemMap.get(targetStem);
      if (!descriptor) {
        if (baselineStem) {
          selections.push({
            stemType: targetStem,
            selectedStem: baselineStem,
            selectedFromResultSetId: baselineResultSetId,
            selectionReason: 'fallback:descriptor_missing',
            fallbackUsed: true,
          });
        } else {
          warnings.push(`orchestrated_result_missing_stem:${targetStem}`);
        }
        continue;
      }

      const specialistReport = specialistReports.get(descriptor.specialistId);
      const specialistPassReport = passReports.find((entry) => entry.passId === toPassId(descriptor.specialistId));
      const specialistOutput = specialistOutputs.get(descriptor.specialistId);
      const specialistStem = specialistOutput ? findStemByType(specialistOutput.stems, targetStem) : null;
      if (specialistReport && specialistStem) {
        selections.push({
          stemType: targetStem,
          selectedStem: specialistStem,
          selectedFromResultSetId: specialistReport.resultSetId,
          selectionReason: `${descriptor.specialistId}_override`,
          fallbackUsed: false,
        });
        specialistReport.status = 'selected';
        specialistReport.selected = true;
        specialistReport.fallbackUsed = false;
        specialistReport.selectionReason = `${descriptor.specialistId}_override`;
        specialistReport.sourceResultSetId = specialistReport.resultSetId;
        if (specialistPassReport) {
          specialistPassReport.specialistStatus = specialistReport.status;
          specialistPassReport.reason = specialistReport.reason;
        }
        continue;
      }

      if (!baselineStem) {
        warnings.push(`orchestrated_result_missing_stem:${targetStem}`);
        continue;
      }
      const fallbackStatus = specialistReport?.status ?? 'not_configured';
      const fallbackReason = fallbackReasonFromStatus(fallbackStatus);
      selections.push({
        stemType: targetStem,
        selectedStem: baselineStem,
        selectedFromResultSetId: baselineResultSetId,
        selectionReason: fallbackReason,
        fallbackUsed: true,
      });
      if (specialistReport) {
        specialistReport.passStatusBeforeFallback = specialistReport.status;
        const targetStemMissingAfterSelection = specialistReport.passStatusBeforeFallback === 'selected';
        if (targetStemMissingAfterSelection) {
          specialistReport.passStatusBeforeFallback = 'failed';
          specialistReport.reason = 'specialist_target_stem_missing';
          specialistReport.errorCode = specialistReport.errorCode ?? 'SPECIALIST_TARGET_STEM_MISSING';
          specialistReport.errorMessage = specialistReport.errorMessage ?? 'specialist pass did not produce target stem';
        }
        if (specialistReport.status === 'selected' || specialistReport.status === 'failed') {
          specialistReport.status = 'fallback_to_baseline';
        }
        specialistReport.fallbackUsed = true;
        specialistReport.selected = false;
        specialistReport.selectionReason = targetStemMissingAfterSelection
          ? 'fallback:target_stem_missing'
          : fallbackReason;
        specialistReport.sourceResultSetId = baselineResultSetId;
        if (specialistPassReport) {
          if (targetStemMissingAfterSelection) {
            specialistPassReport.executionStatus = 'failed';
            specialistPassReport.errorCode = specialistReport.errorCode;
            specialistPassReport.errorMessage = specialistReport.errorMessage;
          }
          specialistPassReport.specialistStatus = specialistReport.status;
          specialistPassReport.reason = specialistReport.reason;
        }
      }
    }

    const orchestratedSourceSignature = buildOrchestratedSourceSignature(
      params.projectId,
      params.executionPlan.orchestratedResultSetId,
      selections,
    );
    const orchestratedStemDir = path.join(
      params.projectDir,
      'results',
      params.executionPlan.orchestratedResultSetId,
      'stems',
    );
    await fs.promises.mkdir(orchestratedStemDir, { recursive: true });

    const stemFiles: StemFile[] = [];
    const manifestEntries: ManifestStemEntry[] = [];
    for (const selection of selections) {
      if (!fs.existsSync(selection.selectedStem.filePath)) {
        warnings.push(`orchestrated_source_missing:${selection.stemType}`);
        continue;
      }
      const sourceExt = path.extname(selection.selectedStem.filePath) || '.wav';
      const outputBasename = ORCH_STEM_FILENAME[selection.stemType] ?? selection.stemType;
      const outputFileName = `${outputBasename}${sourceExt}`;
      const outputPath = path.join(orchestratedStemDir, outputFileName);
      await fs.promises.copyFile(selection.selectedStem.filePath, outputPath);
      const copiedStat = await fs.promises.stat(outputPath);
      const relativePath = path.posix.join(
        'results',
        params.executionPlan.orchestratedResultSetId,
        'stems',
        outputFileName,
      );
      const sourceSignature = selection.selectedStem.sourceSignature || orchestratedSourceSignature;
      const modelId = selection.selectedStem.modelId ?? 'unknown';
      const runtimeProfileId = selection.selectedStem.runtimeProfileId ?? 'unknown';

      stemFiles.push({
        id: crypto.randomUUID(),
        projectId: params.projectId,
        stemType: selection.stemType,
        filePath: outputPath,
        codec: selection.selectedStem.codec,
        sizeBytes: copiedStat.size,
        durationMs: selection.selectedStem.durationMs ?? null,
        sampleRate: selection.selectedStem.sampleRate ?? null,
        exists: true,
        sourceOrigin: selection.selectedStem.sourceOrigin,
        confidence: selection.selectedStem.confidence ?? null,
        exportable: true,
        status: StemStatus.Detected,
        modelId,
        runtimeProfileId,
        jobId: selection.selectedStem.jobId,
        parentResultId: params.executionPlan.orchestratedResultSetId,
        sourceSignature,
        sourceKind: ORCH_SOURCE_KIND,
        selectionReason: selection.selectionReason,
        fallbackUsed: selection.fallbackUsed,
        sourceResultSetId: selection.selectedFromResultSetId,
      });

      manifestEntries.push({
        stemType: selection.stemType,
        relativePath,
        codec: selection.selectedStem.codec,
        sizeBytes: copiedStat.size,
        durationMs: selection.selectedStem.durationMs ?? null,
        sampleRate: selection.selectedStem.sampleRate ?? null,
        sourceOrigin: selection.selectedStem.sourceOrigin,
        modelId,
        runtimeProfileId,
        jobId: selection.selectedStem.jobId,
        parentResultId: params.executionPlan.orchestratedResultSetId,
        sourceSignature,
        sourceKind: ORCH_SOURCE_KIND,
        selectionReason: selection.selectionReason,
        fallbackUsed: selection.fallbackUsed,
        sourceResultSetId: selection.selectedFromResultSetId,
      });
    }

    if (stemFiles.length === 0) {
      throw new Error('ORCH_RESULT_EMPTY: orchestrated result set has no readable stems');
    }

    const specialistReportList = sortedSpecialists
      .map((descriptor) => specialistReports.get(descriptor.specialistId))
      .filter((report): report is SpecialistPassReport => !!report);
    const debugReport: OrchestrationResult['debugReport'] = {
      orchestratedResultSetId: params.executionPlan.orchestratedResultSetId,
      baselineResultSetId,
      generatedAt: Date.now(),
      baselinePassStatus: baselinePass.report.executionStatus,
      specialistReports: specialistReportList,
      passReports,
      stemSelections: selections.map((selection) => ({
        stemType: selection.stemType,
        modelId: selection.selectedStem.modelId ?? 'unknown',
        runtimeProfileId: selection.selectedStem.runtimeProfileId ?? 'unknown',
        selectionReason: selection.selectionReason,
        fallbackUsed: selection.fallbackUsed,
        sourceResultSetId: selection.selectedFromResultSetId,
        sourceSignature: selection.selectedStem.sourceSignature || orchestratedSourceSignature,
      })),
    };
    const debugReportRelativePath = path.posix.join(
      'results',
      params.executionPlan.orchestratedResultSetId,
      'orchestration-report.json',
    );
    const debugReportAbsolutePath = path.join(params.projectDir, debugReportRelativePath);
    await fs.promises.writeFile(debugReportAbsolutePath, JSON.stringify(debugReport, null, 2), 'utf-8');

    return {
      orchestratedResultSetId: params.executionPlan.orchestratedResultSetId,
      baselineResultSetId,
      passReports,
      specialistReports: specialistReportList,
      warnings,
      stemFiles,
      manifestEntries,
      resultSetEntry: {
        id: params.executionPlan.orchestratedResultSetId,
        modelId: ORCH_RESULT_MODEL_ID,
        runtimeProfileId: ORCH_RESULT_RUNTIME_PROFILE_ID,
        sourceSignature: orchestratedSourceSignature,
        createdAt: Date.now(),
      },
      debugReportRelativePath,
      debugReport,
    };
  }

  private evaluateSpecialistConfig(
    descriptor: SpecialistDescriptor,
  ): { status: SpecialistStatus; reason: string } | null {
    if (!descriptor.modelId.trim() || !descriptor.runtimeProfileId.trim()) {
      return {
        status: 'not_configured',
        reason: 'model_or_runtime_profile_missing',
      };
    }
    const missingRequiredEnv = descriptor.requiredEnv
      .filter((envKey) => (process.env[envKey]?.trim() ?? '').length === 0);
    if (missingRequiredEnv.length > 0) {
      return {
        status: 'not_configured',
        reason: `required_env_missing:${missingRequiredEnv.join(',')}`,
      };
    }
    if (descriptor.healthStatus === 'unavailable') {
      return {
        status: 'runtime_unavailable',
        reason: 'runtime_health_unavailable',
      };
    }
    if (descriptor.healthStatus === 'failed') {
      return {
        status: 'health_failed',
        reason: 'runtime_health_failed',
      };
    }
    if (!SUPPORTED_WORKER_MODEL_OVERRIDES.has(descriptor.modelId)) {
      return {
        status: 'skipped_by_policy',
        reason: `worker_model_override_unsupported:${descriptor.modelId}`,
      };
    }
    return null;
  }

  private createSpecialistReport(input: {
    descriptor: SpecialistDescriptor;
    resultSetId: string;
    status: SpecialistStatus;
    reason: string | null;
    executionStatus: OrchestrationPassStatus;
    warningCount?: number;
    jobStatus?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): SpecialistPassReport {
    return {
      specialistId: input.descriptor.specialistId,
      targetStem: input.descriptor.targetStem,
      modelId: input.descriptor.modelId,
      runtimeProfileId: input.descriptor.runtimeProfileId,
      resultSetId: input.resultSetId,
      status: input.status,
      healthStatus: input.descriptor.healthStatus,
      reason: input.reason,
      warningCount: input.warningCount ?? 0,
      jobStatus: input.jobStatus ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      selected: input.status === 'selected',
      fallbackUsed: false,
      selectionReason: null,
      sourceResultSetId: null,
      passStatusBeforeFallback: null,
    };
  }

  private async runPass(input: RunPassInput): Promise<RunPassOutput> {
    try {
      const separation = await this.parseJobService.startSeparation({
        projectId: input.projectId,
        sourceFilePath: input.sourceFilePath,
        projectDir: input.projectDir,
        resultSetId: input.resultSetId,
        preserveExistingStems: true,
        allowReadyStatus: true,
        runtimeProfileIdOverride: input.runtimeProfileId,
        workerModelOverride: input.modelId,
      });
      const report: OrchestrationPassReport = {
        passId: input.passId,
        resultSetId: input.resultSetId,
        modelId: input.modelId,
        runtimeProfileId: input.runtimeProfileId,
        executionStatus: separation.projectStatusAfter === ProjectStatus.Ready ? 'success' : 'failed',
        specialistStatus: null,
        reason: separation.projectStatusAfter === ProjectStatus.Ready
          ? null
          : `project_status_after:${separation.projectStatusAfter}`,
        warningCount: separation.warnings.length,
        jobStatus: separation.job.status,
        errorCode: separation.job.errorCode,
        errorMessage: separation.job.errorMessage,
      };
      if (report.executionStatus !== 'success') {
        return { report, stems: [] };
      }
      const allStems = await this.stemFileRepo.findByProjectId(input.projectId);
      const scoped = filterStemsForResultSet(allStems, input.resultSetId);
      if (scoped.length === 0) {
        return {
          report: {
            ...report,
            executionStatus: 'failed',
            reason: 'result_set_stems_empty',
          },
          stems: [],
        };
      }
      return { report, stems: scoped };
    } catch (error) {
      return {
        report: {
          passId: input.passId,
          resultSetId: input.resultSetId,
          modelId: input.modelId,
          runtimeProfileId: input.runtimeProfileId,
          executionStatus: 'failed',
          specialistStatus: null,
          reason: 'parse_service_error',
          warningCount: 0,
          jobStatus: null,
          errorCode: null,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        stems: [],
      };
    }
  }
}
