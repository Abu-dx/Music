/**
 * @module shared/stageMapping
 * @description 璺ㄥ眰鍏变韩鐨勯樁娈垫槧灏勩€侀樁娈垫樉绀哄悕銆両PC 浜嬩欢 DTO
 *
 * GPT R7 Must Fix #2锛氫粠 application 灞傝縼绉诲埌 shared 灞傦紝
 * 绂佹 renderer import application 灞傚父閲忋€? *
 * GPT R7 Suggested #4锛欼PC 浜嬩欢 payload 缁熶竴鎴愬叡浜?DTO銆? *
 * 浣嶇疆閫夋嫨锛氱嫭绔嬫枃浠惰€岄潪 contracts.ts锛屽洜涓洪樁娈垫槧灏勮嚜鎴愪綋绯伙紝
 * 鏀惧叆 contracts.ts 浼氫娇鍏惰繃闀裤€傝鏍兼枃妗?26.2 鍏佽 shared 灞? * 鍖呭惈澶氫釜鏂囦欢锛屽彧瑕佸睘浜庤法灞傛渶灏忓叕鍏遍泦鍚堛€? */

import { JobStage } from './enums';

// ============================================================================
// 1. 闃舵鏄犲皠琛?// ============================================================================

/**
 * 闃舵鏄犲皠鏉＄洰
 */
export interface StageMapping {
  /** 褰掍竴鍖栫殑 JobStage 鏋氫妇鍊?*/
  stage: JobStage;
  /** 寤鸿鏈€灏忚繘搴︾櫨鍒嗘瘮锛堣鏍兼枃妗?搂16锛?*/
  minProgress: number;
  /** 寤鸿鏈€澶ц繘搴︾櫨鍒嗘瘮 */
  maxProgress: number;
}

/**
 * Worker 涓婃姤鐨?stage 瀛楃涓?鈫?瑙勬牸鏂囨。鎺ㄨ崘鐨?JobStage + 鐧惧垎姣斿尯闂? *
 * 瑙勬牸鏂囨。 搂16 杩涘害绯荤粺锛? * - INIT: 0-5%
 * - READ_SOURCE: 5-10%
 * - PREPROCESS: 10-20%
 * - INFER: 20-80%
 * - POSTPROCESS: 80-88%
 * - WRITE_FILES: 88-94%
 * - BUILD_INDEX: 94-97%
 * - GENERATE_WAVEFORM: 97-99%
 * - DONE: 100%
 */
export const STAGE_PROGRESS_MAPPING: Record<string, StageMapping> = {
  'init':              { stage: JobStage.Init, minProgress: 0, maxProgress: 5 },
  'read_source':       { stage: JobStage.ReadSource, minProgress: 5, maxProgress: 10 },
  'preprocess':        { stage: JobStage.Preprocess, minProgress: 10, maxProgress: 20 },
  'infer':             { stage: JobStage.Infer, minProgress: 20, maxProgress: 80 },
  'postprocess':       { stage: JobStage.Postprocess, minProgress: 80, maxProgress: 88 },
  'write_files':       { stage: JobStage.WriteFiles, minProgress: 88, maxProgress: 94 },
  'build_index':       { stage: JobStage.BuildIndex, minProgress: 94, maxProgress: 97 },
  'generate_waveform': { stage: JobStage.GenerateWaveform, minProgress: 97, maxProgress: 99 },
  'done':              { stage: JobStage.Done, minProgress: 100, maxProgress: 100 },
};

// ============================================================================
// 2. 闃舵鏄剧ず鍚?// ============================================================================

/**
 * JobStage 鈫?鐢ㄦ埛鍙嬪ソ鏄剧ず鍚? */
export const STAGE_DISPLAY_NAMES: Record<string, string> = {
  [JobStage.Init]: '初始化',
  [JobStage.ReadSource]: '读取源文件',
  [JobStage.Preprocess]: '预处理',
  [JobStage.Infer]: '分离推理',
  [JobStage.Postprocess]: '后处理',
  [JobStage.WriteFiles]: '写入文件',
  [JobStage.BuildIndex]: '构建索引',
  [JobStage.GenerateWaveform]: '生成波形',
  [JobStage.ChordAnalysis]: '和弦分析',
  [JobStage.Done]: '完成',
};

/**
 * 鏈夊簭闃舵鍒楄〃锛堢敤浜庤繘搴﹂〉鏃堕棿绾垮睍绀猴級
 */
export const ORDERED_STAGES: readonly { key: string; label: string }[] = [
  { key: JobStage.Init, label: STAGE_DISPLAY_NAMES[JobStage.Init] },
  { key: JobStage.ReadSource, label: STAGE_DISPLAY_NAMES[JobStage.ReadSource] },
  { key: JobStage.Preprocess, label: STAGE_DISPLAY_NAMES[JobStage.Preprocess] },
  { key: JobStage.Infer, label: STAGE_DISPLAY_NAMES[JobStage.Infer] },
  { key: JobStage.Postprocess, label: STAGE_DISPLAY_NAMES[JobStage.Postprocess] },
  { key: JobStage.WriteFiles, label: STAGE_DISPLAY_NAMES[JobStage.WriteFiles] },
  { key: JobStage.BuildIndex, label: STAGE_DISPLAY_NAMES[JobStage.BuildIndex] },
  { key: JobStage.GenerateWaveform, label: STAGE_DISPLAY_NAMES[JobStage.GenerateWaveform] },
  { key: JobStage.Done, label: STAGE_DISPLAY_NAMES[JobStage.Done] },
];

// ============================================================================
// 3. IPC DTO 宸茶縼绉诲埌 shared/contracts.ts锛圙PT R8 Decision #1锛?// ============================================================================
// SeparationProgressDTO, SeparationCompleteDTO, SeparationStartResultDTO,
// SelectedFileDTO 鐜板湪浠?shared/contracts.ts 瀵煎嚭銆?// 淇濈暀姝ゆ敞閲婁互璇存槑杩佺Щ鍘嗗彶銆?
