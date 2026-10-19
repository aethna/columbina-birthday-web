/**
 * 画质档位（2026-10-19 加入）
 *
 * 通过 `?quality=` 指定启动档位，默认 `high`：
 *   low  : 低配机器 —— 草 384²、后期除 bloom 全关
 *   high : 默认档（RTX 5060 Laptop 实测零压力）—— 草 768²、DOF/SMAA 关、bloom 开
 *   max  : 原版全开（改动前的老配置，保留但默认不启用）—— 草 1024²、DOF/SMAA 开
 *
 * 为什么草地密度只吃 URL、不做运行时热切换：
 *   `DEFAULT_BLADES_PER_AXIS` 决定 grass compute 的 storage buffer 尺寸和
 *   shader 里的常量，运行时改要重建整套 GPU 资源（管线、buffer、indirect draw），
 *   风险高且会卡一帧。所以草量在启动时定死，改档需重载页面。
 *   后期效果（bloom / DOF / SMAA）不走这里，继续由 gameStore.quality +
 *   侧栏按钮运行时切换。
 */

export type QualityLevel = 'low' | 'high' | 'max';

function readLevel(): QualityLevel {
  try {
    const q = (new URLSearchParams(location.search).get('quality') || '').toLowerCase();
    if (q === 'low' || q === 'high' || q === 'max') return q;
  } catch {
    /* 无 location（SSR / 无头判据）时回退默认档 */
  }
  return 'high';
}

/** 本次启动所用的画质档位（来自 `?quality=`，默认 high） */
export const QUALITY: QualityLevel = readLevel();

export interface QualityPreset {
  /** 草地每轴草叶数，总叶数 = 该值的平方 */
  bladesPerAxis: number;
  /** 默认是否启用景深（仅 max 档为 true；会场模式另有 SKY_MODE 门控） */
  dof: boolean;
  /** 默认是否启用 SMAA */
  smaa: boolean;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: { bladesPerAxis: 384, dof: false, smaa: false },
  high: { bladesPerAxis: 768, dof: false, smaa: false },
  // 原版配置：改动前的 1024 草叶 + 景深，保留于此，默认不启用
  max: { bladesPerAxis: 1024, dof: true, smaa: true },
};

export const PRESET: QualityPreset = QUALITY_PRESETS[QUALITY];
