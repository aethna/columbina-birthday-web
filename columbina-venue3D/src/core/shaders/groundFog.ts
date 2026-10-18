/**
 * 大气雾（指数高度雾 + 远景空气透视）—— 2026-10-19 第二次重写。
 *
 * ── 用户的三轮反馈（把三次都记下来，别再绕回去）────────────────────────
 *   m08820 「雾改成白色，只贴住地面，盖住草地刷新范围之外。浓一些。」
 *           ⇒ 第一版：`smoothstep(内圈 40, 外圈 62, 水平距离)` × `smoothstep(0, 2.5 m, 离地高度)`
 *   m03761 「雾白得过头了，更像是白雾而不是雾。」
 *           ⇒ 只改了**颜色**（纯白 → 白天淡蓝灰 / 夜里深蓝青）
 *   m03988 「雾又变成蓝色条带了。为啥要么白的发亮，要么看不见，就做不出朦胧感么？」
 *           ⇒ **这次才是治根**：形状不对，颜色怎么调都只是一条带子。
 *
 * ── 为什么前两版必然是「一条带子」────────────────────────────────────
 *   ① `rFade = smoothstep(40, 62, 水平距离)` 是一个**环**：0~40 m 完全无雾、
 *      62 m 之后满雾。于是屏幕上必然出现「一圈边界」——环内干净、环外一堵墙。
 *   ② `hFade = smoothstep(0, 2.5 m, 离地高度)` 又是一个**硬天花板**：
 *      2.5 m 以上一刀切没有雾。两个硬边一叠加，就是一条贴地的、颜色均一的带子。
 *   ③ 更要命的是：天空 `SkyMesh` 的材质**吃雾**（它是普通 `NodeMaterial`，
 *      `fog` 默认 true）⇒ 天空本身的像素在这两个硬边之内也被刷成雾色，
 *      于是「带子」直接画在天上，无论如何都穿帮。
 *
 * ── 现在的做法：照 three.js 官方 `exponentialHeightFogFactor()` 的思路 ──
 *   参考：three.js PR #32659（Mugen87）新增的 TSL 节点
 *     https://github.com/mrdoob/three.js/pull/32659
 *     ```
 *     export const exponentialHeightFogFactor = Fn( ( [ density, height ], builder ) => {
 *         const viewZ = getViewZNode( builder );
 *         const distance = height.sub( positionWorld.y ).max( 0 ).toConst();
 *         const m = distance.mul( viewZ ).toConst();
 *         return density.mul( density, m, m ).negate().exp().oneMinus();
 *     } );
 *     ```
 *   语义：**离雾顶越远（越低）、离相机越远，雾越浓**，全是连续的指数衰减，
 *   没有任何 smoothstep 硬边 ⇒ 不会有边界线。我们本地 three 是 0.182，
 *   还没有这个节点（`src/nodes/fog/Fog.js` 里只有 `rangeFogFactor` /
 *   `densityFogFactor`），所以这里按同一思路自己写一份，并把它换成更适合
 *   「薄雾」的**线性光学厚度**形式：
 *
 *       光学厚度  τ = ρ · d · exp(-h / H)
 *       雾占比    f = (1 - exp(-τ)) · fmax
 *
 *   ρ = 每米消光系数，h = 该像素离地高度，H = 雾的标高（e-folding height），
 *   d = 到相机的**世界距离**。这三样保证：
 *     · 近处几乎无雾（τ 小）→ 远处渐浓，**连续**，没有环；
 *     · 贴地最浓、越高越淡（指数，不是阶跃）→ 树冠只在很低的高度才被吃掉；
 *     · `fmax` < 1 ⇒ **永远不完全遮挡**，远处轮廓始终透出来 —— 这才是「朦胧」
 *       而不是「一堵墙」。物理上对应「有限的能见度距离」。
 *
 * ── 颜色：按高度做一次纵向渐变 ─────────────────────────────────────
 *   雾色不是常量：贴近地面时最接近地平线雾色，越高越暗一档（真实大气里
 *   高处的空气散射更弱、更接近暗背景）。两个颜色由 `WorldController` 按
 *   `dayness` 每帧插值好推进来，这里只做一次 `smoothstep(0, 30 m)` 的纵向混合。
 *
 * ── 钩子在哪 ────────────────────────────────────────────────────────
 *   `node_modules/three/src/renderers/common/nodes/Nodes.js:402`：
 *       getFogNode( scene ) { this.updateFog( scene ); return scene.fogNode || … }
 *   ⇒ `scene.fogNode` 会**顶替** `scene.fog`（不是叠加），可以塞自定义 TSL 节点。
 *   注意：一旦设置它，`scene.fog` 那条线性雾对所有材质就不再起作用了，
 *   所以本节点必须自己把「远景景深」也带上（上面的 ρ·d 项就是干这个的）。
 *
 * ⚠️ 天空/星星/月亮这类「天体」材质必须显式 `fog = false`（见
 *    `PhysicalSky.tsx` / `Stars.tsx` / `VenueSky.tsx`），否则它们会被雾色涂掉，
 *    又会变成「天上一条带子」。这是本文件以外唯一必须配合的地方。
 * ⚠️ 高度基准用**相机脚下的地面高度**（`GBASE`）而不是 y=0：地形有 ±5 m 起伏，
 *    用绝对 0 会让低洼处整片没雾、高处整片是雾。
 */
import { Color } from 'three';
import { Fn, cameraPosition, exp, float, max, mix, output, positionWorld, smoothstep, uniform, vec4 } from 'three/tsl';

/** 雾总开关（0 = 完全关） */
const GON = uniform(1.0);
/** 地平线附近的雾色（每帧由 WorldController 按 dayness 插值） */
const GCOLOR = uniform(new Color('#2e4a5a'));
/** 高处（约 30 m 以上）的雾色：比地平线色暗一档，避免整片同色 */
const GCOLOR_TOP = uniform(new Color('#1b2c3a'));
/** 相机脚下的地面高度（每帧更新） */
const GBASE = uniform(0.0);
/** 每米消光系数 ρ（1/m）。0.009 ⇒ 45 m 处约 34% 雾、90 m 约 55%。 */
const GDENS = uniform(0.009);
/** 雾的标高 H（m）：离地 H 米高时浓度衰减到 1/e */
const GH = uniform(7.0);
/** 最大雾占比：永远留出 (1 - fmax) 的可见度 ⇒ 轮廓透出来，才是「朦胧」 */
const GMAX = uniform(0.85);

/** 每帧从 WorldController 推进来。 */
export function updateGroundFog(
    camY: number,
    groundY: number,
    density: number,
    height: number,
    maxFactor: number,
    on: number,
    color: Color,
    topColor: Color,
) {
    void camY;
    GBASE.value = groundY;
    GDENS.value = density;
    GH.value = height;
    GMAX.value = maxFactor;
    GON.value = on;
    GCOLOR.value.copy(color);
    GCOLOR_TOP.value.copy(topColor);
}

/**
 * 直接挂到 `scene.fogNode` 上。签名：`fog(color, factor)` 的 `factor` 是雾占比。
 */
export const groundFogNode = /* @__PURE__ */ (() => {
    return Fn(() => {
        // ① 到相机的世界距离（比 viewZ 更直观，InstancedMesh 上也是真实距离）
        const dx = positionWorld.x.sub(cameraPosition.x);
        const dy = positionWorld.y.sub(cameraPosition.y);
        const dz = positionWorld.z.sub(cameraPosition.z);
        const dist = dx.mul(dx).add(dy.mul(dy)).add(dz.mul(dz)).sqrt();

        // ② 离地高度（地面以下 clamp 到 0，坑底/水面以下同样按贴地算）
        const hAbove = max(positionWorld.y.sub(GBASE), float(0.0));

        // ③ 指数高度衰减：exp(-h / H)
        const fall = exp(hAbove.div(GH).negate());

        // ④ 光学厚度 → 雾占比。`oneMinusExp` 用 `(-τ).exp().oneMinus()` 写，
        //    数学上等价 1 - e^-τ，且 TSL 里没有专门的函数。
        const tau = GDENS.mul(dist).mul(fall);
        const factor = tau.negate().exp().oneMinus().mul(GMAX).mul(GON);

        // ⑤ 纵向色调：0~30 m 之间从地平线色过渡到高处色
        const vTint = smoothstep(float(0.0), float(30.0), hAbove);
        const tint = mix(GCOLOR.toVec3(), GCOLOR_TOP.toVec3(), vTint);

        return vec4(factor.toFloat().mix(output.rgb, tint), output.a);
    })();
})();

export { GON as GROUND_FOG_ON, GCOLOR as GROUND_FOG_COLOR };
