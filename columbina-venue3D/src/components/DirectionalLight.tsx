import { useRef, useMemo, useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useControls } from 'leva'
import * as THREE from 'three'
import { QNUM } from '../core/utils/query';
import { SKY_MODE } from '../core/venuePalette';
import { SkyClock, sunStateFor } from '../core/sky/sunCycle';
import { regionWeights } from '../core/worldRegions';
import { uSunDir, uSunColor, uStarIntensity, uSkyTop, uSkyHorizon, uSkyBlend, uVacuumNight } from '../core/shaders/uniforms';

// ?tfreeze=<秒>：冻结时间（与 WorldController 同一语义）—— 太阳角度也一起定格
const T_FREEZE = (() => {
    const s = new URLSearchParams(window.location.search).get('tfreeze');
    if (s === null) return null;
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
})();
// ?rot=<弧度/秒>：覆盖太阳自转速度（只在 fe 模式下有意义，见下）
const ROT_OVERRIDE = (() => {
    const s = new URLSearchParams(window.location.search).get('rot');
    if (s === null) return null;
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
})();

/** `?sky=fe` 是上游那份「太阳每 12 秒绕一圈」的原版演示；它必须保持原样，
 *  否则同一组对照参数会在不同时刻拍到两个场景。会场模式（缺省）走昼夜循环。 */
const LEGACY_FE = SKY_MODE === 'fe';

/** 灯到原点的距离。**刻意取 (0,2,5) 的模长**：夜里 `lightDir` 就是 (0,2,5)
 *  归一化后的方向，乘上这个模长 ⇒ 位置与改造前逐位相同（会场零回归）。 */
const LIGHT_RADIUS = Math.hypot(0, 2, 5);

/* ★ 真空夜（月球区的夜）：只有**星光 + 地球反照**。
 *  真实数量级：星光照度约 0.002 lux，日光约 100000 lux —— 差 7 个数量级。
 *  这里取 0.14 是「压到能看但不失真的」美术值（会场夜间月光是 1.9、正午 2.2），
 *  相当于把月球之夜压暗约 13 倍，再让浦肯野漂移把色相拽到冷蓝（见 Terrain 的 colorNode）。 */
const VACUUM_COLOR = new THREE.Color('#6f8fc4')
const VACUUM_INTENSITY = 0.14

/* ★★ 「月面白天没有天空补光」的切除比例（`?moonamb=`）。
 *
 * 为什么必须切：`sunCycle` 算出来的那盏环境光是**天空散射**（地球大气把阳光散射下来的
 * 蓝白色补光）。月球**没有大气**，白天唯一的填充是地球反照，量级约 1e-4 于日光 —— 等于没有。
 *
 * 不切会出的正是用户看到的那个怪现象：地面被 Lommel-Seeliger 按 `1/(μ0+μ)` 压暗后，
 * 日光项变小、**冷蓝的天光补光反而变成主导** ⇒ 近处（俯视、μ 大、LS 压得最狠）
 * 是一片**冷蓝灰**；远处坑壁（掠射、μ→0、LS 提亮）日光占绝对主导 ⇒ **暖褐灰**。
 * 同一片月壤因为观察角度不同而分成两个色系，物理上完全说不通。
 *
 * 切掉之后：近处远处都只剩日光，LS 是**标量**补偿（不改色相）⇒ 整片月面是同一种暖灰，
 * 靠 LS 的 `1/(μ0+μ)` 自然做出「月面整盘均匀发亮」的真实观感。
 * 给 0 = 不切（回到旧行为），给 1 = 全切。 */
const MOON_AMB_CUT = QNUM('moonamb', 0.95)!

/** 会场唯一的那盏「太阳」——MMD 角色的材质要跟它同步光照 uniform，
 *  pipeline 建的时候必须拿到同一个 light（给两个不同的 light 会抛
 *  `MMD_TSL_PIPELINE_LIGHT_MISMATCH`）。`<DirectionalLight>` 在 `<Suspense>` 里，
 *  可能比消费方晚挂，所以消费方要等一下。 */
export const SUN_REF: { current: THREE.DirectionalLight | null } = { current: null };

export function DirectionalLight() {
    const directionalLightRef = useRef<THREE.DirectionalLight>(null)
    const ambientRef = useRef<THREE.AmbientLight>(null)
    const helperRef = useRef<THREE.DirectionalLightHelper | null>(null)
    const { scene, camera } = useThree()

    // ★ 这些是**倍率**不是绝对值：绝对强度由 `core/sky/sunCycle.ts` 按「几点」算出来
    //   （正午峰值 `?sunint=`、白天光色 `?suncol=`、月亮强度 MOON_INTENSITY 都在那边）。
    //   如果这里再乘一个 2.0 的绝对强度，夜里就会凭空亮一倍。
    const { rotationSpeed, sunScale, ambientScale, debug } = useControls('Directional Light', {
        rotationSpeed: { value: ROT_OVERRIDE ?? (LEGACY_FE ? 0.5 : 0), min: 0, max: 2, step: 0.1 },
        sunScale: { value: QNUM('sunscale', 1.0)!, min: 0, max: 3, step: 0.05, label: '光强倍率' },
        ambientScale: { value: QNUM('ambscale', 1.0)!, min: 0, max: 3, step: 0.05, label: '环境光倍率' },
        debug: { value: false },
    }, { collapsed: true })

    const basePosition = useMemo(() => new THREE.Vector3(0, 2, 5), [])
    const positionRef = useRef(new THREE.Vector3())
    const rotationMatrixRef = useRef(new THREE.Matrix4())

    // 把 ref 暴露给 SUN_REF（MMD 角色要用**同一个** light 建 TSL pipeline）
    useEffect(() => {
        SUN_REF.current = directionalLightRef.current
        return () => { SUN_REF.current = null }
    })

    // Manage helper visibility
    useEffect(() => {
        if (!directionalLightRef.current) return

        if (debug && !helperRef.current) {
            // Create helper
            const helper = new THREE.DirectionalLightHelper(directionalLightRef.current, 1, 'red')
            helperRef.current = helper
            scene.add(helper)
        } else if (!debug && helperRef.current) {
            // Remove helper
            scene.remove(helperRef.current)
            helperRef.current.dispose()
            helperRef.current = null
        }

        return () => {
            // Cleanup on unmount
            if (helperRef.current) {
                scene.remove(helperRef.current)
                helperRef.current.dispose()
                helperRef.current = null
            }
        }
    }, [debug, scene])

    useFrame((state) => {
        const light = directionalLightRef.current
        if (!light) return

        if (LEGACY_FE) {
            // —— 原版行为：太阳自己在赤道面绕圈 ——
            const t = T_FREEZE === null ? state.clock.elapsedTime : T_FREEZE
            positionRef.current.copy(basePosition)
            rotationMatrixRef.current.makeRotationY(t * rotationSpeed)
            positionRef.current.applyMatrix4(rotationMatrixRef.current)
            light.position.copy(positionRef.current)
            if (helperRef.current) helperRef.current.update()
            return
        }

        // —— 昼夜循环 ——
        SkyClock.advance(state.clock.elapsedTime)
        const s = sunStateFor(SkyClock.current)

        /* ★ 真空夜：先算「相机在不在月球区、以及那里是不是夜」，再设灯。
         *  `regionWeights(0,0).moon === 0` ⇒ 会场里 `vac` 恒为 0 ⇒ **会场零回归**。 */
        const wr = regionWeights(camera.position.x, camera.position.z)
        const vac = wr.moon * (1 - s.dayness)

        positionRef.current.copy(s.lightDir).multiplyScalar(LIGHT_RADIUS)
        light.position.copy(positionRef.current)
        light.color.copy(s.lightColor)
        /* 月球区的夜里没有大气散射，唯一的填充是**地球反照**（冷蓝、极暗）。
           做两件事：光色拽向冷蓝，强度压掉 92%。 */
        light.color.lerp(VACUUM_COLOR, vac)
        light.intensity = (s.lightIntensity * sunScale) * (1 - vac * 0.92)

        const amb = ambientRef.current
        if (amb) {
            amb.color.copy(s.ambientColor).lerp(VACUUM_COLOR, vac)
            /* 白天会场那盏补光夜里本来就是 0；月球区夜里给一点极弱的地照底光，
               否则背光面纯黑会让人以为贴图丢了（真实月面的阴影里确实有微弱地照）。
               ★ 另外：**月球区白天要按 `MOON_AMB_CUT` 掐掉天空补光**（理由见文件上方的
               `MOON_AMB_CUT` 注释）—— 否则地面会被冷蓝天光染成灰蓝，和远处掠射的暖褐
               分成两个色系。`wr.moon` 在会场恒为 0 ⇒ **会场零回归**。 */
            amb.intensity = s.ambientIntensity * ambientScale * (1 - wr.moon * MOON_AMB_CUT)
                + vac * 0.06
        }
        uVacuumNight.value = vac

        // 天空/星空/雾都要知道太阳在哪（Background.tsx 与 WorldController.tsx 读它）
        uSunDir.value.copy(s.lightDir)
        /* ★ 太阳的「颜色 × 强度」：官方海洋着色器 `WaterMesh.js`（`webgpu_ocean` 示例）
         *   要它来算镜面（`pow(dot,100) * sunColor * 2.0`）与漫反射。夜里
         *   `lightIntensity` 掉到 `MOON_INTENSITY`，海面的日光闪闪自然就熄了 ——
         *   不用再单独写一遍昼夜逻辑。
         * ⚠️ 上限**必须留在 1.0 附近**：最初给 2.0，等于把水色和镜面一起乘 2，
         *   正午海面直接过曝成一片白（`V7_sea_day_close/open.png`）。
         *   官方示例之所以不炸，是因为它同时把 `toneMappingExposure` 压到 0.1。 */
        {
            const li = Math.min(s.lightIntensity, 1.0)
            // 注意：`uSunColor` 的 `.value` 是 `THREE.Vector3`，而 r182 的 Vector3
            // **没有 `setRGB`**（那是 `Color` 独有的，见 three.core.js:15668）——
            // 之前误用 `setRGB` 每帧抛 TypeError，直接把整个 render loop 打死。
            uSunColor.value.set(s.lightColor.r * li, s.lightColor.g * li, s.lightColor.b * li)
        }
        /* ★ 月球没有大气 —— 无论几点，站在月球区里天空都必须是「黑底星空」。
         *   不改这一条的话，白天「走」到月球上会看到蓝天，一眼就假。
         *   取 max 而不是覆盖：夜里 `starIntensity` 本来就是 1，会场的夜空不受影响；
         *   月亮区则是把白天的 0 顶回 1（`Background.tsx` 与 `Stars.tsx` 都乘这个值，
         *   所以天空和星点会一起切过去，不会出现「黑天但没星」）。 */
        uStarIntensity.value = Math.max(s.starIntensity, wr.moon)
        uSkyTop.value.set(s.skyTop.r, s.skyTop.g, s.skyTop.b)
        uSkyHorizon.value.set(s.skyHorizon.r, s.skyHorizon.g, s.skyHorizon.b)
        uSkyBlend.value = s.dayness
        // 环境贴图（HDRI ibl）跟着一起提亮：夜里 0.5 = 改造前的值
        scene.environmentIntensity = 0.5 + 0.7 * s.dayness

        if (helperRef.current) helperRef.current.update()
    })

    return (
        <>
            <directionalLight ref={directionalLightRef} position={basePosition.toArray()} intensity={1.0} />
            {/* 白天补的漫反射底光。**夜里强度为 0**，所以会场裸 URL 的观感不变。 */}
            <ambientLight ref={ambientRef} intensity={0} />
        </>
    )
}
