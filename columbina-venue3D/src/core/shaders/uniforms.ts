import { uniform, vec2, vec3 } from "three/tsl";
import type { StorageBufferAttribute } from "three/webgpu";

export const uTime = uniform(0.0);
export const uDeltaTime = uniform(0.016);
export const uGlobalHueShift = uniform(0.0);

// Wind
const WIND_DEFAULT_DIR = vec2(1.0, -0.8);
const WIND_DEFAULT_SCALE = 0.1;
const WIND_DEFAULT_SPEED = 0.35;
const WIND_DEFAULT_STRENGTH = 4.5;
const WIND_DEFAULT_FACING = 1.0;

export const uWindDir = uniform(WIND_DEFAULT_DIR);
export const uWindScale = uniform(WIND_DEFAULT_SCALE);
export const uWindSpeed = uniform(WIND_DEFAULT_SPEED);
export const uWindStrength = uniform(WIND_DEFAULT_STRENGTH);
export const uWindFacing = uniform(WIND_DEFAULT_FACING);

// Terrain
const TERRAIN_DEFAULT_AMP = 1.5;
const TERRAIN_DEFAULT_FREQ = 0.05;
const TERRAIN_DEFAULT_SEED = 0.0;

export const uTerrainAmp = uniform(TERRAIN_DEFAULT_AMP);
export const uTerrainFreq = uniform(TERRAIN_DEFAULT_FREQ);
export const uTerrainSeed = uniform(TERRAIN_DEFAULT_SEED);
export const uTerrainColor = uniform(vec3(0, 0, 0));


// ===== 昼夜循环（由 core/sky/sunCycle.ts 每帧写入） =====
/** 1 = 星空全亮 / 0 = 白天看不见星星 */
export const uStarIntensity = uniform(1.0);
/** 从原点指向太阳的单位向量（夜里指向「月亮」） */
export const uSunDir = uniform(vec3(0.0, 0.3714, 0.9285));
/** 太阳的「颜色 × 强度」。给 `WaterMesh`（官方海洋着色器）做镜面/漫反射用。
 *  夜里 `lightIntensity` 掉到 `MOON_INTENSITY`，海面的日光闪闪自然就灭了。 */
export const uSunColor = uniform(vec3(1.0, 1.0, 1.0));
/** 天空渐变：天顶色 / 地平线色；`uSkyBlend` 0=全星空 1=全天光 */
export const uSkyTop = uniform(vec3(0.016, 0.024, 0.051));
export const uSkyHorizon = uniform(vec3(0.051, 0.082, 0.133));
export const uSkyBlend = uniform(0.0);
/** ★ 真空夜强度（0 = 正常环境 / 1 = 月球区的夜）。
 *
 *  物理依据：**星光只有 0.002 lux，日光约 100000 lux —— 差 7 个数量级**；
 *  月球上没有大气散射，夜里唯一的填充是**地球反照（earthshine）**：
 *  地球反照率 0.30、从月面看地球的视面积又是从地面看月亮的约 13 倍
 *  ⇒ 地照约比满月照亮十几到几十倍，但仍然是「极暗的冷蓝」。
 *  再加上暗视觉（视杆细胞）峰值在 507 nm 的**浦肯野漂移**：
 *  弱光下红色先黑掉，世界整体偏冷蓝、几乎无彩。
 *
 *  ⇒ 用户在月球区过夜时，地面必须**掉到很暗、去彩、偏冷蓝**，
 *    而不是沿用会场的「亮蓝色月光」（`MOON_INTENSITY = 1.9`，几乎和正午 2.2 一样亮）。
 *  由 `DirectionalLight.tsx` 每帧写：`wr.moon * (1 - dayness)`。 */
export const uVacuumNight = uniform(0.0);

// Cosmic Wave System
export const uActiveWaveCount = uniform(0);
export const GlobalWaveState = {
  buffer: null as StorageBufferAttribute | null,
};