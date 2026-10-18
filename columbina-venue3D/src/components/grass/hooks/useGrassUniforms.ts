import { useControls } from "leva";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { uniform, uniformArray, vec2, vec3 } from "three/tsl";
import { createGrassControls } from "../core/grassControls";
import { QNUM, QCOL } from "../../../core/utils/query";
import { KEEP_OUT, KEEP_OUT_EMPTY, KEEP_OUT_MAX } from "../../../core/world/keepOut";
import { SKY_MODE, VENUE } from "../../../core/venuePalette";

/** 模块级常量：避让区的两组 uniformArray 数据（静态，不随帧变化，所以不进 useMemo 依赖）。 */
const KEEP_A = Array.from({ length: KEEP_OUT_MAX }, (_, i) => {
    const o = KEEP_OUT[i] ?? KEEP_OUT_EMPTY;
    return new THREE.Vector4(o.x, o.z, o.rx, o.rz);
});
const KEEP_B = Array.from({ length: KEEP_OUT_MAX }, (_, i) => {
    const o = KEEP_OUT[i] ?? KEEP_OUT_EMPTY;
    return new THREE.Vector4(Math.cos(o.rot), Math.sin(o.rot), 0, 0);
});

/**
 * 把 `keepOut.ts` 的**当前**槽位值同步进 GPU 用的两个 Vector4 数组。
 *
 * 为什么需要手动同步：`KEEP_A/KEEP_B` 是模块级数组、在导入时按 `KEEP_OUT` 拍好，
 * 之后 `KEEP_OUT` 变了它们不会自己跟。而 `scene.fogNode`… 不，草这边是
 * `UniformArrayNode.update()`（`NodeUpdateType.RENDER`）每帧把数组内容重新上传，
 * 所以我们只要改这些 Vector4 的数值，**下一帧** compute shader 就用新值。
 * 阶段切换时调一次即可（`GameLayer.tsx` 里 `showFeast` 的 effect）。
 */
export function syncKeepOutUniforms() {
    for (let i = 0; i < KEEP_OUT_MAX; i++) {
        const o = KEEP_OUT[i] ?? KEEP_OUT_EMPTY;
        KEEP_A[i].set(o.x, o.z, o.rx, o.rz);
        KEEP_B[i].set(Math.cos(o.rot), Math.sin(o.rot), 0, 0);
    }
}

export function useGrassUniforms() {

    const [params] = useControls('Grass', () => createGrassControls(), { collapsed: true })


    const uniforms = useMemo(() => (
        {
            compute: {
                // Shape Parameters
                uBladeHeightMin: uniform(0.4),
                uBladeHeightMax: uniform(0.8),
                uBladeWidthMin: uniform(0.01),
                uBladeWidthMax: uniform(0.05),
                uBendAmountMin: uniform(0.2),
                uBendAmountMax: uniform(0.6),
                uBladeRandomness: uniform(new THREE.Vector3(0.3, 0.3, 0.2)),

                // Clump Parameters
                uClumpSize: uniform(0.8),
                uClumpBlendSmoothness: uniform(0.2), // Blend region width for attribute mixing
                uCenterYaw: uniform(1.0),
                uBladeYaw: uniform(1.2),
                uClumpYaw: uniform(0.5),
                uTypeTrendScale: uniform(0.1),

                // Wind Parameters
                uWindScale: uniform(0.25),
                uWindSpeed: uniform(0.6),
                uWindStrength: uniform(0.35),
                uWindFacing: uniform(0.6),

                // Culling Parameters
                uCullOffset: uniform(0.8),
                uLODNoiseScale: uniform(0.1),

                uViewProjectionMatrix: uniform(new THREE.Matrix4()),
                uCameraPosition: uniform(new THREE.Vector3()),
                uGroupOffset: uniform(new THREE.Vector3()),
                uGridIndex: uniform(new THREE.Vector2(0, 0)),
                uCharacterWorldPos: uniform(new THREE.Vector3(0, 0, 0)),
                uCharacterPushRadius: uniform(0.8),
                uCharacterPushAmount: uniform(0.3),

                /* ── 道具避让区（用户 m02063 任务2：「草地上实现『避开道具』的功能」）──
                 *
                 * 草叶是 compute shader 按网格撒出来的，它**不知道**世界里摆了什么。
                 * 原来月牙石桌/长桌底下照样长满草，远看是「石头里长出草叶」，凑近看是毛刺。
                 *
                 * 为什么是**定长** uniformArray 而不是「运行期长度」：WebGPU 的 uniform
                 * 缓冲区大小在管线里就定死了。`KEEP_OUT_MAX`（8）个槽位够用，没用到的槽位是
                 * `KEEP_OUT_EMPTY`（远处 + 1e-3 半径）⇒ 归一化距离爆表 ⇒ 因子恒 1，不影响。
                 *
                 * A 存 `(中心x, 中心z, 半轴x, 半轴z)`、B 存 `(cos, sin, 0, 0)` —— 两个 vec4
                 * 而不是合成一个 mat，是为了 shader 里每个槽位只取两次 uniform。
                 */
                uKeepA: uniformArray(KEEP_A, 'vec4'),
                uKeepB: uniformArray(KEEP_B, 'vec4'),
            },
            material: {
                uWindSwayFreqMin: uniform(0.4),
                uWindSwayFreqMax: uniform(1.5),
                uWindSwayStrength: uniform(0.1),
                uWindDistanceStart: uniform(10.0),
                uWindDistanceEnd: uniform(30.0),

                uMidSoft: uniform(0.25),
                uRimPos: uniform(0.42),
                uRimSoft: uniform(0.03),
                uBaseColor: uniform(vec3(0)),
                uTipColor: uniform(vec3(1)),
                uBladeSeedRange: uniform(vec2(0.95, 1.03)),
                uClumpSeedRange: uniform(vec2(0.9, 1.1)),
                uAOPower: uniform(0.6),
                uBaseWidth: uniform(0.35),
                uTipThin: uniform(0.9),
                uThicknessStrength: uniform(0.10),

                uGroupOffset: uniform(new THREE.Vector3(0, 0, 0)),
                uCharacterWorldPos: uniform(new THREE.Vector3(0, 0, 0)),
                uCharacterPushRadius: uniform(0.8),
                uCharacterPushAmount: uniform(0.3),
                uCharacterFlattenAmount: uniform(0.5),
                uActiveWaveCount: uniform(0.0)
            }
        }), [])

    useEffect(() => {
        uniforms.compute.uBladeHeightMin.value = params.bladeHeightMin
        uniforms.compute.uBladeHeightMax.value = params.bladeHeightMax
        uniforms.compute.uBladeWidthMin.value = params.bladeWidthMin
        uniforms.compute.uBladeWidthMax.value = params.bladeWidthMax
        uniforms.compute.uBendAmountMin.value = params.bendAmountMin
        uniforms.compute.uBendAmountMax.value = params.bendAmountMax
        uniforms.compute.uBladeRandomness.value.set(
            params.bladeRandomness.x,
            params.bladeRandomness.y,
            params.bladeRandomness.z
        )

        // Clump parameters
        uniforms.compute.uClumpSize.value = params.clumpSize
        uniforms.compute.uClumpBlendSmoothness.value = params.clumpBlendSmoothness 
        uniforms.compute.uCenterYaw.value = params.centerYaw
        uniforms.compute.uBladeYaw.value = params.bladeYaw
        uniforms.compute.uClumpYaw.value = params.clumpYaw

        // Culling parameters
        uniforms.compute.uCullOffset.value = params.cullOffset
        // LOD parameters
        uniforms.compute.uLODNoiseScale.value = params.lodNoiseScale
        // Character interaction (used in compute for push vector)
        uniforms.compute.uCharacterPushRadius.value = params.pushRadius
        uniforms.compute.uCharacterPushAmount.value = params.pushAmount
    }, [params, uniforms.compute])

    useEffect(() => {
        // Wind parameters are now managed globally via Wind component
        uniforms.material.uWindSwayFreqMin.value = params.swayFreqMin;
        uniforms.material.uWindSwayFreqMax.value = params.swayFreqMax;
        uniforms.material.uWindSwayStrength.value = params.swayStrength;
        uniforms.material.uWindDistanceStart.value = params.windDistanceStart;
        uniforms.material.uWindDistanceEnd.value = params.windDistanceEnd;

        // Width shaping uniforms
        uniforms.material.uMidSoft.value = params.midSoft;
        uniforms.material.uRimPos.value = params.rimPos;
        uniforms.material.uRimSoft.value = params.rimSoft;

        // Color uniforms
        const baseColor = new THREE.Color(params.baseColor);
        uniforms.material.uBaseColor.value.set(baseColor.r, baseColor.g, baseColor.b);

        const tipColor = new THREE.Color(params.tipColor);
        uniforms.material.uTipColor.value.set(tipColor.r, tipColor.g, tipColor.b);

        uniforms.material.uBladeSeedRange.value.set(params.bladeSeedRange.x, params.bladeSeedRange.y);
        uniforms.material.uClumpSeedRange.value.set(params.clumpSeedRange.x, params.clumpSeedRange.y);
        uniforms.material.uAOPower.value = params.aoPower;

        // Lighting uniforms
        uniforms.material.uBaseWidth.value = params.baseWidth 
        uniforms.material.uTipThin.value = params.tipThin 
        uniforms.material.uThicknessStrength.value = params.thicknessStrength 

        // Character push uniforms
        uniforms.material.uCharacterPushRadius.value = params.pushRadius 
        uniforms.material.uCharacterPushAmount.value = params.pushAmount 
        uniforms.material.uCharacterFlattenAmount.value = params.flattenAmount

        // ===== URL 覆盖（无头截图专用；给了才生效）=====
        // 判据「参数打印正确 ≠ 功能生效」：观感开关必须能从 URL 打进去，
        // 否则在看不了控制台的环境里没法做 A/B。
        const tipOvr = QCOL('tip', SKY_MODE !== 'fe' ? VENUE.grass.tip : null);
        if (tipOvr) {
            const c = new THREE.Color(tipOvr);
            uniforms.material.uTipColor.value.set(c.r, c.g, c.b);
        }
        const baseOvr = QCOL('base', SKY_MODE !== 'fe' ? VENUE.grass.base : null);
        if (baseOvr) {
            const c = new THREE.Color(baseOvr);
            uniforms.material.uBaseColor.value.set(c.r, c.g, c.b);
        }
        const kH = QNUM('bhk');            // ?bhk=2 整体拔高/压低草叶
        if (kH !== null) {
            uniforms.compute.uBladeHeightMin.value = params.bladeHeightMin * kH;
            uniforms.compute.uBladeHeightMax.value = params.bladeHeightMax * kH;
        }
        const ovrClump = QNUM('clump');    // ?clump=4 丛更大
        if (ovrClump !== null) uniforms.compute.uClumpSize.value = ovrClump;
        const ovrAO = QNUM('ao');          // ?ao=1 根部落差变浅
        if (ovrAO !== null) uniforms.material.uAOPower.value = ovrAO;
    }, [params, uniforms.material])


    return {
        uniforms,
        params,
    }
}