import * as THREE from "three/webgpu";
import {
  texture,
  uniform,
  vec2,
  float,
  positionLocal,
  uv,
  vertexColor,
  Fn,
  vec4,
  vec3,
  step,
  abs,
  normalize,
  transformNormalToView,
  mix,
  varying,
  instanceIndex,
  instancedArray,
  fract,
  smoothstep,
  mx_noise_float,
  remapClamp,
  cross,
  dot,
  clamp,
  acos,
  length,
  If,
  positionWorld,
  cameraPosition,
  materialNormal,
  mat3,
  faceDirection,
  sin,
  cos,
} from "three/tsl";

import {
  type VATMeta,
  createVATSampleUV,
  sampleVATPosition,
  sampleVATNormal,
  shiftHSV,
} from "@core";
import { getTerrainHeight, getTerrainNormal, rotateAxis } from "../../../core/shaders/terrainHelpers";
/* ★ 世界高度（分区版） */
import { getWorldHeight } from "../../../core/shaders/worldHeight";
import { calculateWindStrength, safeNormalize } from "../../../core/shaders/windHelpers";
import { uWindDir, uWindScale, uWindSpeed, uWindStrength, uTerrainAmp, uTerrainFreq, uTerrainSeed, uTime, uGlobalHueShift } from "../../../core/shaders/uniforms";

/**
 * Rose-specific VAT material.
 * Uses shared VAT sampling helpers from @core for position/normal textures.
 */
export function createVATMaterial(
  posTex: THREE.Texture,
  nrmTex: THREE.Texture,
  vatData: ReturnType<typeof instancedArray>,
  visibleIndicesBuffer: ReturnType<typeof instancedArray>,
  meta: VATMeta,
  uniforms: Record<string, any>,
  colorTex: THREE.Texture,
  outlineTex: THREE.Texture,
  normalMapTex: THREE.Texture,
  lodDebugColor?: THREE.Color,
): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  material.side = THREE.DoubleSide;

  const uLodDebugColor = uniform(
    lodDebugColor
      ? vec3(lodDebugColor.r, lodDebugColor.g, lodDebugColor.b)
      : vec3(1.0, 1.0, 1.0)
  );
  void uLodDebugColor;

  const trueIndex = visibleIndicesBuffer.element(instanceIndex);
  const data = vatData.element(trueIndex);
  const seed = data.get("seed");
  const progress = data.get("progress");
  const instancePos = data.get("position");

  const vColor = vertexColor(0).r;
  const isPetal = step(abs(vColor.sub(0.7)), 0.05);
  const isStem = step(abs(vColor.sub(0.0)), 0.05);
  const isLeaf = step(abs(vColor.sub(1.0)), 0.05);
  const outline = texture(outlineTex, uv());
  const uvCord = vec2(uv().x.sub(0.5).mul(0.8).add(0.5), uv().y);

  const frame = data.get("frame");
  const sampleUV = createVATSampleUV(frame, meta);

  const terrainHeightFn = getWorldHeight();
  const terrainNormalFn = getTerrainNormal(terrainHeightFn);

  const applyRotation = Fn(([vec]: [any]) => {
    const randomAngleRad = seed.mul(2 * Math.PI);
    const randDir = vec2(sin(randomAngleRad), cos(randomAngleRad));

    const toChar = uniforms.uCharacterWorldPos.xz.sub(instancePos.xz);
    const safeToChar = toChar.add(1e-6);
    const charDir = normalize(safeToChar);

    const dist = length(toChar);
    const lookRadius = float(3.0);
    const lookFactor = smoothstep(lookRadius, float(0.5), dist);

    const rawBlend = mix(randDir, charDir, lookFactor.mul(0.2));
    const safeBlend = rawBlend.add(1e-6);
    const finalDir = normalize(safeBlend);

    const cosTheta = finalDir.y;
    const sinTheta = finalDir.x;

    const xNew = vec.x.mul(cosTheta).sub(vec.z.mul(sinTheta));
    const zNew = vec.x.mul(sinTheta).add(vec.z.mul(cosTheta));

    let result = vec3(xNew, vec.y, zNew);

    if (terrainNormalFn) {
      const tn = terrainNormalFn(instancePos.xz);
      const up = vec3(0.0, 1.0, 0.0);
      const axis = cross(up, tn);
      const dotProd = clamp(dot(up, tn), -1.0, 1.0);
      const angle = acos(dotProd);

      If(length(axis).greaterThan(0.001), () => {
        result.assign(rotateAxis(result, normalize(axis), angle));
      });
    }

    return result;
  });

  material.positionNode = Fn(() => {
    const vatPos = sampleVATPosition(posTex, sampleUV);

    const scale = mix(uniforms.uScaleMin, uniforms.uScaleMax, seed);
    const localPos = applyRotation(vatPos.mul(scale));

    let worldPos = positionLocal.add(localPos).add(instancePos);

    const heightFactor = smoothstep(float(0.0), float(0.08), vatPos.y.abs()).mul(0.2);

    const windDirNorm = safeNormalize(uWindDir);
    const windStrength = calculateWindStrength(instancePos.xz,
      uWindDir,
      uWindScale,
      uTime,
      uWindSpeed,
      uWindStrength,
    );
    const sway = vec3(windDirNorm.x, 0.0, windDirNorm.y).mul(windStrength.mul(heightFactor));
    worldPos = worldPos.add(sway);

    const charPos = uniforms.uCharacterWorldPos;
    const dirToFlower = instancePos.xz.sub(charPos.xz);
    const dist = length(dirToFlower);

    const radius = float(1);
    const maxPush = float(2.0);

    const pushFactor = smoothstep(radius, float(0.2), dist);
    const pushDir = normalize(dirToFlower);
    const pushVec = vec3(pushDir.x, float(-0.3), pushDir.y).mul(pushFactor).mul(maxPush).mul(heightFactor);
    worldPos = worldPos.add(pushVec);

    if (terrainHeightFn) {
      worldPos.y.addAssign(terrainHeightFn(instancePos.xz));
    }

    return worldPos;
  })();

  material.colorNode = Fn(() => {
    const ns = mix(uniforms.uNoiseScale, vec2(5, 5), isPetal);
    const nr = mix(vec2(0, 1), vec2(0.5, 1), isPetal);
    const n = remapClamp(mx_noise_float(uv().mul(ns)), -1.0, 1.0, nr.x, nr.y);
    const stemColor = mix(uniforms.uGreen, uniforms.uGreen2, n);

    let petalCol = texture(colorTex, uvCord).rgb;
    const seed2 = fract(seed.mul(87.65));

    const hueShift = seed2.mul(float(uniforms.uHueRandomness).add(smoothstep(float(0.6), float(1.0), progress).mul(0.03))).add(uniforms.uHueShift);
    const valueShift = fract(seed2.mul(25.0)).mul(1);
    petalCol = shiftHSV(petalCol, vec3(hueShift, 0.0, valueShift));
    const darker = shiftHSV(petalCol, vec3(0.0, 0.0, -0.1));
    petalCol = mix(darker, petalCol, outline.rgb);

    petalCol.mulAssign(n);

    const finalColor = petalCol.mul(isPetal)
      .add(stemColor.mul(isStem))
      .add(stemColor.mul(isLeaf));

    const hueShifted = shiftHSV(finalColor, vec3(uGlobalHueShift, float(0.0), float(0.0)));
    return vec4(hueShifted.mul(smoothstep(0.95, 0.8, progress)), 1.0);
  })();

  const calculateVatNormalView = Fn(() => {
    const vatNormalLocal = sampleVATNormal(nrmTex, sampleUV, meta.compressNormal ?? true);
    const rotatedNormalLocal = applyRotation(vatNormalLocal);
    return transformNormalToView(rotatedNormalLocal);
  });

  const vN = varying(calculateVatNormalView());

  const calculateVatTangentView = Fn(() => {
    const baseTangent = vec3(1.0, 0.0, 0.0);
    const rotatedTangent = applyRotation(baseTangent);
    const vTangentGuess = transformNormalToView(rotatedTangent);
    return normalize(vTangentGuess.sub(vN.mul(dot(vN, vTangentGuess))));
  });

  const vT = varying(calculateVatTangentView());
  const vB = normalize(cross(vT, vN));

  material.normalNode = Fn(() => {
    const mapN = texture(normalMapTex, uvCord).rgb.mul(2.0).sub(1.0);
    const scaledMapN = vec3(mapN.xy.mul(uniforms.uNormalScale), mapN.z);
    const tbn = mat3(vT, vB, vN);
    return normalize(tbn.mul(scaledMapN)).mul(faceDirection);
  })();

  material.emissiveNode = Fn(() => {
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fresnel = float(1.0).sub(abs(dot(materialNormal, viewDir)))
      .pow(uniforms.uFresnelPower)
      .mul(uniforms.uFresnelIntensity);

    const u = mix(uv(0).x, uv(0).y, isPetal);
    const animSpeed = mix(-0.2, -0.7, fract(seed.mul(35.8)));
    const t = uTime.add(seed.mul(123.0)).mul(animSpeed);
    const wave = smoothstep(0.3, 0.0, abs(u.sub(mix(-0.2, 1.2, fract(t)))));
    const glow = wave.mul(uniforms.uEmissiveIntensity);

    return uniforms.uEmissiveColor.mul(glow.add(fresnel));
  })();

  return material;
}
