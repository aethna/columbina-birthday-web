// src/components/grass/core/grassCompute.ts

import {
  Fn,
  vec2,
  vec3,
  vec4,
  fract,
  sin,
  cos,
  dot,
  mix,
  instancedArray,
  instanceIndex,
  sqrt,
  length,
  min,
  atan,
  If,
  float,
  floor,
  round,
  int,
  uint,
  oneMinus,
  smoothstep,
  step,
  select,
  atomicAdd,
  atomicStore,
  abs,
} from "three/tsl";

import { uWindDir, uWindScale, uWindSpeed, uWindStrength, uWindFacing, uTime, uTerrainAmp, uTerrainFreq, uTerrainSeed } from "../../../core/shaders/uniforms";
import type { LODBufferConfig } from "./config";
import { DEFAULT_GRASS_AREA_SIZE, DEFAULT_BLADES_PER_AXIS } from "./config";
import { calculateWindStrength, applyWindFacingAndNormalize } from "../../../core/shaders/windHelpers";
import { getTerrainHeight, getTerrainNormal } from "../../../core/shaders/terrainHelpers";
/* ★ 世界高度（分区版）：草要长在分区地形上，月球那块地不长草 */
import { getWorldHeight } from "../../../core/shaders/worldHeight";
import { hash2to1, hash2to2 } from "./shaderHelpers";
import { KEEP_OUT_MAX } from "../../../core/world/keepOut";

/**
 * 道具避让因子：1 = 这里可以长满草，0 = 这里在道具肚子里，必须一根不长。
 *
 * `q` 是「归一化椭圆距离」（1 = 正好在占地边界上），然后用
 * `smoothstep(1.0, 1.45, q)` 造一条 0.45 个半轴宽的过渡带：
 * 直接 `q < 1 ? 0 : 1` 会在道具周围切出一圈**刀切的圆坑**，草叶从满高
 * 突然变没，看起来像被除草机推过；有过渡带才是「石头把草压弯了」。
 *
 * ⚠️ 与 `core/world/keepOut.ts` 的 CPU 版 `keepOutFactor()` **必须同参**
 *    （`1.0 / 1.45`）。两边不同的话，花丛会正好摆在草被清掉的边缘上。
 *
 * ⚠️ 空槽位（`KEEP_OUT_EMPTY`）是「9999 远处 + 1e-3 半径」，归一化距离能到 1e7 量级，
 *    `smoothstep` 直接饱和成 1 ⇒ 不影响任何像素。**不能**用半径 0 的槽位：会除零得到 NaN，
 *    NaN 参与 `min()` 之后整片草的高度都会变 NaN（表现为草全部消失）。
 */
const keepOutAt = (worldXZ: any, uniforms: any) => {
  const keep = float(1.0).toVar();
  for (let k = 0; k < KEEP_OUT_MAX; k++) {
    const a = uniforms.uKeepA.element(k);   // (中心x, 中心z, 半轴x, 半轴z)
    const b = uniforms.uKeepB.element(k);   // (cosθ, sinθ, _, _)
    const dx = worldXZ.x.sub(a.x);
    const dz = worldXZ.y.sub(a.y);
    const c = b.x;
    const s = b.y;
    // 世界 → 道具局部（绕 Y 轴旋转 θ 的逆变换），与 keepOutQ() 同式
    const lx = dx.mul(c).sub(dz.mul(s));
    const lz = dx.mul(s).add(dz.mul(c));
    const q = (() => {
      const nx = lx.div(a.z);
      const nz = lz.div(a.w);
      /* ⚠️ 不能用 `.sqr()`：three 的 TSL 节点上**没有**这个方法（实测
       * `TypeError: lx.div(...).sqr is not a function`，一抛就是整片草地编译失败、
       * 加载卡在 CALIBRATING 50%）。自己乘自己即可。 */
      return sqrt(nx.mul(nx).add(nz.mul(nz)));
    })();
    keep.assign(min(keep, smoothstep(float(1.0), float(1.45), q)));
  }
  return keep;
};

export function createGrassCompute(
  grassData: ReturnType<typeof instancedArray>,
  lodConfigs: LODBufferConfig[],
  uniforms: Record<string, any>
) {

  // Constants imported from config
  const BLADES_PER_AXIS = float(DEFAULT_BLADES_PER_AXIS);
  const GRASS_AREA_SIZE = float(DEFAULT_GRASS_AREA_SIZE);
  const BLADE_SPACING = float(DEFAULT_GRASS_AREA_SIZE / DEFAULT_BLADES_PER_AXIS);

  // Build LOD routing chain factory function
  const createLODRoutingChainBuilder = (configs: LODBufferConfig[]) => {
    return (distToCamera: any, instanceIndex: any) => {
      if (configs.length === 0) return;

      // Single LOD case
      if (configs.length === 1) {
        const config = configs[0];
        const lodIndex = atomicAdd(
          config.drawStorage.get("instanceCount"),
          uint(1)
        );
        config.indices.element(lodIndex).assign(uint(instanceIndex));
        return;
      }

      // Multi LOD chain builder
      const buildChain = (index: number): any => {
        if (index >= configs.length) return;

        const config = configs[index];
        const isLast = index === configs.length - 1;

        const minDist = float(config.minDistance);
        const maxDist = config.maxDistance === Infinity
          ? float(1e9)
          : float(config.maxDistance);

        // Add some noise to LOD transitions to prevent hard lines
        const noiseScale = uniforms.uLODNoiseScale;
        const noiseSeed = fract(float(instanceIndex).mul(0.12345)).mul(2.0).sub(1.0);
        const noiseOffset = distToCamera.mul(noiseScale).mul(noiseSeed);
        const noisyDist = distToCamera.add(noiseOffset);

        const inRange = noisyDist.greaterThanEqual(minDist).and(
          isLast || config.maxDistance === Infinity
            ? noisyDist.lessThanEqual(maxDist)
            : noisyDist.lessThan(maxDist)
        );

        const lodBlock = () => {
          const lodIndex = atomicAdd(
            config.drawStorage.get("instanceCount"),
            uint(1)
          );
          config.indices.element(lodIndex).assign(uint(instanceIndex));
        };

        if (isLast) {
          return If(inRange, lodBlock);
        } else {
          const nextChain = buildChain(index + 1);
          return If(inRange, lodBlock).Else(() => {
            if (nextChain) nextChain;
          });
        }
      };

      const chain = buildChain(0);
      if (chain) chain;
    };
  };

  const buildLODRouting = createLODRoutingChainBuilder(lodConfigs);

  const performCulling = Fn(([worldPos]: [any]) => {
    const radius = float(1.5);
    const viewProjMatrix = uniforms.uViewProjectionMatrix;
    const clipPos = viewProjMatrix.mul(vec4(worldPos.x, worldPos.y, worldPos.z, float(1.0)));

    const isInFront = clipPos.w.greaterThan(radius.negate());
    const xIn = abs(clipPos.x).lessThan(clipPos.w.add(radius));
    const yIn = abs(clipPos.y).lessThan(clipPos.w.add(radius));
    const zIn = clipPos.z.lessThan(clipPos.w.add(radius));

    const inFrustum = isInFront.and(xIn).and(yIn).and(zIn);

    const isInCircle = length(worldPos.sub(uniforms.uGroupOffset)).lessThan(GRASS_AREA_SIZE.mul(0.5));

    return inFrustum.and(isInCircle);
  });

  const computeFn = Fn(() => {
    const bladeRandX = uniforms.uBladeRandomness.x;
    const bladeRandY = uniforms.uBladeRandomness.y;
    const bladeRandZ = uniforms.uBladeRandomness.z;

    const calculateWorldPosition = (idx: any) => {
      const uIdx = uint(idx);
      const iGridX = uIdx.div( uint(DEFAULT_BLADES_PER_AXIS));
      const iGridZ = uIdx.mod( uint(DEFAULT_BLADES_PER_AXIS));
      const offsetStepsX = round(uniforms.uGridIndex.x);
      const offsetStepsZ = round(uniforms.uGridIndex.y);

      const globalGridX = int(iGridX).add(int(offsetStepsX));
      const globalGridZ = int(iGridZ).add(int(offsetStepsZ));

      const jitterRand = hash2to2(globalGridX, globalGridZ);
      const jitterScale = BLADE_SPACING.mul(float(1.0));
      const jitterX = jitterRand.x.sub(0.5).mul(jitterScale);
      const jitterZ = jitterRand.y.sub(0.5).mul(jitterScale);

      const gridX = float(iGridX);
      const gridZ = float(iGridZ);
      const fx = gridX.div(BLADES_PER_AXIS).sub(0.5);
      const fz = gridZ.div(BLADES_PER_AXIS).sub(0.5);
      const px = fx.mul(GRASS_AREA_SIZE);
      const pz = fz.mul(GRASS_AREA_SIZE);

      const instancePosRaw = vec3(px, float(0.0), pz);

      const worldPos = vec3(
        instancePosRaw.x.add(jitterX),
        instancePosRaw.y,
        instancePosRaw.z.add(jitterZ)
      ).add(uniforms.uGroupOffset);
      return { worldPos, globalGridX, globalGridZ };
    };

    const { worldPos, globalGridX, globalGridZ } = calculateWorldPosition(instanceIndex);

    const diff = worldPos.sub(uniforms.uCameraPosition);
    const distToCamera = length(diff);
    const isCloseEnough = abs(diff.x).add(abs(diff.z)).lessThan(float(3));
    const isVisible = isCloseEnough.or(performCulling(worldPos));

    If(isVisible, () => {
      const worldXZ = vec2(worldPos.x, worldPos.z);

      // Terrain
      const terrainHeightFn = getWorldHeight();
      const th = terrainHeightFn(worldXZ);
      const tn = getTerrainNormal(terrainHeightFn)(worldXZ);
      const finalPos = vec3(worldPos.x, worldPos.y.add(th), worldPos.z);

      // Voronoi / clumping
      const bladesPerClump = float(uniforms.uClumpSize).div(BLADE_SPACING);

      const getClumpInfo = (gx: any, gz: any) => {
        const cx = floor(float(gx).div(bladesPerClump));
        const cz = floor(float(gz).div(bladesPerClump));
        const minD2 = float(1e9).toVar();
        const secondMinD2 = float(1e9).toVar();
        const bestID = vec2(0.0).toVar();
        const secondBestID = vec2(0.0).toVar();
        const bestDiff = vec2(0.0).toVar();
        const fx = fract(float(gx).div(bladesPerClump));
        const fz = fract(float(gz).div(bladesPerClump));
        const currentPos = vec2(fx, fz);
        const offsets = [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
        offsets.forEach(([ox, oy]) => {
          const neighborX = cx.add(float(ox));
          const neighborZ = cz.add(float(oy));
          const rand = hash2to2(int(neighborX), int(neighborZ));
          const point = vec2(float(ox), float(oy)).add(rand);
          const diff = point.sub(currentPos);
          const d2 = dot(diff, diff);
          If(d2.lessThan(minD2), () => {
            secondMinD2.assign(minD2);
            secondBestID.assign(bestID);
            bestDiff.assign(diff);
            minD2.assign(d2);
            bestID.assign(vec2(neighborX, neighborZ));
          }).ElseIf(d2.lessThan(secondMinD2), () => {
            secondMinD2.assign(d2);
            secondBestID.assign(vec2(neighborX, neighborZ));
          });
        });
        const d1 = sqrt(minD2);
        const d2 = sqrt(secondMinD2);
        const smoothness = uniforms.uClumpBlendSmoothness ?? float(0.2);
        const centerFactor = smoothstep(float(0.0), smoothness, d2.sub(d1));
        const toCenter = bestDiff.mul(uniforms.uClumpSize);
        return { bestID, secondBestID, centerFactor, toCenter };
      };

      const { bestID, secondBestID, centerFactor, toCenter } = getClumpInfo(globalGridX, globalGridZ);
      const blendFactor = mix(float(0.5), float(1.0), centerFactor);

      const getClumpParams = (idx: any, idy: any) => {
        const h1 = hash2to1(int(idx), int(idy));
        const h2 = hash2to1(int(idx).add(123), int(idy).add(456));
        const h3 = hash2to1(int(idx).add(789), int(idy).add(101));
        const h4 = hash2to1(int(idx).add(999), int(idy).add(999));
        const h = mix(uniforms.uBladeHeightMin, uniforms.uBladeHeightMax, h1);
        const w = mix(uniforms.uBladeWidthMin, uniforms.uBladeWidthMax, h2);
        const b = mix(uniforms.uBendAmountMin, uniforms.uBendAmountMax, h3);
        return { height: h, width: w, bend: b, type: h4 };
      };

      const p1 = getClumpParams(bestID.x, bestID.y);
      const p2 = getClumpParams(secondBestID.x, secondBestID.y);
      const height = mix(p2.height, p1.height, blendFactor);
      const width = mix(p2.width, p1.width, blendFactor);
      const bend = mix(p2.bend, p1.bend, blendFactor);
      const type = p1.type;

      const bladeRandSeed = hash2to1(globalGridX, globalGridZ);
      const bladeRandSeed2 = hash2to1(globalGridX.add(1), globalGridZ);
      const bladeRandSeed3 = hash2to1(globalGridX.add(2), globalGridZ);
      const finalHeight = height.mul(mix(oneMinus(bladeRandX), float(1.0).add(bladeRandX), bladeRandSeed));
      const finalWidth = width.mul(mix(oneMinus(bladeRandY), float(1.0).add(bladeRandY), bladeRandSeed2));
      const finalBend = bend.mul(mix(oneMinus(bladeRandZ), float(1.0).add(bladeRandZ), bladeRandSeed3));

      const perBladeHash01 = bladeRandSeed;
      const clumpSeed01 = hash2to1(int(bestID.x).add(47), int(bestID.y).add(31));
      const clumpHash = hash2to1(int(bestID.x), int(bestID.y));
      const baseAngle = atan(toCenter.y, toCenter.x).mul(uniforms.uCenterYaw).mul(centerFactor)
        .add(perBladeHash01.sub(0.5).mul(uniforms.uBladeYaw))
        .add(clumpHash.sub(0.5).mul(uniforms.uClumpYaw).mul(centerFactor));

      // Wind
      const windStrength01 = calculateWindStrength(worldXZ, uWindDir, uWindScale, uTime, uWindSpeed, uWindStrength);
      const facingAngle01 = applyWindFacingAndNormalize(baseAngle, windStrength01, uWindDir, uWindFacing);
      const angleRad = facingAngle01.mul(6.28318);
      const rotSin = sin(angleRad);
      const rotCos = cos(angleRad);

      // Character interaction
      const charXZ = vec2(uniforms.uCharacterWorldPos.x, uniforms.uCharacterWorldPos.z);
      const charDiff = worldXZ.sub(charXZ);
      const charDist = length(charDiff);
      const safeCharDir = select(
        charDist.lessThan(float(0.001)),
        vec2(0.0, 0.0),
        charDiff.div(charDist)
      );
      const pushFactor = smoothstep(uniforms.uCharacterPushRadius, float(0.0), charDist);
      const activePush = step(float(0.001), pushFactor);
      const finalPushStrength = pushFactor.mul(uniforms.uCharacterPushAmount).mul(activePush);
      const pushVector = safeCharDir.mul(finalPushStrength);

      const data = grassData.element(instanceIndex);
      /* 道具避让（`core/world/keepOut.ts`）。
       *
       * ★ 2026-10-19 改：**只压高度、不压宽度**，而且下限是 8%（`KEEP_H_MIN`）而不是 0。
       *   第一版把宽度和高度一起乘 0，道具脚下就剩一块纯地形色的平地 ——
       *   用户看图直接问「这一片不长草的地板是啥？」，一块没有任何草的褐色椭圆
       *   读起来就是水泥地。留一截矮草茬之后变成「被踩秃的草皮」，
       *   草茎也不会再穿过石头（8% × 0.6 m ≈ 5 cm）。
       *   宽度保持 1 是安全的：草叶本来就贴地向上长，只要高度够矮，
       *   就不会出现「贴在边界上那一圈头发丝细三角」的闪点问题。 */
      const keepFactor = keepOutAt(worldXZ, uniforms);
      const keepHeight = mix(float(0.08), float(1.0), keepFactor);
      data.get("data0").assign(vec4(finalPos, type));
      data.get("data1").assign(vec4(
        finalWidth,
        finalHeight.mul(keepHeight),
        finalBend,
        windStrength01
      ));
      data.get("data2").assign(vec4(rotSin, rotCos, clumpSeed01, perBladeHash01));
      data.get("data3").assign(vec4(tn.x, tn.z, pushVector.x, pushVector.y));

      buildLODRouting(distToCamera, instanceIndex);
    });
  });

  return {
    computeFn,
  };
}

export function createResetDrawBufferCompute(lodConfigs: LODBufferConfig[]) {
  const resetFn = Fn(() => {
    lodConfigs.forEach((lodConfig) => {
      const drawBuffer = lodConfig.drawStorage;
      drawBuffer.get("vertexCount").assign(uint(lodConfig.vertexCount));
      atomicStore(drawBuffer.get("instanceCount"), uint(0));
      drawBuffer.get("firstVertex").assign(uint(0));
      drawBuffer.get("firstInstance").assign(uint(0));
      drawBuffer.get("offset").assign(uint(0));
    });
  });

  return resetFn().compute(1);
}