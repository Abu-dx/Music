/**
 * @module infrastructure/adapters/separationResultAdapter
 * @description 鍒嗙寮曟搸杈撳嚭 鈫?缁熶竴 StemFile / ManifestStemEntry 閫傞厤鍣? *
 * GPT R6 Must Fix #1锛? * 灏嗗紩鎿庤緭鍑哄綊涓€鍖栬亴璐ｄ粠 ParseJobService 鍓ョ鍒扮嫭绔?adapter銆? * 鍓嶇/涓婂眰涓嶅簲鎰熺煡鍒嗙妯″瀷杈撳嚭鍘熷缁撴瀯銆? *
 * 鑱岃矗锛? * - 灏?Worker separation result 褰掍竴鍖栦负 StemFile[]
 * - 灏?Worker separation result 褰掍竴鍖栦负 ManifestStemEntry[]
 * - 鐢熸垚 relativePath锛堝熀浜?PROJECT_DIR_STRUCTURE 绾﹀畾锛? * - 澶勭悊缂鸿建瀹瑰繊锛堟湭杈撳嚭鐨勮建閬撲笉鎶ラ敊锛屼粎璁版棩蹇楋級
 * - 杞ㄩ亾绫诲瀷鎺ㄦ柇锛堥€氳繃 inferStemTypeFromFilename锛? *
 * 涓嶈礋璐ｏ細
 * - 鍒嗙浠诲姟缂栨帓 鈫?ParseJobService
 * - 鐩綍鍒涘缓 / 鏂囦欢璇诲啓 鈫?ProjectDirManager / ManifestManager
 * - Worker 閫氫俊 鈫?IpcBridge
 *
 * 璁捐鍘熷垯锛? * - 绾暟鎹槧灏勶紝鏃?I/O锛屾棤鍓綔鐢? * - 鎵€鏈夎矾寰勭害瀹氶泦涓湪姝ゆ枃浠讹紝涓嶆暎钀藉埌搴旂敤灞? * - 鍙崟鍏冩祴璇? */

import * as crypto from 'crypto';
import * as path from 'path';
import { StemFile, ManifestStemEntry } from '../../domain/entities';
import { StemType, StemStatus } from '../../shared/enums';
import { inferStemTypeFromFilename } from '../../domain/policies';
import { ILogger } from '../../shared/logger';

// ============================================================================
// 1. 寮曟搸杈撳嚭鍘熷缁撴瀯
// ============================================================================

/**
 * Worker 鍒嗙缁撴灉涓殑鍗曚釜 stem 鏉＄洰锛堝紩鎿庝晶鍘熷缁撴瀯锛? */
export interface RawEngineStemOutput {
  /** stem 鏂囦欢鍚嶏紙寮曟搸鍐欏叆 stems 鐩綍鐨勬枃浠跺悕锛?*/
  filename: string;
  /** 闊抽缂栬В鐮佸櫒 */
  codec: string;
  /** 鏂囦欢澶у皬锛堝瓧鑺傦級 */
  sizeBytes: number;
  /** 鏃堕暱锛坢s锛?*/
  durationMs: number;
  /** 閲囨牱鐜?*/
  sampleRate: number;
  /** 鍚堝苟鏉ユ簮杞ㄩ亾锛圙PT R7 Suggested #1锛氬紩鎿庡悎骞朵袱鏉″急杞ㄦ椂鏍囨敞鏉ユ簮锛?*/
  mergedFrom?: string[];
}

/**
 * Worker 鍒嗙瀹屾暣缁撴灉锛堝紩鎿庝晶鍘熷缁撴瀯锛? */
export interface RawSeparationResult {
  /** 寮曟搸鐗堟湰 */
  engineVersion: string;
  /** 妯″瀷鍚嶏紙鍙€夛紝Phase 2.5 棰勭暀锛?*/
  modelName?: string;
  /** 褰撳墠妯″瀷鏋舵瀯鏀寔鐨?stem types锛堝彲閫夛級 */
  supportedStemTypes?: string[];
  /** 杈撳嚭鐨?stem 鏂囦欢鍒楄〃 */
  stems: RawEngineStemOutput[];
}

// ============================================================================
// 2. 鐩綍绾﹀畾甯搁噺锛堥泦涓鐞嗭紝涓嶆暎钀藉埌搴旂敤灞傦級
// ============================================================================

/**
 * stems 瀛愮洰褰曞悕锛堜笌 PROJECT_DIR_STRUCTURE.STEMS_DIR 涓€鑷达級
 *
 * 鎵€鏈?stem 鐨?manifest relativePath 閮戒互姝や负鍓嶇紑銆? */
const STEMS_RELATIVE_DIR = 'stems';

// ============================================================================
// 3. 閫傞厤缁撴灉绫诲瀷
// ============================================================================

/**
 * 閫傞厤鍚庣殑鍒嗙缁撴灉
 */
export interface AdaptedSeparationResult {
  /** 褰掍竴鍖栫殑 StemFile 瀹炰綋鍒楄〃锛堝彲鐩存帴鍏?DB锛?*/
  stemFiles: StemFile[];
  /** 褰掍竴鍖栫殑 ManifestStemEntry 鍒楄〃锛堝彲鐩存帴鍐?manifest锛?*/
  manifestEntries: ManifestStemEntry[];
  /** 寮曟搸鐗堟湰 */
  engineVersion: string;
  /** 璀﹀憡淇℃伅锛堢己杞ㄣ€佸悎骞剁瓑锛?*/
  warnings: string[];
}

// ============================================================================
// 4. 鎺ュ彛
// ============================================================================

/**
 * 鍒嗙缁撴灉閫傞厤鍣ㄦ帴鍙? */
export interface ISeparationResultAdapter {
  /**
   * 灏嗗紩鎿庡師濮嬭緭鍑哄綊涓€鍖栦负缁熶竴缁撴瀯
   *
   * 绾暟鎹槧灏勶紝鏃?I/O銆?   *
   * @param raw - 寮曟搸鍘熷杈撳嚭
   * @param projectId - 椤圭洰 ID
   * @param projectDir - 椤圭洰缂撳瓨鐩綍锛堢敤浜庣敓鎴?filePath 缁濆璺緞锛?   * @returns 褰掍竴鍖栫粨鏋?   */
  adapt(
    raw: RawSeparationResult,
    projectId: string,
    projectDir: string,
  ): AdaptedSeparationResult;
}

// ============================================================================
// 5. 瀹炵幇
// ============================================================================

/**
 * 鎵€鏈夐鏈熻建閬撶被鍨嬶紙鐢ㄤ簬缂鸿建妫€娴嬶級
 *
 * GPT R6 Suggested #5锛氱己杞ㄥ蹇嶏紝璁板綍缂哄け杞ㄩ亾銆? */
const MODEL_SUPPORTED_STEMS: Readonly<Record<string, readonly StemType[]>> = {
  htdemucs: [StemType.Vocal, StemType.Drums, StemType.Bass, StemType.Other],
  htdemucs_6s: [StemType.Vocal, StemType.Drums, StemType.Bass, StemType.Guitar, StemType.Keyboard, StemType.Other],
};

function resolveModelName(raw: RawSeparationResult): string {
  if (raw.modelName && raw.modelName.trim()) return raw.modelName.trim().toLowerCase();
  const version = (raw.engineVersion ?? '').toLowerCase();
  if (version.includes('htdemucs_6s')) return 'htdemucs_6s';
  return 'htdemucs';
}

function resolveSupportedStemTypes(raw: RawSeparationResult, modelName: string): readonly StemType[] {
  if (Array.isArray(raw.supportedStemTypes) && raw.supportedStemTypes.length > 0) {
    const allowed = new Set<string>(Object.values(StemType));
    const normalized: StemType[] = [];
    for (const item of raw.supportedStemTypes) {
      if (typeof item !== 'string') continue;
      const lowered = item.trim().toLowerCase();
      if (allowed.has(lowered)) {
        normalized.push(lowered as StemType);
      }
    }
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return MODEL_SUPPORTED_STEMS[modelName] ?? MODEL_SUPPORTED_STEMS.htdemucs;
}

export class SeparationResultAdapter implements ISeparationResultAdapter {
  constructor(private readonly logger: ILogger) {}

  adapt(
    raw: RawSeparationResult,
    projectId: string,
    projectDir: string,
  ): AdaptedSeparationResult {
    const warnings: string[] = [];
    const stemFiles: StemFile[] = [];
    const manifestEntries: ManifestStemEntry[] = [];
    const detectedTypes = new Set<StemType>();
    const modelName = resolveModelName(raw);
    const supportedByModel = resolveSupportedStemTypes(raw, modelName);

    for (const rawStem of raw.stems) {
      // 鎺ㄦ柇杞ㄩ亾绫诲瀷
      const stemType = inferStemTypeFromFilename(rawStem.filename);
      detectedTypes.add(stemType);

      // 鐢熸垚 relativePath锛堢洰褰曠害瀹氶泦涓鐞嗭級
      const relativePath = `${STEMS_RELATIVE_DIR}/${rawStem.filename}`;

      // 鐢熸垚 filePath 缁濆璺緞锛圙PT R7 Decision #3锛氫娇鐢?path.join锛?
      const filePath = path.join(projectDir, relativePath);

      // 鏋勫缓 StemFile 瀹炰綋
      const stemFile: StemFile = {
        id: crypto.randomUUID(),
        projectId,
        stemType,
        filePath,
        codec: rawStem.codec,
        sizeBytes: rawStem.sizeBytes,
        durationMs: rawStem.durationMs,
        sampleRate: rawStem.sampleRate,
        exists: true,
        sourceOrigin: 'engine_output',
        confidence: null,
        exportable: true,
        status: StemStatus.Detected,
      };

      stemFiles.push(stemFile);
      console.log(`[REAL_CHAIN] separationResultAdapter.adapt stem projectId="${projectId}" stemType="${stemType}" filePath="${filePath}"`);

      // 鏋勫缓 ManifestStemEntry
      manifestEntries.push({
        stemType,
        relativePath,
        codec: rawStem.codec,
        sizeBytes: rawStem.sizeBytes,
        durationMs: rawStem.durationMs,
        sampleRate: rawStem.sampleRate,
        sourceOrigin: 'engine_output',
      });
    }

    // 缂鸿建妫€娴嬶紙浠呴拡瀵瑰綋鍓嶆ā鍨嬫灦鏋勬敮鎸佺殑 stems锛?
    for (const expected of supportedByModel) {
      if (!detectedTypes.has(expected)) {
        const msg = `Model "${modelName}" expected stem "${expected}" but it was not produced`;
        warnings.push(msg);
        this.logger.warn(msg, {
          projectId,
          stage: 'separationResultAdapter.adapt',
        });
      }
    }


    this.logger.info('Separation result adapted', {
      projectId,
      modelName,
      stemCount: stemFiles.length,
      warningCount: warnings.length,
      stage: 'separationResultAdapter.adapt',
    });
    console.log(`[REAL_CHAIN] separationResultAdapter.adapt done projectId="${projectId}" stemFilesLength=${stemFiles.length}`);

    return {
      stemFiles,
      manifestEntries,
      engineVersion: raw.engineVersion,
      warnings,
    };
  }
}

// NOTE: GPT R7 Decision #3 鈥?custom joinPath removed, using Node.js path.join instead.
// This adapter runs exclusively in Electron main process, so path module is always available.
