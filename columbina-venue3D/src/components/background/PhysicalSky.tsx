/**
 * PhysicalSky —— **物理大气散射天空**，直接用 three.js 官方 `webgpu_sky` 示例的那套。
 *
 * ⭐ 为什么要有这个文件（用户 m02050 指路 / m01545 的核心诉求）
 * 用户连着说「画质和原本的草地差的不是一个档次」「去搜搜」。另一个搜索 agent 交来的
 * `3D网页即玩包` 里，第五节列出了官方 WebGPU 示例库，其中 🌤️ `sky` 就是这块。
 *
 * ── 我原来错在哪 ──────────────────────────────────────────────────────
 * `Background.tsx:48-51` 白天的天空**只是一个双色垂直渐变**：
 *     const skyGrad = smoothstep(float(-0.14), float(0.95), viewDir.y)
 *     const skyNode = mix(uSkyHorizon, uSkyTop, skyGrad)
 * 没有太阳、没有地平线辉光、没有大气散射。
 * 而 `SeaWater` 在掠射角下 `reflectance = pow(1-theta,5)*0.7+0.3` 趋近 **1.0（纯镜面）**，
 * 镜子里就是这个「平渐变」⇒ 水面永远一片平、一片白。
 * **真正缺的是天空，不是水。**
 *
 * ── 用的是官方哪个文件 ────────────────────────────────────────────────
 *   `three/addons/objects/SkyMesh.js`（本地 7782 B，three 0.182 自带）
 *   官方示例：`https://threejs.org/examples/webgpu_sky.html`
 *   Preetham 解析天空模型（"A Practical Analytic Model for Daylight"），
 *   `BoxGeometry(1,1,1)` + `BackSide` + `depthWrite = false`，**自带太阳盘**：
 *       官方 SkyMesh.js:232  sundisk = smoothstep(sunAngularDiameterCos, ... + 0.00002, cosTheta)
 *       官方 SkyMesh.js:233  L0.addAssign( vSunE.mul(19000.0).mul(Fex).mul(sundisk) )
 *   构造后改这几个 uniform 就能驱动（`SkyMesh.js:48-83`）：
 *       sky.turbidity.value / sky.rayleigh.value / sky.mieCoefficient.value
 *       sky.mieDirectionalG.value / sky.sunPosition.value / sky.upUniform.value
 *
 * ── 三处必须偏离官方示例的适配 ────────────────────────────────────────
 *   ① **跟随相机**。官方示例把穹顶摆在原点、`scale = 450000`，相机就在原点附近。
 *      但 `SkyMesh.js:196` 的片元是 `normalize(positionWorld.sub(cameraPosition))`，
 *      而我们的相机 `far = 200`（`app/App.tsx:156`）⇒ 穹顶得**贴着相机走**、
 *      `scale × √3 ÷ 2 < 200`，取 `?skyscale=200`（面 100 m / 角 173 m，全部在远平面内）。
 *   ② **夜里 / 月球区要透出星空**。我们把官方那个纯不透明的壳改成按 `uStarIntensity`
 *      淡入淡出 —— 这个量本来就由 `sunCycle` 每帧写（1 = 深夜），而且
 *      `DirectionalLight.tsx:144` 还做了 `Math.max(s.starIntensity, wr.moon)`
 *      ⇒ **月球区自动恒为 1（无大气，黑天空）**，一行判断都不用加。
 *   ③ **`?psky=0` 开关**，方便 A/B 与出问题时一键回退。
 *
 * ⚠️ `SkyMesh` 的 `material.colorNode` 是构造函数里 `Fn(()=>{...})()` **立即执行**的，
 *    图在那一刻就建死了。所以驱动它只能改 `uniform.value`。而 `opacityNode` 是独立槽，
 *    构造后**可以**替换（和 `WaterMesh` 一样的性质）。
 */
import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { Fn, float, vec4 } from 'three/tsl';
// @ts-expect-error three 的 examples 没有随包发 .d.ts（node_modules/three 只有 build/*.js）
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { QNUM } from '../../core/utils/query';
import { uSunDir, uStarIntensity } from '../../core/shaders/uniforms';

/** `?psky=0` 关掉物理天空，退回原来的双色渐变（`Background.tsx` 那条路仍然在跑） */
const SKY_ON = QNUM('psky', 1)! > 0;
/** 穹顶缩放。**必须满足 scale × √3/2 < 相机 far(200)**，否则盒子的边角会被远平面切掉 */
const SKY_SCALE = QNUM('skyscale', 200)!;
/** ⭐ **天空增益** —— 见下面 `gain` 那段注释。标定过的值：`?skygain=0.18`
 *  （扫过 0.10 / 0.25 / 0.45：0.45 又发白，0.10 偏灰，0.18~0.25 是蓝灰最舒服的一段） */
const SKY_GAIN = QNUM('skygain', 0.18)!;
/** 浑浊度。官方 `webgpu_sky` 给 10，`SkyMesh` 默认 2。低=通透的蓝天，高=发灰的雾霭 */
const TURBIDITY = QNUM('turbidity', 2.5)!;
/** 瑞利散射强度。越大天越蓝、地平线越亮 */
const RAYLEIGH = QNUM('rayleigh', 2.0)!;
/** 米氏散射系数（气溶胶/雾霾），官方 0.005 */
const MIE_COEF = QNUM('miecoef', 0.005)!;
/** 米氏相函数各向异性 0~1，官方 0.7~0.8。越大太阳附近的辉光越集中 */
const MIE_G = QNUM('mieg', 0.8)!;

export function PhysicalSky({ visible = true }: { visible?: boolean }) {
    const camera = useThree((s) => s.camera);

    const sky = useMemo(() => {
        if (!SKY_ON) return null;

        const s: any = new SkyMesh();
        s.scale.setScalar(SKY_SCALE);
        // 穹顶跟着相机走 ⇒ 视锥剔除会把它的包围球算在世界原点，必须自己关掉
        s.frustumCulled = false;

        /* 官方给的默认值偏「干净」，`webgpu_sky` 示例的初始值是
           turbidity 10 / rayleigh 3 / mieCoefficient 0.005 / mieDirectionalG 0.7。
           我们取中间：turbidity 低一点更通透，rayleigh 2.0 让天够蓝。 */
        s.turbidity.value = TURBIDITY;
        s.rayleigh.value = RAYLEIGH;
        s.mieCoefficient.value = MIE_COEF;
        s.mieDirectionalG.value = MIE_G;

        const mat: any = s.material;
        /* ★★★ 2026-10-19 用户 m03988「雾变成蓝色条带」的**头号元凶** ★★★
         * `SkyMesh` 的材质是普通 `NodeMaterial`（`SkyMesh.js:39` 里 `new NodeMaterial()`），
         * `fog` 默认是 true ⇒ `scene.fogNode` 会把**天空自己的像素**也刷成雾色。
         * 所以那条「雾带」其实是**直接画在天上的**，无论怎么调颜色都穿帮。
         * 天空不吃雾之后，远景的雾才是真正「叠在天体前面的空气」，地平线过渡才自然。 */
        mat.fog = false;
        /* ⚠️ `SkyMesh` 默认是**不透明的壳**（`material.side = BackSide; material.depthWrite = false`）。
           夜里/月球区要能看见星空，所以这里按 `uStarIntensity` 淡出。
           `opacityNode` 是 NodeMaterial 的独立槽，构造后替换是有效的 ——
           这和 `WaterMesh` 的 `opacityNode` 一样。 */
        mat.transparent = true;
        mat.opacityNode = float(1).sub(uStarIntensity);

        /* ⭐ **天空增益 —— 没有它整片天是死白的** ─────────────────────────────
           实测 `S1_venue_day.png`：草地与角色都正常，**天空却烧成一片白**，
           `S1_sea_day.png` 那片死白也是同一个原因（水面掠射角全是镜面，照抄了这片白）。

           根因：官方 `webgpu_sky` 的 Preetham 输出是 **HDR 线性值，可以远大于 1**
           （`SkyMesh.js:235` `texColor = (Lin + L0) * 0.04`，`Lin` 里有 `vSunE ≈ 1000`）。
           官方示例能看，是因为它同时把 `renderer.toneMappingExposure` 压到 **0.05**
           并启用 ACES tone mapping；而我们的渲染器 `app/App.tsx:159-169` **没开 tone mapping**
           ⇒ 这些值直接 clip 到白色。

           这里不去动全局渲染器（那会把会场、草地、角色的既有调子全改掉），
           只给天空这一层补一个增益，把它拉回 [0,1]。
           `material.colorNode` 虽然是构造函数里 `Fn(()=>{...})()` 立即执行的，
           但它是**公开属性**，可以在外面再包一层 —— 拿到内层节点原样求值，只缩放 rgb。 */
        const inner: any = s.material.colorNode;
        s.material.colorNode = Fn(() => {
            const c: any = inner;
            return vec4(c.rgb.mul(float(SKY_GAIN)), c.a);
        })();

        return s;
    }, []);

    /* 每帧：① 把穹顶搬到相机脚下（`positionWorld - cameraPosition` 才算得出视线方向）；
             ② 把全局太阳/月亮方向喂进 `sunPosition`。
             `uSunDir` 本来就是「从地面指向光源」，且 `sunCycle.ts:127` 按 `dayness`
             在月亮与太阳之间插值 ⇒ 穹顶的太阳盘会自动跟着昼夜循环走。 */
    useFrame(() => {
        if (!sky) return;
        sky.position.copy(camera.position);
        sky.sunPosition.value.copy(uSunDir.value).normalize();
    });

    useEffect(() => () => {
        if (!sky) return;
        sky.geometry?.dispose();
        sky.material?.dispose();
    }, [sky]);

    if (!sky || !visible) return null;
    return <primitive object={sky} />;
}
