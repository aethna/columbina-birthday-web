import { Suspense, useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useControls } from 'leva';
import * as THREE from 'three/webgpu';
import {
    uTime,
    uDeltaTime,
    uGlobalHueShift,
    uWindDir,
    uWindScale,
    uWindSpeed,
    uWindStrength,
    uWindFacing,
    uTerrainAmp,
    uTerrainFreq,
    uTerrainSeed,
    uTerrainColor,
} from '../core/shaders/uniforms';
import { groundFogNode, updateGroundFog } from '../core/shaders/groundFog';
import { Terrain } from './Terrain';
import { StarrySky } from './background/StarrySky';
import { useGameStore } from '../core/store/gameStore';
import { AsyncCompile } from '@core';
import GrassWebGPU from './grass/GrassWebGPU';
import { GrassCullingDebug } from '../debug/GrassCullingDebug';
import { QNUM, QCOL } from '../core/utils/query';
import { VenueSky, MoonProps, SKY_MODE } from './background/VenueSky';
import { VenueProps, PROPS_ON } from './venue/VenueProps';
import { VenuePropsReal, REAL_ON } from './venue/VenuePropsReal';
import { RegionProps } from './world/RegionProps';
import { Forest } from './world/Forest';
/* ★ task-20：月坑浅水（`?craterwater=0` 关）。 */
import { CraterWater } from './water/CraterWater';
import { MoonShip } from './world/MoonShip';
import { WingShip } from './world/WingShip';
import { WingShipApi } from './world/WingShipApi';
/* `SeaWater`（浅海海面）于 2026-10-11 随「删海」删除（用户 m05607）。文件已移入
 * `_回收站_20261008\删海_SeaWater_20261011`。 */
/* ★ 物理大气散射天空（three.js 官方 `webgpu_sky` 的 `SkyMesh`）。
   原来白天的天空只是 `Background.tsx` 里的**一条双色垂直渐变**，
   而水面在掠射角近 100% 镜面 —— 镜子里没东西可反射，所以「水显平」。
   `?psky=0` 可退回老路（渐变那条仍然在跑）。见该文件顶部注释。 */
import { PhysicalSky } from './background/PhysicalSky';
import { VENUE } from '../core/venuePalette';
import { regionWeights, forestWeight, worldHeightCPU, CRATERS } from '../core/worldRegions';
import { R_VIS, VISR_ON, useVisGate } from '../core/world/visRadius';
/* 森林剔除半径：雾的远端从这份真值推导，别各写一个常数（见下方 FOREST_FOG_FAR 注释）。 */
import { CULL_R } from '../core/forest';
import { SkyClock, sunStateFor } from '../core/sky/sunCycle';
import { MmdCharacter, MMD_ON } from './columbina/MmdCharacter';
import { GameLayer } from './game/GameLayer';
import { MiniMapProbe } from './MiniMapProbe';
import { PostFX } from './PostFX';
import GroundMist from './world/GroundMist';

/** ?tfreeze=<秒>：冻结世界时间，保证截图可复现 */
export const T_FREEZE = (() => {
    const s = new URLSearchParams(window.location.search).get('tfreeze');
    if (s === null) return null;
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
})();

/* ===== URL 覆盖（无头截图专用；null = 用 leva 面板值） =====
 * 判据「参数打印正确 ≠ 功能生效」：所有观感开关都要能从 URL 打进去，
 * 才能在无头环境里做 A/B。这里只在「给了参数」时覆盖，人肉调试不受影响。
 *   ?hue=0.35      全局色相平移（0..1）
 *   ?amp= / ?freq= / ?tseed= / ?tcol=6b4a2e    地形
 *   ?windstr= / ?windspeed= / ?winddir=x,z     风
 *   ?tspeed=       时间缩放
 */
const OVR_HUE = QNUM('hue');
const OVR_AMP = QNUM('amp');
const OVR_FREQ = QNUM('freq');
const OVR_TSEED = QNUM('tseed');
const OVR_TCOL = QCOL('tcol');
const OVR_WINDSTR = QNUM('windstr');
const OVR_WINDSPEED = QNUM('windspeed');
const OVR_WINDDIR = QNUM('winddirx') !== null || QNUM('winddirz') !== null
    ? [QNUM('winddirx') ?? 1, QNUM('winddirz') ?? -0.8] as [number, number]
    : null;
const OVR_TSPEED = QNUM('tspeed');
/**
 * `?grass=0` 关掉整片草。**不为省性能，是为了「验收图里能看见她的腿」**：
 * 草高到她的胸口，正侧面机位下整条腿全被草挡住，步态**根本没法看**
 * （判据：验收图必须真的能看到被验收的那个东西）。
 */
const GRASS_ON = QNUM('grass', 1)! > 0;

/**
 * `?area=<米>`：地面网格的边长。缺省 80（和草的场地一样大）。
 *
 * ★ 无缝大地图带来的新约束：地形面只有 80×80 m、以相机为中心 ⇒ **你只能看见脚边 40 m 的地**。
 *   会场那边一直没暴露这个问题，是因为树环半径 29 m + 雾把这个边界挡住了；
 *   但月球主环形山口径 92 m，站在坑边**坑的对面一半根本不在地面网格里**。
 *   所以做了这个开关：出月球/浅海的验收图时把它开到 200~400。
 *   缺省从 80 提到 160：月球主坑口径 92 m，玩家真的走过去时要能站在坑边把整个坑看全，
 *   80 m 的网格只能看见脚边 40 m，坑的对面一半在地面网格外面。
 */
const TERRAIN_AREA = QNUM('area', 160)!;

/* ★ 区域雾（`?fog=0` 关掉做 A/B 对照）。
 * 指数雾让空气有厚度：近处清楚、远处发白 —— 这是「和现实一样观感」里最便宜的一半。
 * 但**月球没有大气**：走到月球区里雾必须归零，否则真空里飘着霾，一眼就假。
 * 所以浓度乘上 `(1 - regionWeights().moon)`；颜色与浓度都由太阳高度角驱动（日出日落偏橙、正午偏灰蓝）。 */
const FOG_ON = QNUM('fog', 1)! > 0 ? 1 : 0;

/* ★★ 森林浓雾（2026-10-10 用户 m01512）。
 *  两件事一起定：
 *  ① **观感**：参考图 `背景素材1.png` 的远景是一片**淡薄荷青的浓雾**（实测 `#9bcaba`，
 *     见 `_tools/refcolor.py`），近处的朱红草、苍白的树干全都被这层雾托住 ——
 *     这是原神森林「有空气」的第一来源，比任何模型都管用。
 *  ② **省显卡**：用户要求把树木等景观的刷新范围收到草地圆盘边缘（`CULL_R = 44`）。
 *     44 m 处一刀切下去，如果没有雾，抬头就是一条「树突然没了」的硬边。
 *     浓雾正好把那条边吃掉：`density = 0.028` 时 44 m 处的透过率
 *     `exp(-(0.028*44)²)…` 实际按 FogExp2 是 `exp(-(d·z)²)`，d·z = 1.23 ⇒ 只剩 ~22% 可见，
 *     足够把边界糊掉，又不至于连 10 m 内的树都看不清。
 *  ⚠️ **只按相机所在位置混**（`forestWeight(camera.xz)`），不是逐片元。
 *     `THREE.FogExp2` 只有全局密度，做不了分区；但玩家一次只能看一个地方，
 *     走进森林时整场雾渐浓、走出森林渐淡，肉眼看不出这是「全局开关」。
 *  ⚠️ 会场是**月夜星空**，绝不能糊：`forestWeight` 在会场内恒 0，所以会场一点不动。 */
/* ═══ ★★ 2026-10-10 用户 m01915：「视野范围仍然看到了草没刷新时的地面。在那里放雾。
 *              也就是说，视野范围（草地刷新范围）之外，都是雾。」★★
 *
 * 从 `THREE.FogExp2` **换成 `THREE.Fog`（线性雾）**。为什么非换不可：
 *   指数雾没有「起雾距离」这个参数 —— 它是从相机脚下就开始按 `1-exp(-(d·z)²)` 衰减，
 *   想在 40 m 处做到 100% 雾，就得把密度推到 `d≈0.05`，那时 **15 m 处已经 40% 雾**，
 *   站在树边上都看不清树干。而用户要的是「草地圆盘之内清楚、之外全是雾」——
 *   这恰好是线性雾的两个参数：`near`（开始起雾）/ `far`（完全化在雾里）。
 *
 * 参数：
 *   · 森林 —— `near = FOG_FAREST_NEAR(20)` / `far = FOG_FIELD_R(40)`。
 *     40 m 正好是**草地圆盘的半径**（`grass/core/config.ts` 的 `DEFAULT_GRASS_AREA_SIZE = 80`）
 *     与**森林剔除半径** `forest.ts` 的 `CULL_R = 44` 的内侧。⇒ 草一没、树一没，雾同时到位，
 *     玩家永远看不到「草没刷新的地面」。
 *   · 会场 —— `near = 40` / `far = VENUE_FAR(600)`，等价于原来的 `sky.fogDensity ≈ 0.0032`
 *     指数雾（d=0.0032 时 200 m 处 34% 雾，线性 near40/far600 在同一点是 27%，肉眼一致）。
 *     ⚠️ 会场是月夜星空，用户明确不许糊，所以**只在 forestWeight > 0 的地方加浓**。
 *   · 月球 —— 真空，`far` 推到 1e9（等于没有雾）。
 *
 * ⚠️ `THREE.Fog` 的 `near/far/color` 都是 **uniform**，每帧改不会触发着色器重编译；
 *    而「换 fog 类型」会（雾的类型是编译期分支）。所以这里是**一次性**换成线性雾，
 *    之后靠 uniform 在三种区域之间插值。
 * ⚠️ `?ffog=` 的语义跟着变：现在它是 **`far` 的倍率**（0.5~2），`?ffog=0` 仍然是完全关雾。 */
const FOREST_FOG_FAR_SCALE = QNUM('ffog', 1)!;
/* ★★ 2026-10-21 第四轮反馈 4b：「草地之外的地板也渲染了」★★
 *
 *  用户要 Minecraft 的渲染距离语义 ⇒ 40 m 外**只留裸基底**。
 *  地形细节在 40 m 处已经由 `shaders/worldHeight.ts` 的 `renderFadeNode()` 归零
 *  （`Terrain.tsx` 的每一条细节层都乘了它），但**地形网格本身不能删**
 *  （它是地面，删了就露出虚空）。
 *
 *  所以剩下的收尾工作在这里：雾必须**在 40 m 之后还有一小段**，
 *  让「细节没了」这件事被雾接住，而不是在 40 m 处出现一条「细节/裸基底」的硬圆环。
 *
 *  ⚠️ 历史口径与本次的区别：
 *    · task-15 把 far 收到 `CULL_R = 40`（= 树在 40 m 一刀切、雾在 40 m 满）。
 *      那时 40 m 外是**全雾色**，本来就是平的 —— 站在地面看不到「地板」。
 *    · 现在 `renderFadeNode` 在 39→45 m 才把细节收干净，若 far 仍然正好 40，
 *      40~45 m 那一圈会**细节已经半退、雾还没满** ⇒ 一条可辨的过渡环。
 *    ⇒ far 乘 1.35（= 54 m）把雾墙拉长到细节完全退干净之后。
 *      40 m 处透过率仍是 (40-20)/(54-20) ≈ 59% 的雾，观感更通透一点，
 *      换来的是 45 m 处 100% 雾、边界彻底化掉。
 *      要回旧口径：`?ffog=0.74`（= 40 m）；`?rvfade=0&rvfade2=0` 可把细节改回硬切。 */
const FOG_FAR_4B = QNUM('fogfar4b', 1.35)!;
/** 森林雾色的**白天**基色。夜里的深色见 `FOREST_FOG_NIGHT`。
 *  ★ 2026-10-19：原缺省 `#9bcaba` 是淡薄荷绿（亮度 ~192），夜里等于一块发光的
 *    薄荷色板。改成 `#8fb0a6`（亮度 ~166，蓝绿倾向、饱和度更高）作白天基色，
 *    夜里再按 `1 - dayness` 压到深青 —— 见 `useFrame` 里的插值。 */
const FOREST_FOG_COLOR = QCOL('ffcol', '#8fb0a6')!;
/** 森林雾的**夜间**色：深青（亮度 ~62）。夜里雾本该比远处树冠暗一档，这样树才
 *  有剪影；再亮就又回到「白纱」了。 */
const FOREST_FOG_NIGHT = '#1e3735';
/* ★★ 2026-10-20 task-7：森林雾要**比树的剔除半径更近**一步到位。
 *  树现在在 `CULL_R = 52 m` 处一刀切（`core/forest.ts`）。雾如果还是 42/70，
 *  52 m 处的透过率是 (52-42)/28 ≈ 64% ⇒ 边界一眼可辨（「树突然没了」的硬边）。
 *  改成 28/52：52 m 处雾已经 100%，边界完全化在雾里；28 m 起雾还比原来更近，
 *  正好把用户要的「渲染范围收到草地圆盘」在小屏幕上读成「林子里有雾」。
 *  ⚠️ 只影响森林（`forestWeight > 0` 的地方），会场/月球一个字没动。
 *  ⚠️ `?ffog=` 仍然是远端的倍率：`?ffog=1.34` 可回到旧的 70 m 口径。 */
/* ★★★ 2026-10-20 task-15：雾与可见半径收到**同一口径 = 草盘边缘 40 m** ★★★
 *  裁定见 `core/world/visRadius.ts` 文件头（用户 10-20 反馈3/4）。
 *  之前是 task-7 的森林 28 / 52：树的剔除半径 52 m，雾到 52 m 才满 ⇒ 用户红线在 40 m，
 *  于是 40~52 m 这一圈**雾还没到、树还在画**，正是反馈3 里那一排「落在红线外的树」。
 *  现在：树 40 m 一刀切，雾 20 m 起、**40 m 满** ⇒ 树的边界和草的边界、雾的边界三者重合，
 *  「红线之外」只剩被雾吃掉的地形（地形是地面，不能删）。
 *  ⚠️ 与会场雾的分工没变：`wf = forestWeight(相机)` 仍是插值权重，
 *     只是两套参数的 **far 都收到 ≈ `R_VIS`**。
 *  ⚠️ `?ffog=` 仍然是**森林** far 的倍率（`?ffog=1.3` 回到 52 m 口径做对照）；
 *     会场 far 不再吃这个开关（它是固定 46，`?visr=0` 时也一样）。
 *  ⚠️ 天空 / 星星 / 月亮 / 星球全部 `fog={false}`（见 `background/*.tsx`），
 *     所以雾收到 40 m **不会**把月亮和星空糊掉。
 *
 * ★★★ 2026-10-21 反馈4 最终口径：**树 40 m / 雾 40 m 满，一起走** ★★★
 *  用户澄清了红线语义（原话）：「比如我的世界，我把渲染距离设置为 40 m，
 *  那么 40 m 外啥都看不见，但是角色走到哪里，地图上该有的东西进了 40 m 就会
 *  渲染出来，出了 40 m 就看不见。」
 *  ⇒ 40 m 是**流式渲染边界**，雾必须在**同一距离**收满，边界才化在雾里、
 *    看不到「树突然没了」的硬边。这两个数必须从同一份真值推导，不能各写一个常数。
 *
 *  ⚠️ 中间有一版把两者一起抬到 96（理由「40 m 圆里只有 6.7 棵树」）——
 *    那是把**密度问题**错当成**半径问题**去解，等于拆掉用户要的渲染距离。
 *    真正的修法在 `core/forest.ts`：半径不动，把 40 m 内的树层密度和
 *    `FAR_TIERS` 抽稀曲线改对。 */
const FOREST_FOG_NEAR = 20;
/* 远端 = 森林剔除半径本身（已含 `?far=` 乘子），再乘 `?ffog=` 做人工微调。
 * 雾在树消失的**同一距离**才满 ⇒ 边界化在雾里，看不到「树突然没了」的硬边。
 * ⚠️ 直接 import `CULL_R`，以后动 `?fcull=` / `?far=` 时雾自动跟随，
 *    不会再出现「树和雾两个口径」的历史 bug（task-7 与 task-15 各踩过一次）。 */
const FOREST_FOG_FAR = CULL_R * FOREST_FOG_FAR_SCALE * FOG_FAR_4B;
/* 会场：原来 38 / 82（为了保住月夜星空的通透）。
 *   · 26 m 起雾 ⇒ 会场本体（长桌、蛋糕、书架、NPC 都在这 15 m 内）一点不糊；
 *   · far 回到 46：与森林雾同一距离收满。树在距会场中心 70 m 才出件这件事
 *     不影响观感 —— 人只要**走出会场**（离中心 > 62 m），相机周围 40 m 内
 *     就是满密度的森林（z ≈ -70 起），此时用的是森林雾那一套，不是会场雾。
 *   · 中间有一版抬到 96 是为了让「站在会场中心望出去」能看穿到 70 m 外的树，
 *     但那等于把会场月夜星空的通透感也一起糊掉，且用户要的是「走过去能看到」，
 *     不是「站在会场里能远眺」——所以退回 46。 */
const VENUE_FOG_NEAR = 26;
const VENUE_FOG_FAR = 46 * FOG_FAR_4B;
/* 预先建好 Color 对象：`lerp` 每帧都要用，别在 useFrame 里 new（GC 抖动）。
 * `FOREST_FOG_COLOR_OBJ` 是**每帧写入**的最终色（白天基色 ↔ 夜间色的插值结果）。 */
const FOREST_FOG_DAY_OBJ = new THREE.Color(FOREST_FOG_COLOR);
const FOREST_FOG_NIGHT_OBJ = new THREE.Color(FOREST_FOG_NIGHT);
const FOREST_FOG_COLOR_OBJ = new THREE.Color();

/* ── 贴地白雾（groundFog.ts）的 URL 开关 ─────────────────────────────
 * `GF_INNER` = 40 正好是草地圆盘半径 ⇒ 圈内绝对清晰。
 * `GF_OUTER` = 70 在地形盘半宽（80）以内 ⇒ 化在雾里之前地平线还在。
 * ⚠️ `?ffog` 管的是**原有线性雾**的 far 倍率，跟这套无关，别混。
 * ★ `GF_TOP` 曾用 5.5：62 m 外**所有低于 5.5 m 的东西**（= 全部树干）被白雾
 *   整个刷掉，出图只剩树冠团浮在雾上（T3_eye 验收翻车原因）。2.5 = 只盖
 *   「地面 + 膝盖以下」，树干从膝高起完整露出，远景依然有雾墙遮秃地。 */
/* ★★ 2026-10-23 第九轮（用户 m02119「把这个贴地白雾关掉」）：缺省改成 **0 = 关**。
 *   要回到白雾墙行为：`?gf=1`（浓度 `?gfden=`、标高 `?gfh=`、最大占比 `?gfmax=`）。
 * ⚠️⚠️ 关掉它的同时**不能**把 `updateGroundFog()` 一起停掉（见下方 useFrame）：
 *   那个函数除了推雾参数，还每帧写 `GCOLOR = GROUND_FOG_COLOR`，而后者是
 *   `Terrain.tsx` 里「40 m 外地面压色」的**目标色**。只 gate `scene.fogNode`
 *   的挂载、仍然照常推进 uniform，否则 `GCOLOR` 会冻在缺省 `#2e4a5a`。
 *   挂了 `scene.fogNode` 时线性雾（`scene.fog`）会被 three 的 `getFogNode()`
 *   短路掉（`return scene.fogNode || ...`），所以两者只有一个生效。 */
const GF_ON = QNUM('gf', 0)!;
/* ═══ 2026-10-19 第三次重写：从「圆环 + 硬天花板」改成**指数高度雾** ═══
 * 用户 m03988：「雾又变成蓝色条带了。为啥要么白的发亮，要么看不见，
 * 就做不出朦胧感么？」—— 根因在 `shaders/groundFog.ts` 的形状：
 * 旧的是 `smoothstep(40, 62, 水平距离) × smoothstep(0, 2.5 m, 离地高度)`，
 * 两个硬边叠起来必然是「一圈边界 + 一个天花板」= 一条颜色均一的带子。
 * 现在换成光学厚度 τ = ρ·d·exp(-h/H) 的指数形式（照 three.js 官方
 * `exponentialHeightFogFactor()` 的思路，见 groundFog.ts 文件头），
 * **全程连续、没有边界**，并且 fmax < 1 保证远处轮廓永远透出来。
 *
 *   `?gfden=`  ρ（1/m）  ：0.009 ⇒ 45 m ≈ 34%、90 m ≈ 55%、130 m ≈ 71%
 *   `?gfh=`    H（m）    ：雾的标高，越大雾铺得越高（7 时 5 m 高处还剩 49%）
 *   `?gfmax=`  最大占比  ：0.85 ⇒ 永远留 15% 可见度
 *   `?gf=0`    整个关掉  */
const GF_DENSITY = QNUM('gfden', 0.028)!;
const GF_HEIGHT = QNUM('gfh', 8.0)!;
const GF_MAX = QNUM('gfmax', 0.92)!;
/* ═══ ★★★ 2026-10-19 用户反馈「雾白得过头，更像白雾而不是雾」★★★ ═══
 *
 * 先说结论：**地平线上那条刺眼的白带就是这一项**（不是 `scene.fog`）。
 * `groundFog.ts` 把「超出草地刷新范围的一圈」和「远景大气项」都朝 `GCOLOR` 混色，
 * 而这里原来写死 `#ffffff`、强度 1.0 ⇒ 62 m 以外满屏是**纯白**。
 * 之前用户 m08820 要的确实是「白色贴地雾」，但那是在**只看会场近处**时提的；
 * 一旦镜头拉宽（`venue_wide` 机位）它就读成一条白墙。
 *
 * 改法：雾色**跟时段走**，一次 `copy/lerp`，不分配：
 *   · 白天（dayness=1）→ `#c8d8de`（很淡的蓝灰，像被日光打亮的雾）
 *   · 夜里（dayness=0）→ `#2e4a5a`（深蓝青，比夜空亮一档、比树影暗一档，
 *     所以既盖得住裸地，又能透出远处轮廓）
 * `?gfcol=` 仍然覆盖**白天基色**（夜间色照旧自动压下来，保持「深夜不白」这条底线）。
 * ⚠️ 不要改回纯白：白雾在夜里没有「雾的体积」，只有一层白纱。 */
const GF_COLOR = QCOL('gfcol', '#c8d8de')!;
const GF_NIGHT_COLOR = '#2e4a5a';
const GF_DAY_OBJ = new THREE.Color(GF_COLOR);
const GF_NIGHT_OBJ = new THREE.Color(GF_NIGHT_COLOR);
/* 每帧写入的实际雾色（复用同一个对象，符合「useFrame 里不分配」的铁律）。 */
const GF_MIST_OBJ = new THREE.Color();
/** 高处那一档雾色（= 地平线色 × 0.62），每帧写入，复用同一个对象。 */
const GF_MIST_TOP_OBJ = new THREE.Color();
/* m09580 新增的**远景大气项**（`scene.fogNode` 会顶替线性雾，必须自己补回来）。
 * `GF_DTOP` = 这一项生效的高度上限，超出它的高度（天、月亮）不受影响。
 *
 * ═══ ★★★ 2026-10-17 缺陷①「远处树冠发白」的真凶就是这里 ★★★ ═══
 * 用户 m00002 的反馈图里，远处几棵树是**刺眼的纯白球**，近处树是正常的蓝。
 * 用 `_tools\ab_stat.py` 做分带像素统计（判据：`min(r,g,b)>110 且 max−min<35`）：
 *
 *   变体                 树冠区白像素%   地平雾带亮度   天空亮度
 *   缺省（DTOP=14）          1.29          91.0         29.5
 *   `?gfd=0`（关远景项）     0.37          90.9         23.8   ← 树冠干净了
 *   `?gfdtop=4&gfd=0.5`      0.38          90.9         24.0   ← 同上，且保住雾带
 *   `?gf=0`（关整片雾）      0.20          63.4         26.8   ← 雾带没了（不可接受）
 *
 * 读法：`?gfd=0` 只把**树冠**洗白（1.29→0.37），**地平雾带亮度一点没动**
 * （91.0→90.9）⇒ 刷白树冠的是**远景大气项**，不是贴地雾那一支。
 * 原因：`hFade2 = smoothstep(DTOP, 0, above)` 用 14 m 当高度上限，而本场景
 * 最高的树 `tree_a` 只有 5.4 m（×jitter 1.3 ≈ 7 m）——**整棵树都落在遮罩之内**，
 * 于是 42 m 以外的树冠拿满 `dFade = 0.8 × hFade2 ≈ 0.52~0.63`，被纯白刷掉一半。
 * 近处树在 29 m 环上（< `DNEAR=42`）所以没事，这才出现「近蓝远白」的割裂。
 *
 * ★ 用户 m00552 的硬约束：「我需要贴地雾来制造朦胧的观感以及盖住草地刷新范围外的
 *   裸漏地面。所以你可以调整但是不能删了雾」⇒ **雾整体保留**，只把远景大气项的
 *   高度上限从 14 m 收到 **4 m**（树冠之上、树干之下）、强度从 0.8 降到 **0.5**。
 *   4 m 的取舍：`tree_a` 树干 5.4 m、树冠从约 3 m 起，收到 4 m 后**树冠完全在遮罩
 *   之外**（不再被刷白），而 0~4 m 这一层仍有距离雾 —— 远景地面照旧有朦胧景深，
 *   贴地雾墙（`GF_TOP=2.5` 那一支）分毫未动。
 *   ⚠️ 别再把它调回 10 m 以上：只要遮罩盖住树冠，白球树就会回来。 */
const GF_DSTRENGTH = QNUM('gfd', 0.5)!;
const GF_DTOP = QNUM('gfdtop', 4.0)!;

/** 会场中心（宴会长桌那一带）—— 会场道具整组剔除用的圆心。 */
const VENUE_GATE_X = 0;
const VENUE_GATE_Z = -6;
/** 三艘「月船」的落点（`CRATERS[0]` 圆心）—— 整组剔除用的圆心。 */
const SHIP_GATE_X = CRATERS[0].x;
const SHIP_GATE_Z = CRATERS[0].z;

/**
 * ★★ task-15：给整棵子树挂「相机距离超过 `R_VIS` 就不提交绘制」的开关。
 *
 * 为什么不改各组件内部：船（`WingShipApi` 26.9 MB GLB / 499,834 三角）、
 * 会场道具（`VenuePropsReal`）各自已经有自己的 `visible` 语义
 * （`?wapi=0` / `?ship=1` / `?props=0` / 阶段门控），在**挂载层**加一层
 * 只会额外隐藏、不会反向打开 ⇒ 不动它们的内部逻辑，也不和别处的开关打架。
 *
 * 判据的唯一真值在 `core/world/visRadius.ts`（`R_VIS` / `?visr=`），本组件只是消费者。
 */
function VisGate({ x, z, enabled = true, children }: {
    x: number; z: number; enabled?: boolean; children: React.ReactNode;
}) {
    const ref = useRef<THREE.Group>(null);
    useVisGate(ref, x, z, enabled);
    return <group ref={ref}>{children}</group>;
}

export function WorldController() {
    const setActiveTargets = useGameStore((state) => state.setActiveTargets);
    const setComponentReady = useGameStore((state) => state.setComponentReady);
    const { scene, camera } = useThree();

    /* 一个常驻的**线性** Fog 对象，每帧只改它的 color / near / far（不重建，避免 GC）；
     * `FOG_ON = 0` 时把 `scene.fog` 摘掉 —— 让 three 走「无雾」那条着色分支。 */
    const fog = useMemo(() => new THREE.Fog(0x0d1522, VENUE_FOG_NEAR, VENUE_FOG_FAR), []);
    useEffect(() => {
        return () => {
            if (scene.fog === fog) scene.fog = null;
        };
    }, [scene, fog]);

    const debugMode = new URLSearchParams(window.location.search).get('debug') === 'true';

    // Enable eruda console only in debug mode (?debug=true)
    useEffect(() => {
        if (!debugMode) return;

        let cancelled = false;

        (async () => {
            try {
                const mod = await import('eruda');
                if (cancelled) return;
                const eruda: any = (mod as any).default ?? mod;
                if (typeof eruda.init === 'function') {
                    eruda.init();
                }
            } catch (e) {
                console.error('Failed to initialize eruda', e);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [debugMode]);

    const { enableEnv, enableGrass, enableGrassDebug } = useControls('Game.Content', {
        enableEnv: { value: true, label: 'Environment' },
        enableGrass: { value: true, label: '🌿 Grass Field' },
        enableGrassDebug: { value: false, label: '🌿 Grass Culling Debug' },
    }, { collapsed: true });


    const { timeScale, globalHue } = useControls('Game.System', {
        timeScale: { value: 1.0, min: 0.0, max: 2.0, label: 'Game Speed' },
        globalHue: { value: 0.0, min: 0.0, max: 1.0, label: 'Global Hue' },
    });

    const [windParams] = useControls('Game.Wind', () => ({
        windDirX: { value: 1, min: -1, max: 1, step: 0.01 },
        windDirZ: { value: -0.8, min: -1, max: 1, step: 0.01 },
        windSpeed: { value: uWindSpeed.value, min: 0, max: 3, step: 0.01 },
        windStrength: { value: uWindStrength.value, min: 0, max: 10, step: 0.01 },
        windScale: { value: uWindScale.value, min: 0.01, max: 1, step: 0.01 },
        windFacing: { value: uWindFacing.value, min: 0.0, max: 1.0, step: 0.01 },
    }), { collapsed: true });

    const [terrainParams] = useControls('Game.Terrain', () => ({
        amplitude: { value: SKY_MODE !== 'fe' ? VENUE.terrainAmp : uTerrainAmp.value, min: 0.1, max: 3.0, step: 0.1 },
        frequency: { value: uTerrainFreq.value, min: 0.01, max: 0.1, step: 0.01 },
        seed: { value: uTerrainSeed.value, min: 0.0, max: 100.0, step: 0.1 },
        color: { value: '#000000' },
    }), { collapsed: true });

    useEffect(() => {
        uWindDir.value.set(...(OVR_WINDDIR ?? [windParams.windDirX, windParams.windDirZ]));
        uWindScale.value = windParams.windScale;
        uWindSpeed.value = OVR_WINDSPEED ?? windParams.windSpeed;
        uWindStrength.value = OVR_WINDSTR ?? windParams.windStrength;
        uWindFacing.value = windParams.windFacing;
    }, [windParams]);

    useEffect(() => {
        uTerrainAmp.value = OVR_AMP ?? terrainParams.amplitude;
        uTerrainFreq.value = OVR_FREQ ?? terrainParams.frequency;
        uTerrainSeed.value = OVR_TSEED ?? terrainParams.seed;
        const c = new THREE.Color(OVR_TCOL ?? (SKY_MODE !== 'fe' ? VENUE.ground : terrainParams.color));
        uTerrainColor.value.set(c.r, c.g, c.b);
    }, [terrainParams]);

    useEffect(() => {
        const targets: string[] = [];
        if (enableGrass) targets.push('grass');
        setActiveTargets(targets);
    }, [enableGrass, setActiveTargets]);

    useFrame((_state, rawDelta) => {
        const delta = Math.min(rawDelta, 0.1);
        uGlobalHueShift.value = OVR_HUE ?? globalHue;
        const speed = OVR_TSPEED ?? timeScale;

        // ?tfreeze=<秒>：把世界时间钉死（风、草浪、太阳角度全部定格），
        // 这样两张截图才是同一时刻的同一场景 —— 判据 A（冻结时间再比对）在 WebGPU 线的落点。
        if (T_FREEZE === null) {
            uTime.value += delta * speed;
            uDeltaTime.value = delta * speed;
        } else {
            uTime.value = T_FREEZE;
            uDeltaTime.value = 0;
        }

        /* ★ 区域雾：线性雾的三根参数（color / near / far）在「会场」与「森林」之间按
         * `forestWeight(相机位置)` 插值；月球是真空，把 far 推到天上（等于没有雾）。
         * 见文件上方 `FOREST_FOG_*` 的长注释（用户 m01915 要求「草地刷新范围之外全是雾」）。 */
        /* ★ 推时钟（幂等）。`SkyClock.advance(now)` 内部用 `_lastStamp` 去重，同一帧
         * 调几次都只推一次，所以这里和 `DirectionalLight.tsx:130` 都调是安全的。
         * 之前全项目只有 DirectionalLight 调 ⇒ 本组件的 useFrame 若先执行（挂载更早，
         * 事实如此），`SkyClock.current` 读到的就是**上一帧**的 hour（`get current` 返回
         * `_lastHour`，而 `_lastHour` 在 `advance()` 里才更新）。差值 1 帧、视觉无感，
         * 但「每帧读到的太阳相位永远慢一帧」会让 `?tfreeze` 定格截图与光照对不齐。 */
        SkyClock.advance(_state.clock.elapsedTime);

        const sky = sunStateFor(SkyClock.current);
        const wr = regionWeights(camera.position.x, camera.position.z);
        const wf = forestWeight(camera.position.x, camera.position.z);
        /* ★ 2026-10-19：雾色跟时段走（`1 - dayness` = 夜权重）。
         * 深夜里雾是**深蓝/青**的薄雾，白天才是亮的；一套常量做不到两件事，
         * 所以每帧在这里插值一次（`copy/lerp` 不分配对象）。 */
        const nightMix = 1 - sky.dayness;
        FOREST_FOG_COLOR_OBJ.copy(FOREST_FOG_DAY_OBJ).lerp(FOREST_FOG_NIGHT_OBJ, nightMix);
        fog.color.copy(sky.fogColor).lerp(FOREST_FOG_COLOR_OBJ, wf);
        /* ⚠️ near 取 `lerp`、far 取 `lerp`，**不要**写成 `mix(near, far)` 那种把两者混起来的写法：
         *     线性雾靠 (far - near) 的跨度决定「雾墙」的厚度，两个参数必须各自插值。 */
        fog.near = VENUE_FOG_NEAR + (FOREST_FOG_NEAR - VENUE_FOG_NEAR) * wf;
        fog.far = VENUE_FOG_FAR + (FOREST_FOG_FAR - VENUE_FOG_FAR) * wf;
        // 月球：真空。far 推到 1e9 ⇒ smoothstep 恒为 0。
        if (wr.moon > 0.001) fog.far = fog.far + 1e9 * wr.moon;
        if (FOG_ON > 0) {
            if (scene.fog !== fog) scene.fog = fog;
        } else if (scene.fog === fog) {
            scene.fog = null;
        }

        /* ★★ 贴地白雾（用户 m08820：「雾改成白色，只贴住地面，盖住草地刷新范围之外。浓一些。」）
         *
         * 挂在 `scene.fogNode`（three r182 的正式钩子，见 `shaders/groundFog.ts` 的长注释）。
         * 它**优先于**上面那个线性 `scene.fog` 的类型分支 —— 两者会叠加，所以上面的
         * 线性雾负责「远处朦胧的景深」，这里的贴地雾负责「草地刷新范围之外那一圈贴地白雾」。
         *
         * ⚠️ `GINNER` 取草地圆盘半径（40 m）⇒ **刷新范围内一点雾都不加**，满足
         *    「刷新范围内清晰、之外是雾」。
         * ⚠️ 地面高度基准取**相机脚下的地形高度**（`worldHeightCPU`），不能取 y=0：
         *    地形本身有 ±5 m 起伏，用绝对 0 会让低洼处整片是雾。
         * ⚠️ 月球是真空 ⇒ 权重乘 (1 - wr.moon)。 */
        /* ★★ 2026-10-23 第九轮：**uniform 每帧照推，只有挂载受 `?gf` 控制**。
         *   理由见上面 `GF_ON` 的注释 —— `updateGroundFog()` 顺带承担
         *   「每帧把雾色写进 `GCOLOR`」，而 `GCOLOR` 是 `Terrain.tsx` 40 m 外
         *   压色的目标色。关雾却停推颜色 ⇒ 目标色冻回 `#2e4a5a`（暗蓝），
         *   40 m 外会从「雾色」变成一圈暗蓝——那是回归，不是关雾。 */
        {
            const camX = camera.position.x, camZ = camera.position.z;
            const gy = worldHeightCPU(camX, camZ);
            // 夜里换成深蓝青的雾（白天基色 ↔ 夜间色插值，见文件上方注释）
            GF_MIST_OBJ.copy(GF_DAY_OBJ).lerp(GF_NIGHT_OBJ, nightMix);
            /* 高处雾色：同一个颜色压暗到 62%。复用对象、copy+multiplyScalar，
             * 不在 useFrame 里 new（项目铁律：每帧零分配）。 */
            GF_MIST_TOP_OBJ.copy(GF_MIST_OBJ).multiplyScalar(0.62);
            /* 白天雾要**薄得多**：同样的 ρ 在亮度高的画面里会糊成一片白（实测
             * `?hour=13` 时 30 m 外的树几乎看不见）。夜里 100%、白天 45%。 */
            const dens = GF_DENSITY * (0.45 + 0.55 * nightMix);
            updateGroundFog(
                camera.position.y, gy,
                dens, GF_HEIGHT, GF_MAX,
                // 月球是真空：整片雾按月球权重压掉（关雾时 on 恒 0）
                GF_ON * (1 - wr.moon),
                GF_MIST_OBJ, GF_MIST_TOP_OBJ,
            );
        }
        if (GF_ON > 0) {
            if (scene.fogNode !== groundFogNode) scene.fogNode = groundFogNode;
        } else if (scene.fogNode === groundFogNode) {
            scene.fogNode = null;
        }
    });

    return <>
        {/* Environment - use group visibility to avoid remounting */}
        <Suspense fallback={null}>
            <group visible={enableEnv}>
                {SKY_MODE === 'day' ? <VenueSky /> : <StarrySky />}
                {/* ★ 物理大气散射天空。摆在最前面：它是一层跟着相机走的透明壳
                    （`uStarIntensity` 1 时 alpha=0 ⇒ 夜里/月球区自动透出后面的星空）。 */}
                <PhysicalSky visible={enableEnv} />
            {/* 月亮 / 光晕 / 远景星球：霜月的天是夜空，缺省就摆在星夜里 */}
            <MoonProps />
                <Terrain grassAreaSize={TERRAIN_AREA} />
                {/* ★ task-20（用户 m02364 任务5）：月坑浅水。原蓝花环（`r 15~21.5`）改成
                    一圈**贴地**的深蓝水面：顶点高度 = `worldHeightCPU + 0.30`（膝盖），
                    所以碗形坑壁、飞船落位、碰撞全都不受影响（水面只是画上去的薄片）。
                    材质/几何在 `components/water/CraterWater.tsx`，真值全部收在
                    `core/world/waterState.ts`（半径/深度/涟漪/涉水阻尼）。
                    `?craterwater=0` 关掉 ⇒ 回到 task-19 的暗蓝地面。 */}
                <CraterWater />
                {/* 会场道具：树木 / 石头 / 蘑菇 / 废墟建筑（老线摆位表 `wujien-layout.json`）
                    用 vite 的 Suspense 等它自己加载完；`?props=0` 关掉。
                    ★ 用户 m07996 第①条：树/建筑/柱子/石台换成 Poly Haven 的写实成品模型，
                    `?real=1`（缺省）走 `VenuePropsReal`，`?real=0` 退回原神那套 OBJ 做对照。 */}
                {SKY_MODE !== 'fe' && PROPS_ON && (
                    <VisGate x={VENUE_GATE_X} z={VENUE_GATE_Z} enabled={enableEnv}>
                        {REAL_ON
                            ? <VenuePropsReal visible={enableEnv} />
                            : <VenueProps visible={enableEnv} />}
                    </VisGate>
                )}

                {/* ★ 会场中央的生日宴长桌（用户 m00002）：三张 Ark 生成的实木长桌拼成
                    5.94 m 宴会桌 + 月亮主体多层生日蛋糕 + Poly Haven CC0 的零食/饮料/果盘。
                    15 个 NPC 围坐由 `NpcCrowd` 的 `?npclayout=table` 负责，第 16 席
                    （+x 端）留给缺省站在 `(0,0,-10)` 的哥伦比娅。`?banquet=0` 关掉。
                    ⚠️ 2026-10-14 起**不再直接挂在这里** —— 长桌/蛋糕/椅子的显隐由
                    `components/game/GameLayer.tsx` 按任务阶段控制（委托阶段是要收起来的）。
                    这个文件里的 `BANQUET_ON` 只作为「允许出现」的总开关转交给 GameLayer。 */}

                {/* ★ 新区域（月球 / 浅海）的散置道具：月岩 / 坑缘巨石 / 遗迹 / 礁石。
                    位置直接取 `worldHeightCPU()` 算好的 y —— 新区域的基础 FBM 被淡出到 0，
                    只剩解析式，CPU 与 GPU 逐位同式 ⇒ **精确贴地**。
                    区域是有限圆盘，所以一次性摆在世界坐标里，不需要跟相机流式加载。 */}
                {SKY_MODE !== 'fe' && <RegionProps visible={enableEnv} />}
                {/* 无主地带的无缝森林（用户 m05607 方案 B / m06230）。
                    实例化 + 以相机为中心 5×5 chunk 流式重算；`?forest=0` 可关。 */}
                {SKY_MODE !== 'fe' && <Forest visible={enableEnv} />}
            {/* ⚠️ 2026-10-11 撤掉 `<GroundMist/>`（文件保留在 `world/GroundMist.tsx`，不再挂载）。
                原因：**一块水平面在几何上做不到「贴着地面的雾」**。
                雾面的透明度只能按**它自己那片元的位置**算（`positionWorld.xz`），
                而玩家看到的是「雾面**后面**的地面」—— 射线在雾面上的交点到相机的距离是
                `D × (eyeY - mistY) / eyeY`。会场机位 eyeY=2.2 / mistY=1.15 ⇒ 交点半径只有
                `0.48 × D`：要让交点进入「起雾半径 40 m」，地面距离得 **D ≥ 84 m**，
                而雾面自己只铺到 110 m ⇒ 真正被盖住的只剩 84~110 m 一条窄带，肉眼看不见
                （出图 `MST_venue.png` 就是这样）。
                ⇒ 用户 m02206 的要求「刷新范围内清晰、范围外朦胧」用**线性场景雾**就能精确做到：
                  线性雾的 `near` 就是「起雾距离」，把它设在草地圆盘半径上，
                  40 m 内雾权为 0（完全清晰），之外随距离渐浓 —— 不需要地面雾面。 */}

                {/* ★★ task-15：三艘船**统一按相机距离剔除**（用户 10-20 反馈3：红线里圈的那艘
                    飞船从会场 196 m 外还在画，实测 499,834 三角 = 全场最贵的一件远景）。
                    缺省那艘是 `WingShipApi`（`?wapi=1`），另两个是 `?wing=1` / `?ship=1` 的备选；
                    三者落点都在 `CRATERS[0]`（(0,-196)），所以共用一个圆心。
                    站在会场（距坑 ~196 m）⇒ 完全不可见；站到坑边（< 40 m）⇒ 完整可见。
                    `?visr=0` 关判据 ⇒ 回到改前的「永远画」。 */}
                <VisGate x={SHIP_GATE_X} z={SHIP_GATE_Z} enabled={enableEnv}>
                    {SKY_MODE !== 'fe' && <WingShipApi visible={enableEnv} />}
                </VisGate>

                {/* 备选 1：手搓解析几何版（比例照 Seedream 三视图推的，细节不如上面那个真模型）。
                     默认关，`?wing=1` 调出来对照。 */}
                <VisGate x={SHIP_GATE_X} z={SHIP_GATE_Z} enabled={enableEnv}>
                    {SKY_MODE !== 'fe' && <WingShip visible={enableEnv} />}
                </VisGate>

                {/* 备选 2：原神 dump 里那艘**月牙形小舟**（`Prop_MoonShip_01`）。
                     它跟参考图那艘带翼飞船不是一回事（详见 `MoonShip.tsx` 头注释）。
                     默认关（跟上面同坑会打架），`?ship=1` 调出来。 */}
                <VisGate x={SHIP_GATE_X} z={SHIP_GATE_Z} enabled={enableEnv}>
                    {SKY_MODE !== 'fe' && <MoonShip visible={enableEnv} />}
                </VisGate>
                {/* 浅海区的水面 `<SeaWater/>` 于 2026-10-11 随「删海」删除（用户 m05607）。 */}
            </group>

            {/* 哥伦比娅本体（MMD `少女.pmx`，TSL 管线）。放在 env group 外面：
                她是角色不是环境，`?mmd=0` 可关。 */}
            {MMD_ON && <MmdCharacter visible={enableEnv} />}

            {/* 原神角色群像（用户 m00002 任务）：`公用区\模型` 下 15 个角色主模型，
                一条共享 MMD TSL 管线 + 加载期烘焙的静态站姿，撒在半径 8~25 m 的环带里。
                同样放在 env group 外面（他们是角色不是环境），`?npc=0` 可关。
                细节与全部 URL 开关见 `npc/NpcCrowd.tsx` 头注释。
                ⚠️ 2026-10-14 起**不再直接挂在这里** —— 群像的站姿/坐姿两套、以及
                「委托阶段才有 / 宴会阶段才有」的时序，全部由 `components/game/GameLayer.tsx`
                用 `<NpcCrowd pose layout/>` 两个实例管。`NPC_ON` 仍然是总开关。 */}

            {/* ★★ 生日会游戏流程总控（用户 m02541 全套）：任务阶段状态机 → 决定书桌/
                信箱/采集点/站姿 NPC/坐姿 NPC/长桌蛋糕各自何时出现；同时注册全部 F 键互动
                （写邀请函 / 寄信 / 采道具 / 打招呼 / 接委托 / 交委托 / 切蛋糕）。
                挂在 env group **外面**：它管的是角色与道具的时序，跟 `?sky=` 环境开关无关。
                单独关它：`?game=0`（见 GameLayer 头注释）。 */}
            <GameLayer />

            {/* 小地图的数据源：每帧把「玩家在哪 / 朝哪 / 现在几点」写进 ui/minimapState.ts。
                自己不渲染任何东西 —— 画图那一头是 DOM 里的 `ui/MiniMap.tsx`。 */}
            <MiniMapProbe />

            {/* ★ 全局 ACES tone mapping + Bloom（用户 m02225）。
                它用 `useFrame(cb, 1)`（正 priority）**接管渲染** —— 从此 R3F 不再自动出图，
                由 `PostFX` 里那句 `pp ? pp.render() : gl.render(...)` 负责。
                放最后是习惯位（它是「屏幕后」的东西），实际执行顺序由 priority 决定。 */}
            <PostFX />

            {/* Major components - toggle visibility instead of unmounting */}
            <AsyncCompile id="grass" onReady={setComponentReady} debug={debugMode}>
                {enableGrassDebug && <GrassCullingDebug />}
                {!enableGrassDebug && <GrassWebGPU visible={enableGrass && GRASS_ON} />}
            </AsyncCompile>
        </Suspense>
    </>
}