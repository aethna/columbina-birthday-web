/**
 * GroundMist —— **贴着地面的雾**（用户 m02019）。
 *
 * ── 为什么需要它（不要用「雾墙」一刀切）────────────────────────────
 * 用户的话（m01976 / m02019）：
 *   「参考 素材1 有可见的纵深感（能沿路看到很远）——你当然可以做那种朦胧的纵深感。
 *     但问题是，在草地刷新范围之外就看到了光秃秃的地面，那并不好看不是么」
 *   「在近处用贴着地面的雾，在远处开始用雾墙。」
 *
 * 病根是**几何**上的：草地只有一块 80×80 m 的圆盘（`grass/core/config.ts` 的
 * `DEFAULT_GRASS_AREA_SIZE`），跟着相机跳格搬家；圆盘之外的地面**没有草**，只有
 * `shaders/worldHeight.ts` 的程序化地面色。平视时这层秃地正好落在 40~100 m 的
 * 「中景」，非常显眼。而 `THREE.Fog` 是按**相机距离**衰减的 —— 想在中景把它糊掉，
 * 就得把 `far` 压到 40 m，那连纵深一起没了（`DN_eye` 的 far=40 版就是那样）。
 *
 * ── 为什么不能用 scene.fog 做「高度雾」──────────────────────────
 * ⚠️ three 的雾**没有 height 项**，而且没有注入钩子：
 *   `node_modules/three/src/materials/nodes/NodeMaterial.js:1161 setupFog(builder, outputNode)`
 *   用的 `builder.fogNode`，而 `node_modules/three/src/renderers/common/nodes/Nodes.js:207`
 *   是 `nodeBuilder.fogNode = this.getFogNode(renderObject.scene)` —— fogNode **完全由
 *   `scene.fog` 的类型决定**（`Fog` 线性 / `FogExp2` 指数两支），外部塞不进去。
 *   ⇒ 「贴着地面的雾」只能靠**额外的半透明几何体**实现，就是本文件。
 *
 * ── 做法：一块水平雾面，跟着相机走 ───────────────────────────────
 * 一块 220×220 m 的水平面，贴在相机脚下的地面上方 `MIST_Y`（1.15 m）：
 *   · 从 1.7 m 的视高看出去，**看向地面**的视线很快就穿过这块面 ⇒ 地面被染成雾色；
 *   · 而**看向树冠/树干上部**的视线是向上抬的，永远不穿它 ⇒ 纵深、树干、树冠全部保留。
 * 这正是「贴地雾」与「雾墙」的区别：一个只吃地面，一个什么都吃。
 *
 * 透明度 = 径向渐入（中心 5 m 内 0，30 m 外到满）× `forestWeight`（会场/月球里为 0，
 * 所以不会污染会场那个月夜星空）。
 *
 * 尺寸取 220（半径 110）：森林里 `WorldController` 的线性雾 `FOREST_FOG_FAR` 是 95 m，
 * 95 m 之外已经 100% 雾 ⇒ 雾面在 110 m 处的硬边正好被吃掉。会场里 `wf = 0` 整块不可见。
 */
import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { float, length, positionWorld, smoothstep, uniform, vec3 } from 'three/tsl';
import { regionWeightNode } from '../../core/shaders/worldHeight';
import { REGION_BY_ID, worldHeightCPU } from '../../core/worldRegions';

/** 雾面离地高度（米）。人的视高约 1.7 m ⇒ 站在地面时正好「齐胸」，
 *  低头看地一定穿过去，抬头看树不会。 */
const MIST_Y = 1.15;
/** 径向渐入的起止半径（米）：中心 `MIST_IN` 之内完全透明，`MIST_OUT` 之外到满。 */
const MIST_IN = 40;
const MIST_OUT = 62;
/** 满透明度的上限。留一点余地，免得地面被糊成一片死色、连石板路都看不见。 */
const MIST_ALPHA = 0.78;
/** 基准浓度。**全场一致**（用户 m02190 澄清：
 *  「我没有指定雾在森林。我说的是，草刷新范围外做雾」——
 *  雾的判据是「草地圆盘的半径」，不是「森林权重」，所以这里必须是 1.0，
 *  不能再按 `forestWeight` 分档）。唯一例外是月球：真空，见 `mistW`。 */
const MIST_BASE = 1.0;
/** 雾面边长（米）。见文件头对 220 的说明。 */
const MIST_SIZE = 220;

export default function GroundMist({ fog, visible = true }: { fog: THREE.Fog; visible?: boolean }) {
    const meshRef = useRef<THREE.Mesh>(null);
    const { camera } = useThree();

    const uCenter = useMemo(() => uniform(new THREE.Vector2(0, 0)), []);
    const uColor = useMemo(() => uniform(new THREE.Vector3(0.6, 0.79, 0.73)), []);
    const uAlpha = useMemo(() => uniform(MIST_ALPHA), []);

    const material = useMemo(() => {
        const m = new THREE.MeshBasicNodeMaterial();
        m.transparent = true;
        m.depthWrite = false;
        m.side = THREE.DoubleSide;
        /* ⚠️ 自己关掉 scene.fog：这块面**本身就是雾**，再叠一层距离雾会让它比
         *    真正的雾更浓，出现一圈比周围更白的「盘子」。 */
        m.fog = false;
        /* ⚠️⚠️ 2026-10-11 第一版**整块看不见**，两个错叠在一起：
         *  ① `planeGeometry` 默认躺在 **XY 平面**（面朝 +Z）—— 不旋转就是一面**竖墙**，
         *     相机正好贴在它内部/侧面 ⇒ 什么都看不到。必须 `rotation.x = -π/2` 躺平。
         *  ② 半径与 `forestWeight` 原本用 `positionLocal.xz` 算。`positionLocal` 是
         *     **未旋转的局部坐标**，躺平之后它的 `.z` 恒为 0 ⇒ 半径退化成 `|x|`。
         *     改用 `positionWorld`：它已经把旋转、位移都算进去了，不用再手动加 `uCenter`。
         */
        const r = length(positionWorld.xz.sub(uCenter));
        const radial = smoothstep(float(MIST_IN), float(MIST_OUT), r);
        /* 浓度：森林最浓（1.0），会场留一个基准（0.55），月球是真空（0）。
         * ⚠️ 2026-10-11 第二版：原来只在森林里出（`radial × wf`），
         *    用户在会场截图说「雾没做出来」—— 会场的草地圆盘边缘一样会露秃地，
         *    而且 `背景素材1/2` 的地面本身就带着一层齐地面的薄雾。
         *    所以改成「处处有、森林更浓」。 */
        /* 浓度：**全场一致**（`MIST_BASE`），只把月球排掉（真空）。
         * ⚠️ 2026-10-11 第三版。第一版按 `forestWeight` 门控（只在森林里出），
         *    第二版在会场留 0.55 基准 —— 用户 m02190 明确否掉：
         *    「我没有指定雾在森林。我说的是，草刷新范围外做雾」。
         *    ⇒ 判据是**草地圆盘的边界**（`GRASS_EDGE_FADE` / `CULL_R`），与区域无关。
         *    所以这里不再读 `forestWeight`。 */
        const wMoon = regionWeightNode(positionWorld.xz, REGION_BY_ID.moon);
        const mistW = float(MIST_BASE).mul(float(1).sub(wMoon));
        m.colorNode = vec3(uColor.x, uColor.y, uColor.z);
        m.opacityNode = radial.mul(mistW).mul(uAlpha).mul(float(visible ? 1 : 0));
        return m;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useFrame(() => {
        const cx = camera.position.x;
        const cz = camera.position.z;
        /* 跟着相机走。⚠️ y 取**相机脚下的地形高度** + MIST_Y，不是世界固定高度 ——
         * 否则站到丘陵上时雾面会整块沉到地面以下、彻底看不见。 */
        const gy = worldHeightCPU(cx, cz);
        if (meshRef.current) meshRef.current.position.set(cx, gy + MIST_Y, cz);
        uCenter.value.set(cx, cz);
        // 颜色跟随 WorldController 每帧算好的雾色（它已经把太阳色与森林色混过了）
        uColor.value.set(fog.color.r, fog.color.g, fog.color.b);
    });

    return (
        <mesh ref={meshRef} material={material} rotation={[-Math.PI / 2, 0, 0]} renderOrder={900} frustumCulled={false}>
            <planeGeometry args={[MIST_SIZE, MIST_SIZE]} />
        </mesh>
    );
}
