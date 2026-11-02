/**
 * MmdCharacter —— 哥伦比娅本体（`少女.pmx`），走 MMD 管线。
 *
 * ══ 为什么不用「社区那份 MMDLoader」══
 * three 0.182 的 `node_modules/three/examples/jsm/loaders/` 里**根本没有 MMDLoader**
 * （`Test-Path` = False），`three/addons/*` 是靠 package exports 映射过去的。
 * 而社区那份 MMDLoader 的 MMD 质感（toon 渐变 / 球面贴图 / 自阴影 / 轮廓线）**全部**
 * 靠 `onBeforeCompile` 往 GLSL 里注入 shader 片段 —— 但 **WebGPU 永远不调用
 * `onBeforeCompile`**：three 的桥接只做属性浅拷贝
 * （`three/src/renderers/common/nodes/NodeLibrary.js:52-74` 的 `fromMaterial()`
 * 里 `for (const key in material) nodeMaterial[key] = material[key]`），
 * 遇到没注册的类型就 `error(...)` 然后换成裸 `NodeMaterial()`
 * （`three/src/nodes/core/NodeBuilder.js:2895-2901`）。
 * → 结果**不是报错，是静默灰模**，最难查。所以必须走纯 TSL 的实现。
 *
 * `@yohawing/three-mmd-loader@0.8.4` 的 `./webgpu` 入口满足这个条件：
 * `dist/webgpu/` 下 `onBeforeCompile|ShaderMaterial|gl_Position|gl_FragColor` 命中数为 0，
 * 材质是 `MmdTslToonNodeMaterial extends THREE.MeshToonNodeMaterial`。
 * 它的 npm tarball 自带 `mmd_anim_wasm_bg.wasm` 与 `toon01..10.bmp`，
 * **不需要** ammo.js / TGALoader / DDSLoader / fflate（本模型 15 张贴图全是 png+bmp，
 * 权重类型 `{BDEF1, BDEF2, BDEF4}` 没有 SDEF/QDEF）。
 *
 * ══ 渲染怎么接 ══
 * 本项目的画面由 `Effects.tsx` 用 `THREE.PostProcessing` 接管
 * （`useFrame(..., 1)` → `pp.outputNode` → `pp.render()`）。所以我们**不能**调
 * `pipeline.render(scene, camera)` —— 那会在 composer 之外再渲一遍，还会让
 * 自阴影 / 稀疏 morph 与合成器不同步（`dist/webgpu/pipeline.js` 的 `render()`
 * 其实就是 `prepareRender()` + 可选自阴影 pass + `renderer.render()`）。
 * 这里只调 **`prepareRender(scene)`**：它干两件事 —— 把光照 uniform 同步给 MMD 材质、
 * 跑稀疏 morph 的 compute。然后 scene 照常被 composer 渲出来。
 * 自阴影 pass 因此**整个关掉**（`selfShadowEnabled: false`）。
 *
 * 帧序：`useFrame(cb, -1)` 优先级比 Effects 的 `1` 小，先跑。
 *
 * ══ 老线抄过来的三条 ══
 *  1. 身高归一到 1.62 m（老线 `main.js:886-895` 是 1.70，那是对着老线的世界的比例；
 *     本线会场道具是同一套老线摆位表，先用 `?charh=` 可调）。
 *  2. 贴地：读包围盒 `minY` 再 `-minY*scale`（不能手填 y）。
 *  3. センター 恒定站位偏移：从 `/センター/.position` 轨道取 X/Z 均值，整只模型平移回来。
 *     **绝不能删这条轨道**（删了就没有上下起伏、腿原地甩），**也不能改轨道值**
 *     （腿 IK 目标带同样偏移，会拉变形）。见老线 `main.js:896-913`。
 *     老线的 `yawSign` 在 `rotation.y = 0` 时取 `-1`，这里照抄。
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { ThreeMmdLoader } from '@yohawing/three-mmd-loader';
// MMD Bullet 物理解算（用户 m08676 任务3(2)）：**加载器自带**的后端，走 `/physics` 子入口。
// 为什么不用社区 ammo.js / 也不用自己写布料：MMD 的衣服本来就是「刚体 + 6DOF 弹簧关节」，
// PMX 里已经带好了 573 个非静态刚体与关节，直接用原生 Bullet 解算就是最正确的做法。
// 接线细节与「为什么以前没敢开」见下面 `PHYSICS_ON` 那一段。
import {
    loadCustomBulletMmdModule,
    createCustomBulletMmdPhysicsBackend,
} from '@yohawing/three-mmd-loader/physics';
import { createMmdTslPipeline } from '@yohawing/three-mmd-loader/webgpu';
import { useGameStore } from '../../core/store/gameStore';
import { QFLAG, QNUM, QSTR, QVEC } from '../../core/utils/query';
import { SUN_REF } from '../DirectionalLight';
// 走路：直接复用参考库那套「相机相对 + 平滑」的解算器与状态
// （`路线A-webgpu\src\components\character\` 是参考库留下的，我们没删，
//   `Character.tsx` 本体不挂了，但 `solveCam` / `config` 是纯函数，正好拿来用）
import { INITIAL_PHYSICS_STATE, type PhysicsState } from '../character/config';
import { solveCam } from '../character/utils/solveCam';
import { input } from '../../core/input/controls';
// ★ 树环的位置公式（与 `VenuePropsReal.tsx` 共用同一份）—— 用户 m11046 任务3
import { treeColliders } from '../../core/venueRing';
import { treeColliderList } from '../../core/world/treeCollide';
// ★★ 用户 m01242 任务2：**脚下地面高度**。她原来被钉死在 `CHAR_POS[1]` 这个常数上，
//    走进月坑底部悬空、走上坑壁穿模、站在浅海里踩在水面上 —— 全是这一个根因。
//    `worldHeightCPU` 与 GPU 的 `getWorldHeight()` 是同一套公式的两份实现，
//    在月球/浅海区**逐位相等**（见 `core/worldRegions.ts` 文件头那段论证）。
import { worldHeightCPU, CRATERS } from '../../core/worldRegions';
import { DESK_XZ, DESK_YAW } from '../../core/game/layout';
import { DESK_HALF_X, DESK_HALF_Z } from '../../core/world/keepOut';
// ★ 用户 m02037 任务5：自动寻路的「外部期望方向」输入通道。
//   `navStep()` 只算本帧该往哪走，位移仍由下面同一段碰撞/贴地/收尾逻辑执行；
//   目标解析、卡住检测、±45° 绕行都在 `core/game/autowalk.ts` 里（那边不进
//   zustand，因为它每帧都要推进）。
import { navState, navStep, stopNav } from '../../core/game/autowalk';
/* ★ task-20：月坑浅水的涉水状态（涟漪中心 / 阻尼）。真值全在 `core/world/waterState.ts`。
   ★ 2026-10-21 反馈3：减速改成**随脚点水深插值**（`waterPaceAt`），并新增垂直沉降
   `waterSinkAt` —— 旧版是常量 `WATER_PACE`，踩到水线和走到齐小腿一样快，
   读作「水面没接住我」。两个函数都在 waterState 里，这里只读不算。 */
import { inPond, setPlayerWaterState, waterPaceAt, waterSinkAt } from '../../core/world/waterState';
// 世界时间 uniform（`?tfreeze=` 下被 WorldController 钉死成常数）。
// 用它而不是 `state.clock.elapsedTime`：墙钟在每次截图里都不一样，
// 会让「静止浮步」的上下起伏差出最多 2 cm（≈7 px），把所有 A/B 淹掉。
import { uTime } from '../../core/shaders/uniforms';
// 次级运动：头发 / 披风 / 裙摆的延迟跟随（用户 m06469 问题 2）
import {
    createSecondaryMotion, updateSecondary, resetSecondary, auditColliders, auditClash, auditHairClash, auditRod,
    measureSleeve, auditSleeveClash, measureSleevePose,
    type SecondaryRig,
} from './secondaryMotion';
// ★★ 用户 m00718 任务2：写信时要她「走到书桌前坐下 → 写完起身」。
//    任务状态是唯一真值（`writingIndex >= 0` = 信纸正开着），所以得读它。
//    ⚠️ 不用 `useGameStore2((s) => …)` 订阅：那会让这个 3400 行的组件跟着重渲，
//       而这里只需要「每帧问一句现在有没有在写信」—— `getState()` 在 `useFrame` 里读，
//       零订阅、零重渲染。
import { useGameStore2 } from '../../core/game/questStore';

/** ?tfreeze=<秒>：与 WorldController 同一语义 —— 冻结世界时间，动作也一起定格。
 *  （这里自己读一遍 URL，而不是从 WorldController import：那会形成循环 import。） */
const T_FREEZE = (() => {
    const s = new URLSearchParams(window.location.search).get('tfreeze');
    if (s === null) return null;
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
})();

/** ?plain=1 —— **纯诊断开关**：加载完后把所有 MMD 材质换成「只贴 diffuse 图」的
 *  `MeshBasicNodeMaterial`（不受光、不做 toon）。用来二分：白剪影是「贴图/UV 坏了」
 *  还是「MMD 的 colorNode 算错了」。查完就该删。 */
const PLAIN_MAT = QFLAG('plain');
/** 诊断：`?plaintex=/columbina/spa/gold.png` —— 见下方「现拉贴图」那段注释 */
const PLAIN_TEX = QSTR('plaintex');

/* ===== URL 覆盖（无头验收用）=====
 *  ?mmd=0               不加载角色
 *  ?pmx=/columbina/xxx.pmx  ?motion=/columbina/xxx.vmd
 *  ?gait=raw            用**改造前**的原始 `walk.vmd`（默认用改造后的 `walk_glide.vmd`）
 *  ?char=x,y,z          站位（米）   ?charyaw=<弧度>    ?charh=<米>
 *  ?animspeed=          动作倍速     ?rest=1 定格在初始姿势
 *  ?ctrfix=0            关掉 センター 偏移补偿
 *  ?mask=1              把眼罩**戴回去**（默认摘掉，见下面「问题 1」那段）
 *  ?lean=               走路时前倾角（度，缺省 0 = 不倾；负值反向）
 *  ?gait=glide          换成 `_tools/vmd-gait.py` 改造过的「飘步」版（缺省关）
 */

/**
 * ★ 本轮（m08676 任务3(2)）找到的**物理炸开根因**的修复。
 *
 * `node_modules/@yohawing/three-mmd-loader/dist/runtime/physics.js:341-353` 里
 * `extractMmdWorldMatricesInto()` 抽的是 **`bone.matrixWorld.elements`** —— **真·世界矩阵**；
 * 而 `runtime/core.js:481` 也是直接 `mesh.updateWorldMatrix(false, true)` 之后抽。
 * 与此同时，PMX 的**刚体 / 关节描述**（`rigidBodies[].position/size`、`joints[].translation`）
 * 一直是**模型网格单位**、以模型原点为基准。
 * ⇒ 加载器的隐含前提是「**模型摆在原点、缩放 1**，于是 `matrixWorld` == 模型空间」。
 *
 * 我们这条线给角色挂了一层 `CHAR_H / 模型高 = 1.62 / 20.52 = 0.07896` 的缩放，
 * 于是喂进物理世界的骨骼位置被缩小了 **12.66 倍**，刚体却还是原始尺寸 ——
 * Bullet 第一步就把布料推到 ±200 单位（模型才 20.5 单位高），画面表现为角色被「炸开」。
 *
 * **实测对照**（`window.__physCtx` 探针，见 `MmdCharacter` 里的后端包装）：
 *   · `?charh=20.52&char=0,0,0`（缩放 1、原点）：输出位移恒在 `-5.143 … 10.92`，逐帧只漂 0.001 —— **完全稳定**
 *   · `?charh=1.62&char=0,0,0`（缩放 0.07896、原点）：第 1 步就跳到 `-45.5 … 200.0`，之后在 ±100 振荡 —— **炸**
 *   注意**与位置无关**，纯粹是缩放。
 *
 * 修法：在 `model.update()` 期间「**假装 `root` 的父链是单位矩阵**」，
 * 手动把整棵子树算一遍，让 `bone.matrixWorld` 正好等于模型空间；跑完再 `updateWorldMatrix` 恢复。
 * `applyPhysicsOutputToSkeleton`（同文件 `physics.js:526`）只写 `bone.position` / `bone.quaternion`
 * 这两个**局部**量，所以恢复世界矩阵**不会**把物理结果冲掉。
 *
 * @param root 模型根节点（`model.root`）
 * @returns 恢复世界矩阵链的函数
 */
function pushModelSpace(root: any): () => void {
    root.updateMatrix();
    root.matrixWorld.copy(root.matrix);
    // `Object3D.traverse` 是**先父后子**的深度优先 ⇒ 走到每个节点时 `o.parent.matrixWorld` 已经算好了。
    root.traverse((o: any) => {
        if (o === root) return;
        o.updateMatrix();
        o.matrixWorld.multiplyMatrices(o.parent.matrixWorld, o.matrix);
    });
    return () => { root.updateWorldMatrix(false, true); };
}

export const MMD_ON = QNUM('mmd', 1)! > 0;
const PMX_URL = QSTR('pmx') ?? '/columbina/少女.pmx';
/**
 * ★ 缺省动作 = `mahlazer.vmd`（模型 `_motions\` 里自带的成女走路，951 帧 / 31.70 秒）。
 *
 * 为什么换成它：`walk.vmd` 签名模型名是 `十六夜咲夜`，是一份**原地走**，我们之前一直在
 * 它的姿势上叠各种正弦/关键帧曲线想做出「飘步」，被用户连续否决（m07400 / m07646
 * 「依然无任何变化」）。而 `mahlazer.vmd` 渲染出来就是**标准的正常成年女性走路**：
 * 脚跟着地 → 脚掌滚动 → 脚尖蹬离，双腿自然交替，不飘、不抽、不剪刀。
 *
 * 周期实测 = **40 帧 = 1.3333 s**（`_tools/vmd-window.py` 逐帧比对：第 0 帧 == 第 40 帧、
 * 第 20 帧 == 第 0 帧左右对调）；一个循环真正走的米数实测 ≈ **0.718 m**
 * （`_tools/foot-slide.py` 扫 `?stride=` 取支撑脚世界滑动最小的那个：
 * 0.5→0.15 / **0.7→0.03** / 0.9→0.16 / 1.1→0.32 / 1.3→0.48 m/s，那一轮用的 loopdur=1.3）
 * ⇒ 常速 ≈ **0.538 m/s**。
 */
// 2026-10-11 回滚：路线A（原神 muscle → VMD）判定失败，用户 m08938「步态回滚。你做失败了」。
// 默认回到 MiaoBox 那套。gs_*.vmd 三个文件先留在 public 里不删，要用加
// ?motion=/columbina/miao/gs_walk.vmd 仍然能切过去看。
/* ════════════════════════════════════════════════════════════════════════════
 * ★★★ 坐姿模式（`?colsit=`，缺省 **0**）—— 摆拍/演示用；游戏流程里她**全程站着**
 *
 * ⚠️ 2026-10-15：缺省已从 1 改成 **0**。理由见本节末尾「★★ 缺省为什么是 0」。
 *    下面这段历史仍然有效（它解释了「坐姿要真的成立必须关掉哪三件事」），
 *    只是不再影响缺省值。
 *
 * 用户 m00002 原话：「一张大桌子（可以围坐所有 NPC + 哥伦比娅）」。
 * 15 个 NPC 早已围坐（`NpcCrowd.tsx` 的 `?npcpose=sit` 缺省 `sit`），
 * 只有她一直站着、第 16 把椅子空着。
 *
 * ── 为什么「换上 `座る.vmd`」远远不够（这一轮踩死的老坑）───────────────
 * 光把 `?motion=` 指向 `/motion/sit_idle.vmd` 是**没用的**：实测骨骼世界坐标显示
 * `左足 → 左ひざ → 左足首` 三段**连成一条直线**（髋 0.865 → 膝 0.486 → 踝 0.094，
 * 段长 0.379 / 0.392 = 腿完全伸直），只有 `センター` 掉了 0.32 m
 * ⇒ 画面是「整个人矮了一截、腿笔直戳在地上」，不是坐着。
 *
 * 真根因是**站姿合成块**（下面 `SETTLE_ON` 那一大段）：它在她静止时每帧把
 * 腿链朝**绑定姿势（单位四元数 = 腿伸直）**做 slerp，权重一路爬到 1。
 * `座る.vmd` 的坐姿**恰恰只写在 `足ＩＫ` 的反解结果里**（FK 膝/踝轨全是 0），
 * 所以「混到绑定姿势」= 把 IK 刚解出来的屈膝**原样抹平**。
 *
 * 取证（`_tools/spec-settleab.json`，同一机位、同一 `?animt=2.5`，只差一个开关）：
 *   `?settle=1`（旧缺省）  センター 0.807 / 左ひざ 0.486 / 左足首 0.094  ← 直腿
 *   `?settle=0`            センター 0.807 / 左ひざ 0.737 / 左足首 0.384  ← 屈膝，真坐姿
 * 两条 `センター` 逐位相同 ⇒ 下沉量对，差别**全在腿**，就是站姿合成干的。
 *
 * ── 所以坐姿模式必须同时关掉三件事 ────────────────────────────────────
 *   ① `SETTLE_ON` —— 站姿合成（腿链混回绑定姿势），根因；
 *   ② `FOOTLOCK_ON` —— 接地补偿。它是按「站直后最低脚骨会下沉多少」标定的，
 *      坐姿下这套基准没有意义，会把整个人抬起来；
 *   ③ `STANCE_DEG` —— 站距外张。它是给站姿腿链加 Z 轴旋转的，坐姿下会把腿掰开。
 * 另外把播放头钉在 `座る.vmd` 的**静止坐姿段**（第 50~105 帧，实测完全静止），
 * 并按「坐着的女孩不会自己走开」把 `MOVE_ON` 缺省关掉（`?move=1` 仍可强行开）。
 *
 * `?colsit=0` 退回**逐位不变**的旧行为（走路演示线全在这条路上，别删）。
 *
 * ── ★★ 缺省为什么是 0（2026-10-15，被用户 m02724 推翻后的定版）────────────
 * 这一整套坐姿机制是上一轮按「**她也坐进第 16 把椅子**」做的（§0.10）。
 * 用户随后 m02671 → m02724 两次改口，最终定版是：
 *   「所有 NPC 是坐姿，而唯独哥伦比娅本人**没有椅子**，是**站着**的，
 *     留出的是**中央主位**给哥伦比娅切蛋糕用。」
 * ⇒ **她全程站着**，长桌 +x 端那一席是留给她的**站位**，不摆椅子
 *   （`Banquet.tsx:438` 只遍历 `seatSpots()` 的 15 席，见 `layout.CAKE_STAND_XZ`）。
 *
 * 所以缺省必须是 0：若留在 1，播放头会被钉在 `座る.vmd` 的坐姿段
 * （下面 `SIT_T` 那条分支），而生日会全流程要求玩家**操控她走遍全场**
 * （书桌写信 → 信箱投递 → 14 个 NPC 接委托 → 13 个采集点 → 主位切蛋糕）。
 * 一个「腿盘着」的人在地图上滑行，画面直接穿帮。
 *
 * ⚠️ 注意这跟 `MOVE_ON` 是**两件事**：`MOVE_ON` 管「能不能走」（缺省已改 1），
 *    `COL_SIT` 管「腿是什么姿态」。二者必须同时正确，缺一个都穿帮。
 * 摆拍需要她坐下时：`?colsit=1`（可再配 `?colsitt=55/30`、`?colsitz=-9.508`）。
 * ════════════════════════════════════════════════════════════════════════════ */
const COL_SIT = QNUM('colsit', 0)! > 0;
/** 坐姿播放头钉在哪个时刻（秒，30 fps 制）。缺省 55 帧 = `座る.vmd` 静止段的中间。 */
const SIT_T = QNUM('colsitt', 55 / 30)!;
const MOTION_URL = QSTR('motion')
    ?? (COL_SIT ? '/motion/sit_idle.vmd' : '/columbina/g5/walk_loop.vmd');

/* ══════════════════════════════════════════════════════════════════════
 * ★ 2026-10-18 用户 m00863 任务1：**写邀请函时的坐姿整套删除**。
 *
 *   原话：「坐下的动作不对。直接删了。不坐了。连写邀请函时的椅子，桌子一并删除。」
 *   上一版（m00718 任务2）在写信时用 `?lettersit` 把动作换成 `sit_seq.vmd`、
 *   让她坐到书桌前的椅子上；实测那条 VMD 自带的位移/朝向与椅子落点对不上，
 *   观感是「悬在椅子前、还偏出去一掌」，用户判定救不回来，要求整条删掉。
 *
 *   ⇒ 现在她**全程站着**写信。删掉的东西（需要时从 git 历史取）：
 *     · 本文件的坐姿状态机 `sitPhase / sitT / sitReady / sitBusy / sitActiveRef`；
 *     · 运行时换动作的封装 `switchClip`（加载器 `model.setAnimation` 本身仍支持）；
 *     · `?lettersit= / ?sitmotion= / ?sitdown= / ?situpfrom= / ?situpend= / ?sitspeed=`；
 *     · `DeskProps.tsx` 的椅子（`?deskchair= / ?chairurl= / ?chairh= / ?chairseat=`）；
 *     · `core/game/layout.ts` 的 `DESK_CHAIR_XZ / DESK_CHAIR_YAW / DESKSIT_BACK / DESKSIT_SIDE`。
 *   `public/motion/sit_seq.vmd` 保留（已无引用，留着便于将来重做）。
 *
 * ⚠️ 与 `COL_SIT`（`?colsit=1`，摆拍用，缺省 0）**无关** —— 那是「把腿摆成坐姿」的
 *    另一套机制，不参与生日会流程，本次不动。
 * ══════════════════════════════════════════════════════════════════════ */
/**
 * ★★ **MiaoBox 走路动作分享**（用户 2026-10-07 找到并提供：`公用区\走路动作240625\`）。
 *
 * 为什么这套能用，而之前的 `walk.vmd` / `mahlazer.vmd` 都不行：
 *   · 这套是**逐帧烘焙的 FK** —— `足` / `ひざ` / `足首` **每帧一个关键帧**，
 *     一个循环 44~180 帧就是 44~180 个姿态，膝盖、脚踝全是画出来的。
 *   · 之前两个是 **IK 驱动** —— `ひざ` / `足首` 全程**只有 1 帧**（绑定姿势），
 *     腿型完全靠 `足ＩＫ` 反解，所以脚踝永远保持模型自带的尖头高跟造型 ⇒ 全程点脚尖。
 *   · 配布里作者自己贴了一张图：**「IK要关」**（`重点注意，ik要关.jpg`）。
 *     因为 VMD 里**根本没有 `足ＩＫ` 轨道**，开着 IK 求解器会把腿拖回 IK 目标（绑定姿势），
 *     等于把刚烘好的 FK 全废掉 ⇒ 位移必须 `{ ik: false }`。
 *     （加载器侧：`dist/runtime/core.js` 里 `if (options?.ik !== false) this.solveIk();`）
 *
 * **周期与步幅是直接量出来的，不是猜的**：`_tools/vmd-delroot.py` 读 `グルーブ` 位移轨，
 * 剪掉每个循环的单调前进量（那就是真实步幅），剩下的原地振荡保证首尾严丝合缝。
 * 实测（都已生成 `*_loop.vmd`，文件名转成 ASCII 免得 URL 编码踩坑）：
 *   01 `01_female_loop.vmd`    44 帧 / **1.4667 s** / **1.789 m** ⇒ 1.220 m/s
 *   02 `02_sultry_loop.vmd`    41 帧 / **1.3667 s** / **1.211 m** ⇒ 0.886 m/s
 *   03 `03_male_loop.vmd`      41 帧 / **1.3667 s** / **2.020 m** ⇒ 1.478 m/s
 *   04 `04_catwalk_loop.vmd`  180 帧 / **6.0000 s** / **4.916 m** ⇒ 0.819 m/s
 *   05 `05_standard_loop.vmd`  47 帧 / **1.5667 s** / **1.990 m** ⇒ 1.270 m/s  ← **曾是缺省**
 *       ⚠️ 2026-10-16 起**缺省已换成第五版**（`/columbina/g5/walk_loop.vmd`，见下面的
 *          `G5_TABLE`）。miao 这五套全部保留，用 `?motion=/columbina/miao/…` 仍可切回。
 * 「01/02/03/05 去根后，第 0 帧与第 P 帧**所有骨骼**的四元数差都是 0.000000」——逐位闭环。
 *   用 `?motion=/columbina/miao/01_female_loop.vmd` 切别的。
 */
const MIAO_TABLE: Record<string, { loop: number; stride: number; label: string }> = {
    '01': { loop: 44 / 30, stride: 1.7894, label: '女生走路' },
    '02': { loop: 41 / 30, stride: 1.2113, label: '妖娆走路' },
    '03': { loop: 41 / 30, stride: 2.0200, label: '男生走路' },
    '04': { loop: 180 / 30, stride: 4.9163, label: '走猫步' },
    // ★ `05` 的 stride **不是**原始文件的根位移，而是「腿自己走出来的步长」。
    //
    //   原始 `05标准走路.vmd` 的根（`グルーブ`）每周期前进 25.202 单位
    //   （f0 z=0.034 → f47 z=−25.168）× 0.07895 ⇒ **1.990 m**，所以最初填了 1.9897。
    //   但脚并不听话：`_tools\slide-probe.js` 实测「支撑脚世界坐标在接地期间仍在动」，
    //   滑移量 = 0.215 × 身体速度，**三个速度（0.80/1.27/1.84 m/s）下比例完全一致**
    //   ⇒ 纯比例误差，与速度无关 ⇒ 步长填大了 21.5%。
    //   由 `脚世界速度 = v·(1 + g'/STRIDE)`、零滑移 ⇔ `g' = −STRIDE` 反解出
    //   `g' = −1.562 m/周期`（= 接地期间脚相对身体的后扫量 ÷ 接地占比
    //   = 0.733 m ÷ 0.469）⇒ **真实步长 = 1.562 m**。
    //   ⇒ 源动作本身根位移就比腿多走 21%（MMD 根位移偏快是常见现象），
    //     用根位移当步长一定会滑步；必须以「腿」为准。改成 1.562 后滑移归零。
    '05': { loop: 47 / 30, stride: 1.562, label: '标准走路' },
};
const MIAO = MIAO_TABLE[/(?:miao\/)(\d\d)_/.exec(MOTION_URL)?.[1] ?? ''] ?? null;
/**
 * ★★ **原神客户端导出的哥伦比娅专属动作**（路线 A：从本地客户端离线解出的
 * Unity AnimationClip 转成 VMD，见 `_tools/anim2vmd.py`）。
 *
 * 来源：`E:\game\Genshin Impact\...\blocks\*.blk` → AnimeStudio 解包 →
 * `_tmp_assets\as_columbina_full\AnimationClip\`（824 条 clip）→ 取具名
 * humanoid muscle 通道（139 条）× 60 fps → 按 Unity 标准换算成骨骼局部旋转
 * → 映射到 PMX 标准骨 → 写 VMD。
 *
 * 三条（都是**原速原幅度**，没有做任何「飘化」处理）：
 *   gs_walk   `..._Columbina_Replace_Walk`      2.533 s / 3.228 m ⇒ 1.274 m/s
 *   gs_idle   `..._Columbina_ZeroGravity_Idle`  5.033 s / 原地
 *   gs_float  `..._ZeroGravity_NormalFLoop`    20.033 s / 前进（漂浮动）
 *
 * ⚠️ 用 `?motion=/columbina/miao/gs_walk.vmd` 切换。
 * ⚠️ 这套是**逐帧烘焙的局部旋转**，没有 `足ＩＫ` 轨道 ⇒ 必须 `{ ik: false }`。
 */
const GS_TABLE: Record<string, { loop: number; stride: number; label: string }> = {
    // 实测（`_tools/anim2vmd.py` 打印的「根骨 Z 前后 行程」）
    'walk': { loop: 76 / 30, stride: 3.228, label: '原神·走路' },
    'idle': { loop: 151 / 30, stride: 0, label: '原神·零重力待机' },
    'float': { loop: 601 / 30, stride: 86.068, label: '原神·浮动循环' },
};
const GS = GS_TABLE[/\/gs_([a-z]+)\.vmd$/.exec(MOTION_URL)?.[1] ?? ''] ?? null;
/**
 * ★★★ **第五版步态**（用户 2026-10-15 交付的成品，`公用区\哥伦比娅步态复刻_第五版\`）。
 *
 * 从朋友给的原神实录视频（走路/冲刺，正面+侧面）自动提取：RTMW 逐帧 2D 关键点 → 以落脚
 * 「水波纹」为每一步相位零点 → 多步取中位数得一个周期 → 侧视给前后/上下、正视给左右，合成 3D。
 * 已重定向到 `少女.pmx`（骨骼名两端都是 `Columbina`，模型骨骼一样）。
 *
 * 两版腿部实现（都已拷进 web 线）：
 *   · **普通版（推荐）**：腿是 **FK 旋转**逐帧烘焙，文件首帧的 IK 关键帧把 `足ＩＫ`/`つま先ＩＫ` 关掉
 *     ⇒ 必须配 `{ ik: false }`（与 miao 那套同理）。
 *   · IK 版：腿用 `足ＩＫ` 位置/旋转驱动、IK 保持开启。两者腿部角度差 1~3°。
 *
 * **周期与步幅都是实测的**（不是照抄作者口径）：
 *   · 周期：第 0 帧与第 P 帧全骨逐位闭环 ⇒ 走路 **P=70**（差 0.000000）、冲刺 **P=65**。走路循环版
 *     840 帧 = 12 周期，冲刺循环版 910 帧 = 14 周期。
 *   · 步幅：作者给的「前进版」根位移（走路 11.515 m/周期 = 4.94 m/s、冲刺 16.609 m/周期 = 7.67 m/s）
 *     是**游戏速度**，不是腿自己走的距离 —— 哥伦比娅是「漂浮滑行」步态（每步只有约 1/4 时间脚尖
 *     点地，其余双脚离地），实测接触占比走路仅 10%、冲刺约 15%，**没有站定平台**。
 *     ⇒ 用「真位移下支撑脚世界速度过零」扫描反解：走路 **S≈3.61~3.66**（tol 0.02 取 3.61/3.66，
 *       tol 0.05 取 3.34/3.39），冲刺 **S≈2.33**（2.32 → 滑移 −0.003/+0.017；2.63 → +0.087/+0.070）。
 *     取走路 **3.63 m**、冲刺 **2.33 m**。公式自检：`脚世界速度 = v·(1 − S_true/S_used)`，
 *     走路 S=2.20 ⇒ 预测 −0.390 vs 实测 −0.392；S=4.00 ⇒ 预测 +0.056 vs 实测 +0.054。
 *     另：同一 stride 下 `?autowalk=` 翻倍则滑移也翻倍 ⇒ 证实滑移与速度成比例（纯比例误差）。
 *
 * ⚠️ 原地循环版**不含根位移**（`センター` 的 X/Z 全程恒为 0）⇒ 前进靠 `group.position` 推进，
 *    与本项目既有架构一致，原作者自己也是「跑步机拍法」（角色原地、相机/背景后移）。
 * ⚠️ `センター` 首帧 Y：走路 +0.2059、冲刺 +0.2900（网格单位）⇒ 比 miao 那套高约 0.016 m。
 * ⚠️ 没有 `グルーブ` / `腰` / `左肩` / `両目` / `つま先` / `親指` 轨道；**有** `下半身`/`上半身1`。
 * ⚠️ morph 轨道数 = 0 ⇒ `IK_OFF_MO` 绕法安全。
 * ⚠️ 原作者要求「MMD 物理重力 28、方向后倾 30°（走路）/45°（冲刺）」——那是 MMD 工程里的设置，
 *    **VMD 带不了**。本 web 线的布料走自研弹簧骨（`secondaryMotion.ts`，`?physmode=none` 缺省），
 *    等价实现见 `?secgrav=` 一族开关。
 *
 * 切换：`?motion=/columbina/g5/walk_loop.vmd`（缺省）/ `dash_loop.vmd` /
 *      `walk_loop_ik.vmd`（配 `?ik=1`）/ `dash_loop_ik.vmd` / `walk_single.vmd`（单周期 70 帧）。
 */
const G5_TABLE: Record<string, { loop: number; stride: number; label: string }> = {
    /* ★★ 2026-10-20 · 用户「ABC 全做」⇒ 缺省回到**实测零滑步**那一组。
     *
     * 步幅是量出来的，不是拍的（量法见上面 `S≈3.61~3.66` / `S≈2.33` 那两段）：
     *   · 走路：加权折叠曲线（`_tools\_g5_wstride.py`，按贴地程度加权）
     *     σ=0.015~0.02 的稳定平台给 **3.58 / 3.46 m/周期**，与扫描法的 3.61~3.66 一致
     *     ⇒ 取 **3.63**。（2026-10-19 曾按用户 m03761「每步 2.18 m」抬到 4.35，
     *       代价是触地相滑步 0.37 m/s；现在按 C 方案回到实测值。）
     *   · 冲刺：同一条加权曲线 σ=0.015~0.02 给 **2.52 m/周期**
     *     （旧值 2.33 来自更早的扫描，低估约 8%，且 2.33 会让「冲刺步幅 < 走路步幅」
     *      看起来像 bug —— 实测就是如此：这条冲刺动画腿的行程本来就比走路小，
     *      游戏里的冲刺速度靠**滑行**而不是靠腿，见 `_logs\g5s\phase2.jsonl`。）
     * ⚠️ 想回到「大步伐」只要 `?stride=4.35`；想看严格零滑步就跑缺省。 */
    walk_loop: { loop: 70 / 30, stride: 3.63, label: '第五版·走路（原地循环）' },
    dash_loop: { loop: 65 / 30, stride: 2.52, label: '第五版·冲刺（原地循环）' },
    walk_loop_ik: { loop: 70 / 30, stride: 3.63, label: '第五版·走路·IK版' },
    dash_loop_ik: { loop: 65 / 30, stride: 2.52, label: '第五版·冲刺·IK版' },
    walk_single: { loop: 70 / 30, stride: 3.63, label: '第五版·走路（单周期）' },
    walk_fwd: { loop: 70 / 30, stride: 11.5146, label: '第五版·走路·前进版' },
    dash_fwd: { loop: 65 / 30, stride: 16.6091, label: '第五版·冲刺·前进版' },
};
const G5 = G5_TABLE[/\/g5\/([a-z_]+)\.vmd$/.exec(MOTION_URL)?.[1] ?? ''] ?? null;
/**
 * **IK 开关**：缺省「MiaoBox 那套 → 关；其它 → 开」。
 * 老的两个动作（`walk.vmd` / `mahlazer.vmd`）是 IK 驱动的，关掉 IK 腿会完全不动。
 * `?ik=1` / `?ik=0` 可以强制覆盖（做对照实验用）。
 * 第五版两套：普通版（FK 烘焙）→ 关；`*_ik.vmd`（`足ＩＫ` 驱动）→ 开。
 */
const G5_IK_VERSION = /\/g5\/[a-z_]*_ik\.vmd$/.test(MOTION_URL);
const IK_ON = QNUM('ik', MIAO || GS || (G5 && !G5_IK_VERSION) ? 0 : 1)! > 0;
/**
 * ★★★ **`?ik=0` 曾经完全无效**（2026-10 定位到加载器内部的真 bug），这个常量是绕过去的钥匙。
 *
 * 根因（`@yohawing/three-mmd-loader@0.8.4` 的 `dist/runtime/mmdAnimRuntime.js`）：
 *   · `:192` 有 `parsedTrackRuntime` 时走 JS 解释器，**会把 `options` 传下去** ⇒ `ik:false` 有效；
 *   · `:197-210` 传了 `morphOverrides` 时走 `evaluateClipFrameWithMorphOverrides(..., options?.ik !== false)` ⇒ `ik:false` 也有效；
 *   · ★ 但 `:211-213` 的兜底分支 `else if (this.wasmClip) { this.evaluateWasmClipFrame(...) }`
 *     最终落到 `:536-546` 的 `evaluateWasmClipFrame()` —— 它**压根不看 `options`**，
 *     永远调 WASM 的 `evaluateClipFrame()`（内建 IK 恒开，用 `ikTolerance` 默认 1e-2）。
 *   ⇒ 我们平时的调用（无 morph overrides）永远走这条，`{ ik: false }` 被静默丢弃，
 *     WASM 的 IK 把左右踝钉死在**静止的** `左足ＩＫ`/`右足ＩＫ` 世界坐标上
 *     ⇒ 大腿/膝盖在摆、脚却纹丝不动（脚底以行走速度在地上滑）。
 *
 * 绕法：**故意塞一个非空 `morphOverrides`**，把执行逼进 `:203` 那条线，
 * 于是 `options.ik === false` 终于被读进去。
 * 安全性：`05_standard_loop.vmd` 与 `01_female_loop.vmd` 的 **morph 轨道数都是 0**
 * （`vmd-dump.py` 实测），把 morph 0 的权重钉成 0 不会盖掉任何表情动画。
 */
const IK_OFF_MO = { indices: new Int32Array([0]), weights: new Float32Array([0]) };
/** 把 `ik` 开关变成加载器真正认得的 `update()` 选项。 */
function ikOpts(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return IK_ON ? { ik: true, ...extra } : { ik: false, morphOverrides: IK_OFF_MO, ...extra };
}
/* ★ 坐姿下她的缺省站位要**往前挪 0.49 m**，否则她坐在椅子后面（悬空）。
 *
 * 实测（`_tools/spec-colchair.json` 的骨骼世界坐标探针）：
 *   · 第 16 把椅子 `banquet_chair_15` 在 **z = −9.881**
 *     （= `SEAT_INFO().columbina` 的 −10.0005 再按 `CHAIR_BACK = −0.12` 朝桌心挪）
 *   · 对照组 furina：`センター` z = −4.17669，她的椅子 z = −4.177 ⇒ **严丝合缝**
 *     （`NpcCrowd` 烘焙时只保留根链的 Y，X/Z 用绑定位置，所以 NPC 的 `センター` 就落在席位点上）
 *   · 而 `MmdCharacter` 走的是**逐帧 update**，`座る.vmd` 的 `センター` 位移轨整份生效，
 *     坐姿相对 root 把 `センター` **往后退 0.373 m**（站立时该差值是 **+0.038 m**）：
 *        `?char=0,0,-10.0` ⇒ センター −10.373  (Δ −0.373)
 *        `?char=0,0,-9.60` ⇒ センター  −9.973  (Δ −0.373)
 *        `?char=0,0,-9.40` ⇒ センター  −9.773  (Δ −0.373)
 *     三点线性、偏差恒定 ⇒ 要让 `センター` 落在椅心 −9.881，root 就得放在
 *     **−9.881 + 0.373 = −9.508**。
 * 站立模式仍用老的 −10（`?char=` 显式给了就一律以它为准）。 */
const SIT_CHAR_Z = QNUM('colsitz', -9.508)!;
const CHAR_POS = QVEC('char', COL_SIT ? [0, 0, SIT_CHAR_Z] : [0, 0, -10]) as [number, number, number];
const CHAR_YAW = QNUM('charyaw', 0)!;
const CHAR_H = QNUM('charh', 1.62)!;
/**
 * **整体倍速**（缺省 1）：只乘**前进速度**，动画会被相位自动带快。
 *
 * 支撑脚零滑的充要条件（推导见文件头「步态」那节）：
 *     `STRIDE × ANIM_SPEED = D_true × LOOP_DUR / C_true`
 * 注意式子里**没有 `v`** —— 也就是说**速度是自由变量**：把 `WALK_SPEED` 调大，
 * 相位推进随之变快、动画也就播得更快，而脚底依然不滑。
 * 所以「想让她走快一点」直接调 `?pace=`（或 `?walkspeed=`）就行；
 * 真正会破坏锁定的只有 `?stride=` 和 `?animspeed=` 这两个数。
 */
/**
 * ★ 步幅倍率（用户 m09585：「鉴于场地较大，可以让她走快点。就是姿态不变，
 *   但是移动距离长一些」）。
 *
 * `PACE` 同时乘进 `WALK_SPEED` / `RUN_SPEED` / `GAIT_CAP`，**唯独不动 `STRIDE`**。
 * 这一点很关键：
 *   · `STRIDE = 1.9897 m` 是**从动画本身量出来的**（`walk.vmd` 一个循环里
 *     支撑脚相对地面走过的距离）。地面速度 ÷ STRIDE = 步频。
 *   · 把 `PACE` 调大 ⇒ 地面速度和步频**同步**变大，`dist/STRIDE` 与
 *     `g.position` 推进同一个倍数 ⇒ **脚底依然零滑动，姿态逐位不变**，
 *     只是「走得快」。
 *   · 反过来去调 `?stride=` ⇒ 一个循环要求的位移 ≠ 动画给的位移
 *     ⇒ **立刻脚滑**（这是之前量到「滑动 0.84 m/s」的那个坑）。
 * ⇒ 想让她更快，**永远调 `?pace=`，不要调 `?stride=`**。
 * 缺省 1 ⇒ 1.270 m/s（`?pace=1.45` ⇒ 1.84 m/s，接近人类快走）。
 */
/* ★ 2026-10-20（「ABC 全做」的 C 项）：缺省回到 **1.45**。
 *   `PACE` 就是**动画播放倍速**，乘进 `WALK_SPEED`/`RUN_SPEED`/`GAIT_CAP`，不动 `STRIDE`
 *   ⇒ 改它**不会**产生滑步，只是「腿倒得快一点/慢一点」。
 *   1.45 ⇒ 一个整圈 2.3333/1.45 = **1.61 s**（原片是 2.33 s，`?pace=1` 可完全对齐原片）；
 *   常速 = 3.63/2.3333×1.45 = **2.256 m/s**（零滑步）。
 *   2026-10-19 曾为「移动距离增加」把它降到 1.20 再乘 `wspd=1.25`，那组现在只在
 *   `?pace=1.20&wspd=1.25` 里还能复现（滑步 0.56 m/s）。
 *
 * ═══ ★★★ 第二十轮（2026-10-26，用户 m01984 的第 2 条，改法由用户指定）══════════
 * 「哥伦比娅步态动作比较慢，滞空（换腿/飘）时间长，但移动距离远。」
 * 补充澄清：「踩地那一下是略快的（目前的速度），但是滞空（空中换腿）的动作是慢的，
 *   所以滞空时间才会长。」
 *
 * **第十九轮试过「相位弯折」（`?gaitwarpl=`）来做非均匀放慢，实测无效并被用户否掉
 *   （「步态无变化」）。本轮按用户给的替代方案落地：**不做非均匀，整体放慢。**
 *   用户原话：「既然 `?pace=`/`?stride=` 都是均匀缩放，做不到『踩地保持现状、只放慢滞空』，
 *   那就整体放慢。动画放慢但是移动距离拉长，也可以做到滞空增加。」**
 *
 * 为什么这条方案在数学上成立（两个量**正交**，可以各调各的）：
 *   · 步频（腿多久倒一次）= `PACE / CYCLE_SEC` —— 只由 `PACE` 决定；
 *   · 单步距离 = `STRIDE / 2` —— 只由 `STRIDE` 决定；
 *   · 地面速度 = 两者之积 = `STRIDE / CYCLE_SEC × PACE`（= `WALK_SPEED`）。
 *   ⇒ 把 `PACE` 调小 = 动画整体放慢（滞空自然变长，因为整圈变长）；
 *     把 `STRIDE` 调大 = 每步走得更远。
 *   ⚠️ 代价（必须写明）：`STRIDE` 与动画自身的真实步幅不再相等 ⇒ **支撑相有滑步**。
 *      这是用户指定的方向（他要「滞空久 + 每步远」），想要零滑步回 `?stride=3.63&pace=1.45`。
 *
 * 本轮缺省（`CYCLE_SEC = 70/30 = 2.3333 s`）：
 *   |            | STRIDE | PACE | 单步米数 | 单步秒数 | 地面速度 | 步频     |
 *   | 改前（零滑步）| 3.63  | 1.45 | 1.815   | 0.805    | 2.256    | 0.621 步/s |
 *   | **改后**    | **6.00** | **0.80** | **3.000** | **1.458** | 2.057 | 0.343 步/s |
 *   ⇒ 单步时间 **×1.81**（滞空明显变长）、单步距离 **×1.65**（走得更远），
 *     地面速度只降 9%（2.256 → 2.057 m/s），所以「慢」的是动作不是赶路。
 */
const PACE = QNUM('pace', 0.80)!;
const ANIM_SPEED = QNUM('animspeed', 1)!;
const REST_POSE = QNUM('rest', 0)! > 0;
const CTRFIX = QNUM('ctrfix', 1)! > 0;

/* ===== 走路（WASD）=====
 *  ⚠⚠ 走路有两条**实测出来的**硬事实，不照这两条做就一定复现用户报的那两个毛病：
 *
 *  ① **整段里有 31.5 圈**。`_tools/vmd-dump.py` 读出 `walk.vmd` 的
 *     `metadata.maxFrame = 1145`（38.17 秒），而 `@yohawing/three-mmd-loader` 的
 *     `update(seconds)` 收**绝对秒数**，越界时**不报错、不回绕**，直接把姿态
 *     **静默钳死在最后一帧**（`src/runtime/animation.ts` 的
 *     `readPackedBoneFrameInto(track, previousIndex, frames[previousIndex] ?? 0, target)`）。
 *     ⇒ 播放头只要是自己一直累加，播到 1145 帧就会 **腿不动、身体继续平移**。
 *
 *  ② **真正的循环长度 = 32 帧 = 1.0667 秒**。`_tools/vmd-cycle2.py` 对 `左足ＩＫ` 的
 *     Z 分量做自相关，峰值在 32 帧（相关 0.954），64/96 帧只是它的 2×/3× 谐波；
 *     整段 1010 帧 = 31.56 圈。⇒ 拿整段取模 = 31 圈连播 = **步子又多又碎**。
 *
 *  ⇒ 所以播放头**不再自己累加**，改由「已走距离 ÷ 步长」反推
 *     （这正是 Unreal 论坛讲 root motion 的做法，也是原神自己的定义：
 *       `移速 = 步长 ÷ 动画周期`，提速靠缩短周期而不是加大步幅）：
 *
 *       dist     += 有效速度 × dt
 *       相位      = (dist / stride) mod 1
 *       animTime  = 相位 × loopDur        ← 数值上恒在 [0, loopDur) 内 ⇒ **结构上不可能越界**
 *       group.translateZ(有效速度 × dt)   ← 唯一的位移源（VMD 是原地走，センター 净推进 0.0000）
 *
 *     这样「脚走过的地面」和「身体前进的距离」被同一个变量锁死：
 *     碎步（动画比位移快）与滑行（动画停了人还在走）**同时消失**。
 *
 *  ?move=0        关掉键盘控制（摆拍用）
 *  ?walkspeed=    常速（m/s。缺省 = 步长 ÷ 循环时长 ⇒ 动画正好 1.0 倍速，脚不离地）
 *  ?runspeed=     疾跑（m/s，Shift）
 *  ?stride=       一个循环走过去的地面距离（米）。缺省 0.76 —— 由 VMD 自己实测：
 *                 `左足ＩＫ` 的 Z 行程 −8.542..+1.055 网格单位 × 0.0789 m/单位 ≈ 0.76 m。
 *  ?loopdur=      循环时长（秒，缺省 32/30 = 1.0667，见上面②）
 *  ?gaitmax=      步频上限（倍，缺省 2.0）。超过这个倍速腿就追不上地面了；
 *                 宁可「极限速度下轻微滑步」，也不要「腿转成风火轮」。
 *  ?idlecreep=    站着不动时播放头的蠕动倍率（缺省 0.06 —— 抄老线 `main.js:1978`
 *                 的 `basin = 0.06`；她是浮空角色，极慢的原地浮步正合适。设 0 = 完全定格）
 *  ?animspeed=    动画速度总倍率（缺省 1，调试用；≠1 会破坏「脚不离地」）
 *  ?bobamp=       站定时上下浮动幅度（米，缺省 0.02）
 *
 * ★★ 2026-10-15 修正：这里原本是 `QNUM('move', COL_SIT ? 0 : 1)` —— **缺省被坐姿带成了 0**。
 * 那条推理（「坐着的女孩不会自己走开」）只对**纯摆拍场景**成立；
 * 生日会全流程里玩家要**自己操控哥伦比娅走遍全场**（去书桌写信、去信箱投递、
 * 去 14 个 NPC 处接委托、去 13 个采集点、最后走到主位切蛋糕），
 * 键盘一关整个游戏就没法玩了 —— 实测第二轮出图时她是钉在原地的。
 * ⇒ 缺省一律 **1**；只有明确要摆拍时才 `?move=0`。
 * （`COL_SIT` 只该管**腿的姿态**，不该管**能不能走**。）
 */
const MOVE_ON = QNUM('move', 1)! > 0;
/**
 * **无头诊断专用：绕过输入系统，直接以一个固定速度一直往前走**（米/秒）。
 *
 * 为什么必须开这个口子：headless 里给 window 派发 `KeyboardEvent` 并不可靠
 * （实测 `keydown` 确实到了 window，但 `CameraViewControl` 的
 * `setControlEnabled(true)` 依赖 `resetCamera()` 的 promise，时序对不上，
 * 于是 `solveCam` 永远不跑、人永远不动）。要量「支撑脚在世界里滑不滑」
 * 就必须让她真的走起来，所以这里直接给一个不经过输入系统的驱动。
 * **只在诊断时用**：`?autowalk=1.4`、`?autowalk=1.0` …
 */
const AUTOWALK = QNUM('autowalk', 0)!;
/**
 * **无头诊断专用：原地走** —— 和 `?autowalk=` 一起用。
 *
 * 播放头照常按 `?autowalk=` 的速度推进（动画真的在走），但**不做 `group` 位移**。
 * 这样角色留在原地，相机不用追，可以做「同一姿态、只差布料」的逐像素 A/B：
 *   两张图如果骨架相位完全相同、只有像素差，那差值就**只**来自布料/头发。
 * 不加这个开关时，两次截图之间人会走掉一两米，A/B 会被位移污染。
 */
const HOLD = QFLAG('hold', false);
/**
 * 自动寻路时的**转向角速度**（弧度/秒）。6 rad/s ≈ 344°/s：
 * 大约 0.5 s 掉头 180°，既不生硬（一帧直接掰过去）也不至于绕大圈。
 * 只有自动寻路用；手动控制仍走 `solveCam` 的插值。
 */
const NAV_TURN = 6;
const _fwdDir = new THREE.Vector3();
/** 站姿接地补偿用的两个临时向量（踝的世界坐标），每帧复用，不在循环里 new */
const _ankL = new THREE.Vector3();
/** 诊断探针 `secTail` 读骨尾世界坐标用的临时量（每帧复用） */
const _vTip = new THREE.Vector3();
/**
 * **一个完整循环里她从脚下走过多少米**（两个单步）。
 *
 * ★ 这里以前写的是 0.76 —— 那是**一个单步**的脚行程，被当成了**整圈**。
 *   后果：动画的相位推进比地面快了整整一倍，因此
 *   「腿倒得飞快、地面却慢慢挪」⇒ 肉眼就是「迈小碎步 + 抽搐」。
 *   这正是用户 m06286 问题 1 的根因（不是动作文件不好，是我们喂给它的
 *   速度不对）。
 *
 * 实测（`_tools\vmd-period.py` + `_tools\vmd-dump.py`，`walk.vmd`）：
 *   - 取 `左足ＩＫ` / `右足ＩＫ` 的位移轨，Z 行程
 *       左 1.055 − (−8.542) = 9.597 网格单位
 *       右 1.051 − (−8.283) = 9.334 网格单位
 *     均值 9.466 单位 × 0.0789 m/单位（= 1.62 m / 20.52 单位）= **0.747 m / 单步**
 *   - 关键帧序列的重复周期 = 8 个关键帧 = **32 帧**（1.0667 s），也就是
 *     「左足支撑 → 右足支撑」各走一步 ⇒ 整圈 2 步 = **1.494 m**
 *   - 于是她这条动作自带的真实步速 = 1.494 / 1.0667 = **1.40 m/s**
 *
 * ⚠️ 但那套推导只适用于**旧的 `walk.vmd`**，而它做出来的步态一直不对
 *   （用户 m07400 / m07646 连续否决）。现在缺省动作换成 `mahlazer.vmd`，
 *   下面的 0.70 是在**新动作**上重新实测出来的，两套数不要混用：
 *
 *   `mahlazer.vmd`（951 帧 / 31.70 s，周期 **40 帧 = 1.3333 s**）扫 `?stride=`：
 *     0.5 → 脚滑中位 0.15 m/s
 *     **0.7 → 脚滑中位 0.03 m/s**   ← 谷底
 *     0.9 → 0.16 / 1.1 → 0.32 / 1.3 → 0.48
 *   ⇒ 一个循环真正走的米数 **D = 0.70 × 1.3333 ÷ 1.300 = 0.718 m**
 *     （那一轮扫描用的是 `loopdur=1.3`；换成正确的 1.3333 之后同一条零滑条件
 *      要求 `STRIDE = 0.718`），常速 0.718 / 1.3333 = **0.538 m/s**。
 *   旁证：`左足ＩＫ` 的 Z 行程 = 4.730 网格单位 × 0.0789 m/单位 = 0.373 m/步，
 *         两步 0.747 m —— 与 0.718 m 吻合到 4% 以内。
 *   （量法：`_tools/foot-sampler.js` 采 `左足ＩＫ` 世界坐标，`_tools/foot-slide.py`
 *     只取「脚处于纵向最低 45%」的支撑相，算它在世界里的水平速度。）
 */
/* ★★ 2026-10-19 用户 m03761 第 4 条：「增加走路移动距离，减慢步伐动画速度」。
 *
 *    这两个要求**在本项目原本的锁步模型里是同一件事的两面** ——
 *    步频 = `PACE / CYCLE_SEC`（因为地面速度是从步长反推的），所以：
 *      · 想「步幅更大」 ⇒ 调大 `STRIDE`；
 *      · 想「腿倒得更慢」 ⇒ 调小 `PACE`。
 *    两者一起动，就是用户要的效果：
 *      旧：STRIDE 0.718 / PACE 1.45 ⇒ 0.80 m/s，腿 1.115 圈/秒（每步 0.359 m）
 *      新：STRIDE 0.950 / PACE 1.25 ⇒ 0.91 m/s，腿 0.962 圈/秒（每步 0.475 m）
 *    ⇒ 每步距离 +32%、腿的节奏 −14%、地面速度 +14%。
 *
 *    ⚠️ **代价说清楚**：这条动画本身一个循环只走 0.718 m（`STRIDE` 的注释里有量法）。
 *      现在让它一个循环走 0.95 m，支撑脚在触地相会**滑行约 0.29 m/s**。
 *      这是「步幅变大」在固定动作素材上必然的代价 —— 以前为了消灭滑步，把
 *      步幅锁死在 0.718、靠加快节奏来提速，结果就是用户说的「迈小碎步」。
 *      现在反过来取舍：宁可轻微滑步，也要动作看着是正常的大步。
 *      想回到零滑步：`?stride=0.718&pace=1.45`。 */
/* ★★★ 第二十轮（2026-10-26）步幅倍率：缺省 **6.00 / 3.63 = 1.653**。
 *  ❗ 为什么用**倍率**而不是直接改 `G5_TABLE` 里的 `stride`：表里那个数是
 *     「这段 VMD 自己一个循环真实走多少米」的**素材实测值**（`vmd-dump` 量出来的），
 *     是事实，不该被调参污染 —— 而且 `dash_loop` / `*_ik` / `*_fwd` 都共用同一套读法。
 *     所以保留表、在缺省取值处乘一个倍率：改的是「我们让它一个循环走多远」，
 *     不是「它本来能走多远」。`?stride=` 显式给值时仍然**直接覆盖**（倍率不参与）。
 *  理由与配平见 `PACE` 上方第二十轮那段注释：`STRIDE` 只决定「每步多远」，
 *  与 `PACE`（每步多快）正交 ⇒ 两者一起调就是用户要的「动作放慢 + 距离拉长」。
 *  ⚠️ 放大了 1.653× ⇒ 支撑相滑步同比例放大。这是用户指定的取舍；
 *     零滑步回滚：`?stride=3.63&pace=1.45`。
 *  ⚠️ `GAIT_CAP` 会跟着 `STRIDE` 一起放大（见下方定义），所以本改动不会把
 *     「相位推进」钳住 —— 那才是「腿倒不过来、脚底打滑」的真凶。 */
const STRIDE_K = QNUM('stridek', 1.653)!;
/* ★★★ 第二十轮（2026-10-26）步幅倍率：缺省 **6.00**（改前 3.63 = 零滑步基线）。
 *  理由与配平见 `PACE` 上方第二十轮那段注释：`STRIDE` 只决定「每步多远」，
 *  与 `PACE`（每步多快）正交 ⇒ 两者一起调就是用户要的「动作放慢 + 距离拉长」。
 *  ⚠️ `STRIDE 6.00` ≠ 这段 VMD 的真实步幅 ⇒ 支撑相滑步按 6.00/3.63 = **1.65×** 放大。
 *     这是用户明确指定的取舍；零滑步回滚：`?stride=3.63&pace=1.45`。
 *  ⚠️ `GAIT_CAP` 会跟着 `STRIDE` 一起放大（见下方定义），所以本改动不会把
 *     「相位推进」钳住 —— 那才是「腿倒不过来、脚底打滑」的真凶。 */
const STRIDE = QNUM('stride', (MIAO ? MIAO.stride : GS ? GS.stride : G5 ? G5.stride : 3.63) * STRIDE_K)!;
/**
 * **播放头窗口**（秒）：这段 VMD 里一个循环占多少秒 —— 实测 **40 帧 @30fps = 1.3333 s**。
 * 怎么测的（`_tools\vmd-window.py`，比自相关靠谱得多）：把 `左足ＩＫ` / `右足ＩＫ` 的
 * 位移轨按帧插值出来逐帧打印，**第 0 帧和第 40 帧每个分量完全相同**、第 20 帧是
 * 左右对调 ⇒ 单脚周期 20 帧（一步），整圈 40 帧（两步）。
 * ⚠️ `_tools\vmd-cycle2.py` 的自相关给的是 39 帧 —— **差这一帧会让窗口每圈少放一帧**，
 *    所以以逐帧法为准。
 * ⚠️ 它**不代表真实世界里的循环时长**，那个是下面的 `CYCLE_SEC`。
 */
const LOOP_DUR = QNUM('loopdur', MIAO ? MIAO.loop : GS ? GS.loop : G5 ? G5.loop : 40 / 30)!;
/**
 * ★★ **真实世界里走完一个完整循环（两步）要几秒** —— 用户 m07189 给了实机侧面录像后定的。
 *
 * 素材：`公用区\参考视频\走路——侧面.mp4`（**原神官方锁 60 帧**，容器标 120 是假的，
 * ffprobe 的 `avg_frame_rate = 43425000/723997 ≈ 60.0`、`duration = 16.089 s`、965 帧）。
 *
 * **她这条步态的形状**（用户 m07189 原话）：
 *     单脚蹬地 → 飘 → 空中换腿 → 另一只脚蹬地 → 飘 → 空中换腿。**走和跑都是**。
 *   ⇒ 所以**没有双支撑相**；脚下那圈蓝色涟漪 = **蹬地那一下**，**一圈 = 一步**。
 *
 * 实测（`_logs\side_rgb.raw` / `side_hi.raw`，60 fps，对她做静背景抠图后跟踪）：
 *   - 蹬地相关的四个信号主频**全都是 0.870~0.876 Hz**：
 *       腿张合 |前脚 x − 后脚 x|、上下起伏（脚底 y）、左右摆（质心 x）、前脚相对身体 x
 *   - 涟漪圈出现的时刻（帧号）120 → 190 → 260 → 330 ⇒ **每隔 1.167 s 一次**
 *   两条独立证据一致 ⇒ **单步 ≈ 1.15 s，整循环（两步）≈ 2.30 s**。
 *
 * ⚠️ 而我们原来让 `LOOP_DUR` **同时**扮演「播放头窗口」和「真实循环时长」两个角色，
 *    于是整圈只花 1.0667 s —— 比她的真实步频**快了 2.15 倍**。腿倒得飞快、地面只挪半步，
 *    正是用户 m06286 说的「迈小碎步 + 抽搐」，也是 m06469 问题 4「走路姿态不对」。
 *    ⇒ 播放头仍然恒在 `[0, LOOP_DUR)` 内（结构上不会被加载器钳死），
 *      但同样的 1.0667 s 动作现在被**拉长到 2.30 s** 播完 ⇒ 0.464× 慢放。
 *
 * ⚠️ 上面那套 0.870 Hz / 2.30 s 是**原神实机**的节奏，只对「飘步」路线有意义。
 *    换成 `mahlazer.vmd` 之后，缺省直接取 `LOOP_DUR`（1.30 s = 新动作自己的周期），
 *    于是动画正好 **1.0 倍速**播放、一个循环走 0.70 m ⇒ 常速 **0.538 m/s**。
 *    想更快**不要**改这个数（改了就等于用 `?walkspeed=` 破坏脚底锁定），
 *    要快应该整体调 `?animspeed=`，或另找一份更快的动作。
 */
const CYCLE_SEC = QNUM('cyclesec', LOOP_DUR)!;
/** 常速缺省 = 一个整圈的位移 ÷ 真实用时 ⇒ 支撑脚与地面**零滑动**（0.538 m/s） */
/* ═══ 2026-10-19 用户 m03988 第二条 ═══
 * 「移动动画不变，但是移动距离增加。」
 * ⇒ **不动 STRIDE / PACE**（那两个一改，腿的节奏和步幅全变），只在地面速度上乘
 *    一个增益。动画播放倍速仍然是 PACE，所以腿看起来和刚才一模一样，
 *    但同样时间里走过更远的地面距离。
 * ⚠️ 代价诚实记录：动画的真实步幅是 STRIDE=4.35，地面速度提到 2.80 m/s 之后，
 *    触地相滑步从 0.37 m/s 涨到约 0.56 m/s。想回到完全无滑步：
 *    `?stride=3.63&pace=1.45&wspd=1`；只想微调：`?wspd=1.4`。
 *
 * ★★ 2026-10-20「ABC 全做」：缺省改回 **1.0**（零滑步），上面这套「乘增益换距离」
 *    降级成 `?wspd=1.25` 的可选项。理由：触地相的滑步是肉眼可见的「脚底下抹油」，
 *    而 `PACE` 1.45 已经把常速抬到 2.256 m/s，够用了。 */
const SPEED_GAIN = QNUM('wspd', 1.0)!;
const WALK_SPEED = QNUM('walkspeed', (STRIDE / CYCLE_SEC) * PACE * SPEED_GAIN)!;
/* 冲刺：2026-10-20 用户要求**整段停用**（「冲刺删了，连带冲刺功能一起停，按冲刺键不起作用，
 *  回头我重做冲刺动画再说」）。
 *  做法：`core/input/controls.ts` 不再把 Shift 映射成 `Run`；这里把跑步速度直接等于走路速度，
 *  即使有别的路径按到 `Run` 也只走走路速度 —— 不会出现「跑不如走」，也不会换动作。 */
const RUN_SPEED = QNUM('runspeed', WALK_SPEED)!;
const GAIT_MAX = QNUM('gaitmax', 2.0)!;
/**
 * 相位推进的封顶速度：超过它就不再把速度换算成步频（宁可轻微滑步，也不要风火轮）。
 * ⚠️ **必须跟着 `PACE` 一起放大**，否则 `?pace=3` 时速度超过封顶、
 *    相位推进被钳住而身体照走，脚底立刻打滑（实测 pace3.5 时滑动 0.84 m/s
 *    中位，刚好等于「前进 1.89 − 封顶 1.077」）。
 */
const GAIT_CAP = ((STRIDE * GAIT_MAX) / CYCLE_SEC) * PACE * SPEED_GAIN;
const IDLE_CREEP = QNUM('idlecreep', 0.06)!;
const BOB_AMP = QNUM('bobamp', 0.02)!;

/* ── ★ 松开方向键时「把最后一步走完」（用户 m09585 任务2）───────────────────
 *  用户原话：「任意时刻停止按 WASD 方向键应把最后一步走完，回到站立姿态，
 *             目前是停在哪个姿态就哪个姿态，哪怕是走路的两腿分叉姿势也会停在那」。
 *
 *  旧行为：`moving` 立刻掉到 0 ⇒ 播放头推进速度变成 `IDLE_CREEP × WALK_SPEED`
 *  （0.06 × 1.99 ≈ 0.12 m/s），于是她**几乎原地冻在当前相位** ——
 *  如果那一刻正好是「两腿分叉的接地相」，就永久摆着一个劈叉姿势。
 *
 *  新行为：检测到输入归零时，记下「本步走完」的目标累计距离
 *  （下一个相位 == `?standph=` 的位置），然后**继续按走路速度把剩下的路走完**，
 *  最后把播放头精确钉在站立相位上再交还给静止逻辑。
 *
 *    ?landing=0   关掉收尾（回到旧行为，A/B 对照用）
 *    ?standph=    站立相位（0..1，缺省 **0.553**，= `05_standard` 第 26 帧）。
 *                 ★ 缺省值 0.25 是**错的**：那是在「加载器 IK bug 把脚钉死」的年代定的，
 *                   当时每个相位看上去都「双脚并拢」。修掉 IK 之后用离线 FK
 *                   （`_tools\fk-stand.py`）逐帧重量 47 个相位，得到这张表（单位 cm）：
 *                     f   相位     踝间距   左踝高   右踝高   两踝高差
 *                     12  0.255    73.8     17.4     23.1      5.7   ← 旧缺省，两腿劈开
 *                     23  0.489     6.7      0.1      6.9      6.2
 *                     24  0.511    11.0      0.3      5.1      4.2
 *                     25  0.532    20.0      0.7      3.8      2.5
 *                 ★   26  0.553    29.7      1.2      3.1      1.3   ← 新缺省
 *                     27  0.574    38.8      1.8      3.2      1.4
 *                   「站立」的判据是**两脚都贴地**（两踝高差最小 + 两者都尽量低），
 *                   f26 同时拿下「两踝高差最小 1.3 cm」和「两踝总高最低」两项 ⇒ 选它。
 *                   脚下距离 30 cm 是自然的放松站姿；f23/f24 虽然更拢，但一只脚悬空 5~7 cm。
 *                 ⚠️ 这个动作**没有真正的双脚同时落地帧**（左踝接地 f20–f25、右踝接地
 *                   f44–f2，两个窗口不相交），所以「站立」只能取上面这个折中。
 *                   若要做到「两只脚完全踩平」，需要自己写一段 2 骨腿 IK 做落地校正。
 *                 ★★ **第五版（g5）另重定**：缺省改成 **0.500**。用相位折叠曲线
 *                   （`_tools\g5phase.js` 的 100 箱 → `_tools\_g5_analyze.py`）扫全部相位，
 *                   两脚「前后间距」最小的就是相位 0.500（sep=0.0009 m）与 0.000（0.0027 m），
 *                   其余相位都在 0.3~0.8 m。取 0.500 而不是 0.000 是因为它离取模回绕边界更远。
 *                   （第五版是漂浮滑行步态，同样没有双支撑相 —— 接触占比实测走路仅 10%。）
 *    ?landmin=    收尾阶段的速度下限（× WALK_SPEED，缺省 0.35），
 *                 防止「最后 5 厘米磨 3 秒」。
 */
const LAND_ON = QNUM('landing', 1)! > 0;
const STAND_PH = ((QNUM('standph', G5 ? 0.5 : 0.553)! % 1) + 1) % 1;
/* ★ 2026-10-19：0.35 → 0.75。收尾那一步如果还按 35% 常速去走，视觉上就是
 *   「人都停下来了，她还在小碎步蹭半米」。提到 75% 之后是一步干脆地踏住。 */
const LAND_MIN = QNUM('landmin', 0.75)!;
/** ★ 收尾完成后**冻住播放头**（缺省开）。
 *  不冻的话，`IDLE_CREEP`（0.06 × WALK_SPEED ≈ 0.11 m/s）会继续推进 `dist`，
 *  8 秒就把相位漂走 0.09 个周期 —— 也就是「明明站住了，姿势却在慢慢变成迈步」。
 *  用户 m09585 任务2 要的是「回到站立姿态」，所以收尾一完成就钉死。 */
const LAND_HOLD = QNUM('landhold', 1)! > 0;
/** ★★ `?landold=1` **复现**旧版本的收尾判据（用户 m11046 任务1 的 bug）。
 *  旧写法是 `else if (inputSpeed <= 0.05) … if (prevSpeed > 0.10)`，
 *  并且减速段每帧 `prevSpeed.current = inputSpeed`。
 *  真机上它**永远不会触发**（详见 `useFrame` 里那段根因注释）。
 *  留这个开关是为了留一份可复跑的反证：用 `_tools\realkey-probe.js` 走**真实键盘事件**，
 *  `?landold=1` 应当量到 `everLanded=false / landTargetSeen=0`，
 *  缺省（修复后）应当量到 `everLanded=true / finalPhase=0.553 / tailPhaseSpread=0`。 */
const LAND_OLD = QFLAG('landold', false);

/* ════════════════════════════════════════════════════════════════════════════
 * ★★ 站定姿势合成（用户 m11917 任务1）
 *
 * 用户原话（连提两轮）：「松开 WASD 后走完最后一步、站定 ——还是那样没变」。
 *
 * ── 为什么上一版「挑最不劈腿的相位」没用 ─────────────────────────────────
 * `?standph=0.553`（f26）是离线 FK 扫出来的「两踝高度差最小」的那一帧，
 * 数字上是对的（踝距从 74 cm 缩到 29.6 cm，且精确落在该相位上）。
 * 但**这条 VMD 里根本没有任何「双脚同时落地」的帧**：
 *     左踝接地 f20–f25、右踝接地 f44–f2  —— 两个窗口不相交。
 * 于是**每一个相位都是迈步姿势**，只是劈得开不开的区别。
 * 29.6 cm 的踝距对 1.6 m 的角色仍是明显叉开的「停在半路上」的姿势 ——
 * 这正是用户 m09585 的原话「哪怕是走路的两腿分叉姿势也会停在那」。
 * ⇒ 结论：**「回到站立姿态」不可能靠挑相位实现，只能靠合成。**
 *
 * ── 做法 ───────────────────────────────────────────────────────────────
 * 收尾结束后，在 `SETTLE_SEC` 内把**腿链**（足 / ひざ / 足首 / つま先）的局部
 * 四元数 slerp 向**绑定姿势**（= 单位四元数 —— MMD 骨没有静止旋转，所以
 * identity 就是「直腿站姿」，高跟那 +42.1° 的俯角已经建在 足首→つま先 的
 * 绑定关系里，不需要另算）。脊柱 / 手臂 / 头发**仍走动画姿态**，
 * 否则整个人会变成绑定姿势的 A-pose。
 *
 * `?settle=0`        关掉合成，回到「停在 `STAND_PH` 那一帧」（做 A/B 用）
 * `?settlesec=0.45`  合成时长（秒）
 * `?footlock=0`      关掉接地补偿
 *
 * ── 接地补偿（`?footlock=`，缺省开）────────────────────────────────────
 * 直腿以后骨盆高度没变 ⇒ 脚会往下走，人陷进地面。做法是在第一帧**试算一次**：
 * 把腿链临时摆成绑定姿势、重算这几根骨的世界矩阵、读出两踝世界 y 的较小者，
 * 那就是「站直之后脚会到的高度」。之后每帧把那个量钉住（改 `g.position.y`）。
 * 这也顺带修掉老遗留项「落地后右脚离地约 3.1 cm」。
 */
/* ★ 坐姿模式下这三项缺省关掉，理由见文件上方「坐姿模式」大注释：
 *   `settle` 是**根因**（把 IK 解出的屈膝混回绑定姿势 = 腿伸直），
 *   `footlock` 是按站姿标定的接地补偿（坐姿下基准无意义），
 *   `stance` 是站距外张（坐姿下会把腿掰开）。
 *   显式写 `?settle=1&footlock=1&stance=3` 仍可强行开回来做对照。 */
const SETTLE_ON = QNUM('settle', COL_SIT ? 0 : 1)! > 0;
const SETTLE_SEC = Math.max(0.02, QNUM('settlesec', 0.45)!);
const FOOTLOCK_ON = QNUM('footlock', COL_SIT ? 0 : 1)! > 0;
/** ★ 静态取证开关：一上来就当「已经收尾完成」，于是站姿合成立刻开始跑。
 *  纯粹为了能在 `?tfreeze=1` 的定格出图里看站姿 —— 否则定格路径下
 *  永远进不了 `LAND_ON && landRef > 0` 的收尾完成分支。
 *  用法：`?settleforce=1` 对 `?settle=0`，同一机位、同一 `animt`，只看腿。 */
const SETTLE_FORCE = QFLAG('settleforce', false);
/** ★★ 「一进页面就站直」（用户 m11917 任务1 的补充根治）。
 *
 *  **实测到的真问题**：站姿合成原本只在「走过一次、收尾完成」之后才生效
 *  （进入条件里要求 `landDone.current`）。于是**刚打开页面、还没按过任何键**时，
 *  站立姿势直接就是动画时钟当前所在的**迈步姿势** —— 裸 URL 上量到
 *  **两踝间距 72.1 cm**（走路叉开约 30 cm、站定约 5 cm），而且相位还在缓慢漂移
 *  （空闲时有 `IDLE_CREEP` 的漂移量在推进 `dist`），所以**每次刷新站姿都不一样**。
 *
 *  打开这一项以后，只要「没在移动」（`moving <= 0.05`）且还没进过收尾流程，
 *  站姿合成块也会跑 —— 而 `settleT` 的初值本来就是 1（= 混合权重拉满），
 *  所以**首帧就是站直的**，不需要 0.45 s 过渡。
 *  开始按 WASD 时 `moving > 0.05`，这个块自动让位给走路动画。
 *  `?idlestand=0` 可以退回旧行为。 */
const IDLE_STAND_ON = QNUM('idlestand', 1)! > 0;
/** ★ 站姿合成是否连 `D`（变形）骨一起混。
 *
 *  缺省 1（正确）—— 这个 PMX 的腿顶点蒙皮绑在 `左足D/左ひざD/左足首D/左足先EX` 上，
 *  只混普通骨等于没改（详见建链处的长注释）。`?settled=0` 留着当**对照**：
 *  它复现「读数说 0°、画面还是迈步」的老 bug，用来证明这一项确实是那件事的根因。 */
const SETTLE_D = QNUM('settled', 1)! > 0;

/* ════════════════════════════════════════════════════════════════════════════
 * ★★★ 上半身的**站姿目标**从哪来（`?armpose=`）—— 用户 m13541 真机截图的根因
 *
 * 用户原话：「出现BUG，看图，这是停止前进后的姿势。手是不往前伸了。
 *             但是往两侧伸就对吗？」
 *   ⇒ `SETTLE_SCOPE` 把手臂混到**绑定姿势**是对的（手确实不往前伸了），
 *     但**这个模型的绑定姿势是 T-pose** —— 手臂本来就是水平张开的造型
 *     （PMX 只有 position/parentIndex，没有静止旋转字段 ⇒
 *      `identity` 就是绑定姿势，而绑定的造型就是张开手臂做的蒙皮）。
 *   ⇒ 于是「混到绑定」= 把手摊成 T 字，比迈步姿势更不像站着。
 *
 * ★ 站姿的**正确目标不能靠手调欧拉角**（MMD 骨的局部轴朝哪、腕捩/手捩的
 *  分层，全靠猜；而且换模型就废）。这里用**模型自己的数据**：
 *   把整条循环动画在 8 个相位上均匀采样，逐骨求**平均四元数**（nlerp）。
 *   走路时手臂前后摆动是**同一个周期上的正负半波**，平均必然互相抵消
 *   ⇒ 得到「手臂自然垂下、肘微屈」的中立姿势，正是人站着的样子。
 *   （腿链**不能**这么干：腿的平均值是两腿劈开的一半 ⇒ 仍然是迈步，
 *     所以腿链照旧混绑定姿势，那里绑定姿势就是「笔直站立」。）
 *
 *   0 = 绑定姿势（T-pose，**用户已否定**，留作对照）
 *   1 = 循环动画的平均四元数（缺省，正确）
 *   2 = 循环起点的原始动画值（手向前伸的老行为，仅对照）
 */
const ARM_POSE = QNUM('armpose', 1)!;
/** 采样相位数（`?armsamples=`）：越多摆动抵消得越干净，代价 = 建链那一帧多调几次
 *  `model.update()`（纯 WASM 求值，8 次实测无感）。 */
const ARM_SAMPLES = Math.max(2, Math.min(24, Math.round(QNUM('armsamples', 8)!)));

/* ════════════════════════════════════════════════════════════════════════════
 * ★★ 站定合成的范围（`?settlescope=`）
 *
 * 用户 m13249 原话：「这是侧面视角。侧面视角，停下的时候，**同时看到两条腿，
 * 两只脚**，正常？」—— 侧视里站直的人两腿应当前后重叠成一条轮廓，看见两条腿
 * 就是迈步。同一条消息里还写了「手向前伸出」⇒ 只把**腿链**混到绑定姿势不够，
 * 上半身还停在动画相位（迈步时手臂前摆），所以「停下来」看起来仍是走路。
 *
 *   0 = 只混腿链（老行为，`?settlescope=0`）
 *   1 = 腿链 + 下半身/上半身/首/頭 + 肩·腕·ひじ·手首 全臂链（缺省）
 *
 * 不混的东西（**故意**）：
 *   · 根骨 `グルーブ/センター` —— 它们带**位置轨**，混成绑定会把 Y 位移抹掉
 *     （脚会浮起来），位置本来就该跟着动画走。
 *   · 二次动力（布料/头发）那 573 根 —— 混成绑定等于把飘动删掉，
 *     与用户 m11046 任务2「衣服头发摆动」冲突。它们在 `updateSecondary` 里
 *     已经算过，本块跑在它**之后**，所以只要不碰它们就不会被覆盖。
 *   · IK 骨 / 足ＩＫ / ダミー / 腰キャンセル —— 不参与蒙皮，混了没用还可能反噬。
 * ════════════════════════════════════════════════════════════════════════════ */
const SETTLE_SCOPE = QNUM('settlescope', 1)!;

/** 上半身骨名**前缀**表（比全名列表稳：腕捩/手捩这类带编号的骨一并命中）。
 *  ★ 2026-10-17 拆成两组 —— 缺陷②「站立前倾」的修复（见 `TORSO_BIND`）。 */
const SETTLE_TORSO_PREFIX = ['下半身', '上半身', '首', '頭'];
const SETTLE_ARM_PREFIX = ['左肩', '左腕', '左ひじ', '左手', '右肩', '右腕', '右ひじ', '右手'];
const SETTLE_BODY_PREFIX = [...SETTLE_TORSO_PREFIX, ...SETTLE_ARM_PREFIX];

/* ════════════════════════════════════════════════════════════════════════════
 * ★★★ 2026-10-17 缺陷②「静止站立时身体前倾」的根因与修复（`?torsobind=`）
 *
 * 用户 m00002 反馈图：站着的时候上半身/头往前扑，不是直立。
 * 用 `_tools\lean-probe.js` 量「头—两踝中点」轴与**绑定姿势**轴的夹角：
 *
 *   变体                         lean1(°)   lean2(°)   说明
 *   缺省（`armpose=1`）           7.225     13.155    ← 前倾
 *   `?settle=0`（关站姿合成）      14.257    13.377
 *   `?settlescope=0`（只混腿）      7.231    12.926    ← 与缺省一样 ⇒ 前倾在动画里
 *   `?armpose=0`（上半身混绑定）    **0**     **0**    ← 前倾完全消失
 *
 * 根因：`ARM_POSE=1` 的「`ARM_SAMPLES` 个相位求平均四元数」对**手臂**成立
 * （前后摆是同一周期的正负半波，平均必然抵消 ⇒ 自然垂下），但 `collectBodyBones`
 * 返回的 34 根里**混着躯干链** `下半身/上半身/首/頭`，而走路动画的躯干
 * **全程都是前倾的**（第五版说明：「躯干前倾、头部角度已校准」）——
 * 前倾是个**常驻分量**，不是半波，平均之后原样留下 ⇒ 站立时前倾 7.2°/13.2°。
 *
 * 修复：躯干链的目标改成**绑定姿势**（PMX 无静止旋转字段 ⇒ `identity` 就是
 * 直立；这与腿链「混绑定 = 笔直站立」是同一条理由），**只有手臂链**才做相位平均。
 * `?torsobind=0` 可关掉（复现老 bug，用来对照）。 */
const TORSO_BIND = QNUM('torsobind', 1)! > 0;

/** 上半身站姿链的骨序（父在前）。**加载时算目标姿势、`useFrame` 里建链，都用这一份**
 *  —— 同一套筛选逻辑写两遍迟早会错位（判据：只留一处真源）。
 *  骨名要比 `userData.mmdBoneName`（原始 PMX 日文名），理由见建链处的长注释。 */
/** 骨的**原始 PMX 日文名**（加载器把英文名写进了 `bone.name`，见建链处长注释）。 */
const rawBoneName = (b: THREE.Bone) => (b.userData as { mmdBoneName?: string } | undefined)
    ?.mmdBoneName ?? b.name;

/** 是不是**躯干**链的骨（`下半身/上半身/首/頭`）。
 *  缺陷②修复用：躯干的目标是绑定姿势（直立），不能做相位平均。 */
const isTorsoBone = (b: THREE.Bone) => SETTLE_TORSO_PREFIX.some((p) => rawBoneName(b).startsWith(p));

const collectBodyBones = (bs: THREE.Bone[] | undefined): THREE.Bone[] => {
    const depthOf = (b: THREE.Bone) => {
        let n = 0; let p: THREE.Object3D | null = b.parent;
        while (p && (p as THREE.Bone).isBone) { n++; p = p.parent; }
        return n;
    };
    return (bs ?? []).filter((b) => SETTLE_BODY_PREFIX.some((p) => rawBoneName(b).startsWith(p)))
        .sort((a, b) => depthOf(a) - depthOf(b));
};

/* ════════════════════════════════════════════════════════════════════════════
 * ★★★ 站距（`?stance=`）—— 走路时两只脚不能踩在**同一条线**上
 *
 * 用户 m13752 原话：「走路姿势我跟你描述一下。就是左脚和右脚走路时是沿着同一条线
 * 上的落点前进。那么当换腿时，就不可避免两脚穿模。不应沿着同一条线」
 *
 * 这条 05 循环步态的落点确实全在 `x ≈ 0` 的独木桥上（实测：整个循环里两踝的世界
 * x 几乎相等，换腿相位甚至交叉）⇒ 两条腿像剪刀一样在同一个平面上开合，小腿/鞋
 * 必然互插。真实的人走路是**两条平行线**：每只脚向自己那侧偏 5~10 cm。
 *
 * 做法：在动画求值（`UPD(t)`）之后、站姿合成块之前，给**每条腿链最上面那根骨**
 * 的局部四元数**预乘**一个「绕父坐标系 Z 轴（= 角色朝前方向）转 ±θ」的旋转。
 *   · 预乘 = 在**父坐标系**里再转一次 ⇒ 整条腿（膝盖、脚、以及 D 变形骨子树）
 *     刚性外张，髋关节不脱位（对比：直接位移大腿骨会把髋部撕开一个口子）。
 *   · 只写**链头**：`左足D` 若是 `左足` 的后代就跳过（否则同一角度会被施加两次）。
 *     这一条按运行时父子关系判定，不依赖我猜 PMX 的层级。
 *   · 左腿 +θ 往 `+X`（模型自身的左）外张，右腿 −θ 往 `−X` 外张。
 *   · **不动权重**：站定合成块会把腿 slerp 回绑定姿势（用户已验收的站直姿势不变），
 *     外张只在**走路**时可见 —— 也正是用户要修的那个场景。
 *
 * `?stance=0` 关掉（回到独木桥）做 A/B。
 * ★ 缺省：**3**（用户 m14400 说 stance=6 叉太开；m14945 要求先应用起来走一走；m14975 定为 3）。
 *   0 = 完全不改 VMD 的步态（脚怎么落就怎么落，换腿处两腿会重叠成一条线）；
 *   实测两踝最窄侧向间距：0 为 −4.6 cm、2° 约 +2.5 cm、4° 为 +5.0 cm、6° 为 +9.7 cm。
 * ⚠️ 注释里的加粗星号紧接斜杠会被当成块注释结束符（本轮真踩过：整个文件 500、
 *   Vite 报 `Unexpected character`）。写「数字 / 数字」时别在斜杠前留两个星号。
 *   另外 `_tools/vmd-stance.py` 量过 MiaoBox 五套 VMD 各自的站距（侧向差 最小 / 最大，cm）：
 *   01 −4.5 / 11.8；02 +2.4 / 12.9（唯一自始至终不交叉的）；03 −10.4 / 8.0；
 *   04 −5.3 / 25.2（猫步）；05 −5.1 / 11.9。
 * ════════════════════════════════════════════════════════════════════════════ */
const STANCE_DEG = Math.max(0, Math.min(30, QNUM('stance', COL_SIT ? 0 : 3)!));

/* ════════════════════════════════════════════════════════════════════════════
 * ★★★ 走路时的**手臂外展**（用户 m12279/m12280 任务4）
 *
 * 用户原话：「走路时，胳膊稍微外展，不要紧贴身体。不要弄太大了
 *           （意思是外展的幅度不要太大）」。
 * ⇒ 上臂（`左腕` / `右腕`，本模型里 `左腕` 就是**上臂**，肘是 `左ひじ`，
 *   见 secondaryMotion.ts:1344 的链注释）在走路时向外张一个**小角度**。
 *
 * ★ 为什么不用 `?stance=` 那套：`stance` 只取 `左足/右足` 腿链，张的是腿。
 *   这里是另一组骨，另起一个解析器，互不干扰。
 *
 * ★ 轴与符号：与 `applyStance` 同一套几何 —— 绕 Z（角色前后轴）转，
 *   `R_z(+θ)·(0,−1,0) = (+sinθ, −cosθ, 0)` ⇒ 对 +X 侧的左臂是**向外**，
 *   所以左 `+1`、右 `−1`。两侧符号相反才会「一起向外」，同号会变成一起偏向一侧。
 *
 * ★ 幅度：缺省 **4.5°**，上限夹 12° —— 用户明确要求「不要弄太大」。
 *   实测参考：T-pose 下两腕间距 0.178 m（`?armabd=0`）；4.5° 只多张开约 1~2 cm，
 *   够「不贴身体」，又不会变成撑开的姿势。
 *
 * ★ 只在**走动**时生效（`?armabd=` 之外）：静止时手臂本来就是自然下垂，
 *   张开会显得僵。用速度做平滑权重（`armAbdT` 0→1，时间常数 ~0.25 s），
 *   起步/停下都不会突然一跳。`?armabd=0` ⇒ 整块不进，逐位回到改动前（可回滚）。
 * ════════════════════════════════════════════════════════════════════════════ */
const ARM_ARC_DEG = Math.max(0, Math.min(3, QNUM('armarc', 2)!));
const ARM_ARC_LEFT = Math.max(0, Math.min(3, QNUM('armarcleft', ARM_ARC_DEG * 1.25)!));
const ARM_ABD_DEG = Math.max(0, Math.min(12, QNUM('armabd', 4.5)!));

/** 取出「每条腿链的链头骨 + 外张符号」，父在前由调用方保证（这里顺序无所谓）。 */
const collectStanceBones = (bs: THREE.Bone[] | undefined): { bones: THREE.Bone[]; signs: number[] } => {
    const rawName = (b: THREE.Bone) => (b.userData as { mmdBoneName?: string } | undefined)
        ?.mmdBoneName ?? b.name;
    const all = bs ?? [];
    const byRaw = (n: string) => all.find((b) => rawName(b) === n || b.name === n);
    /** `a` 是不是 `b` 的祖先（用于避免对同一条链重复施加） */
    const isAncestor = (a: THREE.Bone, b: THREE.Bone) => {
        let p: THREE.Object3D | null = b.parent;
        while (p) { if (p === a) return true; p = p.parent; }
        return false;
    };
    const out: { bones: THREE.Bone[]; signs: number[] } = { bones: [], signs: [] };
    for (const [nm, sign] of [['左足', 1], ['右足', -1]] as const) {
        const b = byRaw(nm);
        if (b) { out.bones.push(b); out.signs.push(sign); }
    }
    // D 变形骨：只有在它**不是**同名链头的后代时才需要单独写（是后代就跟着转了）。
    for (const [nm, head, sign] of [['左足D', '左足', 1], ['右足D', '右足', -1]] as const) {
        const b = byRaw(nm);
        if (!b) continue;
        const h = byRaw(head);
        if (h && (h === b || isAncestor(h, b))) continue;
        out.bones.push(b); out.signs.push(sign);
    }
    return out;
};

/** ★ 任务4：取「上臂」（`左腕`/`右腕`）与符号 —— 与 `collectStanceBones` 同一风格。
 *  本模型的骨名实测：`左肩 → 左肩C → 左腕`（上臂）`→ 左ひじ`（肘）`→ 左手首`。
 *  所以「外展」要转的是 `左腕`/`右腕`，转肘或腕只管小臂。 */
const collectArmAbd = (bs: THREE.Bone[] | undefined): { bones: THREE.Bone[]; signs: number[] } => {
    const rawName = (b: THREE.Bone) => (b.userData as { mmdBoneName?: string } | undefined)
        ?.mmdBoneName ?? b.name;
    const all = bs ?? [];
    const byRaw = (n: string) => all.find((b) => rawName(b) === n || b.name === n);
    const out: { bones: THREE.Bone[]; signs: number[] } = { bones: [], signs: [] };
    for (const [nm, sign] of [['左腕', 1], ['右腕', -1]] as const) {
        const b = byRaw(nm);
        if (b) { out.bones.push(b); out.signs.push(sign); }
    }
    return out;
};

/* ════════════════════════════════════════════════════════════════════════════
 * ★★ 场景碰撞：不能穿过树木（用户 m11046 任务3）
 *
 * 用户原话：「人物走到树木模型，目前是直接穿过去的。要加入碰撞了。不能穿模。」
 *
 * 做法：树的**位置公式**已经搬到 `core/venueRing.ts`（`ringAt`/`hash01` 只留一份），
 * 这里用同一个公式复算出 26 棵树干的圆心与半径，在**位移之后**做「圆 — 圆推出」。
 *
 * ⚠️ 最容易踩的坑：播放头是「已走距离 ÷ 步长」（`dist.current`），
 *    位置被推回来之后如果还按**名义位移**推进播放头，相位就会跑到位置前面
 *    ⇒ 脚底打滑，看起来像「她顶着树原地踩步」。
 *    所以推出之后要量出**实际位移**，按 `实际/名义` 把 `moving` 一起缩掉，
 *    位移与相位天然保持一致（零滑步）。
 *
 * `?treecol=0` 关掉做 A/B；`?charr=` 角色碰撞半径（米）；`?treer=` 树干半径系数。
 * ════════════════════════════════════════════════════════════════════════════ */
const TREE_COL_ON = QNUM('treecol', 1)! > 0;
/** 角色「体积」半径（米）。她肩宽约 0.36 m ⇒ 半径 0.18；裙摆外沿再多留一点。 */
const CHAR_R = QNUM('charr', 0.30)!;
const TREE_COLS = TREE_COL_ON ? treeColliders() : [];
/* ★★ 2026-10-23（用户反馈 3）：**森林**树干碰撞单独一个开关。
 *  为什么不能复用 `TREE_COLS`：那张表是会场环那 26 棵静态树，只会场有；
 *  森林的树由 `Forest.refill()` 按相机现算，位置每 32 m 就变一次，
 *  而且在月球区一件都没有 —— 混在一张表里会让「A/B 关不掉」也「分不清是谁挡的」。
 *  表本身在 `core/world/treeCollide.ts`，`Forest.tsx` 的 `refill()` 整表重建。 */
const FOREST_COL_ON = QNUM('forestcol', 1)! > 0 && TREE_COL_ON;
/** 森林树干半径上限（米），与注册表里的 `R_MAX` 同义 —— 留给 `?forestr=` 微调。 */
const FOREST_R_SCALE = QNUM('forestr', 1)!;
/** ★★ 森林树干推出的**单元测试入口**（用户 2026-10-23 反馈 3）。
 *
 *  抽成模块级纯函数，理由与 `shipPush()` 完全相同：无头验收直接调
 *  `window.__mmd.forestPush(x,z)`，测到的是 `useFrame` 里**同一个实现**，
 *  不是复制一份逻辑；否则只能「摆个起点让她走进树里看结果」，而落点、朝向、
 *  森林 refill 时机都不可复现（`__forest.total` 在直接出生时甚至可能还没写）。
 *
 *  ⚠️ 这里同样**迭代 2 次**：两棵树挨得近时，被第一棵推到第二棵圈里要再推一次。
 *  ⚠️ 半径 = `t.r * FOREST_R_SCALE + CHAR_R` —— 与 `useFrame` 里逐字一致，
 *     改一处必须改两处（这也是抽成函数的原因之一：以后只需改这里）。
 *  返回值 `hit` 表示**是否被推过**，`dist` 是推后离最近树干的表面距离（米）。
 */
function forestPush(x: number, z: number): { x: number; z: number; hit: boolean; dist: number } {
    if (!FOREST_COL_ON) return { x, z, hit: false, dist: Infinity };
    const fc = treeColliderList();
    let cx = x, cz = z, hit = false;
    for (let it = 0; it < 2; it++) {
        for (let k = 0; k < fc.length; k++) {
            const t = fc[k];
            const rr = t.r * FOREST_R_SCALE + CHAR_R;
            const ex = cx - t.x, ez = cz - t.z;
            const dd = Math.hypot(ex, ez);
            if (dd >= rr) continue;
            if (dd < 1e-5) { cx = t.x + rr; cz = t.z; }
            else { cx = t.x + (ex / dd) * rr; cz = t.z + (ez / dd) * rr; }
            hit = true;
        }
    }
    let dist = Infinity;
    for (let k = 0; k < fc.length; k++) {
        const t = fc[k];
        dist = Math.min(dist, Math.hypot(cx - t.x, cz - t.z) - t.r);
    }
    return { x: cx, z: cz, hit, dist };
}

/* ── 飞船碰撞体（用户 m04735：「飞船穿模，没做碰撞」）──────────────────────
 *  ✖ 原来飞船**完全没有碰撞体**：她直接走进去、从翼身里穿出来，读起来像穿过一层贴图。
 *  ✔ 这里给飞船加一个**椭圆**碰撞体，用与上面树干完全相同的「推出 + 按实际位移
 *    缩播放头」手法 —— 复用同一套代码，不另起一套物理，表现才一致（挡得干脆、不滑步）。
 *
 *  几何来源：飞船长 26 m（局部 Z）· 翼展 16.5 m（局部 X），落点默认 `CRATERS[0]`，
 *  朝向 `?wyaw=-24°` —— 与 `WingShipApi.tsx:60-70` 同一套参数，两边必须一致，
 *  否则碰撞体会和船错开。
 *
 *  ⚠️ **为什么是椭圆而不是圆**：船是细长的（26 × 16.5）。用圆的话半径必须取
 *     大到 8.25 才盖得住翼展，于是船头船尾正前方 8 m 的空气也被堵死，
 *     看起来是「撞上一堵隐形的墙」；半径取小则翼尖能穿。两个半轴分开给就正好。
 *  ⚠️ 半轴比船体轮廓**略收一点**（13→12.6 / 8.25→7.6）：留出一点过渡，
 *     不让碰撞边界读起来像刀切的一堵墙。
 *  `?shipcol=0` 关掉做 A/B。
 */
const SHIP_COL_ON = QNUM('shipcol', 1)! > 0;
const SHIP_CX = QNUM('wx', CRATERS[0].x)!;
const SHIP_CZ = QNUM('wz', CRATERS[0].z)!;
const SHIP_YAW = QNUM('wyaw', -24)! * (Math.PI / 180);
const SHIP_COS = Math.cos(SHIP_YAW);
const SHIP_SIN = Math.sin(SHIP_YAW);
const SHIP_HALF_L = 12.6;   // 沿船长（局部 Z）
const SHIP_HALF_W = 7.6;    // 沿翼展（局部 X）

/**
 * ★ 飞船椭圆碰撞的**推出解**（纯函数）。
 *
 * 输入世界坐标 `(x, z)`，若落在椭圆内部就沿「归一化径向」推到椭圆边界上，
 * 返回推出后的坐标；落在外面则原样返回且 `hit = false`。
 *
 * **为什么归一化到单位圆再径向推出**：世界系里「点到椭圆边界的最近点」没有闭式解
 * （要解四次方程），而归一化之后「单位圆外一点沿径向投到圆上」就是精确解，
 * 只要一次平方根。代价是推出方向不是「最近方向」而是「径向」—— 对碰撞体来说
 * 没有区别（都是把人放到边界上），而且径向推出天然连续，不会在轴上跳变。
 *
 * ⚠️ **退化分支**：正好站在椭圆中心时 `q ≈ 0`，`1/sqrt(q)` 会把乘数放大到 1e4 量级
 *    把人弹飞到十几米外。`q < 1e-8` 时改为沿**船长方向**推到边界，乘数是常数、不发散。
 *    正常游玩走不出这种状态（逼近时是逐帧推出的），但 `?char=` 调试会。
 *
 * 抽成模块级函数是为了**可验证**：无头截图用 `window.__mmd.shipPush` 直接调它做
 * 单元测试。否则只能「摆个起点让她走进去看结果」，而落点 / 朝向 / 加载时序都不可复现
 * —— 实测 `charyaw=180` 时她朝西南 (-0.81,-0.58) 走而不是 -Z，A/B 直接失效。
 */
function shipPush(x: number, z: number): { x: number; z: number; hit: boolean } {
    if (!SHIP_COL_ON) return { x, z, hit: false };
    const wx = x - SHIP_CX, wz = z - SHIP_CZ;
    // 世界 → 飞船局部（绕 Y 旋转 `SHIP_YAW` 的逆变换）
    const lx = wx * SHIP_COS - wz * SHIP_SIN;   // 沿翼展
    const lz = wx * SHIP_SIN + wz * SHIP_COS;   // 沿船长
    const A = SHIP_HALF_W + CHAR_R;
    const B = SHIP_HALF_L + CHAR_R;
    const nx = lx / A, nz = lz / B;
    const q = nx * nx + nz * nz;
    if (q >= 1) return { x, z, hit: false };
    let lx2: number, lz2: number;
    if (q < 1e-8) { lx2 = 0; lz2 = B; }
    else { const k = 1 / Math.sqrt(q); lx2 = lx * k; lz2 = lz * k; }
    return {
        x: SHIP_CX + lx2 * SHIP_COS + lz2 * SHIP_SIN,
        z: SHIP_CZ - lx2 * SHIP_SIN + lz2 * SHIP_COS,
        hit: true,
    };
}
/* ── 月牙石桌碰撞体（用户 m02063 任务1：「石头加入碰撞」）──────────────────
 *
 *  ✖ 原来书桌换了模型之后**完全没有碰撞体**：她直接走进石头里、从月牙的凹槽
 *    里穿出来，读起来像穿一层贴图（尤其这石头 2.5 m 高，穿过去非常刺眼）。
 *  ✔ 手法与 `shipPush()` **完全一致**（旋转椭圆 + 归一化径向推出），不另起一套。
 *
 *  几何来源：`public/venue/game/moon_table.glb` 归一化 bbox `1.550 × 0.605 × 1.436`，
 *  `DeskProps.tsx` 再乘 `MOON_SCALE = 1.74` ⇒ 2.697 × 1.053 m 的占地。
 *  半轴直接读 `core/world/keepOut.ts` 的 `DESK_HALF_X / DESK_HALF_Z` —— **同一份真值**，
 *  草地避让（`grassCompute.ts`）和玩家碰撞用的是同一个椭圆，不会出现
 *  「草已经让开了、人还能走进去」这种错位。
 *
 *  ⚠️ 半轴要**加上角色半径** `CHAR_R`（0.30 m），否则她会被石头的边缘切进去半个身子：
 *     推进去的是「圆心」，而人是有限宽的。
 *  `?deskcol=0` 关掉做 A/B。
 */
const DESK_COL_ON = QNUM('deskcol', 1)! > 0;
const DESK_COS = Math.cos(DESK_YAW);
const DESK_SIN = Math.sin(DESK_YAW);

/** 月牙石桌的椭圆推出解（纯函数，同 `shipPush` 的可验证套路）。 */
function deskPush(x: number, z: number): { x: number; z: number; hit: boolean } {
    if (!DESK_COL_ON) return { x, z, hit: false };
    const wx = x - DESK_XZ[0], wz = z - DESK_XZ[1];
    // 世界 → 石桌局部（绕 Y 旋转 `DESK_YAW` 的逆变换）
    const lx = wx * DESK_COS - wz * DESK_SIN;   // 沿月牙两角的连线（2.70 m）
    const lz = wx * DESK_SIN + wz * DESK_COS;   // 沿月牙的厚度方向（1.05 m）
    const A = DESK_HALF_X + CHAR_R;
    const B = DESK_HALF_Z + CHAR_R;
    const nx = lx / A, nz = lz / B;
    const q = nx * nx + nz * nz;
    if (q >= 1) return { x, z, hit: false };
    let lx2: number, lz2: number;
    if (q < 1e-8) { lx2 = 0; lz2 = B; }
    else { const k = 1 / Math.sqrt(q); lx2 = lx * k; lz2 = lz * k; }
    return {
        x: DESK_XZ[0] + lx2 * DESK_COS + lz2 * DESK_SIN,
        z: DESK_XZ[1] - lx2 * DESK_SIN + lz2 * DESK_COS,
        hit: true,
    };
}
/* ── 飘 / 悬浮（用户 m07241 给的步态本质）────────────────────────────────
 *  她**走和跑都没有双支撑相**：单脚蹬地 → 往前飘（空中换腿）→ 单脚落地 → 蹬。
 *  我们这条 `walk.vmd` 是标准 MMD 走路（有双支撑），所以必须**整体抬起来**，
 *  把「两只脚都在地上」的相位变成悬空。
 *    ?float=     基础悬浮高度（米）
 *    ?floatbob=  一个循环内**上下起伏的峰谷差**（米）—— 这就是「抛物线」的高度
 *    ?floatph=   最低点相位（0..1 步内；缺省 0 = 落脚那一刻最低）
 *  想看她「脚踏实地」的原样：`?float=0&floatbob=0`。
 *
 * ═══ ★★★ 第二十二轮（2026-10-27）：缺省从 0/0 改回「有起伏的抛物线」═══════════
 *  用户原话（本轮）：「空中换腿这件事其实我们不需要大改步态……简单来说，我们只需要
 *    在她需要滞空时，稍微抬升整个模型不让她触地，在需要落地时放下即可。
 *    也就是说她走路并非向前，而是一个**略向上的抛物线**。」
 *
 *  上一轮实测的现状（`_tools/flightarc.js`，`?autowalk=2.0573&hold=1`，10 s）：
 *    `yPp = 0.0000 m`、40 个相位桶的 y 全等于 0.2701 ⇒ **她完全贴着水平线走**，
 *    一点抛物线都没有。原因就是这两个缺省被写成 0（上面注释还写着 0.04/0.04，
 *    代码与注释对不上 —— 这是被某次改动归零后没同步）。
 *
 *  另外单独实测（`_tools/footorder.js`，40 桶）：
 *    `both 0.000 / neither 1.000` ⇒ **100% 的帧两只脚都在空中**，
 *    也就是「脚从来不真正着地」。所以「落地」这件事在几何上并没有发生，
 *    *视觉上的落地* 只能靠**高度曲线的谷**来表现 —— 这正是用户要的抛物线的意义。
 *    ⚠️ 顺带纠正一条本轮早些时候的错误推断：`corrLR`（两脚相对前后位移的相关）
 *       读到 **+0.746**（同相），但那是 `feet()` 的 `lat[1]` 口径问题（它量的是
 *       「相对角色」的位移，而角色本身在动），**不能据此说「没有换腿」**。
 *
 *  缺省取值（按「看得出抛物线、又不像蹦跳」定）：
 *    `float 0.06` + `floatbob 0.10` ⇒ 谷底 0.06 m、峰顶 0.16 m，pp 0.10 m。
 *    起点：参考视频里她的整体起伏（`hemBot` 的峰谷）约 8~10 cm 量级。
 *
 *  ⚠️⚠️ `floatph` 缺省 **0**（**不是 0.5**，我先前写错了，2026-10-27 修正）：
 *     `bob = BOB·(1−cos(2π(sp2−PH)))/2` 的**谷在 `sp2 = PH`**。
 *     `sp2 = frac(stepPhase·2)`，落地点是 `stepPhase 0 / 0.5` ⇒ `sp2 = 0`。
 *     ⇒ 要让「落地 = 最低」，必须 `PH = 0`。
 *     写成 0.5 会把谷放到**两次落地的正中间**（= 腾空最高的时候贴地），完全反了。
 *     算术验证（谷的位置）：
 *       PH=0.5 : sp2=0 → y 0.160（落地却最高）✗ ；sp2=0.5 → y 0.060（中点最低）✗
 *       PH=0   : sp2=0 → y 0.060（落地最低）✓  ；sp2=0.5 → y 0.160（中点最高）✓
 */
const FLOAT_Y = QNUM('float', 0.06)!;
const FLOAT_BOB = QNUM('floatbob', 0.10)!;
const FLOAT_PH = QNUM('floatph', 0)!;
/* ── 腿部姿态重写 v2：**显式关键帧曲线 + 从绑定姿势直接盖写**（用户 m07400）─
 *  实机参考（`_logs\ref_body.png` 15 帧 = **正好一个整圈**，6 fps ≈ 2.33 s）逐帧读出来的：
 *    ① 点地那一下**膝盖是弯的**（踮脚踩在涟漪圈上），不是脚跟着地的直腿；
 *    ② 离地后双腿张开成大剪刀：前腿向前伸、**脚尖绷直**，后腿向后伸、也绷直；
 *    ③ 回收时后腿**大幅屈膝折起**（小腿几乎收到水平，脚跟贴臀）—— 这是跑步的回收；
 *    ④ 全程**脚永不落到平放**：没有「脚跟着地 → 脚掌滚动 → 脚尖蹬离」这个滚动。
 *    ⑤ 任一时刻**只有一只脚接近地面**，另一只必然抬起（无双支撑）。
 *
 *  为什么不用 v1 的「正弦增量叠加」：`walk.vmd` 本身是**标准 MMD 走路**（上面五条全反），
 *  在它上面加一个小正弦，只是把标准走路糊上一层，姿势本质没变 —— 用户 m07400 的原话
 *  就是「还是正常走路姿势，只不过抽搐的程度小了」。所以这里改成
 *  **从该骨的绑定姿势（PMX 原始局部旋转）直接构造**，把 VMD 对这几根骨的驱动完全接管。
 *  VMD 继续负责躯干 / 手臂 / 头 / 头发（这些是它做对的部分）。
 *
 *  曲线：`u ∈ [0,1)` 是**该腿自己**的相位，`u=0` = 蹬地那一瞬（脚下出涟漪圈）。
 *  左右腿天然反相：`uR = uL + 0.5`。
 *  轴一律用**局部 X**（MMD 腿骨的屈伸轴；已用 `?knee=60/?kneesign=-1` 实拍确认）。
 *  符号（全部实测）：大腿 **+X = 向前摆**；膝 **+X = 小腿向后折**；踝 **+X = 绷脚尖**。
 */
type LegKey = { u: number; thigh: number; knee: number; ankle: number };
const LEG_KEYS: LegKey[] = [
    //  相位     大腿      膝        踝      说明
    { u: 0.000, thigh:  30, knee:  20, ankle: 30 }, // 前脚点地（涟漪圈在这一瞬）
    { u: 0.125, thigh:   6, knee:   8, ankle: 38 }, // 支撑后移，腿绷直
    { u: 0.250, thigh: -26, knee:   4, ankle: 40 }, // 蹬离，整条腿向后伸直
    { u: 0.375, thigh: -52, knee:  24, ankle: 34 }, // 后展到最远 —— 剪刀最开
    { u: 0.500, thigh: -12, knee:  92, ankle: 34 }, // 收腿：小腿折到水平、脚跟贴臀
    { u: 0.625, thigh:  26, knee:  80, ankle: 32 }, // 折叠着往前摆
    { u: 0.750, thigh:  50, knee:  46, ankle: 30 }, // 前伸（膝还弯着，准备落地）
    { u: 0.875, thigh:  44, knee:  26, ankle: 28 }, // 落下
];
/** 腿姿重写开关：`?legpose=0` 关掉，回到纯 VMD 姿势做 A/B */
const LEGPOSE_ON = QNUM('legpose', 0)! > 0;
/** 全局腿姿倍率（0 = 完全不动），用来快速扫「幅度够不够」 */
const LEGPOSE_GAIN = QNUM('legposegain', 1)!;
/** 关节角统一下压（度）：负数 = 全部往绑定姿势靠 */
const LEGPOSE_OFF = QNUM('legposeoff', 0)!;
const X_AXIS = new THREE.Vector3(1, 0, 0);

/** 在 `LEG_KEYS` 上按相位线性插值（含环绕），返回 [thigh, knee, ankle]（度） */
function legCurve(u: number, out: [number, number, number]): [number, number, number] {
    const n = LEG_KEYS.length;
    const uu = ((u % 1) + 1) % 1;
    let i = n - 1;
    for (let k = 0; k < n; k++) { if (LEG_KEYS[k].u <= uu) i = k; }
    const a = LEG_KEYS[i];
    const b = LEG_KEYS[(i + 1) % n];
    const span = ((b.u - a.u) % 1 + 1) % 1 || 1;
    const w = (((uu - a.u) % 1 + 1) % 1) / span;
    out[0] = a.thigh + (b.thigh - a.thigh) * w;
    out[1] = a.knee + (b.knee - a.knee) * w;
    out[2] = a.ankle + (b.ankle - a.ankle) * w;
    return out;
}
/** 越界断言开关（加载器钳死是**静默**的，加一行日志以后 5 秒定位） */
const GAIT_ASSERT = QNUM('gaitassert', 1)! > 0;
/* ── 布料模拟：头发 / 披风 / 裙摆的 Verlet 弹簧骨 ──────────────────────────
 *  用户 m09585 任务1：「走路时衣服、头发是固定的，固定就会穿模」。
 *
 *  算法、以及「为什么加载器自带的三种 physics 全都不能用」见 `secondaryMotion.ts`
 *  文件头 —— 那里有完整的源码行号与实测证据。一句话：
 *    `'stateful-spring'` 只写 `bone.position`、从不碰 `quaternion`，
 *    而裙摆/头发是纯旋转驱动的骨架 ⇒ 等于把这些骨**推回静止位置**（钉死）。
 *
 *  ?secondary=0   关掉（A/B 对照用）
 *  ?secstiff=     回正刚度（1/秒，缺省 7.5）。越大越硬、跟得越紧。
 *                 `?secstiff=3` 很飘、`?secstiff=20` 像塑料。
 *                 头发自动 ×1.4（跟得紧）、裙摆自动 ×0.75（飘）。旧的 `?secgain=` 仍认。
 *  ?seclimit=     限角（度，缺省 22）—— 相对「动画方向」最多偏出去多少。
 *                 MMD 关节表实测就是 ±20°（`rotationLowerLimit/UpperLimit = ±0.349 rad`）。
 *                 头发自动 ×1.5。
 *  ?secgrav=      重力（米/秒²，缺省 9.8）。`?secgrav=0` = 只留惯性、不要重力
 *  ?secdrag=      阻尼（0~1，缺省 0.25；每帧速度保留 1-drag）。VRM 默认 0.4
 *  ?secwind=      ★ 风阻增益（1/s，缺省 6）：把角色**世界速度**变成吹向身后的风。
 *                 没有它的话往前走对布料**完全没有影响**（Verlet 粒子存世界坐标，
 *                 整体平移时 `free - 父骨原点` 不变 ⇒ 刚性位移的偏转恒为 0）。
 *                 `?secwind=0` = 只靠动画自身的摆动；`?secwind=20` = 大风吹。
 *  ?secmax=       最多处理多少根物理骨（缺省 600）
 */
const SECONDARY_ON = QNUM('secondary', 1)! > 0;
/* ★★ 2026-10-19 用户 m03761 第 7 条：「有人说哥伦比娅衣服袖子乱飘，可以把物理解算参数，
 *    子步数改成 3 或 4，你可以试试」（附了一张 Blender MMD Tools 的「子步数 10 / 迭代 10」截图）。
 *
 *    先说清楚**为什么没有照抄「3 个子步」**：那个对话框是 **离线烘焙** 用的 ——
 *    MMD Tools 每帧再切 10 个子步去解约束，是为了让烘焙出来的 VMD 更稳。
 *    我们这个求解器是**实时**的，而且回正项是 `a = 1 - exp(-k·dt)` 的**解析指数解**
 *    （`secondaryMotion.ts:1203`），本身对 dt 已经是精确的、与子步数无关；
 *    把同一个 dt 切成 N 份再跑 N 次，数学上等于 `exp(-k·dt/N)^N = exp(-k·dt)`，
 *    结果**逐位相同**，只是白花 N 倍 CPU。所以「子步数」这个旋钮在我们这套里
 *    真正对应的物理量是**刚度**（k），其次是**阻尼**。
 *
 *    ⇒ 实测调参：刚度 7.5 → 11（袖子/披风回正更快，不再甩来甩去）、
 *      阻尼 0.25 → 0.32（残余摆动更快衰减）。这两个都能用 URL 现场 A/B：
 *      `?secstiff=18&secdrag=0.45` 明显更"硬"，`?secstiff=5&secdrag=0.15` 回到原来那种飘。 */
const SEC_STIFF = QNUM('secstiff', QNUM('secgain', 11)!)!;
/* ═══ ★★★ 第二十四轮 v4：**弹簧刚度/限角的乘数** ═══════════════════════════════
 *
 *  用户 m03115：「我关了参数布料走起来还在飘（我截图是站立，但是走起来还在飘）」。
 *
 *  实测（`_tools/groupdeg.js`，12 s 峰值转角）：`?clothamp=0` 时布料**仍转 9~12°**
 *    · 披风（57 根）均 **9.16°** / 峰 22.7°
 *    · 带（143 根） 均 **9.92°** / 峰 53.4°
 *    · 披肩（72 根）均 **11.95°** / 峰 30.2°
 *    · 裙（274 根） 均 **9.09°** / 峰 35.0°
 *  ⇒ `clothamp` 只关得掉那 4 条**叠加**通道；底下**弹簧求解器**跟随动画的滞后角
 *    完全不受它管，这正是用户看到的"还在飘"。
 *
 *  隔离实验（全部 `clothamp=0`，披风/带/披肩/裙 的均角）：
 *    基线            8.91 / 9.65 / 11.12 / 8.93
 *    `secwind=0`     8.03 / 9.47 /  8.49 / 8.65      ← 风不是主因
 *    `secframe=0`   10.70 /10.77 / 14.72 / 9.58      ← 位移补偿也不是（反而更飘）
 *    `secdrag=0.9`  11.36 /11.46 / 15.47 / 9.87      ← 阻尼也不是
 *    **`secstiff=40`   6.98 /10.63 /  8.52 / 8.49**   ← ★ 刚度才是
 *    **`secstiff=100`  6.23 /11.39 /  5.58 / 8.25**
 *  ⇒ 只有**刚度**能把它压下去。但现有 `?secstiff=` 是**绝对值**，改了会连带影响
 *    头发（×1.4）与裙（×0.75）的相对配比；而且「带」不降反升（9.65→11.39）
 *    ⇒ 各片最优刚度**不同**，必须能分开调。
 *
 *  所以这里加的是**乘数**（不覆盖 `stiffness=11 / drag=0.32` 这两个已定案值）：
 *    `?secstiffk=`     全局刚度乘数，缺省 **1**（=1 逐位回滚）
 *    `?secstiffhair=`  头发分片乘数，缺省 1
 *    `?secstiffskirt=` 裙分片乘数，缺省 1
 *    `?secstiffother=` 其它布（披风/带/披肩/袖）分片乘数，缺省 1
 *    `?seclimitk=`     限角乘数，缺省 1（弹簧再硬也会顶到限角，两个一起调才够）
 *
 *  ⚠️ 实测参考：`secstiff=100` ≈ 披肩 11.12°→5.58°、披风 8.91°→6.23°；
 *     `seclimit=0.001` 效果接近（披肩 5.09°）⇒ "几乎不动"要两者一起上。 */
const SEC_STIFFK = QNUM('secstiffk', 1)!;
const SEC_STIFF_HAIR = QNUM('secstiffhair', 1)!;
const SEC_STIFF_SKIRT = QNUM('secstiffskirt', 1)!;
const SEC_STIFF_OTHER = QNUM('secstiffother', 1)!;
const SEC_LIMITK = QNUM('seclimitk', 1)!;
/* ★★★ 第二十五轮：三片布各自的刚度乘数（缺省都是 1 = 逐位回滚）。
 *  用户 m03364：「8 号布料飘的太大，单独调。」`?secstiffk=` 是全局的，一调四片一起变，
 *  而同一刚度下各片的滞后量差很多 ⇒ 需要分片。材质组见 `SecondaryRig.matGroup`：
 *    `?secstiffcape=`   → 2 披风（编号 6）
 *    `?secstiffribbon=` → 3 带  （编号 8，用户点名要单独调的那片）
 *    `?secstiffshawl=`  → 4 披肩（编号 4） */
const SEC_STIFF_CAPE = QNUM('secstiffcape', 1)!;
const SEC_STIFF_RIBBON = QNUM('secstiffribbon', 1)!;
const SEC_STIFF_SHAWL = QNUM('secstiffshawl', 1)!;
/* ★★★ 第二十五轮 C：**布料链一致化强度** α（0..1，缺省 **0** = 关 = 精确回滚）。
 *  用户 m03364（`clothamp=0&secstiffk=20`）：
 *    「6 号布料应该是两半是一个整体，同时往左右循环飘，目前是分开各飘各的」
 *    「4 号布料尾部飘很大，上面几乎不动，需要整体飘」
 *    「8 号布料飘的太大，单独调」
 *  机制见 `SecondaryOptions.netCape`：本骨方向朝父骨解算方向混合 α，
 *  α→1 时一片布像刚性体整体转，同时压掉梢部的乱甩。 */
const SEC_NET_CAPE = QNUM('secnetcape', 0)!;
const SEC_NET_RIBBON = QNUM('secnetribbon', 0)!;
/* ★ 第二十六轮改缺省 **0.7 → 0**（用户 m03795「4 号布料直接飞了」）。
 *  第二十五轮把它定成 0.7 的依据是**相对量**（下/上位移比 4.18→0.46、下上相关
 *  −0.32→+0.9973），**没测绝对朝向** ⇒ 漏掉了它把整片披肩拽平。
 *  根因：链一致化原本混父骨的**绝对朝向**，而披肩骨挂在**手臂父链**上（§1.21），
 *  手臂朝外伸 ⇒ 整片被拉成水平并冻住 = 用户说的「翅膀」。
 *
 *  第二十六轮两步：
 *    ① `patch26b` 把混的量从「绝对方向」改成「相对静止方向的偏差」（四元数版见 `patch26c`）
 *       ⇒ 翅膀消失（`u26t_angle.js` 站定竖直分量 `up0.shawl` **0.865**，1 = 垂落）。
 *    ② 但**同步性没改善**（`_logs/round26/u26t.jsonl` 下上相关 `cosLH`：
 *       net 0 → **0.4154**、0.7 → **−0.2405**、1 → 0.291）⇒ 加大 α 反而更不同步。
 *  ⇒ 既然达不到「整片一起飘」，就不该让它默认开着。**回滚 = 已经是 0。** */
const SEC_NET_SHAWL = QNUM('secnetshawl', 0)!;
const SEC_NET_SKIRT = QNUM('secnetskirt', 0)!;
/* ★★★ 第二十五轮 D：**压住飘动** β（0..1，缺省 **0** = 关 = 精确回滚）。
 *  为什么需要：`clothamp=0&secstiffk=20` 下 8 带位移 pp 均 0.1801 m，
 *  给带单独加刚度 `?secstiffribbon=` 1→3→8 得 0.1801→0.1508→**0.1514**（不再下降）
 *  ⇒ 地板 = 动画自己的裙骨关键帧，刚度这条路走完了。
 *  这条通道把布料朝**站定姿态**混合：β→1 ⇒ 钉在站立垂落的样子，不再随动画摆。
 *  机制见 `SecondaryOptions.holdCape`。 */
const SEC_HOLD_CAPE = QNUM('secholdcape', 0)!;
/* ★ 第二十五轮 E 曾定 **0.45**（用户「8 号布料飘的太大，单独调」）；
 *  ★ 第二十六轮改 **0.25**（用户 m03795「8 号一动不动」）—— 两次诉求相反，取中间。
 *
 *  实测（`_tools/u26t_angle.js` 转角口径，`clothamp=0.35` 缺省，
 *  带子逐骨「相对站定方向」的最大转角中位 / 全片最大，`_logs/round26/u26h2.jsonl`）：
 *    β 0     → **46.00°** / 179.30°   ← 第二十五轮用户嫌「飘太大」的就是这一档
 *    β 0.05  → 21.49° / 119.83°
 *    β 0.10  → 13.20° / 175.76°
 *    β 0.15  → 10.76° /  54.87°
 *    β 0.30  →  9.44° /  36.36°
 *    β 0.45  →  7.57° /  39.82°   ← 第二十五轮定的值，第二十六轮用户嫌「一动不动」
 *  ⇒ 0.45 把带子压到 β=0 时的 **16%**，过了。0.25 落在 0.15~0.3 之间（≈10°），
 *    既压掉 179° 的翻卷毛刺（max 从 179 → 约 40°），又留得下看得见的摆动。
 *  回滚到第二十五轮：`?secholdribbon=0.45`；完全放开：`?secholdribbon=0`。 */
const SEC_HOLD_RIBBON = QNUM('secholdribbon', 0)!;
/* ★ 第三十一轮：4号披肩「前端（下摆）往回缩、微微摆动」（用户 m07039）。
 *  实测：这是唯一有效旋钮 —— `?secstiffshawl=8` 只降 14%，`?secshawl=-1` 几乎不变。
 *  缺省 0.85 让下摆每骨位移峰峰 0.2332 -> 0.0454 m（−81%）、转角 162.9 -> 12.8°。
 *  ⚠️ 它把骨拉向**站定方向**，会吃掉 `secshawlpush` 的前移量 ⇒ push 必须同时加（见下）。
 *  逐位回滚 = `?secholdshawl=0&secshawlpush=5`。 */
const SEC_HOLD_SHAWL = QNUM('secholdshawl', 0)!;
const SEC_HOLD_SKIRT = QNUM('secholdskirt', 0)!;
const SEC_LIMIT = QNUM('seclimit', 22)!;
const SEC_GRAV = QNUM('secgrav', 9.8)!;
const SEC_DRAG = QNUM('secdrag', 0.32)!;
const SEC_WIND = QNUM('secwind', 6)!;

/* ══════════════════════════════════════════════════════════════════════════════
 * ★★★ 2026-10-08 布料整体回滚（用户 m03765 / m03772 裁决）
 *
 * 用户 m03765 原话：「回滚，把衣料回滚到我说走路时衣服应该往前摆，衣料和大腿穿模之前。
 *   步态不要动」
 * 用户 m03772 补充：「我提出人物前面的衣料和大腿穿模，应该随人物走路往前摆动之前」
 *
 * ⇒ 目标 = 存档 V2（`公用区\存档\步态V2_20261007`）的布料行为。步态 / 站姿 / 收尾
 *   一律不动。V2 的布料 = 纯 Verlet 弹簧骨（573 根）+ PMX 静止刚体碰撞（34 个胶囊），
 *   刚度 7.5 / 重力 9.8 / 限角 22°，**没有**棒采样、没有碰撞体放大、没有推出迭代、
 *   没有静置松弛封顶、没有位移补偿、没有方向性约束、没有肢体驱动、没有布-布斥力。
 *   依据 `公用区\存档\步态V2_20261007\存档说明.md` 第 13 / 20 行；V2 实测 0.4–0.6 ms/帧。
 *
 * 本次改动的 11 个缺省（左 = 回滚前，右 = 现在 = V2 等价）：
 *
 *   | 开关              | 回滚前 | 现在 | 作用                                  |
 *   |-------------------|--------|------|---------------------------------------|
 *   | `?secwindfront=`  | 0      | 1    | 前侧布片风力系数（1 = 前后一视同仁）   |
 *   | `?secframe=`      | 1      | 0    | 布料粒子的角色位移补偿                 |
 *   | `?seccols=`       | 1.35   | 1    | 碰撞体半径全局放大                     |
 *   | `?seccolsleg=`    | 1.35   | 1    | 腿刚体额外放大                         |
 *   | `?seciter=`       | 3      | 1    | 碰撞推出迭代次数                       |
 *   | `?secslackmax=`   | 0.015  | 0    | 单对最大静置嵌入（米）                 |
 *   | `?secrod=`        | 4      | 1    | 骨棒采样点数（1 = 只测骨尾 = V2）      |
 *   | `?secanti=`       | 0      | -1   | 方向性约束（-1 = 关）                  |
 *   | `?secdrive=`      | 18     | -1   | 肢体驱动（-1 = 关）                    |
 *   | `?secdrivelead=`  | 0.10   | 0    | 相位超前（驱动关了即无效）             |
 *   | `?secrepel=`      | 0      | 0    | 布-布斥力（早前 m03697 已回滚）        |
 *
 * ⚠️ 这次回滚**只动布料**：11 个开关全部只进 `createSecondaryMotion` 的 options
 *    （`secondaryMotion.ts`），不碰腿链 / 站姿 / 步长 / 收尾 / 动画时钟 ⇒
 *    「步态不要动」是结构性保证，不是靠自觉。
 *
 * ⚠️ 下面每个开关原来那段长注释**保留**，它们是每条结论的取证记录。
 *    回滚的只是**缺省值**；功能代码与开关都在，想逐条打开做 A/B 就按上表加参数。
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * ★★ 前侧布片（前襟/身前那几片）吃多少风（`?secwindfront=`，缺省 **0** = 不吃）。
 *
 * 用户 m14400 原话：「走路时前方衣摆依然是向后摆动的。而不是向前。」
 * 机理：`SEC_WIND` 把角色世界速度变成**吹向身后**的风（`secondaryMotion.ts` 里
 * `wx = -vx·wind·d²`）⇒ 前襟被一路吹到身体后面、贴住大腿，腿再往前摆就穿出来。
 * 而走路时前襟**应该**由前摆的腿顶着向前（`?secdrive=` 那条线，实测缺省 18° 能把
 * 前侧骨最靠后的位置从 −3.2 cm 抬到 +2.8 cm）。
 * ⇒ 对 `axisSel===0 && axisSign>0` 这一组乘 `SEC_WIND_FRONT`：缺省 0（后面/侧面/头发照旧吃风）。
 * `?secwindfront=1` 一键回到旧行为做 A/B。
 */
const SEC_WIND_FRONT = QNUM('secwindfront', 1)!;   // ← 已回滚（V2 前后一视同仁）
/**
 * ★★★ 角色位移补偿（`?secframe=`，缺省 **1** = 全补）。
 *
 * 用户 m14400 任务②「走路时前方衣摆依然是向后摆动的。而不是向前」的**真正**根因：
 * 布料求解器在**世界坐标**里跑 Verlet —— 粒子存的是世界点，每帧只把「骨头的世界位置」
 * 当锚点。角色以 v 前进时锚点跑了、粒子不跑，回正弹簧只好把它拖过去，于是有稳态落后
 * `lag ≈ v / 刚度`：v=1.446 m/s、刚度 7.5/s ⇒ 约 0.19 m，加阻尼实测 **0.30 m**。
 * 证据：把 `?secwindfront=0`（前襟完全不吃那股「吹向身后」的风）跑同一条路，
 * `frontMin` 只从 −0.298 变到 −0.286 ⇒ **不是风的问题，是这个坐标系副作用**。
 * ⇒ 把角色这一帧的位移同时补进粒子位与上一帧位（等价于在角色的移动坐标系里解算）。
 * 拖尾感改由 `?secwind=`（显式风）提供，`?secframe=0` 一键回旧行为做 A/B。
 *
 * ★ 实测（真实步速 `?autowalk=1.446`、连走 2.6 s、n=60 样本、两次独立跑数一致）：
 *   `?secframe=0` → 前侧骨在最靠后的时刻只到 **+1.2 cm**（`frontMin`）、均值 +15.7 cm；
 *   `?secframe=1` → **+11.0 cm**（`frontMin`）、均值 +19.0 cm，`frontMax` 24.1 → 25.3 cm。
 *   目视（`_logs\frame\RG_c0.png` vs `RG_c1.png`，侧视同帧）：关掉时长纱被**水平甩到身
 *   后近半米**、两腿裸露；打开后纱料收回身侧、随身体垂坠。⇒ 缺省翻成 **1**。
 * ⚠️ 踩过的坑：`?autowalk=` 是**速度 m/s**，不是时长 —— 我一度写 `autowalk=99`
 *   让她以 99 m/s 飞出去，那批 `frontMin`（−30 cm）全是废数据，别再用。
 *
 * ★★ 2026-10-17 重新翻回缺省 **1**（用户 m00002 缺陷③「走路时前方衣服穿模」）。
 *   当年（m03765/m03772）把这 11 个开关一起回滚，理由是「效果没区别」—— 那是因为
 *   **朱红的草丛把角色糊住了**，肉眼根本看不清。这次用 `?grass=0` 关掉草再拍，
 *   并用 `?tfreeze=1&animt=<秒>&hold=1&secvelz=1.446` 把动画钉死做可复现的 A/B，
 *   单因素拆解结果（`_logs\fc7.jsonl` / `_logs\fc9.jsonl`）：
 *     `secframe=0` → frontMin −0.4039（相 0.875 s）/ −0.4306（相 2.0417 s）
 *     `secframe=1` → frontMin **+0.0062** / **+0.0062**（负值归零，前襟不再跑到身后）
 *     `secanti=0`  单独只有 −0.1241 / −0.1413，且与 `secframe=1` 叠加无边际增益
 *   ⇒ **只翻 `secframe` 这一个缺省值**（真正的根因修复），其余开关保持回滚态。
 *   目视佐证 `_logs\c_fc11_walk.jpg`（左 = 旧缺省，纱片被甩到身后、大腿裸露；
 *   中/右 = 新缺省，前襟正常垂坠在身前）。
 */
const SEC_FRAME = QNUM('secframe', 1)!;   // ← 缺陷③修复后翻回 1（详见上一段注释）
const SEC_MAX = QNUM('secmax', 600)!;
/**
 * ★ 是否用 PMX 自带的 34 个静止刚体做**碰撞体**（头/颈/胸/腰/肩/臂/腿）。
 * 缺省开 —— 这是「腿把裙子穿过去」的解药：弹簧骨只会跟着父骨摆，腿扫过来它不管；
 * 把腿做成胶囊、把布料粒子推出去，裙子才会被顶开。`?seccol=0` 关掉做 A/B。
 */
const SEC_COL = QNUM('seccol', 1)! > 0;
/**
 * ★★ 碰撞体半径放大系数（`?seccols=`，缺省 1.35）。
 *
 * 用户 m11046 任务2：「身前的衣服向后摆动穿过了身体，不考虑身体模型」。
 * 根因之一：PMX 的 34 个静止刚体是给**物理引擎**用的粗代理，比可见网格细一圈
 * （实测胸 7.1 cm、髋 6.8 cm、大腿 7.1 cm 半径，而可见网格要宽 30% 以上）。
 * 用它们直接当碰撞面，布料会「贴着骨架表面」而**穿过可见的皮肤**。
 * ⇒ 把半径放大到贴住可见表面。`?seccols=1` 复现旧行为做 A/B。
 */
const SEC_COLS = QNUM('seccols', 1)!;   // ← 已回滚（V2 用原始 PMX 半径）
/**
 * ★★★ **腿**刚体的额外放大系数（`?seccolsleg=`，缺省 **1.35** ⇒ 腿的碰撞总体 1.82×）。
 *
 * 用户 m14756 把穿模处圈出来了（`公用区\无标题1.png` / `无标题.png`）：长袖/裙片
 * 挂在手边、腿从这片布里穿过去。根因不是「推得不够猛」，而是**碰撞体是贴骨轴的粗代理**：
 * 布片是**面**，网格可以离自己的骨轴好几厘米 —— 只按 `colScale=1.35` 把骨轴推出去，
 * 不能保证**网格**离开**可见的腿**。
 * 实测（真实步速 `?autowalk=1.446` 连走 2.6 s、每 40 ms 一次 `rodAudit`）：
 *   `?seccolsleg=1`（腿 1.35×）→ `Skirt_1_0⇠D` 骨棒最深插进原始半径 **47.5 mm**（6 对、57 帧 >5 mm）
 *   `?seccolsleg=1.35`（腿 1.82×）→ `maxPenVis = 0`、0 对
 *   `?seccolsleg=2`（腿 2.7×）→ 同样 0，但目视会把裙摆吹成**钟形外扩**
 * 定格三档目视对照（`路线A-webgpu\_logs\legmid.png`，换腿最窄相 ph0.50）：
 *   1.35× 长纱横穿小腿（就是穿模）／1.82× 布片被推到腿两侧、腿干净且垂坠自然／2.7× 外扩过度
 * ⇒ 缺省取 **1.35**（腿 1.82×）：插深归零、观感仍自然。`?seccolsleg=1` 复现旧行为做 A/B。
 */
const SEC_COLS_LEG = QNUM('seccolsleg', 1)!;   // ← 已回滚（V2 无腿部放大）
/**
 * ★★ 碰撞推出迭代次数（`?seciter=`，缺省 3）。
 *
 * 推出后要按骨长把方向归一化，这一步会把推出的成果**吃回去**（新尾巴又落回
 * 以骨为心、半径 L 的球面上，可能仍在体内）。迭代到不再穿透为止。
 * `?seciter=1` 复现旧行为做 A/B。
 */
const SEC_ITER = QNUM('seciter', 1)!;   // ← 已回滚（V2 单趟推出）
/**
 * ★★ 单对允许的最大静置嵌入深度（米，`?secslackmax=`，缺省 0.015）。
 *
 * 背景：`colSlack` 是「初始化那一帧本来就插进去多少」——比它更深才推出去。
 * 但那一帧**可能是迈步姿势**，于是某根前襟骨的尾巴恰好落在放大的大腿胶囊里
 * 3.7 cm 深 ⇒ 这一对**永远**不会被推出去，也就是用户 m11046 看到的
 * 「身前的衣服向后摆，穿过了身体」。
 * 封顶之后，任何一对最多只能嵌 `secslackmax` 米 ⇒ 穿模深度有了硬上界。
 * `?secslackmax=99` 复现旧行为做 A/B。
 */
const SEC_SLACKMAX = QNUM('secslackmax', 0)!;   // ← 已回滚（V2 无静置嵌入封顶）
/**
 * ★★ 碰撞检测的**骨棒采样点数**（`?secrod=`，缺省 4；`1` = 只测骨尾 = 旧行为）。
 *
 * 用户 m13789：「走路时前面衣料和袖子穿模的问题。还没修」。
 * 旧版每根弹簧骨只把**骨尾那一个点**拿去和身体胶囊比对 ⇒ 腿可以从两根骨之间
 * 穿过而不被发现（骨尾全在胶囊外，`maxPenVis = 0`，见 `_logs/walkcollide.jsonl`）。
 * 现在沿「父骨原点 → 骨尾」取 `secrod` 个采样点（`s = 0.5…1.0`）一起测。
 * 量级用 `__mmd.rodAudit()` 看：`?secrod=1` 与 `?secrod=4` 的 `maxPenVis` 之差
 * 就是那条盲区有多大。详见 `secondaryMotion.ts` 的 `SecondaryRig.rodSamples`。
 */
const SEC_ROD = QNUM('secrod', 1)!;   // ← 已回滚（V2 只测骨尾）
/**
 * ★★★ 布-布斥力（`?secrepel=`，缺省 **0.010** 米 = 1 cm；`0` = 关）。
 *
 * 用户 m15017：「布-布斥力你做一个我看看效果」。
 * 引擎原先**只**做「布料 × 身体胶囊」，**布片之间完全没有排斥**：`clashAudit` 在
 * 真实走路 3.2 s 里量到不同组骨棒最近 **0.17 mm**、每个相位都有 **94~165 对**在
 * 2 cm 以内（长袖叠裙摆、前襟外披片互相叠）—— 只能直接穿过去。
 * 现在每帧在身体碰撞之后再做一遍「骨尾互斥」：距离 < `secrepel` 的两根骨（且**不在
 * 同一骨链 3 跳内**）各让开一半。`?secrepelcut=`（缺省 0.06 米）是**当前帧**双向点到
 * 线段的入表阈值，`?secrepelw=`（缺省 1）是强度，`?secrepelevery=`（缺省 3）是邻接表
 * 重建周期。量效果用 `__mmd.clashAudit()` 的 `minDist`（改前 0.2 mm 级；生效后应升到
 * 接近 `secrepel` 的量级）。判据与两个坑（**不能按静止姿势建表**、**不能只比骨尾对骨尾**）
 * 见 `secondaryMotion.ts` 的 `rebuildRepel` 长注释。
 *
 * ★ 缺省 **关闭**（`0`）。用户 m03697 看过四档联络图后的裁决原文：「效果没区别。还不如之前。
 *   回滚吧」⇒ 出厂回到加这个功能之前的画面，功能代码保留成**可选的关闭开关**。
 *   想要就加 `?secrepel=0.022&secrepelevery=3`（下表的中间档），更强的档位见下。
 *
 *   实测四档（2026-10-08，证据 `_logs/repel4~6.jsonl`，联络图 `_logs/repel/repel_4way.png`、
 *   `repel_4way_zoom.png`）。定格走路相 ph0.50 的 `clashAudit(0.05,6)` 计数（<1 / <2 / <5 cm 对数）：
 *     关 → 52 / 204 / 1068；15 mm·8 帧 → 39 / 185 / 1056；
 *     22 mm·3 帧 → 25 / 109 / 960；30 mm·2 帧 → 21 / 81 / 711。
 *   动态走路 3.2 s 的 `<2 cm` 对数：关 270 → 15 mm 265 → 22 mm 198 → 30 mm 136。
 *   代价：布料求解 `secMs` 均值 1.04 ms（关）→ 1.56 ms，预算充足。
 *   ⚠ 数字都在变好，但**用户看画面判定「没区别、还不如之前」** —— 原因是最坏的那一对骨棒
 *   仍在 0.2 mm 量级（布片的**骨杆很细**，骨杆分开了网格边缘照样视觉上叠着），而调大的
 *   部分代价是裙子逐步「撑开」。**结论：靠骨杆间距治不了布片互穿这个可见问题**，
 *   要做得按「布片半宽」给非零安全距离，或直接从网格层面处理；下一轮别在 `secrepel` 上加大
 *   数值再试一遍。判据与两个坑（**不能按静止姿势建表**、**不能只比骨尾对骨尾**）
 *   见 `secondaryMotion.ts` 的 `rebuildRepel` 长注释。
 */
const SEC_REPEL = QNUM('secrepel', 0)!;
const SEC_REPEL_CUT = QNUM('secrepelcut', 0.06)!;
const SEC_REPEL_W = QNUM('secrepelw', 1)!;
const SEC_REPEL_EVERY = QNUM('secrepelevery', 8)!;   // ← 已回滚（斥力关闭时无意义）
/**
 * ★★ 方向性约束容差（度，`?secanti=`，缺省 8；`?secanti=-1` 关闭）。
 *
 * 用户 m11933：「原神里哥伦比娅走路时，身后衣服头发正常摆动，**身前的衣服基本不摆动，
 * 自然下垂飘动，甚至会向前摆动（被腿走路时顶起来，会向前摆动一下）**」。
 *
 * 用户 m11937「先搜再做」⇒ 查到两条成熟路线（MagicaCloth 的 Surface Penetration、
 * Maya 裙摆 rig 的前后左右分解控制），结论一致：**这是一条方向性硬约束，光靠碰撞解不了**。
 * 我们的 Verlet 粒子存世界坐标、把角色整体平动的惯性全量喂进去 ⇒ 走路时**所有**布片
 * （含前襟）都被甩向身后。业主的做法是按骨的静止朝向区分前/后悬挂件，只许它们「离开身体」摆。
 * 详见 `secondaryMotion.ts` 里 `SecondaryRig.fwdLocal` 上方的长注释。
 *
 * `?secanti=0` = 完全不许朝身体方向偏（最严格）；`?secanti=90` ≈ 关闭；`?secanti=-1` 关闭。
 */
const SEC_ANTI = QNUM('secanti', -1)!;   // ← 已回滚（V2 无方向性约束）
/* ── ★★ `?secanti=` 的定标实测（`_tools\anti-probe.js`，真走 20 秒、500 样本，
 *      `?autowalk=1.446&hold=1`，读数 = 「最靠后的那根前侧骨」相对角色中线的前后偏移，
 *      负 = 已经越到身体后面 ⇒ 就是用户看到的「身前的衣服向后摆穿过身体」）──
 *
 *   | `?secanti=` | frontMin 最小值 | 约束命中样本占比 | 单帧最大修正角 |
 *   |---|---|---|---|
 *   | `-1`（关） | **−0.3055 m** | 0%   | 0°    |
 *   | `20`        | −0.3140 m     | 3%   | 23.7° |
 *   | `8`         | −0.1608 m     | 46%  | 28.4° |
 *   | **`0`（缺省）** | **+0.0426 m** | 100% | 29.8° |
 *
 *  ⇒ 单调、可复现：关掉时前襟最深跑到身体后面 **30.5 cm**（穿模）；`0` 时**永远不越过中线**。
 *  取 `0` 作为缺省是因为用户 m11933 的定义就是「身前的衣服**基本不摆动**，自然下垂」——
 *  它仍然可以自由地**向前**摆（被腿顶起来的那一下）和左右摆，只是不许朝身体方向去。
 *  想松一点看效果可以 `?secanti=8`。
 */
/**
 * ★★ **肢体驱动的「向前摆」**（度，`?secdrive=`，缺省 18；`?secdrive=-1` 关闭）。
 *
 * 用户 m12638（原话）：
 *   「走路时，胳膊，腿会向前摆动，所以，身前的衣服，袖子一定是跟随着向前摆动的，
 *     否则一定穿模。袖子跟着胳膊前后摆，而身前的衣服一定是向前摆——原地来回」
 * 用户 m12655（补充）：
 *   「身前的衣服，当手和腿向前时，身前的衣服提前向前摆，当手和腿向后时，衣服回到原地。
 *     向前到原地，在两者之间来回摆动」
 *
 * ⇒ 前侧悬挂件的正确运动是**单向**的：「原地 → 向前」之间来回，**永远不到原地之后**；
 *    驱动它的不是风/惯性，而是**腿与胳膊的向前摆动**。
 *
 * 实现在 `secondaryMotion.ts`：每帧量出大腿/上臂相对绑定姿势向前摆了多少（0..1），
 * 再把这个量换算成绕**侧向轴**的旋转，压到布的**弹簧目标方向** `_vRest` 上 ——
 * 于是「这段布自己的静止位置向前挪了」，弹簧真的把它推向前。
 * 腿/臂向后摆时驱动量归 0，弹簧把布拉回原地，方向性约束（`?secanti=`）再兜住「不许更靠后」。
 *
 * 与 `?secanti=` 的分工（用户 m12638 点出的穿模）：
 *   ① 前襟/前裙 —— 腿驱动（`driveSel===2`），并且受方向性约束；
 *   ② **袖子/臂饰 —— 胳膊驱动（`driveSel===1`），并且【整条豁免】方向性约束**。
 *      否则胳膊向前摆、袖子被约束卡在原地 ⇒ 胳膊从袖子里穿出来，正是用户说的
 *      「否则一定穿模」。分类靠骨名的父链（`左/右腕|ひじ|手首`）。
 */
const SEC_DRIVE = QNUM('secdrive', -1)!;   // ← 已回滚（V2 无肢体驱动）
/**
 * ★★ **相位超前**（秒，`?secdrivelead=`，缺省 0.10；`0` = 关，即纯跟随手脚）。
 *
 * 用户 m12822 原文：「可以考虑，当手和腿向前时，身前的衣服和袖子等衣料，**提前**向前运动，
 * 不必一定要等手和腿驱动」。
 *
 * 纯跟随（`量 = 当前摆幅`）的问题：布片永远**落后**于手脚 —— 手已经摆到最前面了，袖子才刚开始跟上，
 * 于是这一小段时间里手臂穿出袖口。超前项让布片**先动**：`量 = 摆幅 + τ × 摆幅变化率`，
 * 腿还在往后撤但已经**开始加速向前**时，驱动量就已经 > 0。腿开始往回摆时驱动量**先归零**，
 * 布片提前回到原地。负值被 clamp 掉 ⇒ 前襟的行程仍然是「原地 ↔ 向前」，不会越到身后。
 *
 * 定标依据：走路周期 1.567 s，大腿从 −27° 摆到 +27° 约 0.78 s ⇒ 归一化摆幅的典型速率约 2.5 /s，
 * τ = 0.10 s 时超前项约 0.25（满幅的四分之一）—— 看得出来「提前」，但不抢在手脚前面太多。
 */
const SEC_DRIVE_LEAD = Math.max(0, QNUM('secdrivelead', 0)!);   // ← 已回滚（驱动关了即无效）
/**
 * ★★★ **袖子走路时向外撑开的角度**（度，`?secflare=`，缺省 **16**；`-1` 或 `0` = 关）。
 *
 * 用户 2026-10-21 反馈1 原话：「袖子在走路时，和衣服穿模，解决方案，袖子走路时位置向外延申，
 * 避开衣服」。
 *
 * 为什么单开这一条（而不是把 `?secdrive=` 打开）：
 *   `?secdrive=` 管的是**前后**摆（袖子跟着胳膊往前），但穿模发生在**侧向** ——
 *   胳膊往前摆时袖子仍然贴着前襟，两片布在 2 cm 以内就只能互相插过去
 *   （`secondaryMotion.ts` 的 `auditClash` 实测每相位 94~165 对）。
 *   布-布斥力（`?secrepel=`）能解，但要建邻接表、每 8 帧重建，代价大且在 V2 里被回滚了。
 *   ⇒ 按用户给的方案直接做**侧向偏置**：离身体中线越远越安全，零额外开销。
 *
 * 量由**角色水平速度**归一（`?secflarespd=`，缺省 0.9 m/s ⇒ 走路 1.446 m/s 已是满值），
 * 站定自动归 0，不需要额外的「正在走路」状态机。
 * 只作用于 `driveSel === 1`（父链经过 `左/右腕|ひじ|手首` 的袖子/臂饰那一组）。
 */
const SEC_FLARE = QNUM('secflare', 16)!;
/** 撑开量达到满值所需的水平速度（m/s） */
const SEC_FLARE_SPEED = QNUM('secflarespd', 0.9)!;
/**
 * ★★★ **袖子向两侧摆动**的幅度（度，`?secside=`，缺省 **8**；`<= 0` 或 `-1` 关）。
 *
 * 用户 m18305（第七项修复）：「现在的袖子是随着手臂摆动**前后**运动……实际上，袖子的
 * 摆动方向是**向两侧**，人物走起来以后，袖子是向两侧飘而不是前后。这也改善了袖子和
 * 衣服穿模的问题。因为袖子向两侧飘就不会碰到衣服。」
 *
 * 与上面 `?secflare=` 的分工：那条是**静态外偏**（把静止目标朝身体外偏一个固定角，
 * 与手肘摆动无关）；这条是**摆动**（跟手肘相对肩膀的侧向摆把袖子朝外甩），
 * 并且按 `?secsidekill=` 压掉袖子目标方向里的前后分量 —— 主运动轴因此从 Z 换到 X。
 * `-1` 时运行期整段不跑，逐位回到改前行为（`?secdrive=` / `?secflare=` 同理各自回滚）。
 *
 * ★★★ 缺省 **8**（2026-10-25，用户 m11019：「先定 8°，我需要进游戏实机验收再定」）。
 *  历代：26 → 52（十轮）→ 60（十二轮）→ **8**（本轮）。
 *
 *  ⚠️ 60 那个值为什么必须降：第十二轮「让通道生效」时，侧摆量其实被弹簧完全抵消
 *  （写回旋转 `R = _vRest → _vDir ≈ I`），画面上一点都不动。第十四轮修掉真根因
 *  （写回阶段左乘 `_qSide` 增量，见 `secondaryMotion.ts:2244-2254`）之后，60° 才
 *  第一次真正作用到网格上 —— 幅度**远大于**当初按「几乎无效」调出来的手感，
 *  用户 m10834 反馈「向两侧飘起的程度太大了」。所以回到小量级。
 *
 *  逐档实测（冻结姿态 `?tfreeze=1&animt=8.5&seclock=1.6&secvelx=1.446&charyaw=180`，
 *  读数 `window.__mmd.sleevePose()`；`applied` = 真正叠进写回四元数的骨数，
 *  `sideMax` = 单骨最大侧张，`sideOver10` = 侧张 ≥10° 的骨数）：
 *    8°   applied 160，sideMax 17.73°，sideOver10 112，sideMed 13.58°
 *    12°  applied 160，sideMax 21.44°，sideOver10  99，sideMed 11.44°
 *    16°  applied 160，sideMax 25.41°，sideOver10  86，sideMed  9.70°
 *    60°  applied 160，sideMax 62.04°，sideOver10  34
 *  正面机位出图（`_tools/frontcam.js`）：`_tmp_preview/r15_front08_only.jpg`
 *  / `r15_front12_only.jpg` / `r15_front16_only.jpg`、拼图 `r15_pick3.jpg`。
 *
 *  保留 `60` 仅作 `?secside=` 的**机制上限**（`secondaryMotion.ts` 里
 *  `Math.min(60, sideDegRaw)` 封顶），缺省已不是它。
 */
/* ★ 第二十九轮回滚步态V3 时这里被置 0（V3 的 secondaryMotion.ts 里
 *  `sideDeg/sideAmp/sideOsc` 全为 0 —— 袖只有纯弹簧，没有侧张通道）。
 *
 *  ★ 第三十五轮（用户 m08642「1号布料走路时位置外移一些，指向身体两侧」）恢复并定档 20°：
 *  实测（`_tools/u35sleeve3.js`，相对站定页 176 根袖骨 `tipS` 中位，单位 m）：
 *    `?secside=0`  +0.008 ／ 10°  +0.041 ／ 15°  +0.053 ／ **20°  +0.065** ／ 30°  +0.087
 *  按骨高分带看是**下段外移、肩部不动**（20° 档 `hU 0.90` 带 +0.215 m → `hU 1.25` 带 +0.006 m），
 *  正是「袖片往两侧张开」而不是整条手臂平移。
 *  穿模同步改善（`auditSleeveClash` 的 `under5` 帧数）：0° 729 → 10° 179 → 15° 95 → **20° 61** → 30° 36。
 *  取 20° 而不是 30°：30° 只把中位再抬 22 mm，却让最外侧骨到 0.33 m，视觉上开始「撑开」。
 *  站定不受影响 —— 侧向闸门是 `_hasSide = sideAmp > 0 && sideAmt > 0`（`sideAmt` 是水平速度），
 *  站定实测 `?secside=60` 的净外移仍是 0.0000 m。
 *  逐位回滚 = `?secside=0`。 */
const SEC_SIDE = QNUM('secside', 20)!;
/** 侧摆量达到满值所需的水平速度（m/s） */
const SEC_SIDE_SPEED = QNUM('secsidespd', 0.9)!;
/** 侧摆时压掉前后摆的比例（0..1，`?secsidekill=`，缺省 0.35） */
const SEC_SIDE_KILL = QNUM('secsidekill', 0.35)!;
/**
 * ★ t16：侧摆的**静态份额**（0..1，`?secsidestand=`，缺省 0.55）。
 *
 * 只乘速度量会让「站定 / 慢走 / 定格取证」时袖摆幅度归零 —— 但用户要的是
 * 「走起来袖子向两侧飘」，而旧的 `?secflare=` 外撑在定格口径下本来就是死通道
 * （`flareAmt` 由水平速度 smoothstep 得到）。留 55% 的常量外张保证：
 *   ① 定格取证能拍到、能量到（不再依赖速度信号）；
 *   ② 站定时袖子也不贴回衣身（正好是用户说的穿模来源）。
 * 走起来时 `w = 0.55 + 0.45 × 速度调制`，满幅仍是 `?secside=` 的设定角度。
 * `?secside=-1` 时整条通道不建（`sideBones=0`），这个数不起作用。
 */
const SEC_SIDE_STAND = QNUM('secsidestand', 0.55)!;
/**
 * ★★★ t20 近裙摆减推量（`?secsideh=` / `?secsidehlo=` / `?secsidehhi=`）。
 *
 * 来源：t16 实测 X 走向的袖-裙最差净距只有 0.00888 m，最差对是
 * `Bone_ArmLets01_R錘 × Skirt_*` —— 那两根袖骨贴着裙摆上沿。旧做法是全局满推
 * `sin(?secside=26°)`，袖片被侧推过去正好擦到裙摆。
 *
 * 改法：**按袖骨节点高度加权**，越靠近裙摆推量越小，袖片主体（小臂以上）仍满推。
 *
 * ★★ t20 实测结论：**缺省关（0）**。扫过 k = 0 / 0.2 / 0.35 / 0.55 四档（`?seclock=1.6`，
 *   X/Z 两走向各 3 帧，`_logs/sleeve/t20g.jsonl` + `t20h.jsonl`）：
 *     k=0    X: x=0.25473 minDist=0.02068 u1=0 ／ Z: x=0.25978 minDist=0.04104 u1=0
 *     k=0.2  X: x=0.24719 minDist=0.02170 u1=0 ／ Z: x=0.24855 minDist=0.04898 u1=0
 *     k=0.35 X: x=0.25220 minDist=0.02231 u1=0 ／ Z: x=0.22644 minDist=0.05128 u1=0
 *     k=0.55 X: x=0.22998 minDist=0.01879 u1=0 ／ Z: x=0.22273 minDist=0.05985 u1=0
 *   净距改善在噪声量级（0.021 → 0.022 m），侧向外移却掉 5~13%。
 *   原因：排除 `*錘` 端点骨后，参与判据的袖骨只有 `Bone_ArmLets01_*`/`02_*` 四根，
 *   它们**全都**贴着裙摆上沿 —— 按高度加权等于整体削推，没有「只削最低那根」的空间。
 *   机制保留（`?secsideh=0.2` 可开、`?secsidehlo/hi` 可标定），缺省关以保住侧向优势。
 *
 * ★ 为什么不直接降 `?secside=`：那是侧向优势的唯一来源（第十二轮把缺省从 52 抬到 60，只准升不准降）。
 * ★ 三项语义见 `SecondaryRig.sideHiK` 的长注释。
 */
const SEC_SIDE_HI = QNUM('secsideh', 0)!;
const SEC_SIDE_HI_LO = QNUM('secsidehlo', 1.50)!;
const SEC_SIDE_HI_HI = QNUM('secsidehhi', 1.58)!;
/**
 * ★★★ 裙摆**最下摆**的两条通道（用户 m11430 任务3）：
 *  「图三我圈出来的衣料，最下摆那部分走路时不要往后飘，自然垂落略微向前摆就行。」
 *
 *  `?sechemwind=<0..1>`：下摆吃风的份额，缺省 **0.10**（= 削掉九成风）。
 *  `?sechemfwd=<度>`：下摆走路时的前倾角，缺省 **4°**（`<= 0` 关）。
 *  `?sechemhi=<0..1>`：下摆高度窗口，缺省 0.45（裙摆竖直跨度里最低的 45%）。
 *  全部置 0 即回到改动前行为（`_logs/round16/hem*.jsonl` 是改动前的基线读数）。
 *  ⚠️ 只作用 `Skirt_*` 里**不属于袖布**的那 237 根（袖布 176 根由 `?secside=` 管）。
 */
const SEC_HEM_WIND = QNUM('sechemwind', 0.10)!;
const SEC_HEM_FWD = QNUM('sechemfwd', 4)!;
const SEC_HEM_HI = QNUM('sechemhi', 0.45)!;
/* ═══ ★★★ 落脚脉冲（用户 m07388：「每一步的脚落地，衣摆和头发都会整体向上
 * 和向四周飘一下，抬腿后落下，下一只脚落地又向上/四周飘，循环往复」）═══════════
 *
 * 参考视频实测（`_tools\hem_pulse_probe2.py` + `_tools\fold_pulse.py`，
 * `_logs\hemref\p2_side.jsonl`，侧视 60fps / 541 帧，分析窗 3.0–12.0 s）：
 *   · **落脚周期 1.163 s/单步**（地面蓝色涟漪峰值 t=3.23/4.40/5.57/6.73/7.88/9.05，
 *     interval 1.163±0.007）；整循环（两步）**2.327 s**，步频 0.86 步/s。
 *   · 相位折叠（phase 0 = 涟漪出现）：
 *       `h = ymax−ymin` pp **36.3 px**，**min @0.19**（下摆相对上身抬得最高）；
 *       `dH`（下摆离地）pp **46.5 px**；`dHair`（发梢离地）pp **73.3 px**（= 1.58 × 下摆）；
 *       `hemW`（下摆横向跨度）pp **84.8 px**（均值 125.4，**+67.6%**），**max @0.65**。
 *     ⇒ 抬升峰距落脚 0.19 步（≈0.22 s）、外扩峰距落脚 0.65 步（≈0.76 s），
 *       **两者不同相** —— 这也是为什么下面要两条独立包络，不能合成一条。
 *   · 像素→米：白裙包围盒高 239 px ≈ 角色 1.62 m ⇒ **6.8 mm/px**
 *     ⇒ 下摆垂直 pp ≈ 0.32 m、头发 ≈ 0.50 m、横向跨度 ≈ 0.58 m。
 *
 * ★ 结构性根因（为什么以前完全没有这个动作）：改前所有次级运动通道
 *   （`SEC_FLARE` / `SEC_SIDE` / `SEC_HEM_*` / `SEC_SIDE_OSC`）都只由**角色水平速度**
 *   驱动，与「脚落地的时刻」没有任何锁相关系 ⇒ 匀速走路时它们全是常数，
 *   所以每步落地时不会有一次性脉冲。本组参数新增一条**由步态相位驱动**的通道。
 *
 * 回滚：`?secland=-1`（或 0）⇒ 幅度全 0 ⇒ 逐骨那段整块跳过、`landN` 恒 0，
 *       与改动前逐位一致。
 *
 * ★★ 定案参数（2026-10-26 实走标定，`?autowalk=1.446&hold=1` + `_tools\landprobe6.js`，
 *    每档 7 s 采样 / 24 相位桶 / 61 根下摆骨；目标来自参考视频 0.32 m / 0.58 m）：
 *    | secland | lowY pp（抬升） | 跨度 pp（外扩） |
 *    |   -1（OFF） | 0.0613 | 0.104 |
 *    |   14        | 0.2671 | 0.508 |
 *    | **16**      | **0.3218** | **0.527** |   ← 缺省
 *    |   18        | 0.3526 | 0.538 |
 *    ⇒ **16° 落点 0.322 m ≈ 目标 0.32 m**，跨度 0.527 m 略小于 0.58（外扩留给 `seclandspread`
 *      现场加，缺省 16×0.75 = 12°，调到 20 时跨度 0.488 / 调到 34 时 0.712）。
 *    ⚠️ `secstiff` 不要跟着调：裙摆的 `stiff = stiffness * 0.75`（`secondaryMotion.ts:1114`），
 *      `secstiff 11→22` 会让 lowY pp 从 0.352 跳到 0.581（同一 `secland=18`）—— 刚度比角度更猛。
 *
 * ═══ ★★★ 第二十轮（2026-10-26）：上面那套 16°/12° 的定标**已不适用**，缺省改为
 *      抬升 8° / 外扩 2°。原因不是参考视频变了，而是**那条通道的选骨范围变了**：
 *      第十九轮 `collectPieceSel()` 用「骨名 → 所有同名骨」反查材质归属，
 *      把整片布通道的骨数从真实的 200 根污染到 479 根；本轮改成按 **skeleton 对象
 *      同一性** 一对一映射后，落脚脉冲分摊的骨从「一堆假披风骨」回落到真裙骨，
 *      同样的角度写出了**2.6 倍**的位移量。
 *
 *      本轮实测（`_tools/lowyscan.js`，`?autowalk=1.446&hold=1`，10 s，
 *      `lowY pp` = 全圈下摆骨尾最低高度的峰谷差；参考视频目标 **0.32 m**）：
 *        | 参数                      | lowMin | lowMax | pp    |
 *        | 三条通道全关（基线）       | 0.0655 | 0.2027 | 0.137 |
 *        | 抬升 16 / 外扩 12（旧缺省）| 0.1975 | 1.0282 | 0.831 |  ← 掀到腰高
 *        | 外扩 0（只留抬升 16）      | 0.1786 | 0.5274 | 0.349 |
 *        | 抬升 0（只留外扩 12）      | 0.1990 | 1.0264 | 0.827 |  ← **抬升几乎不起作用**
 *        | 外扩 2 / 4 / 6 / 8 / 12    | —      | 0.572/0.625/0.691/0.805/1.026 | pp 0.414/0.445/0.485/0.596/0.843 |
 *      ⇒ 两个结论（都是读数，不是推理）：
 *        ① **抬高裙摆的是「外扩」不是「抬升」**——外扩关掉 pp 掉到 0.349，抬升关掉 pp 仍 0.827。
 *           这正是 §1.16.3 那条几何原理的另一面：下垂链绕开 θ，竖直分量 ∝ cosθ 变小（=抬高），
 *           所以外扩本身就是抬高；两者不该给同一个权重。
 *        ② 取 **外扩 2° + 抬升 8°** ⇒ `lowMin 0.1885 / lowMax 0.5691 / pp 0.381`，
 *           最接近参考目标 0.32，且 `lowMax` 从 1.03 降到 0.57（下摆不再被掀到腰）。
 *
 * ★ 第二轮定标（同日，把第十九轮通道整体删干净之后）：上面那组 8°/2° 是在
 *   「piece/thigh 通道还在」的构建上量的。通道删掉后，落脚脉冲不再与它们抢同一批骨，
 *   **同样的角度小了**：`pp` 从 0.456 掉到 0.176。重新扫外扩（抬升保持 8°）：
 *     | `?seclandspread=` | 4 | **6** | 8 | 10 |
 *     | `lowMin / lowMax` | 0.155/0.367 | **0.198/0.497** | 0.220/0.634 | 0.234/0.738 |
 *     | `pp`             | 0.212 | **0.299** | 0.414 | 0.504 |
 *   ⇒ 定案 **外扩 6°**（`pp 0.299` vs 参考 0.32，`lowMax 0.497` 仍在腰以下）。
 *   ⚠️ 教训：**定标必须在最终构建上做**。通道增删会改变同一批骨的分摊，
 *      在中间态量出来的缺省值换到成品上就是错的（这一轮踩了两次）。
 */
const SEC_LAND = QNUM('secland', 8)!;
const SEC_LAND_LIFT = QNUM('seclandlift', SEC_LAND)!;
/* ★ 外扩缺省**不再**跟 `secland` 成比例（旧式 `SEC_LAND * 0.75`）。
 *  两者量纲相同但作用完全不同（见上面 ① 的读数），绑在一起调必然一个过头一个不够。 */
const SEC_LAND_SPREAD = QNUM('seclandspread', 6)!;
const SEC_LAND_HI = QNUM('landhi', 0.45)!;
const SEC_LAND_LIFT_PH = QNUM('landlandph', 0.0)!;
const SEC_LAND_SPREAD_PH = QNUM('landspreadph', 0.62)!;
const SEC_LAND_LIFT_W = QNUM('landliftw', 0.05)!;
const SEC_LAND_LIFT_D = QNUM('landliftd', 0.12)!;
const SEC_LAND_SPREAD_W = QNUM('landspreadw', 0.30)!;
/** 头发相对裙摆的额外增益（参考视频 `dHair` pp 是 `dH` 的 1.58×） */
const SEC_LAND_HAIRK = QNUM('landhairk', 1.35)!;
const SEC_HAIR_SOLVE = QNUM('hairsolve', 0)!; /* ★ 第四十四轮：0 = 头发纯动画（第五版姿态），1 = 恢复解算 */
const SEC_HAIR_FLOOR = QNUM('hairfloor', 1.52)!;
/**
 * **诊断专用：把落脚相位钉死在指定值**（0..1，缺省 `null` = 不钉，走真实 `dist`）。
 *
 * 为什么必须有：落脚脉冲是**相位驱动**的，但真机是连续走的 —— 想「看相位 0.0 那一帧」
 * 只能靠碰运气截到。有了它就能 `?tfreeze=1&seclandph=0.0` 与 `?seclandph=0.65`
 * 各出一张图，做**逐像素 A/B**，也能和参考视频的相位折叠读数直接对照。
 *
 * ⚠️ 只在诊断时给：缺省 `null` ⇒ 行为与没有这个旋钮逐位一致。
 * ⚠️ 钉住相位时 `landPulse` 是常数 ⇒ 布料会收敛到「该相位的稳态姿态」，这正是出图要的。
 */
const SEC_LAND_PH: number | null = QSTR('seclandph') !== null ? (QNUM('seclandph', 0) ?? 0) : null;
/**
 * ★★★ 侧展角随摆臂**往复**（用户 m12388）。
 *
 * 原话：「袖子侧展其实我们已经做了 8°，不过没有随着摆臂而向外摆动，我是这个意思，
 * 就是说，可以随着行走时摆臂动作，加入一定角度的往复运动，比如 8° 到 10° 再到 8° 这样」。
 *
 * ⇒ 语义不是「加大 8°」，而是在已验收的 8° 基准上叠一个**跟着摆臂相位**的往复量。
 *   `?secsideosc=<度>`  往复振幅，缺省 **2**（⇒ 8° ↔ 10°）；`<= 0` 关（逐位回到十六轮的常量侧展）。
 *   `?secsideoscref=`   相位归一的参考幅值，缺省 **0.35**（走路时前臂前后投影的典型峰值）。
 *
 * 相位源用「该侧前臂方向在前后轴上的投影」，不用 `sideRollNorm`
 * —— 后者量的是手臂**侧向角速度**，MMD 走路动画里恒为 0（这正是「有 8° 但不往复」的根因）。
 * 左右两侧自然反相（走路一前一后），所以两片袖子不会互相抵消。
 */
const SEC_SIDE_OSC = QNUM('secsideosc', 0)!;
const SEC_SIDE_OSC_REF = QNUM('secsideoscref', 0.35)!;

/* ═══ ★★★ 第二十一轮：披风/带「整片同向飘」 + 裙子被大腿顶起（用户 m01984）═══
 *
 * 这两项在第十九轮做过一次，但被用户否掉（「衣摆整体坏了，走路到处乱飘，停下拧成一团」）。
 * 根因不是通道本身，而是三处**实现细节**（第二十轮已逐一取证，见 `继续任务.MD` §1.18.1）：
 *   ① `pieceBaseDir`/`thighBaseDir` **只写不清零** ⇒ 增量跨帧累积（乱飘 + 拧成一团）；
 *   ② `collectPieceSel()` 按骨名扩散 ⇒ 选骨从 200 根膨胀到 479 根（整圈裙都被转）；
 *   ③ 落脚脉冲的「抬高」其实是外扩在抬（与本轮两项无关，但同批骨会互相抢）。
 * 本轮在**已修好 ①② 的基线**上重做，所以那三处都不再成立。
 *
 * ── 判定「整片同向」的量（`_tools/piecescan.js`）────────────────────────────
 *   `capeCorr` / `ribCorr` = 披风 / 带「左片平均侧向位移」与「右片」的相关系数。
 *     **同向应 > 0**；OFF（`?secpiece=-1`）时实测 **−0.95 / −0.98**（各走各的）。
 *   ⚠️ 只用这个判据会把「同向」优化成「同向地乱飞」——
 *     第十九轮就是这样定到 25° 的：corr 0.97 好看，但下摆被掀到 1.12 m（腰高）。
 *     所以必须配第二个判据 `lowMax` = 整圈下摆骨尾最低高度跨帧最大值
 *     （裙子被整体抬到多高；贴腿下垂时 0.5 m 量级）。
 *
 * ── 定案读数（本轮实测，不是抄的）──────────────────────────────────────────
 *
 * ① 整片布（`?secpiece=`，扫描时 `secthigh=-1` 只开这一条）
 *    判据 A = `capeCorr`/`ribCorr`（左右两片侧向位移相关，**同向应 > 0**）；
 *    判据 B = `devMean`（布料偏离静止方向的平均角，太大就是「同向地乱飞」）。
 *    | secpiece | capeCorr | ribCorr | devMean | 说明 |
 *    |   -1（OFF）| **−0.297** | **−0.888** | 8.75 | 各走各的（基线） |
 *    |    4      | 0.489 | 0.402 | 12.59 | 太弱 |
 *    |    8      | 0.848 | 0.840 | 15.92 | 已同向 |
 *    | **12**    | **0.937** | **0.907** | 20.25 | ← 缺省 |
 *    |   16      | 0.943 | 0.909 | 21.23 | 与 12 同级，但偏离更大 |
 *    |   20      | 0.940 | 0.829 | 22.90 | 带开始过头 |
 *    |   25      | 0.904 | 0.845 | 23.50 | 相关性反而回落 |
 *    ⇒ 取 **12°**：两条判据都过 0.90，且 `devMean` 还没起飞。
 *    ⚠️ 第十九轮定 25° 是因为**只看 corr**（0.97 好看），结果下摆被掀到 1.12 m。
 *       本轮 `lowMax` 对这条通道**不敏感**（0.618→0.619），因为材质按对象同一性修好后，
 *       这条通道只转披风 57 + 带 143，**不碰整圈裙摆** —— 这本身就是「乱飘」已消除的证据。
 *
 * ② 裙子被大腿顶起（`?secthigh=`，扫描时 `secpiece=-1` 只开这一条）
 *    口径 = **定相位 ON/OFF 差量**（`_tools/thighdelta.js`）。
 *    ⚠️ 不能用 `corr(tipF, thighAmt)` 时间序列：走路动画本身就让裙骨前后摆，
 *       幅度远大于注入量 ⇒ 相关系数被稀释到 0 附近（实测 0.03~0.10，**测不出不等于没做**）。
 *    | secthigh | dF_pp（前后） | corr(dF, amt) | dU_pp（上下） |
 *    |   -1（OFF）| — | — | — |
 *    |    28     | 0.1132 m | **+0.748** | 0.0471 m |
 *    | **44**    | **0.1281 m** | **+0.730** | 0.0963 m | ← 缺省 |
 *    |    52     | 0.1262 m | 0.722 | 0.1124 m |
 *    |    60     | 0.1414 m | 0.708 | 0.1355 m |
 *    ⇒ 取 **44°**：前后位移已接近饱和（再加大只涨「上下」），相关仍 0.73。
 *    ⚠️ **符号必须实测**：`?secthsign=-1` ⇒ corr **−0.879**（腿往前、裙往后 = 会加重穿模）；
 *       `+1` ⇒ **+0.730**。缺省 **+1**。
 *    ⚠️ 相位 0.75~0.875 区间 `amt=0` 时 `dF≈0` —— 站定/低驱动时**确实不顶**（对）。
 */
const SEC_PIECE = QNUM('secpiece', 12)!;
/* ★ 第二十九轮（用户 m06677「8号布料回滚步态V3的备份」）：
 *  带吃 piece 通道的系数。V3 的 secondaryMotion.ts 里 `pieceSel` 命中 0 处 ⇒
 *  V3 根本没有这条通道；「回滚 8号」= 系数 0。第二十五轮口径是 0.65。 */
const SEC_PIECE_WRIB = QNUM('secpiecewrib', 0)!;
/* ★★★ 第二十二轮：`piecePh` = **0**（配 `cos(2π·stepPhase)`，见 `secondaryMotion.ts` 的推导）。
 *
 *  用户要求：「每一次落地，布料都会运动到左或右的最高点」（左右交替）。
 *
 *  **双视角实测**（背视 `走路——背.mp4` + 正面 `走路——正.mp4`，同一套掩膜口径）：
 *    · 落脚间隔 **1.15~1.17 s**（背视涟漪 1.150 / 正面涟漪 1.150~1.183）
 *    · **一个落脚区间内布料只走半个往复**（偏左 → 中立 → 偏右）
 *    · ⇒ 布料完整往复 = **2 个落脚区间 = 一个整圈 = 2.33 s**
 *    · 布料横向宽度 `hemW` 的峰与落脚**几乎同帧**（差 −0.05~+0.02 s）= 落地时上扬
 *
 *  实现：`pieceOsc = cos(2π·(stepPhase + ph))`，`ph = 0`：
 *    `stepPhase = 0`   ⇒ osc = **+1**（左极限，落地）
 *    `stepPhase = 0.5` ⇒ osc = **−1**（右极限，落地）
 *  ⇒ 每次落地都在极限、左右交替、**整圈连续无断点**。
 *
 *  ⚠️ 参考视频实测布料极限比落脚晚 +0.05~0.1 s。想要这个滞后：
 *     `?secpieceph=0.04`（相位单位 = 一步的分数；0.04 步 ≈ 0.06 s @ pace 0.80）。
 *     缺省取 0（落地即极限）是因为用户明确说「落地时到最高点」。
 *  ⚠️ 这个相位**与 `?pace=` 无关**（纯相位量，不涉及秒数）⇒ 调 pace 不用重算。 */
const SEC_PIECE_PH = QNUM('secpieceph', 0)!;
const SEC_THIGH = QNUM('secthigh', 44)!;
/** thigh 高度带（占裙摆自身竖直跨度的比例）—— 实测裙摆跨 y∈[0.40,1.80]，
 *  0.30~0.65 ⇒ y∈[0.82,1.31]，正好覆盖「裙最下部在大腿位置」那一段。 */
const SEC_THIGH_LO = QNUM('secthighlo', 0.30)!;
const SEC_THIGH_HI = QNUM('secthighhi', 0.65)!;
/** 前顶角的符号（`?secthsign=`，缺省 **+1**）。实测：`+1` corr +0.730 / `−1` **−0.879**。 */
const SEC_THIGH_SIGN = QNUM('secthsign', 1)!;

/* ═══ ★★★ 第二十二轮：披肩（cloth_map_view.jpg 编号4）整片摆动 ═══════════════
 *  用户原话：「编号4 你确实是向前摆动了，但是**只有最下部分摆动**。这布料是一个整体，
 *  不是上面不动下面往前动。而且**摆动幅度有点大**。」
 *
 *  为什么原来只有下部分动：披肩的骨挂在手臂父链上 ⇒ 被算进「袖骨」组，
 *  吃袖子的**高度减推** `hw = 1 − sideHiK·(1 − hn)`（`sideHiK` 缺省 0.55）。
 *  这是为「袖子别撞裙摆」设计的，对整片布不成立。
 *
 *  ⇒ 独立一片（材质 `披肩`，实测 **37 根**），**整片同权**（无任何高度权重），
 *    绕前后轴与披风/带**共用相位**（一起朝同一侧，视觉上是一整块），
 *    但**幅度单列且更小**：缺省 **5°**（披风/带是 12°）。
 *
 *  ⚠️ 与 `?secpiece=`（披风/带）是两个独立旋钮，互不影响：
 *     `?secshawl=5` 调披肩、`?secpiece=12` 调披风/带。
 *  ⚠️ 关掉披肩整片：`?secshawl=-1` ⇒ 披肩回到袖骨组按老样子动（只有下部分动）。 */
const SEC_SHAWL = QNUM('secshawl', 0)!;
const SEC_SHAWL_PH = QNUM('secshawlph', 0)!;
/* ★ 第二十八轮：披肩刚性整片（编号4「整片一起飘」）。
 *  `?secshawlrigid=0` 退回逐骨解算（旧行为）；`?secshawlrigidamp=` 摆幅（度，缺省 10）。
 *  摆幅**不乘 clothAmp** —— 用户常在 `?clothamp=0` 下工作。 */
/* ★ 第二十九轮：缺省改 0 —— 用户实测三个地址无可见变化，这条通道对观感无效，
 *  保留代码仅供以后排查。回滚到「开着」= `?secshawlrigid=1`。 */
const SEC_SHAWL_RIGID = QNUM('secshawlrigid', 0)!;
const SEC_SHAWL_RIGID_AMP = QNUM('secshawlrigidamp', 10)!;
/* ★ 第二十九轮：披肩**整片前移**（编号4）。
 *  `?secshawlpush=` 度数（缺省 0 = 关；量程 [0,75]）；
 *  `?secshawlpushsign=` ±1 定方向（几何约定要实测）；
 *  `?secshawlpushosc=` 走路时叠加的小幅摆动（度，缺省 2，量程 [0,30]）。 */
/* ★ 第二十九轮定缺省：5°。依据 = 三维最近距离扫描（_tools/u29_clip.js）：
 *  0° 走动时披肩与左足>左ひざ 最近仅 **0.9 mm**（穿大腿）；
 *  2° 17 mm / 3° 51 mm / **5° 75 mm** / 10° 127 mm / 14° 157 mm。
 *  用户要「幅度尽量小」⇒ 取 5°（消除穿模且留 75 mm 余量）。
 *  ⚠️ 开启后仍乘 `gaitW`：站定为 0、起步 0.35 s 渐入，不会一直撑着。
 *  逐位回滚 = `?secshawlpush=0`。 */
/* ★ 第三十一轮：随 `secholdshawl` 一起从 5 抬到 15。
 *  push 负责「整块甩到大腿前面之外」，hold 负责「别乱飘」；hold 抵消前移，push 补回来。
 *  实测间隙：push5+hold0.85 只剩 21 mm，push15+hold0.85 回到 111 mm（静立）/ 130 mm（走动）。 */
const SEC_SHAWL_PUSH = QNUM('secshawlpush', 30)!;
/* 第三十四轮定档 30°：实测走 600 帧，4 号披肩整体前移量（相对站定 tipF 中位 0.1357 m）
 *   push= 0 → 0.0640（−72 mm，甩在身后）   push=20 → 0.1389（+3 mm）
 *   push=30 → 0.1613（+26 mm，在身前）      push=40 → 0.1859（+50 mm）
 *   同时大腿间隙 gapMin：0 → 1.3 mm / 20 → 18.6 mm / **30 → 33.7 mm** / 40 → 74.8 mm。
 *   30 是「前移看得见 + 间隙已过 20 mm 安全线」的交点；40 起前移过头会像围裙。 */
/* 为什么是 10 而不是 35：`push` 只负责「整片往前推」避开大腿，实测 push>=10 后间隙已到地板，
 *  再加大反而把摆幅从 26mm 抬到 63mm（push=35 实测 oscMax 0.0632），得不偿失。 */

const SEC_SHAWL_PUSH_SIGN = QNUM('secshawlpushsign', 1)!;
const SEC_SHAWL_PUSH_OSC = QNUM('secshawlpushosc', 2)!;
/* ═══ ★★★ 第二十四轮：四片布的总幅度乘数（`?clothamp=`，缺省 1）═══════════════
 *
 *  用户原话：「有些布料的运动幅度太大了，cloth_map_view.jpg 中的编号 1、4、6、8。
 *  这几个布料缩小运动（摆动）幅度。**准备一个参数，缩不同的程度我实机对比再定**。」
 *
 *  一处管四片（编号对照 `_tmp_preview/r16/cloth_map_view.jpg`）：
 *    1 袖   → `?secside=`（侧张角，缺省 60°）＋ `?secsideosc=`（摆臂往复，缺省 2°）
 *    4 披肩 → `?secshawl=`（缺省 5°）
 *    6 披风 ┐
 *    8 带   ┘ → `?secpiece=`（缺省 12°；带在逐骨那段另乘 0.65，比例不变）
 *
 *  ⇒ 最终幅度 = 各自的单通道值 × clothAmp。**乘数不是绝对值**：
 *     `?clothamp=0.5` 就四片全减半、`?clothamp=1` 回到第二十三轮原状、`?clothamp=0` 全关。
 *
 *  ⚠️ 缺省取 **0.35**（用户要「缩小」，所以缺省就得是缩过的；0.5 实测肉眼看不出，
 *     见 `_logs/round24/REPORT2.md` 的像素差与 `dev` 读数）。量程夹在 **[0, 3]**：
 *     `=1` 回滚到第二十三轮原状、`>1` 可放大做对照、`=0` 全关。
 *     而不是把 12°/5°/60° 这些实测定案值直接改小 —— 那些数是前几轮**逐档实测**出来的
 *     （披风 12° 是「左右同向 corr≥0.7 且 lowMax 不涨」双判据扫出来的，
 *      袖 60° 是第十二轮才从 52 抬上去的），改它们等于推翻已验收值且不可回滚。
 *     乘数模型的好处：任何时候 `?clothamp=1` 都能逐位复现第二十三轮。
 *  ⚠️ 五个实测档（`_tools/clothamp.js`，见 §1.22.2）：1 / 0.75 / 0.5 / 0.35 / 0.2
 *     —— **严格线性**（误差 ≤0.01°），实机挑一档回来把这里定死即可。 */
const SEC_CLOTH_AMP = Math.max(0, Math.min(3, QNUM('clothamp', 0.35)!));
/* ★★★ 第二十四轮 v3：**头发径向让位的目标间隙**（米，`?hairsep=`，缺省 0.02；0 关）。
 *
 *  用户 m02740：「你看图的时候没发现头发穿模衣服了吗？」—— 确实穿了，而且我漏看了。
 *
 *  实测（`_tools/hairclash.js` + `_tools/hairradial.js`，5181）：
 *    · `hairClash` 最近距离 **0.3 mm**（`Bone_Hair12_R × Skirt_3_12`），已互穿；
 *    · 按高度分桶的径向半径：**1.0 m 处 头发 0.230 m / 裙 0.227 m** —— 同一空间。
 *    · 已有的 `?secrepel=` 扫了 4 档（0.010/0.025/0.050/0.080）**无效**，
 *      minDist 反而从 0.7 mm 掉到 0.2 mm：它按骨棒最短距离推，方向可能是竖直的。
 *
 *  ⇒ 换成**径向分层**：头发把自己推到「同高度带内布骨最大半径 + hairsep」之外。
 *    只动头发，布料一根都不动（否则会把裙吹起来，用另一个 bug 掩盖这个）。
 *  ⚠️ **缺省 0 = 关**（本通道尚未验证有效）。第一版实测 `?hairsep=` 0/0.02/0.04/0.08
 *     四档的 `hairClash.minDist` 是 0.9 → 0.3 → 1.1 → 0.7 mm，**不单调**，不能当已修好。
 *     现在已升级成「写回阶段增量四元数」（同 shawl/land 那套），待重测出单调改善再打开。
 *  回滚：`?hairsep=0`。 */
const SEC_HAIRSEP = QNUM('hairsep', 0)!;
/** ★ 第二十二轮：布料通道「起步渐入」的时长（秒，`?gaitfade=`，缺省 0.35）。
 *  起步后布料在这么长时间内从 0 线性升到满幅，避免「啪一下出现」的抽动。
 *  `?gaitfade=0` ⇒ 回到旧硬开关（逐位复现改前）。 */
const GAIT_FADE_SEC = QNUM('gaitfade', 0.35)!;

const SEC_ROWS = QNUM('secrows', 0)! > 0;
/**
 * 定格取证时的**布料暖机时长**（秒，缺省 10）。
 *
 * `?tfreeze=1&animt=<t>` 把动画钉死 ⇒ 弹簧骨的父骨一动不动 ⇒ `dir` 会以
 * `1/stiffness ≈ 0.13 s` 的时间常数收敛回动画姿态，肉眼看就是「没有布料」。
 * 所以定格帧要先**循环回放** `?secpre=` 秒动画、每步 1/60 积分一次弹簧骨，
 * 最后一步落在 `t` 上，然后**停止积分**把结果定格。
 * ⇒ 同一组 `?tfreeze=&animt=` 每次得到完全一样的布料状态，可做逐像素 A/B。
 */
const SEC_PREROLL = QNUM('secpre', 10)!;
/** ★★★ `?seclock=<秒>`：把动画姿态钉死、但布料**每帧照常积分**（见 `:3246` 的长注释）。
 *  与 `?tfreeze=`/`?animt=` 的区别只有一条：**不置 `secFrozen`** ⇒ 逐帧 `updateSecondary`
 *  不会被跳过。做「袖子侧摆」这类依赖速度信号 + 每帧积分的 A/B 时必须用这个。 */
const SEC_CLOCK = QNUM('seclock')!;

/* ── MMD Bullet 物理解算（用户 m08676 任务3(2)：「走路时衣服穿模。加入物理解算」）─
 *
 *  ?physics=0        关掉，退回纯骨骼一阶滞后（`secondaryMotion.ts`，A/B 对照用）
 *  ?physurl=         后端脚本 URL（缺省 `/mmd/mmd_bullet.js`）
 *  ?physfix=<秒>     固定步长（缺省 1/60 = MMD 原生）
 *  ?physsub=<n>      每帧最多子步数（缺省 4）
 *  ?physwrap=<秒>    手动指定单调时钟的回绕周期（缺省 = 整数个循环，见下）
 *
 *  ══ 为什么以前不敢开 ══
 *  上一轮我在 `secondaryMotion.ts` 文件头写下的理由是：「物理要求动画时钟单调递增，
 *  而我们的循环必须取模 ⇒ 每个循环物理都会被判定为 `seeking` 并**重新播种**、
 *  头发会在回绕那一帧弹回去 —— 0.94 Hz 的规律抽搐，比不动更糟」。
 *  这句话本身是**对的**，判据在 `dist/runtime/core.js:564`：
 *      seeking: this.previousEvaluateSeconds === undefined
 *            || this.state.seconds < this.previousEvaluateSeconds
 *  只要「时间不往回走」就不会 seek。
 *
 *  ══ 绕开的办法：单调时钟 + 整数循环回绕 ══
 *  非冻结时不再每帧算 `t = phase × LOOP_DUR`，而是算**单调递增**的
 *      tMono = (dist / STRIDE) × LOOP_DUR / ANIM_SPEED      ← dist 只增不减
 *      t     = tMono mod physWrap
 *  `physWrap` 取 `floor(maxFrame / cycleFrames) × cycleFrames / 30`：
 *  `mahlazer.vmd` 是 40 帧一循环、maxFrame 951 ⇒ **920 帧 = 30.667 秒**。
 *  因为 VMD 每 40 帧重复一次，绕前（帧 920）与绕后（帧 0）**姿态逐位相同**
 *  ⇒ 回绕那一帧唯一的不连续只是「布料速度」，每 30.7 秒一次、肉眼不可见。
 *
 *  ⚠️ 而且姿态一点没变：`t mod LOOP_DUR` 恒等于旧的 `phase × LOOP_DUR / ANIM_SPEED`，
 *     所以这次改动的**唯一**视觉效果就是「布料开始真的解算了」。
 *
 *  ⚠️ 定格帧（`?tfreeze=` / `?animt=`）不能直接把时钟钉住 —— 那 `deltaSeconds` 恒为 0，
 *     布料会停在绑定姿势、看起来比一阶滞后还糟。所以定格帧先用**同样的定步**
 *     把物理从 0 顺推到 t（最后一步正好落在 t），再定格 ⇒ 图里看到的也是解算后的布料。
 */
const PHYSICS_ON = QNUM('physics', 1)! > 0;
/**
 * 物理后端选择：`spring`（**默认，实测可用**）| `bullet`（已判死，留档做对照）| `none`。
 *
 * ★ 三档实测结论（别再重走一遍）——**缺省是 `none`**，布料交给「我们自己的弹簧骨」：
 *
 *   `'external'`（Bullet wasm）—— **已判死**。
 *     `public/mmd/mmd_bullet.wasm` 是 **ALLOW_MEMORY_GROWTH=0** 的构建
 *     （Memory 段 `min=1024 max=1024` 页 = 64 MB 死上限，JS 侧 `_emscripten_resize_heap`
 *     是无条件 `abort("OOM")` 的存根）。我把 wasm 的 max 改成 16383 页、把 JS 换成真正的
 *     `wasmMemory.grow()` 之后堆确实能长（64→75→90→120→200 MB），但立刻暴露后两个硬伤：
 *       ① 堆一长，`HEAPF32` 之类缓存的视图就 detach ⇒ `feedBodies` 抛
 *          `TypeError: Cannot perform %TypedArray%.prototype.set on a detached or out-of-bounds ArrayBuffer`；
 *       ② **单步 150–290 ms**（607 刚体 / 956 关节）。60 帧需要 16 ms/步 ⇒ 差一个数量级。
 *     它还有个坐标系陷阱：`dist/runtime/physics.js:341-353` 抽的是 `bone.matrixWorld`
 *     （真·世界矩阵），而 PMX 的刚体/关节是**模型网格单位、以模型原点为基准**；
 *     我们给角色加了缩放（`CHAR_H / 20.52 = 0.07895`）之后刚体坐标差 12.66 倍 ⇒ 一步炸开。
 *     这个坑用 `pushModelSpace()` 绕过去了（保留），但前两条已经足够判死。
 *
 *   `'spring'`（加载器内置纯 JS 弹簧）—— **也不能用**。用户 m09585 看到的
 *     「衣服头发是固定的」就是它：`dist/runtime/core.js:451-473` 的 `stepStatefulSpringPhysics()`
 *     **只写 `bone.position`、从不碰 `bone.quaternion`**，而裙摆/头发是**纯旋转驱动**的骨架
 *     ⇒ 等于把这些骨推回静止位置。更糟的是 `dist/three/index.js:165-170`：
 *     `canCreateImplicitMmdAnimRuntime()` 里有 `&& this.options.runtime?.physics !== "stateful-spring"`
 *     ⇒ 选它还会**关掉快的 WASM 运行时**、退回慢的 JS 运行时。
 *     只留给 `?physmode=spring` 做 A/B 对照。
 *
 *   `'none'`（**缺省**）—— 加载器完全不跑物理，于是能走**快的 WASM `MmdAnimRuntime`**；
 *     布料由 `secondaryMotion.ts` 的 Verlet 弹簧骨接管（在动画姿态之上叠一个世界空间偏转）。
 *
 * ⚠️ 另一条被排除的路：`HostRigPhysics`（`dist/runtime/hostRigPhysics.js`）的 `step(before, output, mask)`
 *    同样直接吃**世界矩阵**（`this.context.inputWorldMatricesColumnMajor = before`），
 *    不做坐标归一 ⇒ 它解决不了「模型被缩放后刚体坐标全错」那个坑，不是替代品。
 */
const PHYS_MODE = (QSTR('physmode') ?? 'none').toLowerCase();
const PHYS_FIX = QNUM('physfix', 1 / 60)!;
const PHYS_SUB = QNUM('physsub', 4)!;
const PHYS_WRAP_OVERRIDE = QNUM('physwrap', 0)!;
const PHYS_URL = QSTR('physurl') ?? '/mmd/mmd_bullet.js';
/**
 * `?secvelx= ?secvelz=` 直接指定「假装在走」的水平速度（米/秒），**用于静态验收**。
 *
 * 为什么需要它：全图 `img-diff` 在这个场景里**证明不了头发在动** ——
 * 草是带风摆动画的，同一 URL 连拍两次都能差 43%（实测），
 * 人物的头发变化完全被淹掉。
 * 而 `?tfreeze=` 能把草和光照钉死（`WorldController.tsx:151`、`DirectionalLight.tsx:94`），
 * 于是「只改 `?secvelz`」的两张图**差异只可能来自次级运动**，
 * 这才是 判据 A「做视觉 A/B 前先冻结时间与随机种子」的正确用法。
 */
const SECV_X = QNUM('secvelx', 0)!;
const SECV_Z = QNUM('secvelz', 0)!;
const SEC_VEL_ON = QSTR('secvelx') !== null || QSTR('secvelz') !== null;

/* ===== 步态的「像不像她本人」（用户 m06469 问题 4）=====
 *  上一轮我只修了「碎步 / 抽搐 / 滑行」三个**机械故障**，步态**形状**还是
 *  通用 MMD 走路（手上这份 `walk.vmd` 出自十六夜咲夜的配布）。
 *  用户指出「走路姿态不对」。抓她实机演示的帧（B站 `BV1mYSeBaEmY`
 *  0:36 的侧面机位，`_logs` 里也留了 `frame_005.jpg`）后，真实步态是：
 *
 *      前倾 · 手臂垂在身侧偏后**不摆** · 上半身**不扭** ·
 *      绷脚背（脚尖朝下、**没有脚跟着地的滚动**）· 上下颠簸很小 · 整个人飘过去
 *
 *  而 standard MMD walk（LearnMMD 那一派）恰好全反：抬臂甩手、脚跟着地→压趾滚动、
 *  躯干扭转、每步一颠。两边对不上，所以观感「不对」。
 *
 *  ⇒ **不改模型、不重做动作**，用 `_tools/vmd-gait.py` 在四元数上就地改造：
 *      · 手臂/躯干/颈 ：把每个关键帧朝该骨的「平均姿势」做 slerp 收敛
 *                       （平均姿势 = 手臂自然垂下 ⇒ 压掉的是**甩动**，不是姿势）
 *      · 脚踝/膝盖     ：朝**绑定姿势**收敛 + 右乘一个固定角度的绷脚背
 *      · センター 位移 ：Y（上下）压到 0.30、Z（前后）压到 0.50
 *      · 腿的步幅**不动**：原地走里支撑脚是相对身体向后滑的，压短 IK 会让脚
 *                         在世界里向前「溜冰」。步幅要改就改 `?stride=`。
 *    成品 = `public/columbina/walk_glide.vmd`（与输入**等长**：只改 float，
 *    帧数/插值曲线/骨骼轨道全部原样搬运）。
 *  `?gait=raw` 回到改造前，用来出对照图。
 */
/**
 * 走路时整个身体的前倾角（度）。实拍里她是明显前倾着飘的。
 * 用户 m07189 补充：**跑步和走路的本质一样**（单脚蹬地→飘→空中换腿），
 * 区别只在幅度、腿部动作和节奏 ⇒ 所以跑步不该另接一套动作，而是走同一套
 * 机制、把 `CYCLE_SEC`（节奏）和步幅调快调大即可。
 * 14° 是按 `_logs\ref_body.png`（实机侧面 6 fps 连拍）目测定的，`?lean=` 可调。
 */
const LEAN_DEG = QNUM('lean', 0)!;
/**
 * 静态看步态的起始相位 [0,1)。配合 `?tfreeze=` 用：
 * `tfreeze` 会把播放头钉在**绝对时间** `T_FREEZE`（可复现），
 * 但只要显式给了 `?phase0=`，就改按相位定格 —— 于是
 * 「`?phase0=0.25&tfreeze=1`」能一格一格地看循环的 1/4 处，
 * 不用真跑起来。**必须区分「没给」和「给了 0」**，所以存的是 null 而不是 0。
 */
const PHASE0: number | null = QSTR('phase0') !== null ? (QNUM('phase0', 0) ?? 0) : null;
/**
 * **直接钉住播放头（秒）** —— 看**非循环的长动作**时用。
 *
 * 为什么必须有它：`?phase0=` 算的是 `phase0 * LOOP_DUR`，而 `LOOP_DUR` 缺省只有
 * 32/30 = 1.067 s（`walk.vmd` 一个循环）。`mahlazer.vmd` 是 **951 帧 / 31.7 s**
 * 的一条长动作，用 `?phase0=` 无论给多少都只会在**头 1 秒**里打转。
 * 有了它就能 `?animt=8.5&tfreeze=1` 直接看第 8.5 秒那一帧。
 */
const ANIM_T: number | null = QSTR('animt') !== null ? (QNUM('animt', 0) ?? 0) : null;

/* ===== 摘眼罩 / 闭眼（用户 m06469 问题 1）=====
 *  用户要「眼罩摘掉，或者直接闭眼」。查下来正好两条路都通：
 *   · `少女.pmx` 里有 `Mask Off`（morph #61）与 `shoes off`（#60）两个
 *     **材质变形（type=8）**，本质是把 `[24] 眼罩` 材质的 diffuse alpha 乘 0。
 *     但 `@yohawing/three-mmd-loader` 的运行时**零消费者**（`materialOffsets`
 *     全包只有解析器在写，没有任何地方读）⇒ **播不了**，只能自己实现。
 *   · 好消息是**手改材质能稳住**：TSL 路径下 `material.userData.mmdMaterialState`
 *     恒为 undefined（`webgpu/material-assembly.js` 从不把状态写回 userData，
 *     于是 `pipeline.js` 每帧的 `if (materialState)` 为假），所以
 *     `material.visible = false` 会被持久保留（`?mmdhide=9` 已验证过这条路）。
 *   · 而她的脸部贴图 `tex\顔.png` **本来就是闭着眼的**（PMX 里没有眼球，
 *     `[3]白目/[6]目/[7]星目` 是另外几片） ⇒ 把 `[24] 眼罩` 摘掉就正好是
 *     用户说的「直接闭眼」，不用换 `少女_闭眼.pmx`。
 *  `?mask=1` 戴回去。
 */
const MASK_OFF = QSTR('mask') !== '1';

/* ===== 质感排查开关（都是无头验收用的，查完可以留，不影响缺省）=====
 *  ?mmonly=8,9        只显示列出的材质序号（其余 visible=false）
 *  ?mmdhide=9         隐藏列出的材质序号
 *  ?mmdint=1          单独给 MMD 管线一盏定向光的强度
 *                     （**不能**直接用场景那盏：它是 2.0，`syncLightUniforms` 每帧写
 *                      `lightColor = color × intensity`，2.0 会把镜面与 `litBase` 顶穿）
 *  ?sphfactor=0|1|2   强制球面贴图权重（`sphereTextureFactor` 的 alpha）。
 *                     加载器在 `material-assembly.js:190` 写的是
 *                     `sphereTexture ? [1,1,1,1] : [0,0,0,0]`，`material-core.js:65`
 *                     的 add 分支是 `base.add(sphere * rgb * a)` —— 只要 a 是 0，
 *                     「加算」这一层就**静默什么都不加**，只剩它自己的 diffuse
 *                     （`[9] 髮+` 的 diffuse 是近黑的 `tex\sp.png`）⇒ 整片头发被盖成黑。
 *                     这个开关就是用来验证这条链的。
 */
const MMD_ONLY = (QSTR('mmonly') ?? '').split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite);
const MMD_HIDE = (QSTR('mmdhide') ?? '').split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite);
const MMD_INT_OVERRIDE = QNUM('mmdint');
const SPH_FACTOR = QNUM('sphfactor');

/** 等 `SUN_REF` 有值（`<DirectionalLight>` 在 `<Suspense>` 里，可能比我们晚挂） */
function waitForSun(timeoutMs = 10000) {
    return new Promise<THREE.DirectionalLight>((res, rej) => {
        const t0 = performance.now();
        const tick = () => {
            const l = SUN_REF.current;
            if (l) return res(l);
            if (performance.now() - t0 > timeoutMs) return rej(new Error('等不到 DirectionalLight'));
            setTimeout(tick, 60);
        };
        tick();
    });
}

interface Live {
    pipeline: any;
    model: any;
    ready: boolean;
    /** VMD 的 `metadata.maxFrame`（`walk.vmd` = 1145）。用来做越界断言。 */
    maxFrame: number;
    /** 真 MMD Bullet 物理解算是否生效（用户 m08676 任务3(2)）。false ⇒ 退回纯骨骼一阶滞后。 */
    physics: boolean;
}

export function MmdCharacter({ visible = true }: { visible?: boolean }) {
    const groupRef = useRef<THREE.Group>(null);
    const setCharacterRef = useGameStore((s) => s.setCharacterRef);
    const isControlEnabled = useGameStore((s) => s.isControlEnabled);
    const { gl, scene, camera } = useThree();
    const live = useRef<Live | null>(null);
    /** 会场太阳 → MMD 专用光的每帧同步（位置/目标，不含强度） */
    const syncLight = useRef<{ sun: THREE.DirectionalLight; light: THREE.DirectionalLight } | null>(null);
    /** 走路状态（速度做了平滑，直接抄参考库的 `INITIAL_PHYSICS_STATE`） */
    const phys = useRef<PhysicsState>({ ...INITIAL_PHYSICS_STATE, walkSpeed: WALK_SPEED, runSpeed: RUN_SPEED });
    /** 动作播放头（**不是自己累加**，由「已走距离 ÷ 步长」的相位反推，见文件头走路那节） */
    const animT = useRef(0);
    /** 累计已走距离（米）。走路播放头唯一的输入。 */
    const dist = useRef(0);
    /** 越界告警只打一次，免得刷屏 */
    const warned = useRef(false);
    /** VMD 的 `metadata.maxFrame`（`walk.vmd` = 1145） */
    const maxFrameRef = useRef(0);
    /** 物理单调时钟的回绕周期（秒）。0 = 还没算出来。见 `PHYSICS_ON` 那一段。 */
    const physWrapRef = useRef(0);
    /** 定格帧的物理预推只做一次 */
    const physPrimed = useRef(false);
    /** 定格帧物理预推的**结束时间**（= t + 整数个循环）。重复帧必须喂同一个值才不会继续积分。 */
    const physEnd = useRef(0);
    /** 加载器当前采样到的 VMD 帧号（-1 = 还没跑过一帧）。见 gait().frame 的注释。 */
    const frameRef = useRef(-1);
    /** 走路时的前倾角（度），一阶滞后平滑；见 `LEAN_DEG` */
    const leanRef = useRef(0);
/** ★ 第二十二轮：布料通道的「起步渐入」权重（0 = 站定完全不跑，1 = 满幅）。
 *  见 `stepPhase` 写入处那段注释：硬开关会让起步那一帧布料突然抽一下。 */
const gaitWRef = useRef(0);
    /** ★ 2026-10-21 反馈3：涉水的**垂直沉降**（米，负值）。平滑后的当前值，
     *  每帧朝 `waterSinkAt()` 的目标 lerp，再并进 `groundY`（见贴地段）。
     *  为什么不直接写 `g.position.y`：贴地段会整段覆写 y，写在前面等于没写。 */
    const _sinkY = useRef(0);
    /** 腿部姿态重写用的六根骨 + 它们的绑定姿势（懒查找，见 `LEG_KEYS`） */
    const legRef = useRef<{
        thighL: THREE.Bone | null; thighR: THREE.Bone | null;
        kneeL: THREE.Bone | null; kneeR: THREE.Bone | null;
        ankleL: THREE.Bone | null; ankleR: THREE.Bone | null;
        bind: THREE.Quaternion[];
        q: THREE.Quaternion;
        tmp: [number, number, number];
    } | null>(null);
    /** 次级运动骨架（头发 / 披风 / 裙摆）。建在 `pipeline.attach` 之后。 */
    const secRef = useRef<SecondaryRig | null>(null);
    /**
     * 定格取证时布料已经「暖机」完毕 ⇒ 从这一刻起**停止积分**。
     *
     * 为什么必须停：`?tfreeze=1` 下弹簧骨的父骨一动不动，`dir` 会以
     * `1/stiffness ≈ 0.13 s` 的时间常数收敛回动画姿态。若继续积分，
     * 暖机出来的偏转会在半秒内被抹平，截图又变回「没有布料」。
     */
    const secFrozen = useRef(false);
    /** 上一帧 `group` 的世界位置，用来算水平速度（惯性甩尾的输入） */
    const lastPos = useRef(new THREE.Vector3());
    /** 这一帧的水平速度（米/秒），写进 `__mmd` 便于无头验证 */
    const vel = useRef({ x: 0, z: 0 });
    /** `lastPos` 是否已经初始化（否则首帧会算出一个巨大的假速度） */
    const posInit = useRef(false);
    /** VMD 自己驱动的骨名（这些骨不能被次级运动覆写，否则腿会被拖慢） */
    const animBones = useRef<Set<string>>(new Set());
    /* ── ★ 收尾（把最后一步走完）的状态 ── */
    /** 目标累计距离（米）。0 = 当前不在收尾。> 0 时 `dist` 要一直推到它 */
    const landRef = useRef(0);
    /** 收尾阶段的速度（米/秒） */
    const landSpeed = useRef(0);
    /** 上一帧真正的行走速度（用来判断「刚刚是在走路」以及收尾该用多快） */
    const prevSpeed = useRef(0);
    /** ★ `?autowalk=` 的**可变**副本：`window.__mmd.setAutoWalk(0)` 可以在运行中掐掉它，
     *  用来在无头环境里**模拟「松开 WASD」**（真人按键注入在无头里进不去，
     *  `CameraViewControl.tsx` 的 `isControlEnabled` 不会被键盘事件翻转）。 */
    const autoRef = useRef(AUTOWALK);
    /** 刚才是否由 `?autowalk=` 驱动 —— 掐掉之后还要再进一次收尾分支 */
    const autoWasOn = useRef(false);
    /** ★ 收尾**已经完成**：用于 `?landhold=` 冻住播放头（见 `LAND_HOLD` 注释）。
     *  再次走起来（`moving > 0.05`）会自动清掉。 */
    const landDone = useRef(false);
    /* ── ★ 站定姿势合成（用户 m11917 任务1，见文件头 `SETTLE_ON` 的长注释）── */
    /** 站姿合成进度 0..1（1 = 已经完成，腿全直） */
    const settleT = useRef(1);
    /** 站姿腿链（懒初始化）：骨 + 绑定四元数 + 脚骨，供接地补偿复用 */
    const standRef = useRef<{
        bones: THREE.Bone[];
        bind: THREE.Quaternion[];
        /** ★ 上半身（脊椎/肩/臂/手/头）的骨与绑定四元数（`?settlescope=1` 才非空）。
         *  和 `bones`（腿链）分开存：`settle().q8` 只报腿链，混在一起会让读数失去意义。 */
        bodyBones: THREE.Bone[];
        bodyBind: THREE.Quaternion[];
        /** 四根脚骨（左/右足首、左/右つま先）：接地补偿量的是它们的**最低**者 */
        feet: THREE.Bone[];
        /** ★ 报「两踝间距」用的左右踝各一根（优先取 `D` 变形骨，见下方注释） */
        sepL: THREE.Bone | null;
        sepR: THREE.Bone | null;
        /** ★ 接地补偿量 drop = 「腿链换成绑定姿势后最低脚骨的世界 y」−「动画姿势同一量」。
         *  同一帧、同一骨盆高度下量出来的**相对量** ⇒ 自动抵消 MMD 根骨（`グルーブ`）
         *  的 Y 位移。实测 −0.0308 m（站直后脚更低）。`null` = 还没定标。 */
        drop: number | null;
        /** ★★ 骨架对象本体，只为调 `skel.update()`（见文件里「为什么必须手动刷新骨架」注释）。
         *  742 根骨远超「骨矩阵走 uniform 数组」的 4 根阈值 ⇒ three 一定建了
         *  `Skeleton.boneTexture`，而 **WebGPU 的蒙皮采样的是这张贴图**，
         *  不是 `bone.matrixWorld`。写了骨四元数却不刷新它 = 白写（JS 骨架变了、画面没变）。 */
        skel: THREE.Skeleton | null;
    } | null>(null);
    /** ★★★ 上半身站姿的**目标四元数**，加载时算好（见文件头 `ARM_POSE` 的长注释）。
     *  为什么不在 `useFrame` 里懒初始化：采样要调 `model.update()`，它会把**每一根骨**
     *  的四元数按动画重写一遍（含布料骨）—— 放在渲染帧里做，那一帧的布料会被打回绑定
     *  姿势。加载时算则完全无副作用：第一帧的 `UPD(t)` 本来就要重写全体，布料也从那之后
     *  才开始积分。 */
    const bodyTargetRef = useRef<{ bones: THREE.Bone[]; target: THREE.Quaternion[] }>({
        bones: [], target: [],
    });

    /** ★★★ 站距（`?stance=`）的腿链链头，加载时解析一次（见文件头 `STANCE_DEG` 的长注释）。 */
    const stanceRef = useRef<{ bones: THREE.Bone[]; signs: number[] }>({ bones: [], signs: [] });
    const stanceQ = useRef(new THREE.Quaternion());
    const stanceAxis = useRef(new THREE.Vector3(0, 0, 1));
    /** 把 `?stance=` 的外张旋转**预乘**到每条腿链的链头上。
     *  调用点：`UPD()` 内部 —— 即每次动画求值之后、站定合成之前（顺序铁律见 `UPD` 注释）。
     *  预乘 = 在父坐标系里再转一次；父在前做 `updateWorldMatrix`，子骨靠遍历跟上来。 */
    const applyStance = () => {
        const S = stanceRef.current;
        if (STANCE_DEG <= 0 || S.bones.length === 0) return;
        const th = (STANCE_DEG * Math.PI) / 180;
        const q = stanceQ.current;
        const ax = stanceAxis.current;
        for (let i = 0; i < S.bones.length; i++) {
            const b = S.bones[i];
            q.setFromAxisAngle(ax, th * S.signs[i]);
            b.quaternion.premultiply(q);
            b.updateMatrix();
        }
        S.bones[0].updateWorldMatrix(true, false);
        for (const b of S.bones) b.updateWorldMatrix(false, true);
    };

    /** ★★★ 任务4（用户 m12279）：走路时把上臂轻微向外张。
     *  与 `applyStance` 同一调用点（`UPD()` 内部，动画求值之后），同一预乘手法。
     *  `armAbdT` 是 0→1 的平滑权重：站定 0、走动 1，时间常数 ~0.25 s。
     *  `ARM_ABD_DEG <= 0` ⇒ 整块不进（可回滚，逐位回到改动前）。 */
    const armAbdRef = useRef<{ bones: THREE.Bone[]; signs: number[] }>({ bones: [], signs: [] });
    const armAbdQ = useRef(new THREE.Quaternion());
    const armAbdAxis = useRef(new THREE.Vector3(0, 0, 1));
    const armAbdT = useRef(0);
    const applyArmAbd = (dtSec: number, movingNow: number) => {
        const S = armAbdRef.current;
        if (ARM_ABD_DEG <= 0 || S.bones.length === 0) return;
        const target = movingNow > 0.05 ? 1 : 0;
        const k = Math.min(1, Math.max(0, dtSec) / 0.25);
        armAbdT.current += (target - armAbdT.current) * k;
        const w = armAbdT.current;
        if (w < 1e-3) return;
        const th = (ARM_ABD_DEG * Math.PI) / 180 * w;
        const q = armAbdQ.current;
        const ax = armAbdAxis.current;
        for (let i = 0; i < S.bones.length; i++) {
            const b = S.bones[i];
            // A shallow outward bow at mid-swing, fading at both forward/back ends.
            let arcWeight = 0;
            const gg = groupRef.current;
            const armArcDegrees = S.signs[i] > 0 ? ARM_ARC_LEFT : ARM_ARC_DEG;
            if (gg && armArcDegrees > 0) {
                const wrist = bodyTargetRef.current.bones.find(wb => (wb.userData.mmdBoneName ?? wb.name) === (S.signs[i] > 0 ? '左手首' : '右手首'));
                if (wrist) {
                    wrist.updateWorldMatrix(true, false);
                    const wp = wrist.getWorldPosition(new THREE.Vector3());
                    const forward = (wp.x - gg.position.x) * Math.sin(gg.rotation.y) + (wp.z - gg.position.z) * Math.cos(gg.rotation.y);
                    arcWeight = Math.max(0, 1 - Math.pow((forward + 0.027) / 0.20, 2));
                    // Left forward sweep keeps its outward bow instead of returning inward.
                    if (S.signs[i] > 0 && forward >= -0.027 && QNUM('leftforwardhold', 1)! > 0) arcWeight = 1;
                }
            }
            q.setFromAxisAngle(ax, (th + armArcDegrees * arcWeight * Math.PI / 180 * w) * S.signs[i]);
            b.quaternion.premultiply(q);
            b.updateMatrix();
        }
        for (const b of S.bones) b.updateWorldMatrix(false, true);
    };

    // 站位**只设置一次**，不用 JSX 的 position prop。
    // 原因：`position={[...]}` 每次父组件重渲染（leva 一动就重渲）都会把角色弹回原点，
    // 而我们现在是会走路的。`useLayoutEffect` 在首帧渲染之前就跑，不会闪。
    useLayoutEffect(() => {
        const g = groupRef.current;
        if (!g) return;
        g.position.set(CHAR_POS[0], CHAR_POS[1], CHAR_POS[2]);
        g.rotation.y = CHAR_YAW;
        // 静态看步态用（见 `PHASE0` 注释）：把累计距离预置到指定相位。
        dist.current = (PHASE0 ?? 0) * STRIDE;
        // `?settleforce=1`：静态取证用 —— 假装收尾已经完成，让站姿合成立刻开始跑
        if (SETTLE_FORCE) { settleT.current = 0; landDone.current = true; }
    }, []);

    useEffect(() => {
        if (!MMD_ON) return;
        let dead = false;
        const log = (s: string) => console.log('[columbina] ' + s);

        (async () => {
            try {
                const sun = await waitForSun();
                if (dead) return;
                log(`光照=${sun.type} 强度=${sun.intensity} 颜色=#${sun.color.getHexString()}`);

                // ①′ MMD 专用的第二盏定向光。
                //     **不能**把场景那盏直接交给 MMD 管线：`syncLightUniforms` 每帧写
                //     `lightColor = light.color × light.intensity`，会场太阳是 intensity 2.0，
                //     于是 `lightColor ≈ (2.0,1.91,1.76)`，把 `litBase` 与镜面全顶穿。
                //     MMD 自己的默认值是 `MMD_TSL_DEFAULT_LIGHT_COLOR = 154/255 = 0.604`
                //     （`material-core.js:5`）—— 那才是「正确曝光」的量级。
                //     这盏灯**不加进 scene**（加进去会真的多照一遍全场），
                //     只在每帧把太阳的位置/目标拷过来 + 手动 `updateMatrixWorld`，
                //     因为 `syncLightUniforms` 只读 `matrixWorld` 里的位置。
                const mmdLight = new THREE.DirectionalLight(
                    sun.color.clone(),
                    MMD_INT_OVERRIDE ?? 1.0,
                );
                mmdLight.position.copy(sun.position);
                mmdLight.target.position.copy(sun.target.position);
                mmdLight.updateMatrixWorld(true);
                mmdLight.target.updateMatrixWorld(true);
                syncLight.current = { sun, light: mmdLight };
                log(`MMD 专用光 强度=${mmdLight.intensity}（?mmdint= 可覆盖）颜色=#${mmdLight.color.getHexString()}`);

                // ① pipeline：内部会 await renderer.init() 并校验真 WebGPU 后端，
                //    回退到 WebGL 会抛 MMD_TSL_PIPELINE_NATIVE_WEBGPU_REQUIRED（有用的哨兵）
                const pipeline = await createMmdTslPipeline(gl as any, {
                    light: mmdLight,
                    selfShadowEnabled: false,
                    // pipeline.js:103 `appendOutlineGroups: options.appendOutlineGroups !== false`
                    // ⇒ **默认是会加轮廓组的**。轮廓是一层放大壳，色 = 材质的 edgeColor。
                    // `?mmdoutline=0` 关掉它，用来排查「白剪影是不是这层壳」。
                    appendOutlineGroups: QSTR('mmdoutline') !== '0',
                });
                if (dead) { pipeline.dispose(); return; }
                log('pipeline 就绪');

                // ①′ 物理后端（用户 m08676 任务3(2)）：**必须在 `new ThreeMmdLoader` 之前**建好，
                //     因为它要从构造参数进 `DefaultMmdRuntimeOptions.physicsBackend`。
                //
                //     `loadCustomBulletMmdModule` 干的事就是往 `<head>` 插一个
                //     `<script src=scriptUrl>`，然后取 `globalThis.MmdBullet` 调它。
                //     而 `mmd_bullet.js` 是**相对脚本自身 URL** 去 fetch 同名 .wasm 的：
                //         var _scriptName = document?.currentScript?.src;
                //         scriptDirectory = new URL(".", _scriptName).href;
                //         readAsync = async url => fetch(url, {credentials:"same-origin"})
                //     ⇒ `mmd_bullet.js` 与 `mmd_bullet.wasm` 必须**同目录**。
                //       我们把这两个文件拷进了 `public/mmd/`，URL 写死，不依赖 vite
                //       怎么改写 node_modules 里的路径（也避开 wasm MIME 那个老坑）。
                let physBackend: any = null;
                if (PHYSICS_ON && PHYS_MODE === 'bullet') {
                    try {
                        const bullet = await loadCustomBulletMmdModule({ scriptUrl: PHYS_URL });
                        physBackend = createCustomBulletMmdPhysicsBackend(bullet, {
                            fixedTimeStep: PHYS_FIX, maxSubSteps: PHYS_SUB,
                        });
                        log(`物理后端就绪：${physBackend?.name ?? '?'}（定步 ${PHYS_FIX.toFixed(5)} s / 最多 ${PHYS_SUB} 子步 / 脚本 ${PHYS_URL}）`);

                        // ①″ 后端探针：把前 12 次 `step(context)` 摘录到 `window.__physCtx`。
                        //     起因：接上物理后角色被「炸开」（PNG 从 243 KB 掉到 60 KB），
                        //     需要看清喂进去的 `deltaSeconds` / 刚体数 / 输出里有没有 NaN。
                        //     顺手兜掉一个已知雷：**首次 evaluate 时 `previousEvaluateSeconds === undefined`
                        //     ⇒ `deltaSeconds = Math.max(0, s - undefined) = NaN`**（`runtime/core.js:476`），
                        //     NaN 进 Bullet 会把整条链污染成 NaN。这里把非有限值改成 0。
                        const rawBackend = physBackend;
                        const ctxLog: any[] = [];
                        (window as any).__physCtx = ctxLog;
                        /** ★ 可检索的物理探针日志。**不要只打 console** —— 页面 console 数组有长度上限，
                         *  贴满之后关键行（尤其「第几步炸的」）会被挤掉；这一份留给 `--eval` 直接读。 */
                        const plog: any[] = [];
                        (window as any).__physLog = plog;
                        let warnedDelta = false;
                        let physSteps = 0;
                        /**
                         * ⚠️ wasm 模块挂在**兼容层里面那一层**：`CustomBulletMmdCompatibilityBackend.backend.module`。
                         * 第一版写成 `rawBackend.module`（`rawBackend` 是兼容层本身）⇒ 一直读到 `0.0 MB`，白查一轮。
                         * 堆是 `mmd_bullet.wasm` **自带导出的 64 MB 固定堆**（`ALLOW_MEMORY_GROWTH=0`，
                         * memory 段 min=max=1024 页；`abortOnCannotGrowMemory` 一超就 `abort("OOM")`）。
                         */
                        const heapMB = () => {
                            const m = (rawBackend as any)?.backend?.module ?? (rawBackend as any)?.module;
                            const n = m?.HEAPU8?.length ?? m?.memory?.buffer?.byteLength ?? 0;
                            return n / 1048576;
                        };
                        const noted = (o: any) => { if (plog.length < 400) plog.push(o); };
                        (window as any).__physHeap = () => heapMB();
                        /**
                         * ★★ wasm 堆用量探针。
                         *
                         * `HEAPU8.length` 是**缓冲区大小**，固定 64 MB、永远不变 ⇒ 量不出用量。
                         * 真正有用的是 `_malloc` 的**返回指针**：Emscripten 的 `dlmalloc` 会复用空闲块，
                         * 所以如果「历史最大指针」**单调长高**，就是实实在在的泄漏（而不是正常波动）。
                         * 顺便记分配次数与最大单次分配，方便判断是谁在吃内存。
                         */
                        const mod: any = (rawBackend as any)?.backend?.module ?? (rawBackend as any)?.module;
                        const alloc = { n: 0, total: 0, maxPtr: 0, biggest: 0, biggestAt: 0, patched: false };
                        (window as any).__physAlloc = alloc;
                        if (mod && typeof mod._malloc === 'function' && !mod.__allocPatched) {
                            mod.__allocPatched = true;
                            const om = mod._malloc.bind(mod);
                            mod._malloc = (n: number) => {
                                const p = om(n);
                                alloc.n += 1; alloc.total += n;
                                if (p + n > alloc.maxPtr) alloc.maxPtr = p + n;
                                if (n > alloc.biggest) { alloc.biggest = n; alloc.biggestAt = alloc.n; }
                                return p;
                            };
                            alloc.patched = true;
                            log('物理堆探针已挂上 _malloc');
                        }
                        physBackend = {
                            get name() { return rawBackend.name; },
                            get disabled() { return rawBackend.disabled; },
                            get disposed() { return rawBackend.disposed; },
                            step(ctx: any) {
                                const badDelta = !Number.isFinite(ctx?.deltaSeconds);
                                if (badDelta && !warnedDelta) {
                                    warnedDelta = true;
                                    log('⚠ 物理 context 的 deltaSeconds 非有限值（' + ctx?.deltaSeconds + '），已按 0 处理');
                                }
                                const fixed = badDelta ? { ...ctx, deltaSeconds: 0 } : ctx;
                                physSteps += 1;
                                const t0 = performance.now();
                                let res: any;
                                try {
                                    res = rawBackend.step(fixed);
                                } catch (e) {
                                    noted({ step: physSteps, ev: 'THROW', heapMB: +heapMB().toFixed(2),
                                            delta: fixed.deltaSeconds, msg: String(e).slice(0, 140),
                                            allocN: alloc.n, allocMaxPtr: alloc.maxPtr,
                                            allocBiggest: alloc.biggest, allocBiggestAt: alloc.biggestAt });
                                    log(`⚠ 物理第 ${physSteps} 步抛异常（堆 ${heapMB().toFixed(2)} MB）：${e}`);
                                    throw e;
                                }
                                const ms = performance.now() - t0;
                                if (physSteps <= 3 || physSteps % 10 === 0) {
                                    noted({ step: physSteps, ev: 'ok', heapMB: +heapMB().toFixed(2),
                                            ms: +ms.toFixed(2), delta: +Number(fixed.deltaSeconds).toFixed(4),
                                            sim: res?.simulated, upd: res?.updatedBoneCount,
                                            seeking: !!ctx?.seeking,
                                            allocN: alloc.n, allocMaxPtr: alloc.maxPtr, allocTotal: alloc.total });
                                }
                                if (physSteps === 1) {
                                    log(`物理堆 ${heapMB().toFixed(1)} MB（wasm 固定 64 MB）；刚体 ${ctx?.rigidBodies?.length ?? 0} / 关节 ${ctx?.joints?.length ?? 0}`);
                                }
                                if (ctxLog.length < 12) {
                                    const scan = (a: any) => {
                                        if (!a || !a.length) return { n: 0, nan: 0, min: 0, max: 0 };
                                        let nan = 0, mn = Infinity, mx = -Infinity;
                                        for (let i = 0; i < a.length; i++) {
                                            const v = a[i];
                                            if (!Number.isFinite(v)) { nan++; continue; }
                                            if (v < mn) mn = v;
                                            if (v > mx) mx = v;
                                        }
                                        return { n: a.length, nan, min: +mn.toFixed(3), max: +mx.toFixed(3) };
                                    };
                                    ctxLog.push({
                                        i: ctxLog.length,
                                        seconds: ctx?.seconds,
                                        delta: fixed.deltaSeconds,
                                        rawDelta: ctx?.deltaSeconds,
                                        seeking: !!ctx?.seeking,
                                        frame: ctx?.frame,
                                        bodies: ctx?.rigidBodies?.length ?? 0,
                                        joints: ctx?.joints?.length ?? 0,
                                        sim: res?.simulated,
                                        updated: res?.updatedBoneCount,
                                        outT: scan(ctx?.output?.translations),
                                        outR: scan(ctx?.output?.rotations),
                                    });
                                }
                                return res;
                            },
                            reset: (c: any) => rawBackend.reset?.(c),
                            dispose: () => rawBackend.dispose?.(),
                            diagnostics: () => rawBackend.diagnostics?.(),
                            debugRigidBodyWorldTransformsColumnMajor:
                                () => rawBackend.debugRigidBodyWorldTransformsColumnMajor?.(),
                        };
                    } catch (e) {
                        log('物理后端加载失败（退回纯骨骼一阶滞后）：' + e);
                    }
                } else if (PHYSICS_ON && PHYS_MODE === 'spring') {
                    log('物理解算：加载器内置弹簧后端（**只作 A/B 对照**）——它只写 position、不写 quaternion，会把裙摆/头发钉死');
                } else if (PHYSICS_ON) {
                    log('物理解算：加载器不跑物理（?physmode=none）⇒ 保住快的 WASM 运行时；布料交给自带 Verlet 弹簧骨');
                } else {
                    log('物理解算已关闭（?physics=0）：布料交给自带 Verlet 弹簧骨');
                }
                if (dead) { pipeline.dispose(); return; }
                /**
                 * `SPRING_ON` 也要算进 `PHYS_ACTIVE`：`PHYS_ACTIVE` 的语义是
                 * **「布料由物理负责，次级运动那套一阶滞后必须让位」**，
                 * 而不是「Bullet 后端在跑」。用错语义的后果很直观：
                 * 内置弹簧刚写好世界朝向，`updateSecondary` 紧接着又把它覆盖回一阶滞后。
                 */
                const SPRING_ON = PHYSICS_ON && PHYS_MODE === 'spring' && !physBackend;
                const PHYS_ACTIVE = !!physBackend || SPRING_ON;

                // ② 模型
                const loader = new ThreeMmdLoader(
                    physBackend
                        ? { runtime: { physics: 'external', physicsBackend: physBackend } }
                        : SPRING_ON
                            ? { runtime: { physics: 'stateful-spring' } }
                            : undefined,
                );
                const model = await loader.loadModel(PMX_URL, pipeline.createModelLoadOptions());
                if (dead) { pipeline.dispose(); return; }
                const meshes: THREE.Mesh[] = [];
                model.root.traverse((o: any) => { if (o.isMesh) meshes.push(o); });
                log(`模型就位：${meshes.length} 个 mesh / 骨骼 ${model.mesh?.skeleton?.bones?.length ?? '?'}`);

                // ③ 身高 + 贴地
                model.root.updateMatrixWorld(true);
                const box = new THREE.Box3().setFromObject(model.root);
                const h = Math.max(0.001, box.max.y - box.min.y);
                const s = CHAR_H / h;
                model.root.scale.setScalar(s);
                model.root.position.y = -box.min.y * s;
                log(`身高 ${h.toFixed(2)} 单位 → ${CHAR_H} m（scale ${s.toFixed(5)}）/ minY ${box.min.y.toFixed(3)}`);

                // ④ 动作 + センター 偏移补偿
                if (!REST_POSE) {
                    try {
                        const motion: any = await loader.loadAnimation(MOTION_URL);
                        const clip = motion?.animation ?? motion;
                        // ★ 这里踩过坑：`loadAnimation` 返回的是 `ThreeMmdAnimation`
                        //   = `{ source, name?, animation: MmdAnimation }`，
                        //   **不是** `THREE.AnimationClip` ⇒ `clip.tracks` 恒为 `undefined`
                        //   （之前一直打印「轨道 ? 条 / センター偏移 (0.000, 0.000)」）。
                        //   真正的结构在 `MmdAnimation.boneTracks`：
                        //     `Record<string, VmdBoneTrack>`，
                        //     `VmdBoneTrack = { packed:'bone', frames:Uint32Array,
                        //                       translations:Float32Array, rotations:Float32Array,
                        //                       interpolations:Float32Array, physicsToggles:Int8Array }`
                        //   ⇒ 每帧 3 个 float（x,y,z）连着排。
                        //   （类型定义：`dist/parser/model/modelTypes.d.ts:331` 与 `:342` 附近）
                        const tracks: Record<string, any> = clip?.boneTracks ?? {};
                        // 次级运动要用：VMD 自己会驱动的骨名。改到它们头上会把腿拖慢。
                        animBones.current = new Set(Object.keys(tracks));
                        const key = Object.keys(tracks).find((k) => /センター/.test(k));
                        const bt = key ? tracks[key] : null;
                        let ctrX = 0, ctrZ = 0;
                        if (bt?.translations?.length >= 3) {
                            let sx = 0, sz = 0, n = 0;
                            for (let i = 0; i + 2 < bt.translations.length; i += 3) {
                                sx += bt.translations[i]; sz += bt.translations[i + 2]; n++;
                            }
                            if (n) { ctrX = sx / n; ctrZ = sz / n; }
                        }
                        model.setAnimation(clip);
                        // ★ `maxFrame` 是「钳死线」：`update(seconds)` 超过它就把姿态冻结在末帧。
                        //   `walk.vmd` = 1145 帧（38.17 秒），而它里面其实塞了 31.5 个 32 帧的循环。
                        maxFrameRef.current = clip?.metadata?.maxFrame ?? 0;
                        // ★ 物理单调时钟的回绕周期：**必须落在「整数个循环」上**，
                        //   否则回绕那一帧姿态会跳（VMD 只在整循环处重复）。
                        //   mahlazer：40 帧/循环、maxFrame 951 ⇒ floor(951/40)=23 个循环 = 920 帧 = 30.667 s。
                        {
                            const cf = Math.max(1, Math.round(LOOP_DUR * 30));
                            const mf = Math.max(cf, maxFrameRef.current);
                            physWrapRef.current = PHYS_WRAP_OVERRIDE > 0
                                ? PHYS_WRAP_OVERRIDE
                                : (Math.floor(mf / cf) * cf) / 30;
                            log(`物理回绕周期 ${physWrapRef.current.toFixed(3)} s（= ${Math.floor(mf / cf)} 个循环 × ${cf} 帧）`
                                + `⇒ 绕前/绕后姿态逐位相同，唯一不连续是布料速度，每 ${physWrapRef.current.toFixed(1)} 秒一次（?physwrap= 可覆盖）`);
                        }
                        const yawSign = CHAR_YAW === Math.PI ? 1 : -1;
                        if (CTRFIX) {
                            model.root.position.x += ctrX * s * yawSign;
                            model.root.position.z += ctrZ * s * yawSign;
                        }
                        log(`动作 ${MOTION_URL} / 骨骼轨道 ${Object.keys(tracks).length} 条 / センター轨迹「${key ?? '无'}」${bt?.frames?.length ?? 0} 帧 / 偏移 (${ctrX.toFixed(3)}, ${ctrZ.toFixed(3)}) 网格单位 → 世界 (${(ctrX * s * yawSign).toFixed(3)}, ${(ctrZ * s * yawSign).toFixed(3)}) m`);
                        log(`VMD maxFrame=${maxFrameRef.current}（${(maxFrameRef.current / 30).toFixed(2)} 秒）⇒ 播放头取 0..${Math.round(LOOP_DUR * 30)} 帧（${LOOP_DUR.toFixed(4)} 秒）`
                            + ` / 整圈位移 ${STRIDE} m 用 ${CYCLE_SEC.toFixed(2)} s 走完 ⇒ 常速 ${WALK_SPEED.toFixed(3)} m/s、动画 ${(LOOP_DUR / CYCLE_SEC).toFixed(3)} 倍速（支撑脚与地面零滑动）`
                            + ` / 前倾 ${LEAN_DEG}°`);
                    } catch (e) {
                        log('动作加载失败（只摆初始姿势）：' + e);
                    }
                }

                /* ⚠️ 2026-10-17 修：`dead` 复检。
                 * 上面 `:1955` 的 `await loader.loadAnimation(MOTION_URL)` 是**第二个长 await**
                 * （VMD 几百 KB~几 MB，解析还要几百 ms）。这期间组件完全可能已经被卸载
                 * （dev 的 StrictMode 双挂载、或用户在加载条上刷新）：
                 *   · `:1938` 那次复检发生在 `loadModel` 之后、`loadAnimation` **之前**；
                 *   · 之后一路到 `:2473` 才有下一道闸 —— 而 `:2013 pipeline.attach()` 会
                 *     把已经 dispose 过的管线再挂一遍，并在 `:2023` 之后建布料骨、
                 *     往已弃用的 model 上挂监听 ⇒ 轻则白干，重则
                 *     `Failed to execute 'setIndexBuffer' … not of type 'GPUBuffer'`
                 *     （同型崩例见 `components/world/WingShip.tsx:420-436`）。
                 * 所以动作加载完之后、attach 之前必须再检一次。 */
                if (dead) { pipeline.dispose(); return; }

                // ⑤ attach：换 TSL 材质 + 建轮廓 + 建影子 caster + 开稀疏 morph。
                //    注意它会 **dispose 原材质**，所以不要在这之前缓存 material 引用。
                if (new URLSearchParams(location.search).has('hairaudit')) {
                    model.mesh.userData.hairAuditPosition = model.mesh.geometry.attributes.position.clone();
                }
                const ok = pipeline.attach(model, { light: mmdLight });
                log('attach=' + ok);

                // ⑤″ ★ 布料骨架（头发 / 披风 / 裙摆的 Verlet 弹簧骨）—— 用户 m09585 任务1
                //     ⚠️ **和加载器自带的物理互斥**：两者抢的是同一批骨。
                //     现在缺省 `?physmode=none`（加载器不跑物理）⇒ 这里接管；
                //     只有显式 `?physmode=bullet|spring` 时才让位（做 A/B 对照用）。
                //
                //     必须建在 `attach` 之后：`attach` 会 dispose 重建材质，
                //     而且我们要读 `mesh.userData.mmdPhysics.rigidBodies`（attach 不会动它）。
                if (SECONDARY_ON && !PHYS_ACTIVE) {
                    try {
                        const sk = model.mesh as unknown as THREE.SkinnedMesh;
                        const rig = createSecondaryMotion(sk, animBones.current, {
                            stiffness: SEC_STIFF,
                            limitDeg: SEC_LIMIT,
                            /* ★ 第二十四轮 v4：弹簧刚度/限角**乘数**（见上方长注释） */
                            stiffK: SEC_STIFFK,
                            limitK: SEC_LIMITK,
                            stiffHair: SEC_STIFF_HAIR,
                            stiffSkirt: SEC_STIFF_SKIRT,
                            stiffOther: SEC_STIFF_OTHER,
                            gravity: SEC_GRAV,
                            drag: SEC_DRAG,
                            wind: SEC_WIND,
                            windFront: SEC_WIND_FRONT,
                            windHem: SEC_HEM_WIND,
                            hemHi: SEC_HEM_HI,
                            hemFwdDeg: SEC_HEM_FWD,
                            /* ★★★ 落脚脉冲（用户 m07388）—— 见上方 `SEC_LAND` 的长注释。
                             *  全部由 `?secland*=` 旋钮控制，`?secland=-1` 整条通道关闭。 */
                            landDeg: SEC_LAND,
                            landLiftDeg: SEC_LAND_LIFT,
                            landSpreadDeg: SEC_LAND_SPREAD,
                            landHi: SEC_LAND_HI,
                            landLiftPh: SEC_LAND_LIFT_PH,
                            landSpreadPh: SEC_LAND_SPREAD_PH,
                            landLiftW: SEC_LAND_LIFT_W,
                            landLiftD: SEC_LAND_LIFT_D,
                            landSpreadW: SEC_LAND_SPREAD_W,
                            landHairK: SEC_LAND_HAIRK,
                            hairSolve: SEC_HAIR_SOLVE === 1,
hairFloor: SEC_HAIR_FLOOR,
                            /* ★ 第二十一轮：两条布料通道（各自的 URL 旋钮可单独关）。 */
                            pieceDeg: SEC_PIECE,
        pieceWRib: SEC_PIECE_WRIB,
                            piecePh: SEC_PIECE_PH,
                            /* ★ 第二十四轮 v3：头发径向让位（修「头发穿进裙/披风」） */
                            hairSep: SEC_HAIRSEP,
                            /* ★ 第二十二轮：披肩（编号4）整片通道（独立幅度） */
                            shawlDeg: SEC_SHAWL,
                            shawlPh: SEC_SHAWL_PH,
        shawlRigid: SEC_SHAWL_RIGID,
        shawlRigidAmp: SEC_SHAWL_RIGID_AMP,
        shawlPush: SEC_SHAWL_PUSH,
        shawlPushSign: SEC_SHAWL_PUSH_SIGN,
        shawlPushOsc: SEC_SHAWL_PUSH_OSC,
                            /* ★ 第二十四轮：四片布总幅度乘数（1袖/4披肩/6披风/8带共用） */
                            clothAmp: SEC_CLOTH_AMP,
                            stiffCape: SEC_STIFF_CAPE,
                            stiffRibbon: SEC_STIFF_RIBBON,
                            stiffShawl: SEC_STIFF_SHAWL,
                            netCape: SEC_NET_CAPE,
                            netRibbon: SEC_NET_RIBBON,
                            netShawl: SEC_NET_SHAWL,
                            netSkirt: SEC_NET_SKIRT,
                            holdCape: SEC_HOLD_CAPE,
                            holdRibbon: SEC_HOLD_RIBBON,
                            holdShawl: SEC_HOLD_SHAWL,
                            holdSkirt: SEC_HOLD_SKIRT,
                            thighDeg: SEC_THIGH,
                            thighLo: SEC_THIGH_LO,
                            thighHi: SEC_THIGH_HI,
                            thighSign: SEC_THIGH_SIGN,
                            carry: SEC_FRAME,
                            collide: SEC_COL,
                            colScale: SEC_COLS,
                            colScaleLeg: SEC_COLS_LEG,
                            slackMax: SEC_SLACKMAX,
                            iterations: SEC_ITER,
                            rodSamples: SEC_ROD,
                            repel: SEC_REPEL,
                            repelCut: SEC_REPEL_CUT,
                            repelW: SEC_REPEL_W,
                            repelEvery: SEC_REPEL_EVERY,
                            antiDeg: SEC_ANTI,
                            driveDeg: SEC_DRIVE,
                            driveLead: SEC_DRIVE_LEAD,
                            flareDeg: SEC_FLARE,
                            flareSpeed: SEC_FLARE_SPEED,
                            sideDeg: SEC_SIDE,
                            sideSpeed: SEC_SIDE_SPEED,
                            sideFrontKill: SEC_SIDE_KILL,
                            sideStandK: SEC_SIDE_STAND,
                            sideHiK: SEC_SIDE_HI,
                            sideHiLo: SEC_SIDE_HI_LO,
                            sideHiHi: SEC_SIDE_HI_HI,
                            sideOscDeg: SEC_SIDE_OSC,
                            sideOscRef: SEC_SIDE_OSC_REF,
                sideRows: SEC_ROWS ? [] : undefined,
                            maxBones: SEC_MAX,
                        });
                        secRef.current = rig;
                        log(`布料弹簧骨：${rig.bones.length} 根（头发 ${rig.info.hair} / 衣物 ${rig.info.cloth}）`
                            + ` / 候选 ${rig.info.total + rig.info.excluded} 根`
                            + `（结构剔除 ${rig.info.excluded} 根 —— 子树里含 VMD 驱动骨，物理会把胳膊拽变形）`
                            + ` / 刚度 ${SEC_STIFF}·1/s / 限角 ${SEC_LIMIT}° / 重力 ${SEC_GRAV} m/s² / 阻尼 ${SEC_DRAG}`
                            + ` / 风阻 ${SEC_WIND}·1/s${SEC_WIND_FRONT < 1 ? `（前襟不吃风 ×${SEC_WIND_FRONT}，见 ?secwindfront=）` : ''}`
                            + ` / 位移补偿 ${(SEC_FRAME * 100).toFixed(0)}%${SEC_FRAME >= 1 ? '（走路不再把衣摆拖到身后，见 ?secframe=）' : ''}`
                            + ` / 碰撞体 ${SEC_COL ? `${rig.info.colliders} 个（PMX 静止刚体 ×${SEC_COLS}${SEC_COLS_LEG !== SEC_COLS ? `，腿 ×${SEC_COLS_LEG}` : ''}；静置松弛对数 ${rig.info.skips}）` : '关'}`
                            + ` × ${SEC_ITER} 次迭代 / 单对最大静置嵌入 ${(SEC_SLACKMAX * 1000).toFixed(0)} mm`
                            + ` / 骨棒采样 ${SEC_ROD} 点${SEC_ROD > 1 ? '（防「腿从两根骨之间穿过」）' : '（只测骨尾 = 旧行为）'}`
                            + ` / 布-布斥力 ${SEC_REPEL > 0 ? `${(SEC_REPEL * 1000).toFixed(0)} mm（表 ${rig.repelCount} 对 / ${rig.repelEvery} 帧重建，入表距离 ≤${(SEC_REPEL_CUT * 100).toFixed(0)} cm${SEC_REPEL_W !== 1 ? ` ×${SEC_REPEL_W}` : ''}）` : '关'}`
                            + ` / 方向性约束 ${SEC_ANTI >= 0 ? `${SEC_ANTI}°（受约束 ${rig.axisSel.reduce((c, v) => c + (v !== 2 ? 1 : 0), 0)} 根）` : '关'}`
                            + ` / 肢体驱动 ${SEC_DRIVE > 0 ? `${SEC_DRIVE}°（前襟 ${rig.driveSel.reduce((c, v) => c + (v === 2 ? 1 : 0), 0)} 根 / 袖子 ${rig.driveSel.reduce((c, v) => c + (v === 1 ? 1 : 0), 0)} 根，袖子豁免方向性约束）${SEC_DRIVE_LEAD > 0 ? ` + 相位超前 ${SEC_DRIVE_LEAD.toFixed(2)} s` : '（无超前，纯跟随）'}` : '关'}`
                            + ` / 袖子外撑 ${SEC_FLARE > 0 ? `${SEC_FLARE}°（${rig.driveSel.reduce((c, v) => c + (v === 1 ? 1 : 0), 0)} 根袖骨；走路时向外让开衣服，速比 ${SEC_FLARE_SPEED} m/s 满幅）` : '关'}`
                            + `（?secstiff= ?seclimit= ?secgrav= ?secdrag= ?secwind= ?secwindfront= ?secframe= ?seccol= ?seccols= ?seccolsleg= ?seciter= ?secslackmax= ?secrod= ?secrepel= ?secrepelcut= ?secrepelw= ?secanti= ?secdrive= ?secdrivelead= ?secflare= ?secflarespd= 可调、?secondary=0 关）`);
                    } catch (e) {
                        log('布料弹簧骨建立失败（跳过）：' + e);
                        (window as any).__secErr = String((e as Error)?.stack || e);
                    }
                } else if (SECONDARY_ON && PHYS_ACTIVE) {
                    log(`布料弹簧骨让位给加载器物理后端（${PHYS_MODE}）（?physmode=none 可换回自带弹簧骨）`);
                } else {
                    log('布料弹簧骨已关闭（?secondary=0）');
                }

                /* ⑤‴ ★★★ 上半身站姿的**目标姿势**（用户 m13541：「往两侧伸就对吗？」）
                 *
                 *  见文件头 `ARM_POSE`：这个模型的绑定姿势是 **T-pose**，所以把手臂混到
                 *  绑定姿势 = 把手摊平；正确目标取自**模型自己的动画** —— 整条循环在
                 *  `ARM_SAMPLES` 个相位上的**平均四元数**（走路的手臂前后摆是同一周期的
                 *  正负半波，平均必然抵消 ⇒ 手臂自然垂下）。
                 *
                 *  ⚠️ 位置铁律：**必须在 `createSecondaryMotion` 之后**（上面那一块）。
                 *     弹簧骨要从**当前骨姿**自标定静止方向，而下面这个采样会把全体骨
                 *     按动画写乱 ⇒ 放到它前面，布料的静止方向就是错的。
                 *     采样本身不需要还原：本函数跑在**加载期**，随后第一帧的 `UPD(t)`
                 *     会把每一根骨重新写回动画值，布料也是从那一帧才开始积分。 */
                if (SETTLE_SCOPE >= 1) {
                    try {
                        const bs2 = (model.mesh as any)?.skeleton?.bones as THREE.Bone[] | undefined;
                        const list = collectBodyBones(bs2);
                        if (list.length) {
                            const target = list.map((b) => b.quaternion.clone());
                            // ★ 缺陷②修复：躯干链（下半身/上半身/首/頭）**不做相位平均**，
                            //   目标直接给绑定姿势（= 直立）。理由见文件头 `TORSO_BIND`：
                            //   走路动画的躯干前倾是**常驻分量**，平均不抵消 ⇒ 站着前扑。
                            const torso = list.map((b) => isTorsoBone(b));
                            let how = '绑定姿势（T-pose）';
                            if (ARM_POSE >= 1) {
                                // 纯动画求值：**不能**走 `UPD`/`physics:true` 那条路，
                                // 采样 8 次等于把布料乱推 8 步。
                                const sample = (tt: number) => (model as any).update(tt, ikOpts());
                                if (ARM_POSE === 2) {
                                    sample(0);
                                    for (let i = 0; i < list.length; i++) {
                                        if (TORSO_BIND && torso[i]) target[i].identity();
                                        else target[i].copy(list[i].quaternion);
                                    }
                                    how = '循环起点原样（手前伸）';
                                } else {
                                    const acc = list.map(() => new THREE.Quaternion(0, 0, 0, 0));
                                    for (let sIdx = 0; sIdx < ARM_SAMPLES; sIdx++) {
                                        sample((sIdx / ARM_SAMPLES) * LOOP_DUR);
                                        for (let i = 0; i < list.length; i++) {
                                            const q = list[i].quaternion;
                                            const a = acc[i];
                                            // ★ 四元数 q / −q 是同一个旋转：先按符号对齐再加，
                                            //   否则正负半波会**互相抵消成零四元数** ⇒ 上半身塌掉。
                                            const sg = (a.x * q.x + a.y * q.y + a.z * q.z + a.w * q.w) < 0 ? -1 : 1;
                                            a.x += sg * q.x; a.y += sg * q.y; a.z += sg * q.z; a.w += sg * q.w;
                                        }
                                    }
                                    for (let i = 0; i < list.length; i++) {
                                        if (TORSO_BIND && torso[i]) {
                                            // 躯干：绑定姿势（identity），不参与平均
                                            target[i].identity();
                                            continue;
                                        }
                                        const a = acc[i];
                                        if (a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w < 1e-8) continue;
                                        target[i].copy(a).normalize();
                                    }
                                    how = `${ARM_SAMPLES} 相位平均`
                                        + (TORSO_BIND ? '（躯干改混绑定，缺陷②修复）' : '（含躯干）');
                                }
                            }
                            bodyTargetRef.current = { bones: list, target };
                            log(`上半身站姿目标：${list.length} 根（?armpose=${ARM_POSE} → ${how}）`);
                        }
                    } catch (e) { log('上半身站姿目标采样失败（退回绑定姿势）：' + e); }
                }

                // ★★★ 站距（`?stance=`）的腿链链头：加载时解析一次即可（`STANCE_DEG`
                //   的长注释里有完整理由）。这里**不**改骨姿 —— 外张是在 `UPD()` 里
                //   每帧乘上去的，加载期只把「哪几根骨」定下来。
                if (STANCE_DEG > 0) {
                    try {
                        const bs3 = (model.mesh as any)?.skeleton?.bones as THREE.Bone[] | undefined;
                        const st = collectStanceBones(bs3);
                        stanceRef.current = st;
                        if (st.bones.length) {
                            log(`站距外张：${st.bones.length} 根链头（?stance=${STANCE_DEG}°）`
                                + ` → ${st.bones.map((b, i) => (st.signs[i] > 0 ? '+' : '-')
                                    + ((b.userData as { mmdBoneName?: string })?.mmdBoneName ?? b.name))
                                    .join(' ')}`);
                        } else {
                            log('站距外张：没找到大腿链头骨（?stance 失效）');
                        }
                    } catch (e) { log('站距外张：解析链头失败：' + e); }
                }

                // ★ 任务4：胳膊外展的骨（`左腕`/`右腕` = 上臂），同样只在这里解析一次。
                if (ARM_ABD_DEG > 0) {
                    try {
                        const bs4 = (model.mesh as any)?.skeleton?.bones as THREE.Bone[] | undefined;
                        const ab = collectArmAbd(bs4);
                        armAbdRef.current = ab;
                        log(ab.bones.length
                            ? `胳膊外展：${ab.bones.length} 根上臂（?armabd=${ARM_ABD_DEG}°）`
                            : '胳膊外展：没找到 左腕/右腕（?armabd 失效）');
                    } catch (e) { log('胳膊外展：解析失败：' + e); }
                }

                // ⑤′ ★★ 纯白剪影的根因就在这里 ★★
                //    `pipeline.attach` 内部一定会调 `createMmdTslShadowCaster(model.mesh)`，
                //    它 `new` 一个**共享同一套几何属性**的代理 SkinnedMesh
                //    （`dist\webgpu\shadow-caster.js:53`），材质是
                //    `new THREE.MeshBasicNodeMaterial({ side })` —— **既没 color 也没 map，纯白**
                //    （`shadow-caster.js:161-167`），然后 `mesh.add(proxy)` 挂成可见网格的**子节点**
                //    （`shadow-caster.js:72`），再 `proxy.layers.set(1)`
                //    （`MMD_SELF_SHADOW_LAYER = 1`，`dist\three\shadow.js:2`）。
                //    正常情况下相机只渲 layer 0，所以这层代理不会露面；但
                //    `src\components\Effects\Effects.tsx:138` 在清理时调了
                //    `camera.layers.enableAll()`，而且它是「设置」不是「恢复」，
                //    只要跑过一次就**永久**把相机放宽到 32 层 ⇒ 那个纯白代理就被主渲染画出来了。
                //    表现就是「形状完全正确、但通体纯白、换材质毫无反应」——
                //    因为我们一直在改**本体**的材质，而画面上那层白壳根本没参与。
                //    我们 `selfShadowEnabled: false` 用不到自阴影，所以直接把这个代理摘掉
                //    （顺带省下一次 20 万三角级别的重复绘制）。
                if (QSTR('mmdproxy') !== '1') {
                    const kids: any[] = (model.mesh as any).children || [];
                    let cut = 0;
                    for (const c of kids.slice()) {
                        if (c?.userData?.mmdTslShadowCaster) {
                            (model.mesh as any).remove(c);
                            cut++;
                        }
                    }
                    log(`摘掉影子代理 ${cut} 个（?mmdproxy=1 可保留）`);
                }

                // ⑥ 材质诊断。MMD 的漫反射贴图**不是** material.map 那么简单：
                //    `dist\webgpu\material-core.js:70-114` 的 `createMmdTslBaseColorNode` 在
                //    `colorNode` **内部**采样 `options.diffuseMap`，而 `material-assembly.js:201-210`
                //    的 `readMmdTslTextureReferences` 按 `source.map ?? retained?.diffuseMap`
                //    取贴图、`source.gradientMap ?? retained?.toonMap` 取 toon 渐变。
                //    `material.userData.mmdTslMaterialUniforms` 才是那份 MMD 材质参数。
                try {
                    const mm: any = (model.mesh as any).material;
                    const ms: any[] = Array.isArray(mm) ? mm : [mm];
                    const ud = (m: any) => m?.userData ?? {};
                    const dOf = (m: any) => m?.map ?? ud(m).mmdTslTextureReferences?.diffuseMap ?? ud(m).mmdTslSourceDiffuseTexture;
                    const tOf = (m: any) => m?.gradientMap ?? ud(m).mmdTslTextureReferences?.toonMap;
                    const nm = (t: any) => t ? `${String(t.name || 'tex').slice(-22)} ${t.image?.width}x${t.image?.height} fmt=${t.format}` : '无';
                    log(`材质 ${ms.length} 份｜有漫反射贴图 ${ms.filter((m) => !!dOf(m)).length}｜有 toon ${ms.filter((m) => !!tOf(m)).length}`);
                    log('材质抽样：' + ms.slice(0, 10).map((m) => {
                        const u = ud(m).mmdTslMaterialUniforms;
                        const d = u?.diffuse;
                        return `${m.name || '?'} [${nm(dOf(m))}] toon=${tOf(m) ? '有' : '无'} diffuse=${d ? '[' + d[0] + ',' + d[1] + ',' + d[2] + ',' + d[3] + ']' : '-'} flags=${JSON.stringify(ud(m).mmdMaterial?.flags ?? null)}`;
                    }).join('\n   '));
                } catch (e) { log('材质诊断失败 ' + e); }

                // ⑦ UV 体检：MMD 白剪影的另一大嫌疑是 uv 属性缺失/全零 —— 那样整只模型
                //    只采样到贴图的同一个角像素，看起来就是一块纯色。
                try {
                    const g: any = (model.mesh as any).geometry;
                    const uv = g?.attributes?.uv;
                    let rep = 'uv 属性缺失';
                    if (uv) {
                        let mn = [Infinity, Infinity], mx = [-Infinity, -Infinity], nan = 0;
                        const n = uv.count;
                        for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 2000))) {
                            const a = uv.getX(i), b = uv.getY(i);
                            if (!Number.isFinite(a) || !Number.isFinite(b)) { nan++; continue; }
                            mn[0] = Math.min(mn[0], a); mx[0] = Math.max(mx[0], a);
                            mn[1] = Math.min(mn[1], b); mx[1] = Math.max(mx[1], b);
                        }
                        rep = `uv count=${n} min=(${mn[0].toFixed(3)},${mn[1].toFixed(3)}) max=(${mx[0].toFixed(3)},${mx[1].toFixed(3)}) nan=${nan}`;
                    }
                    log(`几何 ${g?.attributes?.position?.count ?? '?'} 顶点｜属性 ${Object.keys(g?.attributes ?? {}).join('/')}｜${rep}｜morph ${g?.morphAttributes ? Object.keys(g.morphAttributes).join(',') : '无'}`);
                } catch (e) { log('UV 体检失败 ' + e); }

                // ⑦′ 球面贴图（spa/sph）与光照 uniform 体检。
                //     MMD 的「发丝反光 / 皮肤油光 / 金属感」**全靠球面贴图**：
                //     `spa/hair_s.bmp` 就是头发上那层品红反光，`spa/Metal.png` 是金属件。
                //     没有被应用的话，头发就是一块死黑。读法见
                //     `dist\webgpu\material-assembly.js:201-210` 的 `readMmdTslTextureReferences`。
                //     同时把 `syncLightUniforms` 写进去的 `lightColor` 打出来：
                //     它是 `light.color × light.intensity`（每帧实时取），
                //     而 `createMmdTslBaseColorNode` 里 `litBase = clamp(diffuse*lightColor + ambient, 0, 1)`，
                //     只要 lightColor 的任一分量 ≥ 1，漫反射就被**原样平铺、没有明暗层次** ——
                //     脸会白成一片、头发会变成死黑／死亮。
                try {
                    const mm: any = (model.mesh as any).material;
                    const ms: any[] = Array.isArray(mm) ? mm : [mm];
                    const ud = (m: any) => m?.userData ?? {};
                    const spOf = (m: any) => ud(m).mmdSphereMap?.texture ?? ud(m).mmdSphereTexture ?? ud(m).mmdTslTextureReferences?.sphereMap ?? null;
                    log(`球面贴图 ${ms.filter((m) => !!spOf(m)).length}/${ms.length} 份｜前 12 份 sphereMode：` +
                        ms.slice(0, 12).map((m) => {
                            const meta = ud(m).mmdMaterial ?? {};
                            const sp = spOf(m);
                            /* ⚠️ 第二十六轮 T1-I4 修：`split('/').pop()` 类型上是
                             *  `string | undefined`，`.slice()` 报 `TS2532 Object is possibly 'undefined'`。
                             *  运行期 `split` 至少给 1 个元素、不会 undefined，只是类型不干净。
                             *  补 `?? ''`，行为逐位不变。 */
                            const src = (String(sp?.image?.src || sp?.name || '').split('/').pop() ?? '').slice(-14);
                            return `${meta.sphereMode ?? '?'}${sp ? '(' + src + ')' : ''}`;
                        }).join(' '));
                    const meta0 = ud(ms[0]).mmdMaterial ?? {};
                    log('mmdMaterial 字段：' + Object.keys(meta0).join(',') + '｜sphereMode=' + meta0.sphereMode + ' sphereColor=' + JSON.stringify(meta0.sphereColor) + ' toonColor=' + JSON.stringify(meta0.toonColor));
                    const u = ud(ms[0]).mmdTslMaterialUniforms;
                    if (u) {
                        const rd = (x: any) => {
                            const v = x?.value;
                            if (v == null) return '?';
                            if (Array.isArray(v)) return '[' + v.map((n: any) => (+n).toFixed(2)).join(',') + ']';
                            if (typeof v === 'object' && 'x' in v) return `(${(+v.x).toFixed(2)},${(+v.y).toFixed(2)},${(+v.z).toFixed(2)})`;
                            return String(v);
                        };
                        log(`光照 uniform：lightColor=${rd(u.lightColor)} ambient=${rd(u.ambient)} diffuse=${rd(u.diffuse)} opacity=${rd(u.opacity)}`);
                    }
                } catch (e) { log('球面贴图体检失败 ' + e); }

                // ⑦″ 材质隔离 / 球面权重强制（**纯诊断**，见文件上方 URL 开关注释）。
                //     `?mmonly=8` 只留「髮」那一层、`?mmonly=9` 只留「髮+」那一层，
                //     一眼就能看出死黑是谁盖的。
                try {
                    const mm: any = (model.mesh as any).material;
                    const ms: any[] = Array.isArray(mm) ? mm : [mm];
                    /* ⚠️ 第二十六轮 T1-I4 修：`ud` 只在**上面两个** try 块里各声明过一次
                     *  （`:3019` 材质体检、`:3064` 球面体检），第三个 try 里根本没有
                     *  ⇒ 下面 `ud(m)` 抛 `ReferenceError`，被 `catch` 吞掉，
                     *  所以 `?sphfactor=` 这个诊断开关**从来没有生效过**。
                     *  `tsc` 报的就是 `TS2304 Cannot find name 'ud'`。 */
                    const ud = (m: any) => m?.userData ?? {};
                    if (SPH_FACTOR !== null) {
                        let n = 0;
                        for (const m of ms) {
                            const u = ud(m).mmdTslMaterialUniforms?.sphereTextureFactor;
                            const v = u?.value ?? u;
                            if (v && typeof v.set === 'function') { v.set(1, 1, 1, SPH_FACTOR); n++; }
                        }
                        log(`诊断 ?sphfactor=${SPH_FACTOR}：${n} 份材质的 sphereTextureFactor 已改写`);
                    }
                    if (MMD_ONLY.length) {
                        ms.forEach((m, i) => { if (!MMD_ONLY.includes(i)) m.visible = false; });
                        log(`诊断 ?mmonly=${MMD_ONLY.join(',')}：其余 ${ms.length - MMD_ONLY.length} 份材质已隐藏`);
                    } else if (MMD_HIDE.length) {
                        ms.forEach((m, i) => { if (MMD_HIDE.includes(i)) m.visible = false; });
                        log(`诊断 ?mmdhide=${MMD_HIDE.join(',')}：已隐藏`);
                    }
                } catch (e) { log('材质隔离失败 ' + e); }

                // ⑦‴ ★★★ 球面「加算」层必须**加算混合** —— 头发死黑的真正根因 ★★★
                //     证据链（`_logs\_mm8.png` / `_mm9.png` / `_mmhide9.png`，机位同上）：
                //       `?mmonly=8`  → 同一片头发是**漂亮的深紫罗兰**（就是 `tex\髮.png` 的本色），
                //                      说明 [8]「髮」的贴图、UV、toon 全都没问题；
                //       `?mmonly=9`  → 同一片头发被一层**不透明白银壳**整片盖住；
                //       `?mmdhide=9` → 整只角色**完全正确**：深紫发丝 + 品红高光 + 双辫白十字 +
                //                      闭着眼的脸 + 蓝白裙 + 天使翅膀头饰。
                //     为什么会这样：PMX `[9]「髮+」` 与 `[8]「髮」` **面数一模一样（34971）**，
                //     是同一片头发的第二层。它的漫反射贴图是 `tex\sp.png`，实测
                //     `meanRGB=(2.4,1.5,2.2) meanA=0.5/255` —— **一张近乎全透明的黑色图**，
                //     这一层的全部内容都来自 `spa\hair_s.bmp` 的「加算」球面。
                //     `material-core.js:65` 的 add 分支 `base.add(sphere*rgb*a)` 算式本身是对的；
                //     问题在**混合方式**：材质若按不透明画（`transparent=false` ⇒ opacity 被忽略），
                //     `baseComposite` 又约等于 0，于是这 34971 面就把下面 [8] 的紫发整片盖成黑/白。
                //     改成加算混合后，黑底贡献 0，只有高光叠在紫发上 —— 这才是 MMD 的原意。
                //     `?mmdadd=0` 可关掉（对照用）。
                if (QSTR('mmdadd') !== '0') {
                    const mm: any = (model.mesh as any).material;
                    const ms: any[] = Array.isArray(mm) ? mm : [mm];
                    let n = 0;
                    ms.forEach((m, i) => {
                        const meta = m?.userData?.mmdMaterial;
                        if (meta?.sphereMode !== 'add') return;
                        // 只动「加载器当成不透明」的那份。`[25] 鞋` 的
                        // `transparencyMode === 'alphaBlend'`，本来就按透明画，不能改成加算
                        // （加算会把蓝白靴子变成一层发光）。
                        if (meta.transparencyMode && meta.transparencyMode !== 'opaque') return;
                        m.transparent = true;
                        m.blending = THREE.AdditiveBlending;
                        m.depthWrite = false;
                        m.needsUpdate = true;
                        n++;
                        log(`  加算层 #${i}「${meta.name || '?'}」→ AdditiveBlending（球面 ${String(meta.sphereTexturePath || '').split('\\').pop()}）`);
                    });
                    log(`球面加算层 ${n} 份已改成加算混合（?mmdadd=0 可关）`);
                }

                // ⑦⁗ 漫反射贴图自带 alpha 的材质必须开 alphaTest。
                //     实例：`[24]「眼罩」` 的 `眼罩.png` 是「白金星纹 + 纯黑背景」，
                //     黑底的 alpha 实测深 61.6/255 ⇒ **那半张图是透明的**。
                //     但加载器给它的 `transparencyMode='opaque'`、`transparent=false`、
                //     `alphaTest=0` ⇒ 按不透明画 ⇒ 眼下多出一条**黑色矩形**，
                //     把眼睛整片糊掉（对照 `_logs\_face_on.png`）。
                //     MMD 里这类材质是 alpha 混合的；这里用 **alphaTest 而不是 transparent**，
                //     因为 alphaTest 只丢弃透明像素、其余照旧不透明渲染，
                //     没有排序问题（transparent 会把整只模型拖进透明队列，
                //     发丝之间会互相穿插错乱）。
                if (QSTR('mmdalpha') !== '0') {
                    const cv = document.createElement('canvas');
                    cv.width = cv.height = 32;
                    const c2 = cv.getContext('2d', { willReadFrequently: true });
                    const alphaOf = (t: any): number | null => {
                        const img = t?.image;
                        if (!img || !c2 || !img.width) return null;
                        try {
                            c2.clearRect(0, 0, 32, 32);
                            c2.drawImage(img, 0, 0, 32, 32);
                            const d = c2.getImageData(0, 0, 32, 32).data;
                            let s = 0;
                            for (let i = 3; i < d.length; i += 4) s += d[i];
                            return s / (d.length / 4);
                        } catch { return null; }
                    };
                    const seen: Record<string, number | null> = {};
                    const mm: any = (model.mesh as any).material;
                    const ms: any[] = Array.isArray(mm) ? mm : [mm];
                    const hits: string[] = [];
                    ms.forEach((m, i) => {
                        if (m?.blending === THREE.AdditiveBlending) return;
                        const t = m?.map ?? m?.userData?.mmdTslTextureReferences?.diffuseMap;
                        if (!t) return;
                        const k = String(t.uuid);
                        if (!(k in seen)) seen[k] = alphaOf(t);
                        const a = seen[k];
                        if (a !== null && a < 200) {
                            m.alphaTest = 0.5;
                            m.needsUpdate = true;
                            hits.push(`#${i}「${m?.userData?.mmdMaterial?.name ?? '?'}」ᾱ=${a.toFixed(1)}`);
                        }
                    });
                    if (hits.length) log(`贴图自带 alpha → alphaTest=0.5：${hits.join('，')}（?mmdalpha=0 可关）`);
                    else log('贴图自带 alpha：没有需要处理的材质');
                }

                // ⑦⁵ 摘眼罩（等价于 PMX 里那个 `Mask Off` 材质变形，用户 m06469 问题 1）。
                //     加载器的运行时**不实现** type=8 材质变形（`materialOffsets` 只有解析器在写），
                //     所以这里手写：把 `[24] 眼罩` 的材质隐藏掉。
                //     她的 `tex\顔.png` 本来就是闭眼的（PMX 没有眼球，眼睛是 `[6]目` 那一片），
                //     摘掉眼罩就是用户说的「直接闭眼」。
                //     按**名字**找而不是硬编码下标 24 —— 换 PMX 也不会错。
                if (MASK_OFF) {
                    const mm: any = (model.mesh as any).material;
                    const ms: any[] = Array.isArray(mm) ? mm : [mm];
                    const off: string[] = [];
                    ms.forEach((m, i) => {
                        const nm = m?.userData?.mmdMaterial?.name;
                        if (nm === '眼罩') {
                            m.visible = false;
                            off.push(`#${i}「${nm}」`);
                        }
                    });
                    log(off.length
                        ? `摘眼罩：${off.join('，')}（等价于 PMX 的 Mask Off 材质变形；?mask=1 可戴回）`
                        : '摘眼罩：没有找到名为「眼罩」的材质');
                } else {
                    log('诊断 ?mask=1：眼罩保留');
                }

                // ⑧ ?plain=1 / ?plaintex=<url> 诊断
                if (PLAIN_MAT) {
                    const cur: any = (model.mesh as any).material;
                    const wasArr = Array.isArray(cur);
                    const arr: any[] = wasArr ? cur : [cur];
                    const next = arr.map((m) => {
                        const t = m?.map ?? m?.userData?.mmdTslTextureReferences?.diffuseMap ?? null;
                        return new THREE.MeshBasicNodeMaterial({ map: t, side: THREE.DoubleSide, fog: true });
                    });
                    (model.mesh as any).material = wasArr ? next : next[0];
                    log(`诊断 ?plain=1：${next.length} 份材质已换成 MeshBasicNodeMaterial（只贴 diffuse，共 ${next.filter((m: any) => !!m.map).length} 份有图）`);
                }
                // ?plaintex=<url>：全部材质换成「只贴这张**现拉**的图」的 MeshBasicNodeMaterial。
                // 目的是把「加载器造的 texture 对象」与「渲染器的采样通路」二分：
                // 现拉的图（例如 /columbina/spa/gold.png，均值 37,35,29 近黑）若能把人染黑，
                // 就是加载器的 texture 有问题；若仍是白的，就是采样通路本身有问题。
                if (PLAIN_TEX) {
                    const fresh = await new THREE.TextureLoader().loadAsync(PLAIN_TEX);
                    fresh.colorSpace = THREE.SRGBColorSpace;
                    fresh.flipY = false;
                    fresh.needsUpdate = true;
                    const cur: any = (model.mesh as any).material;
                    const wasArr = Array.isArray(cur);
                    const arr: any[] = wasArr ? cur : [cur];
                    const next = arr.map(() => new THREE.MeshBasicNodeMaterial({ map: fresh, side: THREE.DoubleSide, fog: true }));
                    (model.mesh as any).material = wasArr ? next : next[0];
                    log(`诊断 ?plaintex=${PLAIN_TEX}：${next.length} 份材质换成「现拉贴图」的 MeshBasicNodeMaterial（${fresh.image?.width}x${fresh.image?.height}）`);
                }


                if (dead) { pipeline.dispose(); return; }
                groupRef.current?.add(model.root);
                live.current = { pipeline, model, ready: true, maxFrame: maxFrameRef.current, physics: PHYS_ACTIVE };
                // 诊断钩子：无头脚本用 --eval 读这几个数
                (window as any).__mmd = {
                    attached: ok,
                    meshes: meshes.length,
                    bones: model.mesh?.skeleton?.bones?.length ?? -1,
                    rootY: model.root.position.y,
                    scale: model.root.scale.x,
                    model,
                    pipeline,
                    info: () => gl.info?.render ?? null,
                    // 走路的无头验证用：`--pre` 里 dispatch keydown 后读这几个数
                    pos: () => groupRef.current?.position.toArray() ?? null,
                    /** ★ task-20：把玩家瞬移到某点（**只给无头验收用**，不改任何玩法逻辑）。
                     *  y 不传就沿用当前高度，下一帧 `useFrame` 会用 `worldHeightCPU` 归位。
                     *  用法：`__mmd.setPos(-18,-193)` 站进月坑浅水（r 15~21.5 环带）。 */
                    setPos: (x: number, z: number, y?: number) => {
                        const g = groupRef.current;
                        if (!g) return null;
                        g.position.set(x, y ?? g.position.y, z);
                        return g.position.toArray();
                    },
                    /** ★★ 飞船碰撞体的**单元测试入口**（用户 m04735：「飞船穿模，没做碰撞」）。
                     *  直接调 `useFrame` 里用的那个 `shipPush()` —— 不是复制一份逻辑，
                     *  是同一个函数引用，所以测到的就是真正跑的那条路径。
                     *  用法：`__mmd.shipPush(0,-196)` ⇒ `{x,z,hit:true}` 且结果在椭圆外；
                     *       `__mmd.shipPush(0,-100)` ⇒ `hit:false` 且坐标原样返回。
                     *  另外返回几何参数，方便断言推出结果的半轴。
                     *  为什么不「让她走进去看」：实测 `?charyaw=180` 时她朝西南
                     *  (-0.81,-0.58) 走而不是 -Z，两次 A/B 都只是从船旁边 20.8 m 掠过。 */
                    shipPush: (x: number, z: number) => shipPush(x, z),
                    /* 森林树干推出（用户 2026-10-23 反馈 3「人物直接穿过树干」）。
                     *   `__mmd.forestPush(树心x, 树心z)` ⇒ 应 `hit:true` 且 `dist ≥ 0`；
                     *   `?forestcol=0` 时同一坐标必须 `hit:false`（证明推的不是别的东西）。
                     *   树心坐标从 `__forestRoot.slots` 里读，见 `pre-forest-probe.js`。 */
                    forestPush: (x: number, z: number) => forestPush(x, z),
                    forestCol: () => ({
                        on: FOREST_COL_ON,
                        rScale: FOREST_R_SCALE,
                        count: treeColliderList().length,
                        charR: CHAR_R,
                        sample: treeColliderList().slice(0, 5),
                    }),

                    /* ★ 2026-11-02 第五十七轮：某个世界坐标离**最近的森林树干表面**多远（m）。
                     *   用途：NPC 与采集点撒到 100~250 m 之后，「有没有正好站在树干里」
                     *   不能靠布点算法规避（`treeCollide` 的表是按相机铺的，布点时查不到远处的树）。
                     *   验收法：把角色传送到目标附近 → 等 `Forest.refill()` 铺好表 →
                     *   `__mmd.forestNear(x, z)` ⇒ `{n, gap}`，`gap < 0` 就是插进树干、
                     *   `gap` 在 0~0.6 之间是「擦着站」，都不合格。
                     *   ⚠️ 只反映**当前相机附近**的树（表是整表重建的），所以必须逐个传送去量。 */
                    forestNear: (x: number, z: number) => {
                        const list = treeColliderList();
                        let best = Infinity;
                        let nNear = 0;
                        for (const t of list) {
                            const d = Math.hypot(x - t.x, z - t.z) - t.r;
                            if (t.r + Math.max(0, d) < 80) nNear++;
                            if (d < best) best = d;
                        }
                        /* nNear = 80 m 内有多少棵树干 —— 用来判「表是不是已经铺到这儿了」。
                         * 表是整表重建的，刚传送过去还没 refill 时 n>0 但全是旧位置的树，
                         * 那时 gap 会是几百米，读数不可用。 */
                        return { n: list.length, nNear, gap: Number.isFinite(best) ? +best.toFixed(2) : null };
                    },
                    /* 月牙石桌的椭圆推出（用户 m02063 任务1）。用法同 shipPush：
                     *   __mmd.deskPush(-8.6,-3.2) ⇒ hit:true 且结果在椭圆外；
                     *   __mmd.deskPush(0,-11)    ⇒ hit:false 原样返回。
                     * 无头验收直接调它，不用「让她走进去看」—— 落点/朝向都不可复现。 */
                    deskPush: (x: number, z: number) => deskPush(x, z),
                    shipCol: () => ({
                        on: SHIP_COL_ON, cx: SHIP_CX, cz: SHIP_CZ,
                        yawDeg: SHIP_YAW * 180 / Math.PI,
                        a: SHIP_HALF_W + CHAR_R, b: SHIP_HALF_L + CHAR_R,
                    }),
                    yaw: () => groupRef.current?.rotation.y ?? null,
                    speed: () => phys.current.speed,
                    /** ★ m11046 任务1 的诊断：`prevSpeed` = 本次行走的**峰值**速度
                     *  （只升不降，松手后清零）。收尾条件就是 `prevSpeed > 0.10`。 */
                    prevSpeed: () => prevSpeed.current,
                    /** ★ 当前是否真有方向键/摇杆按着（`KeyboardMapper` 或 `TouchJoystick` 写的）。
                     *  它是「松开就收尾」的判据，见 `useFrame` 里的根因注释。 */
                    keyDown: () => input.isPressed('MoveForward') || input.isPressed('MoveBackward')
                        || input.isPressed('RotateLeft') || input.isPressed('RotateRight'),
                    /** ★ 无头验证专用：模拟「松开 WASD」—— 掐掉 `?autowalk=` 并走收尾 */
                    setAutoWalk: (v: number) => { autoRef.current = Math.max(0, v || 0); },
                    autoWalk: () => autoRef.current,
                    /** 收尾状态：`> 0` = 目标累计距离（米），`0` = 不在收尾 */
                    landTarget: () => landRef.current,
                    /** ★ 收尾是否已完成并冻住播放头（`?landhold=` 生效时为 true） */
                    landDone: () => landDone.current,
                    animT: () => animT.current,
                    /** 收尾的目标相位（`?standph=`，缺省 0.553）—— 验收时用来核对
                     *  「松手之后相位是不是精确停在这里」，见 `_tools/realkey-shot.js`。 */
                    standPh: () => STAND_PH,
                    /** ★ m11917 任务1 的判据：站定姿势合成的实时状态。
                     *  `t` = 混合权重（0→1，**到位后保持在 1**，见代码里「到期停药」那段）；
                     *  `drop` = 接地定标量（站直后脚会下沉多少，负值）；
                     *  `lowFoot` = 当前最低脚骨的世界 y；`y` = `g.position.y`；
                     *  `qL` = 左大腿骨相对绑定姿势的偏角（0° = 腿完全直）。 */
                    settle: () => {
                        const S = standRef.current;
                        const gg = groupRef.current;
                        if (!gg) return { on: SETTLE_ON, active: false, t: settleT.current };
                        /* ★ 两踝水平间距：优先用站姿合成那条腿链；**还没走过**（`standRef`
                         *   尚未建立，它只在收尾完成时懒建）时退回实时模型骨架现找一次 ——
                         *   否则用户一打开页面读到的是 `—`，必须「先走一段」才看得到读数，
                         *   而他们最想看的恰恰是「刚进页面 / 刚停下来」这两刻的踝距。 */
                        let feet: THREE.Bone[] | null = S ? S.feet : null;
                        /* 报间距用的左右踝：`D` 链优先（见 `standRef` 建链处的注释 ——
                         * 顶点蒙皮绑的是 `D` 骨，普通骨只是付与链的中转）。 */
                        let aL: THREE.Bone | null = S ? S.sepL : null;
                        let aR: THREE.Bone | null = S ? S.sepR : null;
                        if (!feet && live.current) {
                            const bs = (live.current.model?.mesh as any)?.skeleton?.bones as THREE.Bone[] | undefined;
                            const find = (n: string) => bs?.find((b) => b.name === n) ?? null;
                            const a = find('左足首D') ?? find('左足首');
                            const b2 = find('右足首D') ?? find('右足首');
                            if (a && b2) { feet = [a, b2]; aL = a; aR = b2; }
                        }
                        let m = Infinity;
                        if (feet) for (const b of feet) m = Math.min(m, b.matrixWorld.elements[13]);
                        let sep = null;
                        if (aL && aR) {
                            const a = aL.matrixWorld.elements, b2 = aR.matrixWorld.elements;
                            const dx = a[12] - b2[12], dz = a[14] - b2[14];
                            sep = +Math.sqrt(dx * dx + dz * dz).toFixed(4);
                        }
                        return {
                            on: SETTLE_ON, active: landDone.current, t: +settleT.current.toFixed(4),
                            drop: S && S.drop !== null ? +S.drop.toFixed(4) : null,
                            lowFoot: Number.isFinite(m) ? +m.toFixed(4) : null,
                            y: +gg.position.y.toFixed(4),
                            pos: [+gg.position.x.toFixed(4), +gg.position.z.toFixed(4)],
                            sep,
                            /* ★★ 整条腿链 8 根骨**各自**离绑定姿势的角度（度）。
                             *  只报 `qL`（左大腿）是不够的 —— 用户 m13137 的截图里
                             *  `qL = 0°` 但看起来仍是迈步状态，所以必须逐骨报，
                             *  才能区分「是大腿没合上」还是「膝/踝没合上」。 */
                            q8: S ? S.bones.map((b) => +(2 * Math.acos(Math.min(1, Math.abs(b.quaternion.w)))
                                * 180 / Math.PI).toFixed(2)) : null,
                            qL: S ? +(2 * Math.acos(Math.min(1, Math.abs(S.bones[0].quaternion.w)))
                                * 180 / Math.PI).toFixed(2) : null,
                            /* ★★ 手臂读数（判据：`?armpose=` 到底把手放到哪了）。
                             *  报两腕**相对角色原点**的世界坐标：T-pose 时 |x| 大、y 高；
                             *  手臂自然垂下时 |x| 小、y 低。只给截图不够 —— 要能不看图
                             *  就分辨 0（绑定 T-pose）/ 1（相位平均）/ 2（循环起点）三种目标。 */
                            arm: (() => {
                                const list = bodyTargetRef.current.bones;
                                const isWrist = (b: THREE.Bone) => /^[左右]手首$/.test(
                                    (b.userData as { mmdBoneName?: string } | undefined)?.mmdBoneName ?? b.name);
                                const ws = list.filter(isWrist);
                                if (!ws.length) return null;
                                return {
                                    pose: ARM_POSE,
                                    n: list.length,
                                    wr: ws.map((b) => [
                                        +(b.matrixWorld.elements[12] - gg.position.x).toFixed(4),
                                        +(b.matrixWorld.elements[13] - gg.position.y).toFixed(4),
                                        +(b.matrixWorld.elements[14] - gg.position.z).toFixed(4),
                                    ]),
                                };
                            })(),
                        };
                    },
                    /** ★★ 骨架刷新自检（判据外的「读数与画面不一致」专用探针）。
                     *
                     *  背景：`three/build/three.webgpu.js` 里**没有 `boneTexture`**（grep 零命中），
                     *  WebGPU 的蒙皮靠 `SkinningNode.update(frame)` → `skeleton.update()`
                     *  （`17923` 行），而 `skeleton.update()` 唯一的输入是各骨当前的
                     *  `bone.matrixWorld`，输出写进 `skeleton.boneMatrices`（Float32Array，
                     *  由节点系统当 storage buffer 上传）。
                     *
                     *  于是「读数说骨姿=绑定姿势、画面却是迈步」只有两种可能：
                     *    (a) `boneMatrices` 与 `bone.matrixWorld` 对不上 ⇒ GPU 拿的是旧姿势；
                     *    (b) 两者一致 ⇒ 骨数据没问题，画面里的迈步来自别处（morph/网格/相机）。
                     *
                     *  本函数直接把两者逐骨比对（`expect = matrixWorld × boneInverses[i]`），
                     *  返回偏差最大的那根骨。`maxDev < 1e-4` 即说明 GPU 与 JS 一致。 */
                    skelDev: () => {
                        const mesh = (live.current?.model?.mesh ?? null) as any;
                        const sk = mesh?.skeleton as THREE.Skeleton | undefined;
                        if (!sk || !sk.boneMatrices || !sk.boneInverses) return null;
                        const bm = sk.boneMatrices as Float32Array;
                        const tmp = new THREE.Matrix4();
                        const got = new THREE.Matrix4();
                        let maxDev = 0, worst = '', worstI = -1, over1e3 = 0;
                        const n = sk.bones.length;
                        for (let i = 0; i < n; i++) {
                            const b = sk.bones[i];
                            if (!b) continue;
                            tmp.multiplyMatrices(b.matrixWorld, sk.boneInverses[i]);
                            got.fromArray(bm, i * 16);
                            const e1 = tmp.elements, e2 = got.elements;
                            let d = 0;
                            for (let k = 0; k < 16; k++) d = Math.max(d, Math.abs(e1[k] - e2[k]));
                            if (d > 1e-3) over1e3++;
                            if (d > maxDev) { maxDev = d; worst = b.name; worstI = i; }
                        }
                        return {
                            bones: n, maxDev: +maxDev.toFixed(6), worst, worstI, over1e3,
                            /* 顺带把二次动力解算是否也白写一起报出来：布片骨的当前四元数
                             * 离绑定姿势的角度（>0 说明解算确实在写，但未必进渲染）。 */
                            hair: (() => {
                                const h = (live.current?.model?.mesh as any)?.skeleton?.bones
                                    ?.find((b: THREE.Bone) => /Bone_Hair1_0$/.test(b.name)) as THREE.Bone | undefined;
                                return h ? +(2 * Math.acos(Math.min(1, Math.abs(h.quaternion.w))) * 180 / Math.PI).toFixed(2) : null;
                            })(),
                        };
                    },
                    /** 走路步长（米/周期）—— 位置与相位的换算系数，验收脚本要复用它 */
                    stride: () => STRIDE,
                    /** 累计已走距离（米）—— 走路播放头唯一的输入 */
                    dist: () => dist.current,
                    /** 当前相位 [0,1)。`animT = phase × loopDur / animspeed` */
                    phase: () => ((dist.current / STRIDE) % 1 + 1) % 1,
                    /** ★★★ m13752 的判据：两脚在**角色自身坐标系**里的落点横向偏移。
                     *  `latGap = 左踝 x − 右踝 x`（正 = 左在左、没交叉）。走路一个周期里
                     *  这个值如果 ≤ 0，说明两只脚踩到同一条线甚至交叉上了 —— 换腿时必然
                     *  穿模。`stance=0` 实测它会穿到负数。 */
                    feet: () => {
                        const gg = groupRef.current;
                        const sk = (live.current?.model?.mesh as any)?.skeleton
                            ?.bones as THREE.Bone[] | undefined;
                        if (!gg || !sk) return null;
                        const raw = (b: THREE.Bone) => (b.userData as { mmdBoneName?: string })
                            ?.mmdBoneName ?? b.name;
                        const find = (n: string) => sk.find((b) => raw(b) === n || b.name === n);
                        const yaw = gg.rotation.y;
                        const cy = Math.cos(yaw), sy = Math.sin(yaw);
                        const loc = (b?: THREE.Bone) => {
                            if (!b) return null;
                            b.updateWorldMatrix(true, false);
                            const e = b.matrixWorld.elements;
                            const dx = e[12] - gg.position.x;
                            const dz = e[14] - gg.position.z;
                            // 绕 Y 反向转 yaw ⇒ 得到「相对角色朝向」的坐标（x = 左右）
                            return [+((dx * cy - dz * sy)).toFixed(4), +((dx * sy + dz * cy)).toFixed(4)];
                        };
                        /* ★ 踝骨的**世界高度**（相对角色基点，米）。
                         *  用来验「落脚脉冲的相位是否真与脚触地对齐」——
                         *  没有这个数，`stepPhase=0` 到底是不是「脚刚落地」全靠注释猜测。 */
                        const hgt = (b?: THREE.Bone) => {
                            if (!b) return null;
                            b.updateWorldMatrix(true, false);
                            return +(b.matrixWorld.elements[13] - gg.position.y).toFixed(4);
                        };
                        return {
                            yaw: +yaw.toFixed(4),
                            lat: loc(find('左足首D') ?? find('左足首')),
                            rat: loc(find('右足首D') ?? find('右足首')),
                            ltoe: loc(find('左足先EX') ?? find('左つま先D')),
                            rtoe: loc(find('右足先EX') ?? find('右つま先D')),
                            lh: hgt(find('左足首D') ?? find('左足首')),
                            rh: hgt(find('右足首D') ?? find('右足首')),
                        };
                    },
                    /** `?stance=` 的实况（解析到哪几根链头、每根符号） */
                    stance: () => ({
                        deg: STANCE_DEG,
                        bones: stanceRef.current.bones.map((b, i) => ({
                            n: (b.userData as { mmdBoneName?: string })?.mmdBoneName ?? b.name,
                            s: stanceRef.current.signs[i],
                            childOfHead: b.parent
                                ? ((b.parent.userData as { mmdBoneName?: string })?.mmdBoneName ?? b.parent.name)
                                : null,
                        })),
                    }),
                    /** ★★ m11046 任务2 的判据：把求解器**最终写回**的骨尾粒子拿去和
                     *  所有身体碰撞体比一遍，量出「插进身体多少米」。
                     *  `worst[].pen > 0` 就是还在穿模；`penSkipped` 是被 `colSkip`
                     *  永久屏蔽掉的那部分（它们再也不会被推出去）。 */
                    collideAudit: (top?: number, visScale?: number) =>
                        auditColliders(secRef.current, top ?? 14, visScale ?? 1.35),
                    /** ★★ m13789 任务③ 的另一半判据：**骨棒**（布片那条带）而不是骨尾
                     *  对身体的穿透。`?secrod=1` 与 `?secrod=4` 的 `maxPenVis` 之差
                     *  = 「腿从两根骨之间穿过」这条盲区的量级。 */
                    rodAudit: (rodSamples?: number, top?: number, visScale?: number) =>
                        auditRod(secRef.current, rodSamples ?? SEC_ROD, top ?? 14, visScale ?? 1.35),
                    /** ★★★ 碰撞体清单自查（用户 m14756「你说的和我认为的不是同一个地方」）：
                     *  列出 34 个碰撞体各自的**宿主骨名 / 半径 / 半长**，用来判断
                     *  「腿到底有没有碰撞体」——若 7 个 `D` 全是髋骨，大腿/小腿就根本没人管，
                     *  长袖与裙片当然会从腿里穿过去（这时该补的是碰撞体，不是推出力度）。 */
                    /* ⚠️ 第二十六轮 T1-I4 修：补 null 守卫。同文件别的探针都写了
                     *  `secRef.current ? … : null`，这里漏了 ⇒ `TS18047`。
                     *  运行期不会崩（调用前 `__mmd` 已就绪），但类型上是脏的。 */
                    cols: () => (secRef.current ? (() => {
                        const s = secRef.current!;
                        return s.colBone.map((b, j) => ({
                            n: ((b.userData as { mmdBoneName?: string })?.mmdBoneName) ?? b.name,
                            r: +(s.colR[j] ?? 0).toFixed(4),
                            half: +(s.colHalf[j] ?? 0).toFixed(4),
                        }));
                    })() : null),
                    /** ★★ m13789 任务③ 的判据：**布料互相**穿模。长袖（`driveSel===1`）
                     *  与前襟/裙摆（`driveSel===2` / 名字含 `Skirt_`）之间没有任何碰撞体，
                     *  所以它们的互相穿插只能这样量：异组骨棒的最短距离。
                     *  `minDist < 0.02` ⇒ 网格基本已经互穿；`under1/under2` 是计数。 */
                    clashAudit: (under5?: number, top?: number) =>
                        auditClash(secRef.current, under5 ?? 0.05, top ?? 12),
                    /** ★★★ 第二十四轮 v3：**头发 ↔ 布料**的穿模读数。
                     *  用户 m02740 指出背面图里头发明显插进白裙与披风 ——
                     *  原有 `clashAudit` 的分组里**没有头发**，所以这件事一直是 0 读数。
                     *  `minDist < 0.02` 基本可认定互穿；`byGroup` 指出穿在哪一类布上。 */
                    hairClash: (under5?: number, top?: number) =>
                        auditHairClash(secRef.current, under5 ?? 0.05, top ?? 10),
                    /** ★ m11046 任务3 的判据：树干碰撞圆的复算结果 + 当前角色位置到
                     *  最近树的「净距」（`gap < 0` = 已经插进树里）。 */
                    trees: () => TREE_COLS.map((t) => ({
                        name: t.name, asset: t.asset,
                        x: +t.x.toFixed(3), z: +t.z.toFixed(3),
                        r: +t.r.toFixed(3), h: +t.h.toFixed(3),
                    })),
                    treeGap: () => {
                        const gg = groupRef.current;
                        if (!gg || TREE_COLS.length === 0) return null;
                        let best = Infinity, name = '';
                        for (const t of TREE_COLS) {
                            const d = Math.hypot(gg.position.x - t.x, gg.position.z - t.z) - (t.r + CHAR_R);
                            if (d < best) { best = d; name = t.name; }
                        }
                        return { gap: +best.toFixed(4), near: name, charR: CHAR_R };
                    },
                    /* ── ★★ 方向性约束（任务2）的取证接口 ──
                     *  `antiInfo()` 给出「哪些骨被判成前/后/侧」，用来核对分类是否符合解剖直觉；
                     *  `secTail(name)` 给出该骨尾巴的**相对角色前方的偏移** —— 这就是
                     *  「身前的衣服有没有被甩到身后」的直接读数（负 = 跑到身体后面了）。
                     */
                    antiInfo: (limit = 12) => {
                        const r = secRef.current;
                        if (!r) return null;
                        const f: string[] = [], b: string[] = [], s: string[] = [];
                        for (let i = 0; i < r.n; i++) {
                            const nm = r.bones[i].name;
                            if (r.axisSel[i] === 0) (r.axisSign[i] > 0 ? f : b).push(nm);
                            else if (r.axisSel[i] === 1) s.push(nm);
                        }
                        return {
                            antiDeg: +(Math.asin(Math.min(1, r.axisTol)) * 57.29578).toFixed(2),
                            n: r.n, front: f.length, back: b.length, side: s.length,
                            free: r.n - f.length - b.length - s.length,
                            fwdLocal: [+r.fwdLocal[0].toFixed(4), +r.fwdLocal[2].toFixed(4)],
                            frontNames: f.slice(0, limit),
                            backNames: b.slice(0, limit),
                            sideNames: s.slice(0, limit),
                        };
                    },
                    /** ★★★ 用户 m18305「袖子向两侧飘」的 A/B 读数：袖骨骨尾相对**动画姿势**
                     *  尾位在角色自身坐标系里的 X（侧向）/ Z（前后）分量均值，单位米。
                     *  同一份样本取多次再平均，见 `_tools/sleeve-probe.js`。
                     *  只读，不改任何粒子/四元数。 */
                    sleeve: () => (secRef.current ? measureSleeve(secRef.current) : null),
                    /** ★ t16：**走向无关**的袖向读数 —— 量的是求解后实际生效的静止目标方向
                     *  `_vRest`（世界单位向量）相对动画静止方向的偏角，**不含** `carry`/风按
                     *  行走方向加的偏置。`sideDeg` 正 = 朝该骨自己那一侧张开。
                     *  用途：证明「朝 +X 走」与「朝 +Z 走」的袖子姿态相同。 */
                    sleevePose: () => (secRef.current ? measureSleevePose(secRef.current) : null),
                    sleeveDbg: () => (secRef.current ? ((secRef.current as unknown as {_sleeveDbg?: unknown})._sleeveDbg ?? null) : null),
                    rawprobe: () => {
                        const r = secRef.current as unknown as { n: number; driveSel: Uint8Array; particle: Float32Array; bones: { name: string; parent: { name: string } | null }[] };
                        if (!r) return null;
                        const idx: number[] = [];
                        for (let k = 0; k < r.n; k++) if (r.driveSel[k] === 1) idx.push(k);
                        return {
                            rigN: r.n, partLen: r.particle.length, selN: idx.length,
                            r183: [183, 184, 250, 300, 400, 500].map((k) => [k, r.bones[k].name, r.particle[k*3], r.particle[k*3+2]]),
                            probeRange: (() => { const s = secRef.current as unknown as { particle: Float32Array; restLen: Float32Array; parentIdx: Int32Array }; const out: (number | string)[][] = []; for (let k = 182; k <= 360; k++) out.push([k, Number.isFinite(s.particle[k*3]) ? 1 : 0, s.parentIdx[k], r.bones[k].name]); return out; })(),
                            parentNames: (() => { const s = secRef.current as unknown as { parentIdx: Int32Array }; const set: string[] = []; for (let k = 0; k < r.n; k++) { if (s.parentIdx[k] >= 0) continue; const p = r.bones[k].parent; if (!p) continue; const nm = p.name; if (!set.includes(nm)) set.push(nm); } return set.slice(0, 40); })(),
                            nanFin: (() => { const s = secRef.current as unknown as { particle: Float32Array; particlePrev: Float32Array; parentIdx: Int32Array; sideSel: unknown }; const bad: number[] = []; for (let k = 0; k < r.n; k++) if (!Number.isFinite(s.particle[k*3])) bad.push(k); const badFin = bad.filter((k) => Number.isFinite((s.particlePrev as Float32Array)[k*3])); return { badN: bad.length, firstBad: bad.slice(0, 8), badWithFinitePrev: badFin.slice(0, 8), hasSideSel: !!(s.sideSel as number[]) }; })(),
                            nanHist: (() => { const s = secRef.current as unknown as { particle: Float32Array; _nanHist?: number[] }; const v = s._nanHist; if (!v) return null; const out: number[][] = []; for (let i = 0; i < 8; i++) out.push(v.slice(i * 6, i * 6 + 6).map((x) => +x.toFixed(3))); return out; })(),
                            direct: (() => { const s = secRef.current as unknown as { particle: Float32Array }; return [s.particle[183*3], s.particle[184*3]]; })(),
                            dsel183: r.driveSel[183],
                            first: idx.slice(0, 4).map((k) => [k, r.bones[k].name, r.particle[k*3]]),
                            finiteAll: (() => { let ok = 0; for (let k = 0; k < r.n; k++) if (Number.isFinite(r.particle[k*3])) ok++; return ok; })(),
                            finiteSel: idx.filter((k) => Number.isFinite(r.particle[k*3])).length,
                            firstFiniteIdx: (() => { for (let k = 0; k < r.n; k++) if (Number.isFinite(r.particle[k*3])) return k; return -1; })(),
                            win: [170, 200, 340, 372].map((k) => (k < r.n ? [k, r.bones[k].name, Number.isFinite(r.particle[k*3]) ? 1 : 0] : [k, '?', -1])),
                            finRanges: (() => { const out: number[][] = []; let st = -1; for (let k = 0; k <= r.n; k++) { const f = k < r.n && Number.isFinite(r.particle[k*3]); if (f && st < 0) st = k; else if (!f && st >= 0) { out.push([st, k - 1]); st = -1; } } return out; })(),
                        };
                    },
                    /** ★ 侧向摆动的判据链（缺一个就说明那段没跑）：
                     *  `sideBones` = 抓到的胳膊关节根数（0 ⇒ 构建期没找到）、
                     *  `sideArm` = 关节名、`sideN` = 本帧被侧向推的袖骨根数、
                     *  `sideDeg` = 本帧最大侧向角（度）、`sideRoll` = 每侧摆速归一值
                     *  （−1 = 该侧没数据）。 */
                    side: () => {
                        const r = secRef.current;
                        if (!r) return null;
                        return {
                            sideBones: r.sideArm.length,
                            sideArm: r.sideArm.map((b) => b.name),
                            /** ★ t20 标定：捕获到的关节世界 y（与 sideArm 同序） */
                            sideArmY: (r.sideArmY || []).map((v) => +v.toFixed(3)),
                            sideSideN: r.sideSideN,
                            sideN: r.sideN,
                            sideDeg: +(r.sideDeg * 57.29578).toFixed(2),
                            sideRoll: r.sideRoll,
                            sideAmp: r.sideAmt ?? 0,
                            dbg: [r._sideDbgW, r._sideDbgRoll, r._sideDbgAmt, r._sideDbgSd],
                            dbgDeg: r._sideDbgDeg ?? 0,
                            /* ★★ t20：近裙摆减推量的三项参数（复核时用来复算 hw）。 */
                            sideHi: [r.sideHiK ?? 0, r.sideHiLo ?? 0, r.sideHiHi ?? 0],
                            /* ★★ t20：本帧最后一根袖骨的高度权重（1 = 满推） */
                            sideHiW: r._sideDbgH ?? null,
                            /** ★ t20 标定：本帧算 hw 用的 `_vHead.y`（场景世界坐标） */
                            sideHiY: r._sideDbgHy ?? null,
                            sel1: r._sideDbgSel1, hit: r._sideDbgHit, kids: r._sideDbgKids, names: r._sideDbgNames,
                        };
                    },
                    /** ★ 袖↔衣专属互穿读数（`auditClash` 是全组混算，袖↔衣的改善会被
                     *  裙摆↔裙摆的 0.0017 m 埋掉）。返回衣身/前襟两档最短距离与命中根数。 */
                    sleeveClash: () => (secRef.current ? auditSleeveClash(secRef.current) : null),
                    /* ★★ 骨表全量转储（诊断用）：列出**每一根**骨的名字/索引/落脚权重/骨长/
                     *  世界高度，用来查「同名骨重复」这种会让 `secTail(name)` 取错对象的问题。
                     *  只能用索引取骨：`Skirt_15_1` 在本模型里存在**两个实例**（一个 w=1.00 是真裙摆，
                     *  一个 w=0.09 是别处同名对象），`findIndex` 只会拿到第一个。 */
                    secDump: () => {
                        const r = secRef.current;
                        if (!r) return null;
                        const out: object[] = [];
                        for (let i = 0; i < r.n; i++) {
                            const b = r.bones[i];
                            const nm = b.name || '';
                            if (!/Skirt|Hair|髪/.test(nm)) continue;
                            b.updateWorldMatrix(true, false);
                            _vTip.setFromMatrixPosition(b.matrixWorld);
                            out.push({
                                i, nm,
                                lw: +r.landWgt[i].toFixed(3),
                                y: +_vTip.y.toFixed(3),
                                len: +r.restLen[i].toFixed(3),
                                sel: r.secdriveSel[i],
                                par: b.parent ? (b.parent.name || '') : '',
                            });
                        }
                        return out;
                    },
                    /* ★★★ 按**索引**取骨尾（诊断）。必须提供这个：本模型存在大量同名骨
                     *  （`Skirt_0_1` 有 20 个实例、`Skirt_15_1` 有 3 个），`secTail(name)` 的
                     *  `findIndex` 只会返回**第一个**同名骨 —— 那个往往 `landWgt=0.09`，
                     *  于是「落脚脉冲没效果」的结论其实是**测错了骨**（踩过两次）。
                     *  真裙摆满权重链：i=543(Skirt_10_1,w0.70) → 549(w0.77) → 555(w0.84)
                     *  → 561(w0.91) → 567(w0.96) → 571(Skirt_15_1,w1.00)。 */
                    /* ★ 材质名 → 覆盖骨数（`_tools/matdump.js` 用）。
                     *  为什么需要它：第十九轮的 `collectPieceSel()` 按材质名分片，
                     *  而「带」这个判据实测选中 **360 根**骨 —— 比披风的 119 根多 3 倍，
                     *  怀疑不止腰侧飘带（可能含裙带）。要判这一点只能把材质名数出来，
                     *  不能靠猜。这里还顺带给出每组覆盖到的**骨名去重前 8 个**，
                     *  一眼就能看出「这是飘带还是裙片」。 */
                    hairSkinAudit: () => {
                        const source = model.mesh as THREE.SkinnedMesh;
                        const mesh = source;
                        const g = mesh.geometry, sk = mesh.skeleton;
                        const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
                        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                        const r = secRef.current;
                        const rows: any[] = [];
                        for (const gr of g.groups) {
                            const name = (mats[gr.materialIndex ?? 0]?.userData as any)?.mmdMaterial?.name ?? '';
                            if (!/^髮$/.test(name)) continue;
                            const counts = new Map<number, Set<number>>();
                            for (let j = gr.start; j < gr.start + gr.count; j++) {
                                const vi = g.index!.getX(j);
                                for (let k = 0; k < 4; k++) {
                                    if (sw.array[vi * 4 + k] < 0.15) continue;
                                    const bi = si.array[vi * 4 + k];
                                    if (!counts.has(bi)) counts.set(bi, new Set());
                                    counts.get(bi)!.add(vi);
                                }
                            }
                            for (const [bi, vertices] of counts) {
                                const b = sk.bones[bi], ri = r?.bones.indexOf(b) ?? -1;
                                let minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
                                for (const vi of vertices) {
                                    const v = new THREE.Vector3().fromBufferAttribute((source.userData.hairAuditPosition ?? g.attributes.position) as THREE.BufferAttribute, vi);
                                    mesh.applyBoneTransform(vi, v); v.applyMatrix4(mesh.matrixWorld);
                                    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
                                    minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
                                }
                                rows.push({bi, name:b.name, ri, group:ri>=0?r?.matGroup[ri]:null, count:vertices.size, minY,maxY,minZ,maxZ, auto:b.matrixAutoUpdate, scale:b.scale.toArray(), raw:b.userData.mmdBoneName, rest:b.userData.mmdRestPosition, head:b.getWorldPosition(new THREE.Vector3()).toArray()});
                            }
                        }
                        return rows;
                    },
                    mmdMaterials: () => {
                        const mesh: any = (model as any)?.mesh;
                        if (!mesh) return null;
                        const g = mesh.geometry;
                        const idx = g?.index;
                        const si = g?.attributes?.skinIndex;
                        const sw = g?.attributes?.skinWeight;
                        const groups = g?.groups;
                        const rawMats = mesh.material;
                        const mats: any[] = Array.isArray(rawMats) ? rawMats : [rawMats];
                        const allBones: any[] = mesh.skeleton?.bones ?? [];
                        if (!idx || !si || !sw || !groups) return null;
                        const itemSize = si.itemSize || 4;
                        const iArr = idx.array, siArr = si.array, swArr = sw.array;
                        const out: any[] = [];
                        for (const gr of groups) {
                            const m = mats[gr.materialIndex as number];
                            const nm = m?.userData?.mmdMaterial?.name || '';
                            if (!nm) continue;
                            const names = new Set<string>();
                            const end = Math.min(gr.start + gr.count, iArr.length);
                            for (let j = gr.start; j < end; j++) {
                                const vi = iArr[j];
                                if (vi == null) continue;
                                for (let k = 0; k < itemSize; k++) {
                                    const w = swArr[vi * itemSize + k];
                                    if (!(w >= 0.15)) continue;
                                    const bb = allBones[siArr[vi * itemSize + k]];
                                    if (bb?.name) names.add(bb.name);
                                }
                            }
                            out.push({ index: gr.materialIndex, name: nm, bones: names.size, sample: [...names].slice(0, 8) });
                        }
                        /* 同名材质会出现在多个 group 里（本体 + 描边）⇒ 合并同名。 */
                        const by: Record<string, any> = {};
                        for (const r of out) {
                            const k = r.name;
                            if (!by[k]) by[k] = { name: k, groups: 0, bones: 0, sample: r.sample };
                            by[k].groups++;
                            by[k].bones = Math.max(by[k].bones, r.bones);
                        }
                        return Object.values(by);
                    },
                    secTailI: (i: number) => {
                        const r = secRef.current;
                        const gg = groupRef.current;
                        if (!r || !gg || !(i >= 0 && i < r.n)) return null;
                        const b = r.bones[i];
                        b.updateWorldMatrix(true, false);
                        _vTip.set(r.restDirLocal[i * 3], r.restDirLocal[i * 3 + 1], r.restDirLocal[i * 3 + 2])
                            .multiplyScalar(r.restLen[i]);
                        _vTip.applyMatrix4(b.matrixWorld);
                        const ry3 = gg.rotation.y;
                        const rx3 = _vTip.x - gg.position.x, rz3 = _vTip.z - gg.position.z;
                        const ry4 = gg.position.y;
                        return {
                            i, name: b.name || '',
                            lw: +r.landWgt[i].toFixed(4),
                            len: +r.restLen[i].toFixed(4),
                            ldeg: +((r.landN > 0 ? r.landDeg : 0)).toFixed(3),
                            tipU: +(_vTip.y - ry4).toFixed(4),
                            tipS: +(rx3 * Math.cos(ry3) - rz3 * Math.sin(ry3)).toFixed(4),
                            /* ★ 第十九轮：**前后**分量（角色局部 +Z = 正面）。
                             *  任务3「裙子被大腿顶起来往前飘」要量它：向前 = tipF 变大。 */
                            tipF: +(rx3 * Math.sin(ry3) + rz3 * Math.cos(ry3)).toFixed(4),
                            /* ★ 真·径向距离（到角色中轴的水平距离）。`tipS` 只是「左右」一个轴，
                             *  量不到身后的布；参考视频的 `hemW` 量的是**整圈**跨度，
                             *  用 `tipR` 取全圈均值/最大才是同一口径。 */
                            tipR: +Math.hypot(rx3, rz3).toFixed(4),
                            /* ★ 第二十九轮：把 `gg` 本身也报出来（tipS/tipF/tipR 的参照系）。
                             *  为什么需要：`secTailI` 的骨表只含布料+头发（腿不在内），
                             *  探针要量腿的「朝前分量」必须用**同一个** gg，否则两个数不可比。
                             *  本轮实测：靠猜候选对象的 local position 反算，delta 差 10 m。 */
                            gx: +gg.position.x.toFixed(5),
                            gy: +gg.position.y.toFixed(5),
                            gz: +gg.position.z.toFixed(5),
                            gry: +gg.rotation.y.toFixed(5),
                            /* ★ 第二十轮：世界坐标（绝对，不减 `g.position`）。
                             *  为什么要有它：上面那些都是「相对角色」的量，量不出
                             *  「停下来之后布还在自己漂 / 相邻帧骨尾突然跳一大下」——
                             *  那类判据必须比同一根骨的**世界位置**逐帧差。
                             *  探针 `_tools/stopdrift.js` 就靠它算 `maxJump`。 */
                            ux: +_vTip.x.toFixed(5), uy: +_vTip.y.toFixed(5), uz: +_vTip.z.toFixed(5),
                            /* ⚠️ 第二十五轮曾在这里加过一个「逐骨 dev（当前方向 vs 动画方向）」，
                             *  实测四组全 89~116°、且方向相反 —— `restDirWorld` 在 **character
                             *  空间**而非 world 空间，与骨世界方向点积得到的是垃圾。
                             *  按 R5「量具先自检」撤掉，**不要照着重写**。判「哪片布在晃」用
                             *  `tipU/tipS/tipF` 相对**站定姿态**的位移（口径明确，已验证）。 */
                            /* 骨头世界坐标（相对角色；判「上段/下段」用它，比骨尾稳） */
                            /* â ç¬¬ä¸åä¸è½®ï¼éª¨å¤´ä¸çåæ ï¼ä¸ ux/uy/uz åä¸å¥åä½ï¼ã
                             *  ä¸ºä»ä¹è¦æï¼`hU` åªæé«åº¦ï¼éãéª¨æ£ Ã éª¨æ£ãæè¿è·ç¦»æ¼ä¸åºæ¥ã
                             *  ç¬¬ä¸åä¸è½®å¤´åç©¿æ¨¡éå·å°±å ä¸ºç¼ºå®åªè½æ¿éª¨å°¾å½ç¹éã */
                            hx: +r.bones[i].matrixWorld.elements[12].toFixed(5),
                            hy: +r.bones[i].matrixWorld.elements[13].toFixed(5),
                            hz: +r.bones[i].matrixWorld.elements[14].toFixed(5),
                            hU: +(() => { const e = r.bones[i].matrixWorld.elements; return e[13] - gg.position.y; })().toFixed(4),
                            /* ★★ 第二十六轮 d：**骨自身的方向**（角色坐标，单位向量）。
                             *  为什么必须补：判「披肩上段是不是不动」只能用**转角**，
                             *  不能用骨尾位移 —— 位移 = 转角 × 骨长，披肩下段骨链长、
                             *  上段短，同样转角下位移天然差 5 倍（`shawlwgt.js` 已记过这个坑）。
                             *  本轮我又用 `dU`（竖直）、`tipS`（左右）、3D 位移各错了一次。
                             *  three 的骨骼沿自身 +Y 延伸 ⇒ `matrixWorld` 第 2 列就是骨方向。 */
                            dirS: +(() => {
                                const e = r.bones[i].matrixWorld.elements;
                                let x = e[4], y = e[5], z = e[6];
                                const l = Math.hypot(x, y, z) || 1;
                                x /= l; z /= l;
                                return x * Math.cos(ry3) - z * Math.sin(ry3);
                            })().toFixed(5),
                            dirF: +(() => {
                                const e = r.bones[i].matrixWorld.elements;
                                let x = e[4], y = e[5], z = e[6];
                                const l = Math.hypot(x, y, z) || 1;
                                x /= l; z /= l;
                                return x * Math.sin(ry3) + z * Math.cos(ry3);
                            })().toFixed(5),
                            dirU: +(() => {
                                const e = r.bones[i].matrixWorld.elements;
                                let x = e[4], y = e[5], z = e[6];
                                const l = Math.hypot(x, y, z) || 1;
                                return y / l;
                            })().toFixed(5),
                        };
                    },
                    secTail: (name: string) => {
                        const r = secRef.current;
                        const gg = groupRef.current;
                        if (!r || !gg) return null;
                        const i = r.bones.findIndex((x) => x.name === name);
                        if (i < 0) return null;
                        const ry = gg.rotation.y;
                        const fx = Math.sin(ry), fz = Math.cos(ry);
                        const rx = r.particle[i * 3] - gg.position.x;
                        const ry2 = r.particle[i * 3 + 1] - gg.position.y;
                        const rz = r.particle[i * 3 + 2] - gg.position.z;
                        return {
                            name, sel: r.axisSel[i], sign: r.axisSign[i],
                            /* ★ 落脚脉冲诊断：该骨在本帧是否真被这条通道选中/转动。
                             *  `lw` 是高度权重（0 = 没选中）、`lbd` = 写回基准方向是否非零、
                             *  `len` = 骨长（决定同样角度下骨尾能移动多少）、`ldeg` = 本帧角度（度）。 */
                            lw: +r.landWgt[i].toFixed(4),
                            len: +r.restLen[i].toFixed(4),
                            lbd: (r.landBaseDir[i * 3] !== 0 || r.landBaseDir[i * 3 + 1] !== 0 || r.landBaseDir[i * 3 + 2] !== 0) ? 1 : 0,
                            ldeg: +((r.landN > 0 ? r.landDeg : 0)).toFixed(3),
                            fwd: +(rx * fx + rz * fz).toFixed(4),
                            up: +ry2.toFixed(4),
                            side: +(rx * fz - rz * fx).toFixed(4),
                            hits: r.antiHits, maxDeg: +r.antiMaxDeg.toFixed(3),
                            /* ★ 真·渲染位置（骨尾世界坐标 = 骨骼矩阵 × 本地骨长方向）。
                             *  ⚠️ 上面 `up/side/fwd` 读的是 `r.particle` —— 那是**约束之后**
                             *  的粒子位置，而 `landBaseDir` 的四元数增量是在**这之后**才写到
                             *  `b.quaternion` 上的 ⇒ 粒子读不到落脚脉冲的贡献。
                             *  判「落脚脉冲到底动没动」，必须读这里。 */
                            /* 骨尾 = 头 + matrixWorld × (restDirLocal × restLen)。
                             *  必须在 `updateWorldMatrix` **之后**读，否则拿到上一帧。 */
                            tipU: +(() => {
                                const b = r.bones[i];
                                b.updateWorldMatrix(true, false);
                                _vTip.set(r.restDirLocal[i * 3], r.restDirLocal[i * 3 + 1], r.restDirLocal[i * 3 + 2])
                                    .multiplyScalar(r.restLen[i]);
                                _vTip.applyMatrix4(b.matrixWorld);
                                return _vTip.y - gg.position.y;
                            })().toFixed(4),
                            tipS: +(() => {
                                const b = r.bones[i];
                                const ry3 = gg.rotation.y;
                                b.updateWorldMatrix(true, false);
                                _vTip.set(r.restDirLocal[i * 3], r.restDirLocal[i * 3 + 1], r.restDirLocal[i * 3 + 2])
                                    .multiplyScalar(r.restLen[i]);
                                _vTip.applyMatrix4(b.matrixWorld);
                                const rx3 = _vTip.x - gg.position.x, rz3 = _vTip.z - gg.position.z;
                                return rx3 * Math.cos(ry3) - rz3 * Math.sin(ry3);
                            })().toFixed(4),
                        };
                    },
                    /* ★ 方向性约束的总账：把所有前侧骨/后侧骨在**角色前向轴**上的尾巴坐标
                     *  取极值。「前侧骨最靠后的那一根」跑到负值 = 布片已经越到身体后面了。
                     *  参考点用角色 group 的位置（地面、约在身体中轴正下方），所以数值可直接
                     *  读成「相对身体中线前后多少米」。on/off 两组用同一个参考点，可比。 */
                    antiStat: () => {
                        const r = secRef.current;
                        const gg = groupRef.current;
                        if (!r || !gg) return null;
                        const ry = gg.rotation.y;
                        const fx = Math.sin(ry), fz = Math.cos(ry);
                        let fMin = Infinity, fMax = -Infinity, bMin = Infinity, bMax = -Infinity;
                        let worst = -1;
                        for (let i = 0; i < r.n; i++) {
                            if (r.axisSel[i] !== 0) continue;
                            const rx = r.particle[i * 3] - gg.position.x;
                            const rz = r.particle[i * 3 + 2] - gg.position.z;
                            const f = rx * fx + rz * fz;
                            if (r.axisSign[i] > 0) {
                                if (f < fMin) { fMin = f; worst = i; }
                                if (f > fMax) fMax = f;
                            } else {
                                if (f < bMin) bMin = f; if (f > bMax) bMax = f;
                            }
                        }
                        const t = (v: number) => (isFinite(v) ? +v.toFixed(4) : null);
                        return {
                            antiOn: r.antiOn,
                            antiDeg: +(Math.asin(Math.min(1, r.axisTol)) * 57.29578).toFixed(2),
                            yaw: +ry.toFixed(4),
                            fwd: [+fx.toFixed(4), +fz.toFixed(4)],
                            frontMin: t(fMin), frontMax: t(fMax),
                            backMin: t(bMin), backMax: t(bMax),
                            // 「最靠后的那根前侧骨」是谁、它的绑定悬挂方向在该轴上的分量是多少、
                            // 它本帧被约束修正了多少度。`restAxis` 是负的 ⇒ 该骨的绑定姿势
                            // 本来就指向身后，约束基准因此偏后（诊断用）。
                            worst: worst < 0 ? null : r.bones[worst].name,
                            worstRestAxis: worst < 0 ? null : +r.restAxis[worst].toFixed(4),
                            hits: r.antiHits, maxDeg: +r.antiMaxDeg.toFixed(3),
                        };
                    },
                    gait: () => ({
                        stride: STRIDE, loopDur: LOOP_DUR, cycleSec: CYCLE_SEC,
                        walkSpeed: WALK_SPEED,
                        runSpeed: RUN_SPEED, gaitCap: GAIT_CAP, idleCreep: IDLE_CREEP,
                        pace: PACE, gain: SPEED_GAIN,
                        maxFrame: maxFrameRef.current, warned: warned.current,
                        // ★ 长时走路的定量证据：加载器当前落在第几帧。
                        //   若「走着走着腿不动」，这个数会停住；正常会 0→maxFrame 循环。
                        frame: frameRef.current,
                        motion: MOTION_URL, ikOn: IK_ON, leanDeg: LEAN_DEG, leanNow: leanRef.current,
                        secondary: secRef.current
                            ? {
                                bones: secRef.current.bones.length,
                                hair: secRef.current.info.hair,
                                cloth: secRef.current.info.cloth,
                                // 全局参数（每根骨在 create 时还会按头发/裙摆再乘一次系数）
                                stiffness: secRef.current.info.stiffness,
                                gravity: secRef.current.info.gravity,
                                wind: secRef.current.info.wind,
                                colliders: secRef.current.info.colliders,
                                skips: secRef.current.info.skips,
                                colScale: secRef.current.colScale,
                                colLeg: SEC_COLS_LEG,
                                colIter: secRef.current.iterations,
                                colRod: secRef.current.rodSamples,
                                colRepel: secRef.current.repelD,
                                colRepelPairs: secRef.current.repelReady ? secRef.current.repelCount : 0,
                                repelHits: secRef.current.repelHits,
                                repelMax: +secRef.current.repelMax.toFixed(4),
                                colSlackMax: secRef.current.slackMax,
                                colWindFront: secRef.current.windFront,
                                colCarry: secRef.current.carry,
                                // ★★ 方向性约束（任务2）：`hits > 0` 才说明约束真的拦住了
                                //    「身前衣服被甩到身后」。`maxDeg` 是本帧最大修正角。
                                antiDeg: +(Math.asin(Math.min(1, secRef.current.axisTol)) * 57.29578).toFixed(2),
                                antiBones: secRef.current.axisSel.reduce((c, v) => c + (v !== 2 ? 1 : 0), 0),
                                antiHits: secRef.current.antiHits,
                                antiMaxDeg: +secRef.current.antiMaxDeg.toFixed(3),
                                // ★★ 肢体驱动（用户 m12638 / m12655）：`driveFwd`/`driveArm` 是本帧
                                //    腿/胳膊的向前摆量 0..1，`driveN` 是被推动的骨数。
                                //    「前襟真的向前摆了」的定量证据 = 走路时 driveFwd 周期性回到 0 又上来。
                                driveDeg: +(secRef.current.driveAmp * 57.29578).toFixed(2),
                                driveLead: +secRef.current.driveLead.toFixed(3),
                                driveFrontBones: secRef.current.driveSel.reduce((c, v) => c + (v === 2 ? 1 : 0), 0),
                                driveArmBones: secRef.current.driveSel.reduce((c, v) => c + (v === 1 ? 1 : 0), 0),
                                driveFwd: +secRef.current.driveFwd.toFixed(3),
                                driveArm: +secRef.current.driveArm.toFixed(3),
                                driveRaw: +secRef.current.driveRaw.toFixed(3),
                                driveArmRaw: +secRef.current.driveArmRaw.toFixed(3),
                                limbSwing: Array.from(secRef.current._limbSwing).map((v) => +v.toFixed(3)),
                                limbRef: Array.from(secRef.current._limbRef).map((v) => +v.toFixed(3)),
                                driveN: secRef.current.driveN,
                                /* ★★ 袖子外撑（用户 2026-10-21 反馈1「袖子走路时向外延」）。
                                 *   三个数缺一不可，因为它们各自堵一类「参数对、功能没生效」：
                                 *   `flareBones` 是**构建期**分类结果（静态）。为 0 ⇒ 分类根本没跑，
                                 *     此时任何运行期读数都会是 0，先查这个再看别的；
                                 *   `flareN` 是**运行期**本帧被撑开的骨数。`flareBones>0` 而这里 0
                                 *     ⇒ 撑开量被速度门压成 0（`flareSpd` 会给出实际用的速度）；
                                 *   `flareDeg` 是参数本身（度），用来证明 URL 参数真的读进来了。
                                 *   `flareAmt` 是本帧撑开量 0..1，与 `flareDeg` 相乘才是实际角度。 */
                                flareDeg: +(secRef.current.flareAmp * 57.29578).toFixed(2),
                                flareBones: secRef.current.flareBones,
                                flareN: secRef.current.flareN,
                                flareAmt: +secRef.current.flareAmt.toFixed(3),
                                flareSpd: +secRef.current.flareSpd.toFixed(3),
                                flareMeanDeg: +secRef.current.flareDeg.toFixed(3),
                                /* 米级取证：袖骨离体轴的水平距离。外撑生效 ⇒ 同一相位下
                                 * `flareOlMean` 随 `?secflare=` 单调变大；单位米，可直接与
                                 * 「衣身半径」比较判断还有多少穿模余量。 */
                                flareOlMean: +secRef.current.flareOlMean.toFixed(4),
                                flareOlMax: +secRef.current.flareOlMax.toFixed(4),
                                /* ★ 米级取证（判据）：外撑**净贡献**的位移 —— 「带外撑」与
                                 * 「不带外撑」两种求解下袖骨位置的欧氏距离，单位米。
                                 * 随 `?secflare=` 单调变大才算「撑开真的有效」，不受步态相位影响。 */
                                flareShiftMean: +secRef.current.flareShiftMean.toFixed(5),
                                flareShiftMax: +secRef.current.flareShiftMax.toFixed(5),
                                flareShiftN: secRef.current.flareShiftN,
                                /* ★★★ 袖子侧向摆动（用户 m18305「袖子向两侧飘」）。
                                 *  判据与 `flareBones/flareN` 同一套：`sideBones`（构建期臂饰分类）
                                 *  > 0 才说明 `?secside=` 这条通道真的建起来了；`sideN` 是本帧
                                 *  被摆的骨数，`sideDeg` 是本帧平均摆角（度）。`?secside=-1`
                                 *  时三者应同时归 0。 */
                                sideBones: secRef.current.sideBones,
                                sideN: secRef.current.sideN,
                                /* ★ 第二十四轮 v3：每根骨属于哪类布（0其它/1头发/2披风/3带/4披肩/5裙/6袖）。
                                 *  `hairClash` 量具和 `_tools/hairradial.js` 都要它 —— 没有这张表，
                                 *  「头发穿进裙」只能靠肉眼看图（用户 m02740 就是这么发现的）。 */
                                matGroup: secRef.current.matGroup,
                                /* ★ 第二十四轮 v3：头发径向让位的逐帧读数。
                                 *  `hairSepN` = 本帧真正让位的头发骨数、`hairSepDeg` = 累计让位角（度）。
                                 *  `?hairsep=0` 时两者恒 0（可回滚判据）。 */
                                /* ★ 第二十四轮 v4：弹簧刚度/限角乘数 + 本帧刚度均值。
                                 *  `stiffMean` 从 `stiff[]` 数组**重算**，证明乘数真的进了数组
                                 *  而不只是读进了常量（本文件踩过「参数打印正确 ≠ 功能生效」3 次）。 */
                                spring: {
                                    stiffK: secRef.current.stiffK,
                                    limitK: secRef.current.limitK,
                                    kHair: secRef.current.kHair,
                                    kSkirt: secRef.current.kSkirt,
                                    kOther: secRef.current.kOther,
                                    stiffMean: +(secRef.current.stiffMean || 0).toFixed(2),
                                    stiffRef: +(
                                        (() => {
                                            const P = secRef.current;
                                            if (!P.stiffness || !P.stiffness.length) return 0;
                                            let s4 = 0;
                                            for (let i4 = 0; i4 < P.n; i4++) s4 += P.stiffness[i4];
                                            return s4 / Math.max(1, P.n);
                                        })()
                                    ).toFixed(2),
                                },
                                hairSep: secRef.current.hairSep,
                                hairSepN: secRef.current.hairSepN,
                                hairSepDeg: +(secRef.current.hairSepDeg).toFixed(2),
                                hairApplied: secRef.current.hairApplied,
                                sideDeg: +(secRef.current.sideDeg * 57.29578).toFixed(2),
                                sideRoll: +secRef.current.sideRoll.toFixed(3),
                                sideAmt: +secRef.current.sideAmt.toFixed(3),
                                sideFrontKill: +secRef.current.sideFrontKill.toFixed(3),
                                /* ★★★ 落脚脉冲（用户 m07388）—— 判据与 sideBones 同一套：
                                 *  `landBones`（构建期建表根数）> 0 才说明通道真的建起来了；
                                 *  `landN` 是本帧被转的骨数、`landDeg` 本帧平均角（度）、
                                 *  `landPulse` 本帧脉冲强度（0..1）、`stepPhase` 步态相位。
                                 *  `?secland=-1` 时后四者应同时归 0 / NaN。 */
                                landBones: secRef.current._landN,
                                landN: secRef.current.landN,
                                landDeg: +(secRef.current.landDeg * 57.29578).toFixed(2),
hairFloorN: secRef.current.hairFloorN,
hairAnimOnly: secRef.current.hairAnimOnly,
hairSolveOff: secRef.current.hairSolveOff,
hairFloorDeg: +(secRef.current.hairFloorDeg * 57.29578).toFixed(2),
                                landPulse: +secRef.current.landPulse.toFixed(3),
                                /* ⚠️ `landLiftE / landSpreadE` 本对象里只许出现**一次** ——
                                 *  原来这两行在下面「起步渐入」那块又写了一遍，esbuild 每帧报
                                 *  `Duplicate key "landSpreadE" in object literal`（第二十三轮引入，
                                 *  语义无害但刷屏）。统一留下面那对（带 `|| 0`）。 */
                                landApplied: secRef.current.landApplied,
                                /* ★ 第二十一轮诊断：
                                 *  `piece*` = 整片布（披风/带）通道；`thigh*` = 裙子被大腿顶起。
                                 *  ⚠️ 两个「骨数」别混：
                                 *    `pieceCapeN/pieceRibbonN` = **构建期**选中的骨数（常数）；
                                 *    `pieceN/pieceApplied` = **本帧**真正转过 / 写回的骨数。
                                 *  站定时两条通道都不跑 ⇒ 全部为 0（符合设计）。 */
                                pieceN: secRef.current.pieceN,
                                pieceApplied: secRef.current.pieceApplied,
                                pieceDeg: +(secRef.current.pieceDegNow).toFixed(4),
                                pieceAmp: +(secRef.current.pieceAmp * 57.29578).toFixed(2),
                                pieceCapeN: secRef.current.pieceCapeN,
                                pieceRibbonN: secRef.current.pieceRibbonN,
                                /* 选骨下标表：`piecescan.js` 要在同一批骨上做开/关 A/B，
                                 *  没有它只能盲猜下标（本模型骨名重名 92 处，按名字找必错）。 */
                                pieceIds: (() => {
                                    const P = secRef.current;
                                    const cape: number[] = [], ribbon: number[] = [];
                                    const thigh: number[] = [], thighW: number[] = [];
                                    const shawl: number[] = [];
                                    for (let i = 0; i < P.n; i++) {
                                        if (P.pieceSel[i] === 1) cape.push(i);
                                        else if (P.ribbonSel[i] === 1) ribbon.push(i);
                                        else if (P.shawlSel[i] === 1) shawl.push(i);
                                    }
                                    for (let i = 0; i < P.n; i++) {
                                        if (P.thighSel[i] === 1) { thigh.push(i); thighW.push(+P.thighWgt[i].toFixed(3)); }
                                    }
                                    return { cape, ribbon, thigh, thighW, shawl };
                                })(),
                                /* ★ 第二十二轮：披肩整片通道的读数（判「整片是否同时动」） */
                                shawlN: secRef.current.shawlN,
                                shawlApplied: secRef.current.shawlApplied,
                                shawlDeg: +(secRef.current.shawlDegNow).toFixed(4),
                                /* ★ 第二十九轮：披肩**整片前移**（编号4）的设定值与本帧实际值。
                                 *  `pushN` 必须 > 0 才说明通道真的跑了（否则是参数没进来 / 选骨为空）。 */
                                shawlPush: +(secRef.current.shawlPush * 57.29578).toFixed(2),
                                shawlPushSign: secRef.current.shawlPushSign,
                                shawlPushOsc: +(secRef.current.shawlPushOsc * 57.29578).toFixed(2),
                                shawlPushN: secRef.current.shawlPushN,
                                shawlPushDeg: +(secRef.current.shawlPushDegNow * 57.29578).toFixed(3),
                                /* ★ 第三十二轮 d：钉住通道的设定值与本帧生效骨数。 */
                                shawlAmp: +(secRef.current.shawlAmp * 57.29578).toFixed(2),
                                shawlBones: secRef.current.shawlBones,
                                /* ★ 第二十四轮：四片布总幅度乘数（原值，核对参数真的读到）
                                 *  + `sleeveIds`（袖骨下标表）—— 逐骨验收要用：
                                 *  袖片没有 `pieceIds` 那种归属表，只能按 `secdriveSel===1` 反查。 */
                                clothAmp: secRef.current.clothAmp,
                                /* 1袖 的两条幅度（度，**已乘 clothAmp**）—— 必须同报：
                                 *  `sideDeg` 是**运行期平均角**，含速度归一（`sideAmt`），
                                 *  原地播放动画（不产生位移）时恒 0，单看它分不清
                                 *  「参数没进来」和「速度不够」。这条坑本文件第 1600 行记过。
                                 *  ⚠️ `sideAmt` 本对象里已在上面出现过一次（esbuild 会报
                                 *  `Duplicate key "sideAmt"` 刷屏），这里不再重复。 */
                                sideAmpDeg: +(secRef.current.sideAmp * 57.29578).toFixed(2),
                                sideOscAmpDeg: +(secRef.current.sideOscAmp * 57.29578).toFixed(3),
                                sleeveIds: (() => {
                                    const P = secRef.current;
                                    const A: number[] = [];
                                    for (let i = 0; i < P.n; i++) if (P.secdriveSel[i] === 1) A.push(i);
                                    return A;
                                })(),
                                /* ★★★ 第二十四轮 v2：**四片布的幅度一次给全**（设定角 + 本帧实际角）。
                                 *  为什么必须两个都给：`set` 证明 URL 读进来了，`now` 证明真的转了。
                                 *  只看 set 会把「参数读对但没生效」当成正常（本文件踩过 3 次同型）。 */
                                clothFlat: {
                                    /* 设定角（度，已乘 clothAmp） */
                                    set: {
                                        sleeve: +(secRef.current.sideAmp * 57.29578).toFixed(2),
                                        sleeveOsc: +(secRef.current.sideOscAmp * 57.29578).toFixed(2),
                                        shawl: +(secRef.current.shawlAmp * 57.29578).toFixed(2),
                                        cape: +(secRef.current.pieceAmp * 57.29578).toFixed(2),
                                        ribbon: +(secRef.current.pieceAmp * 0.65 * 57.29578).toFixed(2),
                                    },
                                    /* 本帧实际（度）：侧摆/披肩/披风+带 的逐骨平均角 */
                                    now: {
                                        sleeve: +(secRef.current.sideDeg * 57.29578).toFixed(2),
                                        shawl: +(secRef.current.shawlDegNow * 57.29578).toFixed(2),
                                        piece: +(secRef.current.pieceDegNow * 57.29578).toFixed(2),
                                    },
                                    amp: secRef.current.clothAmp,
                                },
                                /* ★★★ 第二十五轮：**本轮四条新通道的生效证据**。
                                 *  `netN` / `holdN` = 本帧真被一致化 / 被压住的骨数。
                                 *  只看设定值会把「参数读对但通道没跑」当成正常
                                 *  （本文件踩过 6 次同型坑：pieceAmp/thighAmp/shawlAmp/
                                 *   sideFrontKill/hairSep/matGroup/stiff）。
                                 *  自检口诀：设了非 0 却 `*N === 0` ⇒ 通道没跑，先查闸门/作用域。 */
                                clothNet: {
                                    netCape: secRef.current.netCape,
                                    netRibbon: secRef.current.netRibbon,
                                    netShawl: secRef.current.netShawl,
                                    netSkirt: secRef.current.netSkirt,
                                    netN: secRef.current.netN,
                                    holdCape: secRef.current.holdCape,
                                    holdRibbon: secRef.current.holdRibbon,
                                    holdShawl: secRef.current.holdShawl,
                                    holdSkirt: secRef.current.holdSkirt,
                                    holdN: secRef.current.holdN,
                                    holdReady: secRef.current.holdReady,
                                    stiffCape: secRef.current.stiffCape,
                                    stiffRibbon: secRef.current.stiffRibbon,
                                    stiffShawl: secRef.current.stiffShawl,
                                },
                                /* ★ 第二十二轮：起步渐入权重 + 头发相位偏移（验收要读） */
                                gaitW: +secRef.current.gaitW.toFixed(3),
                                hairPh: secRef.current.hairPh,
                                hairLiftE: +(secRef.current._hairLiftE || 0).toFixed(3),
                                hairSpreadE: +(secRef.current._hairSpreadE || 0).toFixed(3),
                                /* 裙摆的两条包络（对比用：验「头发比裙摆先扬」） */
                                landLiftE: +(secRef.current._landLiftE || 0).toFixed(3),
                                landSpreadE: +(secRef.current._landSpreadE || 0).toFixed(3),
                                thighN: secRef.current.thighN,
                                thighApplied: secRef.current.thighApplied,
                                thighDeg: +(secRef.current.thighDeg).toFixed(4),
                                thighAmt: +secRef.current.thighAmt.toFixed(3),
                                /* ★ 分侧驱动量：逐骨验收要按侧配对（见 `_tools/thighscan2.js`） */
                                amtL: +secRef.current.amtL.toFixed(3),
                                amtR: +secRef.current.amtR.toFixed(3),
                                thighAmp: +(secRef.current.thighAmp * 57.29578).toFixed(2),
                                stepPhase: Number.isFinite(secRef.current.stepPhase)
                                    ? +secRef.current.stepPhase.toFixed(3) : null,
                                collide: secRef.current.info.collide,
                                ms: +secRef.current.lastMs.toFixed(3),
                                limitDeg: +(secRef.current.limit[0] * 57.29578).toFixed(2),
                                keep: +secRef.current.keep[0].toFixed(3),
                                vel: [+vel.current.x.toFixed(3), +vel.current.z.toFixed(3)],
                                primed: secRef.current.primed,
                                // ★ 定量证据：弹簧骨的实际朝向 vs 本帧动画方向的夹角（度）。
                                //   站着不动会收敛到 ~0；走/转时才有值 ⇒ 证明「头发真的在飘」。
                                //   `?secondary=0` 时这里恒为 null，正好做对照。
                                dev: +secRef.current.devDeg.toFixed(3),
                                meanDev: +secRef.current.meanDevDeg.toFixed(3),
                                peakDev: +secRef.current.peakDevDeg.toFixed(3),
                                first: secRef.current.bones.slice(0, 3).map((b) => b.name),
                            }
                            : null,
                        maskOff: MASK_OFF,
                        rootRotX: (model.root as any).rotation.x,
                        // ★ 物理（用户 m08676 任务3(2)）：无头验收靠这几个数分辨
                        //    「物理真的接上了」还是「悄悄退回了绑定姿势」。
                        physics: PHYS_ACTIVE,
                        physMode: PHYS_MODE,
                        physWrap: +physWrapRef.current.toFixed(3),
                        physDebug: (() => {
                            try { return (physBackend as any)?.diagnostics?.() ?? null; } catch { return null; }
                        })(),
                    }),
                    flags: () => {
                        const s: any = useGameStore.getState();
                        return {
                            ctrl: s.isControlEnabled, started: s.isGameStarted,
                            mode: s.cameraMode, move: MOVE_ON, frozen: T_FREEZE !== null || ANIM_T !== null,
                            keyW: input.isPressed('MoveForward'),
                        };
                    },
                };
                log('已挂进场（diagnostics → window.__mmd）');
            } catch (e: any) {
                console.error('[columbina] 加载失败', e);
                (window as any).__mmdError = String(e?.message ?? e);
            }
        })();

        return () => {
            dead = true;
            const l = live.current;
            live.current = null;
            if (l) {
                try { l.pipeline.detach(l.model); } catch { /* ignore */ }
                l.pipeline.dispose();
                /* ⚠️ 2026-10-17 补：只 detach + dispose 管线是不够的 ——
                 *   · `:2474` 把 `model.root` 挂进了 `groupRef`，卸载时 group 离开场景，
                 *     但 **mesh 的 geometry / 材质 / 贴图全留在 GPU 里**；
                 *   · 哥伦比娅这套是 `columbina/少女.pmx`（4.4 MB、三十多张 bmp 贴图、
                 *     742 根骨骼）—— dev 下每次 Fast Refresh / StrictMode 双挂载都会
                 *     再叠一份，显存一路涨到 WebGPU 报 OOM 才停。
                 * 顺序：先从场景图摘掉，再释放（先释放后摘，渲染器可能手里还攥着引用）。 */
                try {
                    l.model?.root?.removeFromParent?.();
                    l.model?.root?.traverse?.((o: any) => {
                        if (!o?.isMesh) return;
                        o.geometry?.dispose?.();
                        const mats = Array.isArray(o.material) ? o.material : [o.material];
                        for (const m of mats) {
                            if (!m) continue;
                            for (const k in m) {
                                const v: any = (m as any)[k];
                                if (v && v.isTexture) v.dispose?.();
                            }
                            m.dispose?.();
                        }
                    });
                } catch (e) {
                    console.warn('[columbina] 卸载时释放模型资源失败（忽略）', e);
                }
                // 诊断钩子要跟着失效，否则无头脚本会读到已卸载实例的 pipeline
                const w: any = window as any;
                if (w.__mmd && w.__mmd.pipeline === l.pipeline) delete w.__mmd;
            }
        };
    }, [gl, scene]);

    useEffect(() => {
        if (!MMD_ON) return;
        setCharacterRef(groupRef as any);
        return () => setCharacterRef(null);
    }, [setCharacterRef]);

    useFrame((state, delta) => {
        const l = live.current;
        if (!l?.ready) return;
        // MMD 专用光跟着太阳走（只同步位置/目标，强度是我们自己的）
        const sl = syncLight.current;
        if (sl) {
            sl.light.position.copy(sl.sun.position);
            sl.light.target.position.copy(sl.sun.target.position);
            sl.light.updateMatrixWorld(true);
            sl.light.target.updateMatrixWorld(true);
        }

        // ── 走路：直接复用参考库那套「相机相对 + 平滑」的解算器 ──────────
        //    `solveCam` 读的就是 `input` 里 WASD 映射出来的 MoveForward/RotateLeft…
        //    （映射在 `src/core/input/controls.ts:7` 的 `keyBindings`，
        //      由 `<KeyboardMapper input={input} keyMap={keyBindings} />` 写进去，
        //      见 `src/app/App.tsx:140`）。参考库原来是在 `Character.tsx` 里调的，
        //      我们没挂 `Character.tsx`，所以**之前按 WASD 什么都不动**。
        //    动作播放头也要跟着速度走，否则她是「原地踏步 + 平移」。
        const d = Math.min(delta, 0.1);   // 切走标签页再回来 delta 会很大，夹一下
        const g = groupRef.current;
        // ⚠️ `?animt=` 也要算「冻结」：它本来就是用来**静态定格某个姿态**的。
        //    之前只判 `T_FREEZE`，于是传了 `?animt=` 但没传 `?tfreeze=` 时
        //    播放头走的是「已走距离 ÷ 步长」那条相位路径，`animt` 被静默忽略
        //    —— 八张「不同相位」的图其实是同一次加载的同一瞬间（实测几乎全同）。
        /* ★★★ `?seclock=<秒>`：**定格动画时钟、但布料照常每帧积分**（t16 新增）。
         *
         *  为什么需要：`?tfreeze=` / `?animt=` 走的是 `secFrozen` 那条路 —— 暖机一次之后
         *  逐帧 `updateSecondary` 被永久跳过（见 `:3746` 与 `:3714` 的注释）。对「看裙摆
         *  静态形状」够用，但对**袖子侧摆**这种「需要速度信号 + 每帧积分」的通道是致命的：
         *  实测 `?tfreeze=1.6&animt=1.6&secvelx=0&secvelz=1.446` 下 `sleeve.x` 报 0.30 m、
         *  `pose.sideMax` 报 28°，可 `Bone_ArmLets01_L` 的 `boneMatrix` 与 `?secside=-1`
         *  **逐个元素相同**、像素差 0.16%（全在星点噪声上）—— 量到的是「粒子」，不是
         *  「被渲染的那份骨骼」（判据 J：参数打印正确 ≠ 功能生效）。
         *
         *  `?seclock=` 的做法：把动画**姿态**钉在 t 上（父骨每帧重写成同一姿态 ⇒ 可复现），
         *  但**不置** `secFrozen`，于是 `:3766` 的逐帧 `updateSecondary` 照常执行，
         *  速度用 `?secvelx/?secvelz` 注入（STANDING 判据之外，见 `SEC_VEL_ON`）。
         *  ⇒ 既有逐像素可复现的 A/B，又是真被渲染的骨姿。
         */
        const secLock = SEC_CLOCK !== null;
        const frozen = (T_FREEZE !== null || ANIM_T !== null) && !secLock;
        let moving = 0;
        // ★ 本帧移动前的水平位置 —— 碰撞推出后要拿它算「实际走了多少」（见下面「场景碰撞」）
        const preX = g ? g.position.x : 0;
        const preZ = g ? g.position.z : 0;


        /* ── ★★ 用户 m02037 任务5：自动寻路（点任务列表 → 自己走过去）────────
         * 这一支**只做两件事**：问 `autowalk.ts` 要本帧的世界方向、按方向推一步。
         * 位移仍然走下面同一段「树/桌/船推出 + 贴地 + 收尾」代码 —— 卡片要求
         * 「不新写移动系统」，所以这里绝不另起一套碰撞。
         *
         * 为什么排在 `?autowalk=` 那条诊断分支**之前**：两者都是「外部驱动」，
         * 但寻路是玩家点的，必须优先；诊断开关只用于无头出图，冲突时让位。
         *
         * 取消（卡片第 3 条）：任意方向键一按下就交还手动 —— 不靠 keyup，
         * 也不改 `controls.ts` 的 keyBindings（那套是电平式，按住连发的语义
         * 与「点一下走一段」完全不同）。
         */
        if (g && MOVE_ON && !frozen && navState.target) {
            const navKey = input.isPressed('MoveForward') || input.isPressed('MoveBackward')
                || input.isPressed('RotateLeft') || input.isPressed('RotateRight');
            if (navKey) stopNav('user');
            const nv = navKey ? null : navStep(g.position.x, g.position.z, d);
            if (!nv) {
                // 到点 / 判定失败 / 被按键取消 —— 内部已 `stopNav()` 并通知 UI，
                // 这里只是把本帧速度清零，下一帧就落回正常的「松开方向键」分支。
                moving = 0;
                prevSpeed.current = 0;
            } else {
                const want = Math.atan2(nv.dx, nv.dz);
                let dy = want - g.rotation.y;
                dy = Math.atan2(Math.sin(dy), Math.cos(dy));
                g.rotation.y += THREE.MathUtils.clamp(dy, -NAV_TURN * d, NAV_TURN * d);
                phys.current.speed = nv.speed;
                _fwdDir.set(Math.sin(g.rotation.y), 0, Math.cos(g.rotation.y));
                g.position.addScaledVector(_fwdDir, nv.speed * d);
                moving = nv.speed;
                prevSpeed.current = nv.speed;
                autoWasOn.current = true;
            }
        } else if (g && MOVE_ON && !frozen && autoRef.current > 0) {
            // ⚠️ 这里必须走 else-if：`solveCam` 每帧也会被调用（`isControlEnabled` 为真），
            //    没有输入时它 `targetSpeed = 0`，但 `s.speed` 上一帧刚被我们设成 AUTOWALK，
            //    只会按 lerp 衰减到 0.9×，而 `moveAngle === null` ⇒ 它退化成
            //    `group.translateZ(s.speed * delta)` —— **又推了一次**。
            //    实测两者叠加后地面速度是设定值的 **1.73 倍**（1.3 → 2.25 m/s），
            //    于是相位推进比地面慢 1.73 倍，量出来的「脚滑」全是这个假象。
            //    所以开了 `?autowalk=` 就完全接管，不调 `solveCam`。
            phys.current.speed = autoRef.current;
            _fwdDir.set(Math.sin(g.rotation.y), 0, Math.cos(g.rotation.y));
            // ★ `?hold=1` ⇒ 原地走：不动 `group`，但 `moving` 照样是 AUTOWALK，
            //   于是播放头照常推进（下面 `dist.current += eff * d` 读的就是 `moving`）。
            if (!HOLD) g.position.addScaledVector(_fwdDir, autoRef.current * d);
            moving = autoRef.current;
            // ★ 让「掐掉 autowalk」之后还能进收尾分支（见下面的 `autoWasOn`）
            prevSpeed.current = autoRef.current;
            autoWasOn.current = true;
        } else if (g && MOVE_ON && !frozen && (isControlEnabled || autoWasOn.current)) {
            // ★ `isControlEnabled || autoWasOn.current`：后者是为无头验证开的 ——
            //   `window.__mmd.setAutoWalk(0)` 掐掉自动走后，`isControlEnabled` 仍是 false，
            //   但我们要的就是「没输入了 ⇒ 把最后一步走完」这条分支。
            const inputSpeed = isControlEnabled ? Math.abs(phys.current.speed) : 0;
            // ★★★ 用户 m11046 任务1 的真根因修在这里（「松开 WASD 走完最后一步」真机不生效）。
            //
            //   旧写法用「速度」当「还有没有输入」的判据：
            //       `else if (inputSpeed <= 0.05) { … if (prevSpeed > 0.10) 触发收尾 }`
            //   真机上 `isControlEnabled === true` ⇒ `inputSpeed = |phys.speed|`，而
            //   `solveCam` 里是 `s.speed = lerp(s.speed, targetSpeed, speedLerpFactor)`，
            //   `speedLerpFactor = 0.1`（`src/components/character/config.ts:103`）
            //   ⇒ 松开 W 之后速度按 0.9^n 衰减，从 1.446 掉到 0.05 要 **~32 帧 ≈ 0.54 s**。
            //   这 0.54 s 里一直走 `else` 分支，而它每帧 `prevSpeed.current = inputSpeed`
            //   把峰值一路改写成**衰减中的小值**；等真的 `inputSpeed <= 0.05` 时
            //   `prevSpeed.current ≈ 0.05`，`> 0.10` 不成立 ⇒ **收尾永远不触发**
            //   ⇒ 症状就是「松开键她停在半路的迈步姿势上」。
            //
            //   ★ 上一轮为什么验不出来：那条验收走的是 `?autowalk=`，而该分支里
            //     `isControlEnabled` 为 false ⇒ `inputSpeed` 恒等于 0 ⇒ **立刻**进收尾分支。
            //     这是**假阳性**——测的不是真机走的那条路。教训：验收必须尽量走真输入路径，
            //     这里用 `window.dispatchEvent(new KeyboardEvent('keydown'|'keyup', {code:'KeyW'}))`
            //     就能走通（`packages/three-core/src/components/input/KeyboardMapper.tsx:12-22`
            //     在 window 上监听、只看 `e.code`、不要求 `isTrusted`）。
            //
            //   修法：**直接问输入系统「现在还有方向键按着吗」**，不再看速度；
            //   松开的那一帧就接管，顺带去掉 0.54 s 的滑行。
            //   `TouchJoystick.tsx:79-87` 写的也是同一套 `setButton`，所以摇杆一样管用。
            const keyDown = input.isPressed('MoveForward') || input.isPressed('MoveBackward')
                || input.isPressed('RotateLeft') || input.isPressed('RotateRight');

            if (LAND_ON && landRef.current > 0) {
                // ── 收尾中：**不调 `solveCam`** ──────────────────────────────
                //    原因有二：① 它会按输入再推一段（速度已经衰减但没到 0）；
                //    ② 它会把 `rotation.y` 往输入方向继续插值，而这时已经没有输入了。
                //    我们自己沿**当前朝向**推，保证「最后一步」走的是直线。
                if (dist.current < landRef.current - 1e-4) {
                    moving = landSpeed.current;
                    _fwdDir.set(Math.sin(g.rotation.y), 0, Math.cos(g.rotation.y));
                    g.position.addScaledVector(_fwdDir, moving * d);
                } else {
                    dist.current = landRef.current;   // ★ 精确落在站立相位上
                    landRef.current = 0;
                    landSpeed.current = 0;
                    prevSpeed.current = 0;            // 别再被静止浮步重新触发
                    autoWasOn.current = false;        // 收尾结束 ⇒ 不再进这个分支
                    landDone.current = LAND_HOLD;     // ★ 冻住播放头（?landhold=0 可关）
                    // ★★ 用户 m11917 任务1：这里开始把腿合成到站立姿势。
                    //   「挑最不劈腿的相位」不够 —— 这条 VMD 没有双脚同时落地的帧，
                    //   任何相位都是迈步姿势（详见文件头 `SETTLE_ON` 的长注释）。
                    settleT.current = SETTLE_ON ? 0 : 1;
                    // ⚠️ 这里**不能**用 `log` —— 它是上面 async IIFE 里的局部函数，
                    //    `useFrame` 回调看不见（历史 bug：`ReferenceError: log is not defined`，
                    //    每帧抛一次，直接把渲染循环打断）。`useFrame` 里只能用 `console.log`。
                    console.log(`[columbina] ★ 收尾完成：相位停在 ${STAND_PH.toFixed(3)}`
                        + `，开始合成站立姿势（${SETTLE_SEC.toFixed(2)} s`
                        + `${SETTLE_ON ? '' : '，?settle=0 已关'}）`
                        + (LAND_HOLD ? '，播放头已冻住（?landhold=0 可关）' : '，播放头仍按静止浮步漂移'));
                }
            } else if (LAND_OLD ? inputSpeed <= 0.05 : !keyDown) {
                // ── 松开方向键了（或本来就没按）───────────────────────────────
                // ★ 判据从「速度掉到 0.05 以下」换成 `!keyDown`：见上面那段根因注释。
                solveCam(g, camera as THREE.Camera, phys.current, d);
                // ★ 用户 m09585 任务2：刚才是**在走路**才需要收尾。
                //   若本来就是静止浮步（`prevSpeed` 为 0），绝不能收尾 ——
                //   否则浮步会让相位慢慢漂离站立相位，漂够远就再次触发收尾，
                //   于是「静止 ⇒ 走一步 ⇒ 静止 ⇒ 走一步」无限循环。
                const lastSpeed = Math.max(prevSpeed.current, inputSpeed);
                if (LAND_ON && lastSpeed > 0.10) {
                    const ph = ((dist.current / STRIDE) % 1 + 1) % 1;
                    /* ★★ 2026-10-19 用户 m03761 第 3 条：「停止时依然迈步太多，要走出很远才停下。
                     *    按 WASD 停下时，下一个脚落地即站定」。
                     *
                     *    旧写法只认一个相位 `STAND_PH`（0.553），`rem` 最坏能到 0.99 个循环
                     *    ⇒ 松手后还要再走将近一整个大步才停。而这套动作**一个循环里有两次落地**
                     *    （0.0 与 0.5，40 帧两步），两个落地点在视觉上是等价的（左右脚对称，
                     *    之后 `SETTLE_SEC` 会把腿链混到站立姿势，落在哪只脚上都一样）。
                     *    ⇒ 改成**在两个落地点里挑更近的那个**，最坏距离直接砍半（≤ 0.25 循环）。
                     *      再配上 `LAND_MIN` 从 0.35 提到 0.75（收尾那一步不再慢吞吞地蹭），
                     *      松手到站定的最长时间从 ~0.9 s 降到 ~0.25 s。 */
                    const remA = ((STAND_PH - ph) % 1 + 1) % 1;
                    const remB = (((STAND_PH + 0.5) % 1) - ph) % 1;
                    const remB2 = (remB + 1) % 1;
                    /* ⚠️ 再给一个硬上限 0.4 m：哪怕只走 0.25 个循环也很远 —— 用户说的
                     *   「走出很远」就是这个量级。0.4 m ≈ 半步，剩下的姿势差由 SETTLE_SEC
                     *   （0.45 s）的腿链合成补掉。 */
                    const rem = Math.min(Math.min(remA, remB2), 0.4 / STRIDE);
                    landRef.current = dist.current + rem * STRIDE;
                    landSpeed.current = Math.max(lastSpeed, LAND_MIN * WALK_SPEED);
                    phys.current.speed = 0;
                    console.log(`[columbina] 松开方向键 → 把最后一步走完：相位 ${ph.toFixed(3)} → ${STAND_PH.toFixed(3)}，`
                        + `还需 ${(rem * STRIDE).toFixed(2)} m（${(rem * CYCLE_SEC).toFixed(2)} s，`
                        + `按 ${landSpeed.current.toFixed(2)} m/s 收尾）`);
                }
                // ★ 峰值用完立刻清零：否则一个很久以前的峰值会在她站定很久之后
                //   被某次「按一下又松开」误当成「刚在走路」而突然迈一步。
                //   `?landold=1` 复现旧行为时不清零（旧代码本来就没有清零）。
                if (!LAND_OLD) prevSpeed.current = 0;
            } else {
                solveCam(g, camera as THREE.Camera, phys.current, d);
                moving = inputSpeed;
                // ★ 只升不降：参见上面的根因注释 —— 旧代码 `prevSpeed.current = inputSpeed`
                //   会在减速段把峰值写成衰减值，导致收尾条件永远不成立。
                if (LAND_OLD || inputSpeed > prevSpeed.current) prevSpeed.current = inputSpeed;
            }
        }

        // ── ★★ 场景碰撞：树干 + 飞船（用户 m11046 任务3 / m04735：「不能穿模」）──
        //   位置被推回来之后，必须把 `moving` 按「实际位移 / 名义位移」一起缩掉，
        //   否则播放头（`dist`）会跑到位置前面 ⇒ 脚底打滑、原地踩步。
        //   ⚠️ 2026-10-09（m04735）：原来这里的门槛是 `TREE_COLS.length > 0`，
        //      而树只在**会场**有、飞船在**月球** ⇒ 若照抄，月球那侧的飞船碰撞
        //      会被整段静默跳过（和当年 `CHAR_POS[1]` 那个判据踩的是同一个坑）。
        if (g && MOVE_ON && !frozen && moving > 0 && (TREE_COLS.length > 0 || SHIP_COL_ON || DESK_COL_ON || FOREST_COL_ON)) {
            const dx0 = g.position.x - preX;
            const dz0 = g.position.z - preZ;
            const nominal = Math.hypot(dx0, dz0);
            // ★ 用户 m01242 任务2：判据从「离常数 `CHAR_POS[1]` 多高」改成
            //   「离**脚下的地面**多高」。原来走到月球（地面 -7.5 m）时这个式子永远
            //   大于 3 m ⇒ 整段碰撞被静默跳过。（树只在会场有，本来不影响；但判据
            //   写对了，以后往新区域加碰撞体才不会踩同一个坑。）
            const collGroundY = CHAR_POS[1] + worldHeightCPU(g.position.x, g.position.z);
            if (nominal > 1e-6 && Math.abs(g.position.y - collGroundY) < 3.0) {
                let cx = g.position.x, cz = g.position.z;
                // 迭代 2 次：被一棵树推到另一棵树的圈里时，再推一次
                for (let it = 0; it < 2; it++) {
                    let pushed = false;
                    for (let k = 0; k < TREE_COLS.length; k++) {
                        const t = TREE_COLS[k];
                        const rr = t.r + CHAR_R;
                        const ex = cx - t.x, ez = cz - t.z;
                        const dd = Math.hypot(ex, ez);
                        if (dd >= rr) continue;
                        if (dd < 1e-5) { cx = t.x + rr; cz = t.z; }
                        else { cx = t.x + (ex / dd) * rr; cz = t.z + (ez / dd) * rr; }
                        pushed = true;
                    }
                    /* ── ★★ 森林树干（用户 2026-10-23 反馈 3「人物直接穿过树干」）────
                       与上面会场那 26 棵**同一套推出**，只是数据源不同：
                         · 会场：`core/venueRing.ts` 的静态表（26 件，模块加载时算好）；
                         · 森林：`core/world/treeCollide.ts` 的注册表，由 `Forest.refill()`
                           在每次收集实例时整表重建（半径 = frac × h × sxz，见该文件注释）。
                       `FOREST_COL_ON` 单独一个开关：森林树干密（一次 refill 几百件），
                       要能在 A/B 时只关它、不动会场的 26 棵。
                       ⚠️ 这里**必须**并联遍历而不是 `else if`：会场树与森林树可能挨在一起，
                          只推一个会导致「推出会场树、再插进森林树」的抖动。 */
                    if (FOREST_COL_ON) {
                        const fc = treeColliderList();
                        for (let k = 0; k < fc.length; k++) {
                            const t = fc[k];
                            const rr = t.r * FOREST_R_SCALE + CHAR_R;
                            const ex = cx - t.x, ez = cz - t.z;
                            const dd = Math.hypot(ex, ez);
                            if (dd >= rr) continue;
                            if (dd < 1e-5) { cx = t.x + rr; cz = t.z; }
                            else { cx = t.x + (ex / dd) * rr; cz = t.z + (ez / dd) * rr; }
                            pushed = true;
                        }
                    }
                    /* ── 飞船椭圆碰撞（用户 m04735：「飞船穿模，没做碰撞」）──────
                       推出解抽成了模块级纯函数 `shipPush()`（定义见文件上方常量区）：
                       一是这里只需要两行，二是无头验证可以直接调它做单元测试
                       （`window.__mmd.shipPush`），不用靠「让她走进去看结果」——
                       那种测法受落点、朝向、加载时序影响，读数不可复现。
                       放进「推两次」这个迭代里：走到船与树的夹缝也能收敛。 */
                    if (SHIP_COL_ON) {
                        const sp = shipPush(cx, cz);
                        if (sp.hit) { cx = sp.x; cz = sp.z; pushed = true; }
                    }
                    // 月牙石桌（用户 m02063 任务1）：同一套椭圆推出，放进同一个迭代里，
                    // 走到「石桌与树」的夹缝也能收敛。
                    if (DESK_COL_ON) {
                        const dp = deskPush(cx, cz);
                        if (dp.hit) { cx = dp.x; cz = dp.z; pushed = true; }
                    }
                    if (!pushed) break;
                }
                if (cx !== g.position.x || cz !== g.position.z) {
                    const actual = Math.hypot(cx - preX, cz - preZ);
                    const ratio = nominal > 1e-6 ? actual / nominal : 1;
                    // ★ 正对着树干撞上（`ratio` ≈ 0）：**整帧撤销**，位置回到本帧出发的那
                    //   一点、相位也冻住。为什么不能只把 `moving` 按比例缩小：
                    //   实测正撞时 `ratio` ≈ 0.05，`moving` 变成 0.07 m/s，
                    //   于是她「以 5% 速度原地踩步」——播放头几乎不走，但身体还在
                    //   0.07 m/s 地贴着树皮挪，读起来就是脚打滑。
                    //   偏斜撞上（`ratio` 大）时照旧按比例缩，她会顺着树皮滑过去 —— 这是
                    //   第三人称游戏里正确的表现（不会卡死在树前）。
                    if (ratio < 0.20) {
                        g.position.x = preX;
                        g.position.z = preZ;
                        moving = 0;
                    } else {
                        g.position.x = cx;
                        g.position.z = cz;
                        // 挡住时她「走的距离」按实际位移算：相位与位置永远一致
                        moving *= Math.min(1, ratio);
                        if (moving < 0.02) moving = 0;
                    }
                }
            }
        }
        /* ── ★ task-20（用户 m02364 任务5）：月坑浅水涉水 ─────────────────────
           只在这里「读外部状态 + 乘系数」，**不动** `solveCam`、也**不动**
           `shipPush()` / `deskPush()` / keepOut 的推出逻辑（上面前两段一行没改）。
           ① 涉水阻力：水里把**本帧位移**按 `waterPaceAt()` 缩掉，并把
              `moving` 同比例缩 —— 和上面碰撞那段「按实际位移缩相位」是同一手法，
              否则播放头（`dist`）跑到位置前面 ⇒ 脚底打滑。
              ★ 2026-10-21 反馈3：系数**随脚点水深插值**（水线边上 1.0 → 最深处 0.75），
                不再是常量 0.75 —— 常量手感是「整片水都是一个粘滞平面」。
           ② 垂直沉降：水里按 `waterSinkAt()` 往下沉最多 4.5 cm，出水后 0.35 s 内
              线性回位（`_sinkY` 平滑，避免贴地那一步与它打架产生抖动）。
              为什么需要：只缩水平位移时角色像在冰面上平移，读作「打滑」；
              人涉水时脚会踩进泥、身体被水托住，**整体略低**才是涉水。
           ③ 把脚点与速度喂给 `core/world/waterState.ts`：涟漪中心 = 这个脚点，
              所以波纹**跟着人走**，停下 1.5 s 内衰减干净。
           玩家允许站在水里（脚在水面下 0.3 m 是正常的），不做游泳、不做浮力。 */
        if (g && MOVE_ON) {
            const wetNow = inPond(g.position.x, g.position.z, 0.6);
            const pace = waterPaceAt(g.position.x, g.position.z);
            if (wetNow && pace < 1 && moving > 0) {
                g.position.x = preX + (g.position.x - preX) * pace;
                g.position.z = preZ + (g.position.z - preZ) * pace;
                moving *= pace;
            }
            /* 沉降：目标值随水深变，用一阶低通追随（出水时自然回升，不突变）。
               ⚠️ 必须在这里算、并在下面并入 `groundY` —— 不能直接改 `g.position.y`，
                  因为下面那段贴地会把 y **整个覆写**成 `groundY + ...`，
                  写在前面等于白写（第一版就是这么踩的，出图完全看不出沉降）。
               `0.35 s` 是手感平滑的时间常数，不是艺术参数；真值（沉多深）在 `PACE_SINK`。 */
            const sinkTarget = waterSinkAt(g.position.x, g.position.z);
            const sinkK = 1 - Math.exp(-(d > 0 ? d : 1 / 60) / 0.35);
            _sinkY.current += (sinkTarget - _sinkY.current) * sinkK;
            setPlayerWaterState(g.position.x, g.position.z, moving, delta);
        }

        // 悬浮感 ─────────────────────────────────────────────────────────────
        // ★★ 用户 m07241 给了她步态的**本质**：**走和跑都没有双支撑相**。
        //   - 正常人走路：前脚迈出 → 后脚离地 → 前脚支撑不动 → 后脚向前变前脚落地
        //     ⇒ 任何时刻**至少一只脚在地**。
        //   - 哥伦比娅：**单脚蹬地 → 整个人往前飘（空中换腿，后脚变前脚）→ 单脚落地
        //     → 蹬 → 重复** ⇒ 除了站立，**没有双脚落地的时候**。
        //   - 起伏：**蹬地那一下整个人往下沉；蹬完靠反作用力往斜上抬一下**。
        //
        //   我们手上这条 `walk.vmd` 是标准 MMD 走路（有双支撑、有脚跟着地滚动），
        //   结构上就对不上。所以这里额外把她**整体抬起来一段**，让 VMD 里
        //   「两只脚都在地上」的那个相位变成**悬空**，再叠一层换腿时的抬升。
        //       `?float=`     基础悬浮高度（米，缺省 0.10）—— 脚永远不贴死地面
        //       `?floatbob=`  空中换腿时额外抬多高（米，缺省 0.05）
        //       `?floatph=`   起伏相位（0..1）
        //   用户 m07241 原话：「**除了站立**，她走跑就没有双脚落地的时候」⇒
        //   站定时**不**加 `FLOAT_Y`（脚踩在地上），只有走起来才整体升起。
        if (g) {
            const e = uTime.value;
            // ★★ 用户 m01242 任务2：「人物是一个高度不变」。根因就在这里 ——
            //    她原来被钉死在常数 `CHAR_POS[1]` 上，于是：
            //      · 走进月坑底部 ⇒ 她在半空中走（地形凹下去了，她没跟下去）；
            //      · 走上坑壁 ⇒ 坡面直接穿过她的身体（地形凸起来，她没跟上去）；
            //      · 走进浅海 ⇒ 她踩在**水面上**（盆地凹 3.2 m，她还在 y≈0）。
            //
            //    修法：把「脚下地面高度」取回来。`worldHeightCPU(x,z)` 与 GPU 侧
            //    `getWorldHeight()` 是同一套解析式的两份实现（环形山 / 微起伏 / 盆地
            //    全是解析式，没有噪声），在月球与浅海区**逐位相等**
            //    ⇒ 她精确踩在地形上，不会有半厘米的悬空或下沉。
            //
            //    ⚠️ 会场那一段基础 FBM 只在 GPU 侧（MaterialX 噪声，JS 复刻不出来），
            //    `worldHeightCPU` 对会场**刻意返回 0**。所以会场的表现与改造前
            //    逐字一致 —— 这是有意的：不为了新区域制造老区域的回归。
            //    月球/浅海才是这次要修的地方，而那里 CPU 与 GPU 是严格相等的。
            const groundY = CHAR_POS[1] + worldHeightCPU(g.position.x, g.position.z) + _sinkY.current;
            if (moving > 0.05) {
                const wp = ((dist.current / STRIDE) % 1 + 1) % 1;
                /* ★★★ 第二十二轮：起伏改成**每步一个抛物线**（一个循环 = 两个）。
                 *
                 *  用户给的运动模型（本轮原话）：
                 *    「她走路并非向前，而是一个**略向上的抛物线**」
                 *    「需要滞空时稍微抬升整个模型不让她触地，在需要落地时放下」
                 *    「步态：左脚离地开始迈步 → 左脚落地 → 右脚离地 → 右脚落地」
                 *
                 *  ⇒ 一个整圈两步 ⇒ 两个抛物线 ⇒ 一个循环里 **y 有两个谷、两个峰**。
                 *  旧式 `(1−cos(2π·wp))/2` 只有**一个**峰（周期为整圈），
                 *  与「每步一次腾空」不符 ⇒ 改成用**步内相位** `sp2` 驱动：
                 *      y = FLOAT_Y + FLOAT_BOB · (1 − cos(2π·sp2)) / 2
                 *  其中 `sp2 = frac(stepPhase·2)` 是步内相位（0 = 一只脚落地、0.5 = 另一只脚落地）。
                 *
                 *  ⚠️ `FLOAT_PH` 是**谷的相位**（缺省 0.5）：`(1−cos)/2` 在 `sp2 = ph` 处取 0（谷）。
                 *     取 0.5 ⇒ 谷落在「另一只脚落地」那一刻，与上面的步态 4 阶段对齐。
                 *  ⚠️ 用 `dist/STRIDE` 而不是墙钟：定格出图可复现（与布线通道同一口径）。
                 *     两者在本文件里等价（`stepPhase` 也是 `dist/STRIDE` 的模），但这里显式写出来。 */
                let sp2 = wp * 2; sp2 -= Math.floor(sp2);
                const bob = FLOAT_BOB * (1 - Math.cos(2 * Math.PI * (sp2 - FLOAT_PH))) * 0.5;
                g.position.y = groundY + FLOAT_Y + bob;
            } else {
                g.position.y = groundY + Math.sin(e * 0.5) * BOB_AMP;
            }
        }

        // 前倾：实拍里她是「明显前倾着飘」过去的（B站 BV1mYSeBaEmY 0:36 侧面机位）。
        // 倾角随速度线性升到 LEAN_DEG，站定时归零，用一阶滞后避免起步/急停时突兀。
        // 注意作用在 `model.root` 上、而不是 `g` 上 —— `g` 的旋转是 `solveCam` 的朝向，
        // 占用了 `rotation.y`；`model.root` 的局部 +Z 就是她的正前方（`solveCam` 也沿它推进），
        // 所以在 `model.root` 上绕 X 转就是纯粹的「前倾」，跟着转向一起走。
        if (l) {
            const want = moving > 0.05 ? LEAN_DEG : 0;
            leanRef.current += (want - leanRef.current) * (1 - Math.exp(-6 * d));
            (l.model.root as any).rotation.x = THREE.MathUtils.degToRad(leanRef.current);
        }

        // 水平速度（米/秒）：次级运动里「惯性甩尾」的输入。
        // 用**位置差分**而不是 `phys.speed` —— 后者是输入意图，
        // 而甩尾要对实际发生的位移负责（急停、转身、被推，都该甩）。
        if (g) {
            if (!posInit.current) { lastPos.current.copy(g.position); posInit.current = true; }
            if (d > 1e-4) {
                // 夹一下，防止传送/首帧算出离谱的速度
                vel.current.x = THREE.MathUtils.clamp((g.position.x - lastPos.current.x) / d, -40, 40);
                vel.current.z = THREE.MathUtils.clamp((g.position.z - lastPos.current.z) / d, -40, 40);
            }
            lastPos.current.copy(g.position);
        } else {
            vel.current.x = 0; vel.current.z = 0;
        }
        // 静态验收用：把速度直接钉死，于是「冻结时间 + 只改这一个参数」的
        // 两张图差异只可能来自次级运动（见文件头 `SECV_X` 的说明）。
        if (SEC_VEL_ON) { vel.current.x = SECV_X; vel.current.z = SECV_Z; }

        // 只要真的动起来了，就解除「收尾完成后冻住播放头」的状态（用户 m09585 任务2）
        if (moving > 0.05) { landDone.current = false; settleT.current = 1; }

        // ── 动作播放头 ────────────────────────────────────────────────────────
        //   非冻结时**不再取模到 1 个循环**，而是走「单调时钟 + 整数循环回绕」：
        //       tMono = (dist / STRIDE) × LOOP_DUR / ANIM_SPEED        ← dist 只增不减
        //       t     = tMono mod physWrap                             ← physWrap = 整数个循环
        //   为什么必须这样：加载器把「时间往回走」判成 `seeking`
        //   （`dist/runtime/core.js:564`），而 seek 会 `resetPhysicsState()` 重新播种 ——
        //   每 1.33 秒把布料状态清一次。绕开之后物理才第一次真正跑起来。
        //   ⚠️ 姿态**完全没变**：`t mod LOOP_DUR` 恒等于旧的 `phase × LOOP_DUR / ANIM_SPEED`。
        //   `?tfreeze=` 仍走「绝对时间」那条路，保证无头出图可复现。
        let t: number;
        if (COL_SIT && ANIM_T === null && T_FREEZE === null && PHASE0 === null) {
            // ⚠️ 这里**不能** `% LOOP_DUR`：`LOOP_DUR` 缺省是走路那支 VMD 的窗口
            //    （40/30 = 1.3333 s），而 `SIT_T` = 55/30 = 1.8333 s。
            //    一取模就变成 0.5 s = `座る.vmd` 第 15 帧（起身过渡的中段），
            //    实测 `センター` y = 1.083（坐着应是 0.807）、膝夹角只剩 15°（伸直）。
            //    坐姿是**另一支 VMD 的另一个时间轴**，直接给绝对秒数。
            t = SIT_T;
            animT.current = t;
        } else if (frozen) {
            // ⚠️ 这里以前是**无条件** `t = T_FREEZE!`，于是「静态看步态」这条路
            //    完全绕过了相位 —— 六张 `?phase0=0/0.25/0.5` 的图几乎一模一样
            //    （实测只差 0.60% 像素），相位看着像没生效，其实是根本没读。
            //    现在显式给了 `?phase0=` 就按相位定格。
            t = ANIM_T !== null
                ? ANIM_T
                : PHASE0 !== null ? (PHASE0 * LOOP_DUR) / ANIM_SPEED
                : SEC_CLOCK !== null ? SEC_CLOCK : T_FREEZE!;
            if (secLock) animT.current = t;
        } else {
            const eff = moving > 0.05
                ? Math.min(moving, GAIT_CAP)     // 封顶：宁可极限速度下轻微滑步，也不要风火轮
                // ★ 收尾完成后（`landDone`）**完全停住**，不走 `IDLE_CREEP`。
                //   否则站立姿态会被浮步慢慢推成迈步姿态（用户 m09585 任务2）。
                : landDone.current ? 0
                : IDLE_CREEP * WALK_SPEED;       // 站着：老线那 0.06× 的原地浮步
            dist.current += eff * d;
            // ★ 无根位移的动作（`gs_idle`：原神 ZeroGravity_Idle，STRIDE = 0）
            //   不能走「按走过的距离推进播放头」这条路 —— 那会除以 0 得到
            //   Infinity / NaN，加载器直接抛 `RangeError: MmdAnimRuntime
            //   seconds must be finite`（每帧一次，画面全黑）。
            //   这类动作本来就该**原地按墙钟时间播**。
            const tMono = STRIDE > 1e-6
                ? (dist.current / STRIDE) * LOOP_DUR / ANIM_SPEED
                : (state.clock.getElapsedTime() * ANIM_SPEED) % LOOP_DUR;
            const wrap = physWrapRef.current > 0 ? physWrapRef.current : LOOP_DUR;
            t = tMono % wrap;
            animT.current = t % LOOP_DUR;
        }
        /* ★★★ 步态相位写进次级运动（用户 m07388 落脚脉冲的输入）。
         *
         *  口径：`dist / STRIDE` 的**小数部分** —— 0 与 0.5 各是一只脚刚落地
         *  （`LOOP_DUR` 一个整循环 = 两步；相位 0 = 左足着地、0.5 = 右足着地，
         *   与 `MmdCharacter.tsx` 建链处「第 20 帧左右对调」的实测一致）。
         *  ⚠️ 用 `dist` 而不是 `animT`：`?tfreeze`/冻结路径下 `animT` 被钉死，
         *    而 `dist` 在定格时也不动 ⇒ 两种路径都在**同一个相位**上，出图可复现。
         *  ⚠️ 站定时 `landDone` 会把 `dist` 钉住而 `landPulse` 仍按相位算 ⇒
         *    站定可能停在「脉冲半途」。所以**站定（moving ≤ 0.05）时不喂相位**
         *    （保持 NaN）⇒ 整块不跑 ⇒ 站定姿态与改动前逐位一致。
         *  ★ 诊断旋钮 `?seclandph=`：直接钉死相位（见 `SEC_LAND_PH` 的注释），
         *    优先级高于 `dist`，且站定时也生效（不然定格出图里没法看指定相位）。 */
        if (secRef.current) {
            /* ★★★ 第二十二轮：**起步平滑接入**（用户：「以上说的所有运动，你需要格外注意
             *  一下开始走的那一下」）。
             *
             *  旧行为是硬开关：`moving > 0.05 ? 相位 : NaN`。
             *  起步那一帧 `stepPhase` 从 NaN 突然变成 0~1 的数字，
             *  三条布料通道（整片布 / 披肩 / 落脚脉冲）在同一帧从「完全不跑」
             *  跳到「按当前相位全力跑」⇒ 视觉上一记突兀的抽动。
             *
             *  改法：给每条通道一个**权重斜坡** `gaitW ∈ [0,1]`，起步后约
             *  `?gaitfade=` 秒（缺省 0.35）线性升到 1，停步后再降回 0。
             *  通道内部把角度乘以这个权重 ⇒ 起步是"渐入"，不是"啪一下出现"。
             *  ⚠️ 站定时 `moving ≤ 0.05` 仍要喂 NaN（否则 landPulse 会停在半途），
             *     所以斜坡只乘**幅度**、不改相位的供给条件。 */
            const onNow = moving > 0.05;
            const wPrev = gaitWRef.current;
            gaitWRef.current += ((onNow ? 1 : 0) - gaitWRef.current)
                * Math.min(1, d / Math.max(0.02, GAIT_FADE_SEC));
            if (gaitWRef.current < 0.002) gaitWRef.current = 0;
            secRef.current.gaitW = gaitWRef.current;
            /* ★ 第二十二轮：**起步脉冲**的时间轴。
             *  「从站定第一次进入走路」那一帧把 startT 归 0，之后累加；
             *  停步（gaitW 掉回 0）时置 −1 表示"不在起步期"。
             *  用途见 `SecondaryRig.startT`：给头发一个与相位无关的起扬脉冲。 */
            if (onNow && wPrev <= 0.0001) secRef.current.startT = 0;
            else if (!onNow && gaitWRef.current <= 0) secRef.current.startT = -1;
            else if (secRef.current.startT >= 0) secRef.current.startT += d;

            secRef.current.stepPhase = SEC_LAND_PH !== null
                ? SEC_LAND_PH
                : (onNow ? (((dist.current / STRIDE) % 1) + 1) % 1 : NaN);
        }
        // 物理解算的驱动（用户 m08676 任务3(2)）：
        //  · 运动帧：`physics: true`，加载器内部走 `stepExternalPhysics`。
        //  · 定格帧：不能直接钉时钟（deltaSeconds 恒 0 ⇒ 布料停在绑定姿势、
        //    比一阶滞后还糟）。所以先用**同样的定步**把物理从 0 顺推到 t，
        //    **最后一次调用正好落在 t 上**（不是另开一次 update(t, physics:false) ——
        //    那样会走 `resetPhysicsState()` 把刚解算出来的状态全清掉，见 core.js:136-149）。
        let st: any;
        // ★ 模型空间归一（`pushModelSpace` 的注释里有完整根因分析）：
        //   加载器把 `bone.matrixWorld`（真·世界矩阵）当模型坐标喂给 Bullet，
        //   而我们给角色挂了一层 0.07896 的缩放 ⇒ 刚体被缩小 12.66 倍、直接炸开。
        //   这里在 `model.update()` 期间把骨骼子树算成模型空间，跑完立刻恢复。
        // ★ 定格帧从第 2 帧起**整段跳过**：
        //   `mmd_bullet.wasm` 是 `ALLOW_MEMORY_GROWTH=0` 的固定堆，每多调一次 `step()`
        //   就漏一点（实测 6740 次后 `Aborted(OOM)`）；而 `--disable-frame-rate-limit`
        //   下每渲染帧都会调一次 ⇒ 30 秒就能把堆耗光。
        //   定格帧的姿态和布料在第 1 帧就已经定死，**根本不需要再算**。
        const freezeDone = frozen && l.physics && physPrimed.current;
        if (!freezeDone) {
            const restoreRig = pushModelSpace((l.model as any).root);
            try {
                const UPD = (tt: number) => {
                    const r = l.physics
                        ? l.model.update(tt, ikOpts({ physics: true }))
                        : l.model.update(tt, ikOpts());
                    // ★★★ 站距：动画求值之后、站定合成之前，把两腿各向外张 `?stance=` 度。
                    //   放在这里（而不是建链处）的理由：`model.update()` 会把每一根骨的四元数
                    //   按动画**整份重写** ⇒ 在它前面乘的任何旋转都会被抹掉。
                    applyStance();
                    /* ★ 任务4：胳膊外展。放在 stance 之后 —— 转的是完全不同的骨
                     *  （`左腕`/`右腕` vs `左足`/`右足`），顺序其实无所谓，
                     *  但都必须在 `model.update()` **之后**（否则被动画整份重写）。 */
                    applyArmAbd(1 / 60, moving);
                    return r;
                };
                if (l.physics && frozen) {
                    physPrimed.current = true;
                    // ★ 预推**必须多推几个循环**：布料从绑定姿势收敛要 1~2 秒，
                    //   只推 0→t（t 常常只有 0.3 秒）等于没推。
                    //   而 VMD 每 `LOOP_DUR` 重复一次 ⇒ `t + k×LOOP_DUR` 的姿态**就是** t 的姿态，
                    //   所以「往前多推 k 个循环」既不改变定格姿态、又给布料足够的收敛时间。
                    const k = Math.max(1, Math.ceil(2.5 / LOOP_DUR));
                    const end = t + k * LOOP_DUR;
                    physEnd.current = end;
                    const n = Math.ceil(end / PHYS_FIX);
                    for (let i = 1; i < n; i++) l.model.update(i * PHYS_FIX, ikOpts({ physics: true }));
                    st = UPD(end);
                } else if (frozen && secRef.current && !secFrozen.current) {
                    // ★ 定格帧给弹簧骨「暖机」（用户 m09585 任务1 的取证手段）。
                    //
                    //   为什么需要：`?tfreeze=1` 把动画钉死 ⇒ 父骨一动不动 ⇒ 弹簧骨的
                    //   `dir` 以 `1/stiffness ≈ 0.13 s` 收敛回动画姿态，肉眼看就是「没有布料」。
                    //
                    //   做法：把动画**循环地**回放 `SEC_PREROLL` 秒（`tt` 用 `% LOOP_DUR` 折叠 ⇒
                    //   每一帧的姿态都是这条循环动画里真实存在的姿态），每步 1/60 手动积分一次
                    //   弹簧骨，最后一步正好落在 `t` 上，然后**停止积分**把布料定格。
                    //   ⇒ 同一组 `?tfreeze=&animt=` 每次得到**完全一样**的布料状态，
                    //     于是可以做「骨架姿态完全相同、只差布料」的逐像素 A/B。
                    //
                    //   ⚠️ 只暖机一次：`secFrozen` 一旦为真，下面的逐帧 `updateSecondary` 也被跳过。
                    //
                    //   ★★ 顺序铁律（2026-10 实测，一次踩死）：**必须 `UPD(t)` 在前、最后一步
                    //      `updateSecondary` 在后**。原来的写法是「先循环 nPre 步、再 `UPD(t)` 收尾」，
                    //      而 `UPD(t)` 会把**每一根骨的四元数按动画重写一遍** ⇒ 刚算出来的布料
                    //      被整份抹掉；紧接着 `secFrozen = true` 又让逐帧的 `updateSecondary` 永远
                    //      不再执行 ⇒ **布料物理等于白算**。
                    //      症状极具欺骗性：`gait().secondary.dev` 报 129°（物理确实在算），
                    //      但 `?secondary=1` 与 `?secondary=0` 的**骨骼世界坐标逐位相同**
                    //      （`Skirt_0_0` 两次都是 0.03251 / 0.92226 / -15.85431），
                    //      像素差 0.03% —— 卡在噪声地板上。判据 J（「参数打印正确 ≠ 功能生效」）
                    //      的又一次现形：**别信自报数字，去量被渲染的那份骨骼世界坐标**。
                    const dtPre = 1 / 60;
                    const nPre = Math.max(1, Math.round(SEC_PREROLL / dtPre));
                    // ① 先回放 nPre-1 步，把布料的惯性/风/重力都积起来
                    for (let i = 1; i < nPre; i++) {
                        const tt = ((t - (nPre - i) * dtPre) % LOOP_DUR + LOOP_DUR) % LOOP_DUR;
                        st = UPD(tt);
                        //   ★ 风也要一起暖机：`?secvelx=/?secvelz=` 模拟「以这个速度匀速走」。
                        //     不传就会把风冻在 0（那样定格图里裙子只会被动画摆动带动）。
                        updateSecondary(secRef.current, dtPre, SECV_X, SECV_Z);
                    }
                    // ② 姿态钉死在 t 上，③ 再走最后一步物理盖上去 —— 顺序不能换
                    st = UPD(t);
                    updateSecondary(secRef.current, dtPre, SECV_X, SECV_Z);
                    secFrozen.current = true;
                } else if (!secFrozen.current) {
                    st = UPD(t);
                }
                // ★★ 已定格（`secFrozen === true`）：**这里必须什么都不做**。
                //   定格之后每一帧再调 `UPD(t)`，就等于把骨骼按动画原样重写一遍
                //   ⇒ 暖机辛苦算出来的布料第二帧就没了；而逐帧的 `updateSecondary`
                //   又被 `!secFrozen.current` 跳过 ⇒ **布料永久丢失**。
                //   （`bone.matrixWorld` 每帧由 three.js 从 `quaternion` 重算 ⇒ 只要
                //    不覆盖四元数，姿态就一直保持着，不需要每帧重算。）
            } finally {
                restoreRig();
            }
        }
        if (st && typeof st.frame === 'number') frameRef.current = st.frame;
        // 越界断言：加载器的钳死是**完全静默**的（无异常、无日志），
        // 加这一行以后 5 秒就能定位，不用肉眼数秒。
        if (GAIT_ASSERT && !frozen && !warned.current && l.maxFrame > 0
            && st && typeof st.frame === 'number' && st.frame >= l.maxFrame - 1) {
            warned.current = true;
            console.warn(`[columbina] 动画时钟越界：frame ${st.frame} ≥ maxFrame-1 ${l.maxFrame}，姿态已被加载器钳死在末帧`);
        }
        // 次级运动：头发 / 披风 / 裙摆的延迟跟随（**只在没有真物理时**跑）。
        // **必须在 `model.update` 之后**（此时骨骼上是这一帧的姿势，
        // 运动学目标才有意义），**在 `prepareRender` 之前**（写完骨姿就交出去渲染）。
        // ⚠️ 用户 m08676 任务3(2) 之后这里加了 `!l.physics`：真物理的解算结果就写在
        //    这批骨上，再跑一遍一阶滞后等于把它**原样覆盖掉**（物理白算）。
        if (!l.physics && !secFrozen.current) updateSecondary(secRef.current, d, vel.current.x, vel.current.z);

        // ════════════════════════════════════════════════════════════════════════
        // ★★ 站定姿势合成 + 接地补偿（用户 m11917 任务1）
        //   见文件头 `SETTLE_ON` 的长注释。一句话：这条 VMD 没有双脚同时落地的
        //   帧 ⇒ 「回到站立姿态」只能把腿链合成到绑定姿势，不能挑相位。
        //   放在 `updateSecondary` **之后**（布料要看到最终的腿），
        //   `prepareRender` **之前**（写完骨姿就交出去渲染）。
        // ════════════════════════════════════════════════════════════════════════
        // ★★ 条件里**不能**带 `settleT.current < 1`。
        //   第一版写的是「没到 1 才处理」，结果：0.45 秒内把腿混到绑定姿势、`settleT` 到 1、
        //   这个块从此不再进 ⇒ 下一帧 `UPD(t)` 把动画的迈步姿势**原样写回来**，
        //   最终定格的还是走路姿势。实测 `?settleforce=1&settle=0` 与 `&settle=1` 逐位相同
        //   （sep 0.4883 / qL 22.83°）就是被这个「到期停药」咬的。
        //   正确语义：`settleT` 是**持续的混合权重**（0→1 爬升后**保持在 1**），
        //   每一帧都拿「动画值 ↔ 绑定值」按这个权重混一次，动画就永远压不回来。
        if (l && g && SETTLE_ON && !HOLD && moving <= 0.05 && (landDone.current || IDLE_STAND_ON)) {
            if (!standRef.current) {
                const bs = (l.model.mesh as any)?.skeleton?.bones as THREE.Bone[] | undefined;
                const skel = ((l.model.mesh as any)?.skeleton ?? null) as THREE.Skeleton | null;
                /* ★★★ 找骨必须同时看 `userData.mmdBoneName`（原始 PMX 日文名）。
                 *
                 *  加载器 `dist/three/skeleton.js:11` 写的是
                 *      `bone.name = boneData.englishName || boneData.name;`
                 *  —— 有英文名的骨，`bone.name` 就**不是** PMX 里的日文名。
                 *  实测本模型：`左足 / 左ひざ / 左足首 / 左つま先` 恰好没有英文名
                 *  （所以按日文名能找到），而 `D` 变形骨**有**英文名 ⇒ `pick('左足D')`
                 *  永远返回 null，日志打出「含 D 变形骨 0 根」。
                 *
                 *  原始日文名被 `dist/three/index.js:642` 存了下来：
                 *      `bone.userData.mmdBoneName = boneData.name;`
                 *  所以两个名字都比一遍，既能命中普通链也能命中 `D` 链。 */
                const pick = (n: string) => (bs ?? []).find((b) => b.name === n
                    || (b.userData as { mmdBoneName?: string } | undefined)?.mmdBoneName === n) ?? null;
                /* ★★★ 必须连 `D`（变形）骨一起混 —— 这是「读数说腿直了、画面还是迈步」的真根因。
                 *
                 *  这个 PMX（`_tools/pmx-dump.py` 实证）同时存在两条腿链：
                 *    普通链：左足 / 左ひざ / 左足首 / 左つま先
                 *    变形链：**左足D / 左ひざD / 左足首D / 左足先EX**（右同）
                 *  MMD 的规矩：有 `D` 对应骨时**顶点蒙皮绑在 `D` 骨上**，普通骨只负责
                 *  「付与（转移）」给裙子之类的次级骨 —— 这个模型正是这样（`左足` 要驱动裙摆，
                 *  为避免循环依赖，真正让腿变形的是 `D` 链）。
                 *
                 *  后果：只改普通骨 ⇒ WASM 运行时的付与链下一帧又把 `D` 骨算回动画值，
                 *  而画面里那条腿的顶点读的是 `D` 骨 ⇒ **改了等于没改**。
                 *  这也解释了为什么同一套写法在布片（`Skirt_*` 没有 `D` 骨、顶点直接绑它）
                 *  上「肉眼可见地生效」，在腿上却完全看不见。
                 *
                 *  顺序**必须父在前**（世界矩阵自顶向下推），而两条链的父子关系不保证
                 *  在名字表里就排好 ⇒ 建完按「到根的骨层数」升序排一次。
                 */
                const names = SETTLE_D ? [
                    '左足', '左足D', '右足', '右足D',
                    '左ひざ', '左ひざD', '右ひざ', '右ひざD',
                    '左足首', '左足首D', '右足首', '右足首D',
                    '左つま先', '左足先EX', '右つま先', '右足先EX',
                ] : ['左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首', '左つま先', '右つま先'];
                const depthOf = (b: THREE.Bone) => {
                    let n = 0; let p: THREE.Object3D | null = b.parent;
                    while (p && (p as THREE.Bone).isBone) { n++; p = p.parent; }
                    return n;
                };
                const bones = names.map(pick).filter((b): b is THREE.Bone => !!b)
                    .sort((a, b) => depthOf(a) - depthOf(b));
                // 接地补偿的「最低脚骨」把两条链的脚骨都算进去（鞋底绑在哪条链上都 covered）
                const feet = ['左足首', '左足首D', '右足首', '右足首D',
                    '左つま先', '左足先EX', '右つま先', '右足先EX']
                    .map(pick).filter((b): b is THREE.Bone => !!b);
                // 报「两踝间距」用的左右踝：优先 `D` 链（那才是画面里真正那双脚）
                const sepL = (SETTLE_D ? pick('左足首D') : null) ?? pick('左足首');
                const sepR = (SETTLE_D ? pick('右足首D') : null) ?? pick('右足首');
                // ★ 上半身（`?settlescope=1`）：配置阶段已经算好骨序 + 目标四元数
                //   （`bodyTargetRef`，见文件头 `ARM_POSE`）。这里直接取用；万一加载期
                //   采样失败（`bones` 为空）就现场按前缀筛一次、目标退回绑定姿势。
                const bt = bodyTargetRef.current;
                const bodyBones = SETTLE_SCOPE >= 1
                    ? (bt.bones.length ? bt.bones : collectBodyBones(bs))
                    : [];
                const bodyBind = SETTLE_SCOPE >= 1 && bt.bones.length === bodyBones.length
                    ? bt.target.map((q) => q.clone())
                    : bodyBones.map(() => new THREE.Quaternion());
                standRef.current = {
                    bones,
                    // ★ 绑定姿势 = **单位四元数**。PMX 的骨结构里**根本没有静止旋转字段**
                    //   （只有 position / parentIndex / flags），所以 identity 就是绑定姿势。
                    //   `secondaryMotion.ts` 的 `bindOf()` 也是靠「沿父链只累加 position」
                    //   做自标定的，两处依据同一个事实。
                    bind: bones.map(() => new THREE.Quaternion()),
                    bodyBones,
                    bodyBind,
                    feet,
                    sepL,
                    sepR,
                    drop: null,
                    skel,
                };
                const dCount = bones.filter((b) => /D$/.test(
                    (b.userData as { mmdBoneName?: string } | undefined)?.mmdBoneName ?? b.name)).length;
                console.log(`[columbina] 站姿合成就位：找到腿链 ${bones.length}/${names.length} 根`
                    + `（脚骨 ${feet.length}/8，骨架刷新 ${skel ? '可用' : '★不可用'}；`
                    + `含 D 变形骨 ${dCount} 根；上半身 ${bodyBones.length} 根/范围 ${SETTLE_SCOPE}）`);
            }
            const S = standRef.current;
            if (S && S.bones.length) {
                // 平滑插值权重（smoothstep），避免起止处速度突变
                settleT.current = Math.min(1, settleT.current + d / SETTLE_SEC);
                const x = settleT.current;
                const wgt = x * x * (3 - 2 * x);
                // `Quaternion.slerp(qb, t)` = 把 **this** 朝 qb 挪 t。这里 this 就是
                // `UPD(t)` 刚写上的动画值 ⇒ 得到「动画 ↔ 绑定」的混合。每帧 `UPD(t)`
                // 都会把动画值重新写回来，所以不会累积过头；定格路径（`secFrozen`）
                // 下不重写，插值也会单调收敛到目标，同样安全。
                for (let i = 0; i < S.bones.length; i++) {
                    S.bones[i].quaternion.slerp(S.bind[i], wgt);
                }
                // ★ 上半身同款（`?settlescope=1`）：手不摆了，站着才像站着（用户 m13249）
                for (let i = 0; i < S.bodyBones.length; i++) {
                    S.bodyBones[i].quaternion.slerp(S.bodyBind[i], wgt);
                }
                for (const b of S.bones) b.updateMatrix();
                for (const b of S.bodyBones) b.updateMatrix();
                // 判据 P：MMD 骨的 `matrixAutoUpdate === false`，
                // `updateWorldMatrix` 不会重算 `matrix` ⇒ 必须先 `updateMatrix()`，
                // 再自顶向下推 `matrixWorld`（父在前，`S.bones` 已按这个序排好）。
                S.bones[0].updateWorldMatrix(true, false);
                for (const b of S.bones) b.updateWorldMatrix(false, true);
                if (S.bodyBones.length) {
                    S.bodyBones[0].updateWorldMatrix(true, false);
                    for (const b of S.bodyBones) b.updateWorldMatrix(false, true);
                }

                /** 四根脚骨里最矮的那根的世界 y（米） */
                const lowFootWorld = () => {
                    let m = Infinity;
                    for (const b of S.feet) m = Math.min(m, b.getWorldPosition(_ankL).y);
                    return m;
                };

                if (FOOTLOCK_ON) {
                    if (S.drop === null) {
                        // ★ 一次定标：只量**相对量** —— 「把腿链摆成绑定姿势会让脚下沉多少」。
                        //   同一帧、同一个骨盆高度、同一条父链下分别量两次：
                        //     mAnim = 动画姿势的最低脚骨世界 y
                        //     mBind = 腿链（且只有腿链）换成绑定姿势后的最低脚骨世界 y
                        //     drop  = mBind − mAnim   （< 0 = 站直后脚更低，实测 −0.0308 m）
                        //   为什么不去量「绑定姿势的绝对高度」当基准：MMD 的根（`グルーブ`）
                        //   带 **Y 位移轨**（项目还按 0.30 压过振幅），绝对高度里混着这一刻的
                        //   根位移 ⇒ 基准会随相位漂（实测 p375/p553/p000 = −0.0179 / 0.0065 /
                        //   0.0192 m，差 3.7 cm）。相对量把这个漂移**整项抵消**。
                        for (const b of S.bones) b.updateWorldMatrix(true, false);
                        const mAnim = lowFootWorld();
                        const keepQ = S.bones.map((b) => b.quaternion.clone());
                        for (let i = 0; i < S.bones.length; i++) {
                            S.bones[i].quaternion.copy(S.bind[i]);
                            S.bones[i].updateMatrix();
                        }
                        for (const b of S.bones) b.updateWorldMatrix(true, false);
                        const mBind = lowFootWorld();
                        // 还原（下面还会按 wgt 重新 mix，但这一帧要先恢复成动画值）
                        for (let i = 0; i < S.bones.length; i++) {
                            S.bones[i].quaternion.copy(keepQ[i]);
                            S.bones[i].updateMatrix();
                        }
                        for (const b of S.bones) b.updateWorldMatrix(true, false);
                        S.drop = mBind - mAnim;
                        console.log(`[columbina] 接地定标：站直后最低脚骨变化 ${S.drop.toFixed(4)} m`
                            + `（动画 ${mAnim.toFixed(4)} → 绑定 ${mBind.toFixed(4)}；`
                            + `按混合权重反向补偿）`);
                    }
                    // 位移是线性的（`g.position.y` 加多少，脚骨世界 y 就变多少），
                    // 所以同一帧内一步到位；再乘 `wgt` 让它和腿的混合同步渐进，不会突然弹一下。
                    // 符号：`drop < 0`（脚更低）⇒ 修正为正 ⇒ 把整个人抬起来。
                    g.position.y -= S.drop * wgt;
                }

                /* ★ 手动把骨矩阵推给 GPU。
                 *  `three/build/three.webgpu.js` 里**没有 `boneTexture`**（grep 零命中），
                 *  WebGPU 的蒙皮走 `SkinningNode.update(frame)` → `skeleton.update()`
                 *  （`17923` 行），而 `skeleton.update()` 只做一件事：
                 *      boneMatrices[i] = bone.matrixWorld × boneInverses[i]
                 *  然后由节点系统当 storage buffer 上传。它在渲染阶段被调用时用的是
                 *  `scene.updateMatrixWorld()` 刚刷新的 `matrixWorld`，所以正常路径下
                 *  不调这一句也够；但**定格取证路径**（`?tfreeze`/`secFrozen`）里没人
                 *  重算骨姿，保险起见在这里显式刷一次，避免「JS 骨架变了、GPU 没变」。 */
                S.skel?.update();
            }
        }

        // 腿部姿态重写 v2（用户 m07400）：把腿从「标准走路」换成
        // **剪刀腿 + 收腿折膝 + 常绷脚尖**，见文件里 `LEG_KEYS` 那段注释。
        // 在 `model.update` 之后、`prepareRender` 之前 —— 这就是**接管**这几根骨，
        // 不是叠加：直接 `绑定姿势 × 曲线角`，VMD 对它们的驱动被完全覆盖。
        if (LEGPOSE_ON) {
            if (!legRef.current) {
                const bs = (l.model.mesh as any)?.skeleton?.bones as THREE.Bone[] | undefined;
                const pick = (n: string) => (bs ?? []).find((b) => b.name === n) ?? null;
                const tL = pick('左足'), tR = pick('右足');
                const kL = pick('左ひざ'), kR = pick('右ひざ');
                const aL = pick('左足首'), aR = pick('右足首');
                legRef.current = {
                    thighL: tL, thighR: tR, kneeL: kL, kneeR: kR, ankleL: aL, ankleR: aR,
                    // 此刻骨骼还停在 PMX 绑定姿势（`pipeline.attach` 刚做完，一帧都没 update 过），
                    // 正好当锚点。顺序 = [大腿L, 大腿R, 膝L, 膝R, 踝L, 踝R]
                    bind: [tL, tR, kL, kR, aL, aR].map((b) => (b ? b.quaternion.clone() : new THREE.Quaternion())),
                    q: new THREE.Quaternion(),
                    tmp: [0, 0, 0],
                };
                const g0 = legRef.current;
                console.log(`[columbina] 腿部重写 v2（关键帧曲线）就位：足 ${!!tL}/${!!tR}｜ひざ ${!!kL}/${!!kR}｜足首 ${!!aL}/${!!aR}`
                    + `｜${LEG_KEYS.length} 个关键相位｜倍率 ${LEGPOSE_GAIN}`);
            }
            const g0 = legRef.current;
            const gp = (((t * ANIM_SPEED) / LOOP_DUR) % 1 + 1) % 1;
            // [骨, 绑定四元数, 该腿相位]
            const pairs: [THREE.Bone | null, THREE.Quaternion, number][] = [
                [g0.thighL, g0.bind[0], gp],
                [g0.thighR, g0.bind[1], gp + 0.5],
                [g0.kneeL, g0.bind[2], gp],
                [g0.kneeR, g0.bind[3], gp + 0.5],
                [g0.ankleL, g0.bind[4], gp],
                [g0.ankleR, g0.bind[5], gp + 0.5],
            ];
            for (let k = 0; k < 3; k++) {
                const bL = pairs[k * 2][0], bR = pairs[k * 2 + 1][0];
                if (!bL && !bR) continue;
                const cL = legCurve(pairs[k * 2][2], g0.tmp);
                const dL = (cL[k] + LEGPOSE_OFF) * LEGPOSE_GAIN;
                const cR = legCurve(pairs[k * 2 + 1][2], g0.tmp);
                const dR = (cR[k] + LEGPOSE_OFF) * LEGPOSE_GAIN;
                if (bL) {
                    g0.q.setFromAxisAngle(X_AXIS, dL * (Math.PI / 180));
                    bL.quaternion.copy(pairs[k * 2][1]).multiply(g0.q);
                }
                if (bR) {
                    g0.q.setFromAxisAngle(X_AXIS, dR * (Math.PI / 180));
                    bR.quaternion.copy(pairs[k * 2 + 1][1]).multiply(g0.q);
                }
            }
        }
        // 只做准备：光照 uniform 同步 + 稀疏 morph compute。
        // 真正的渲染交给 Effects 里的 PostProcessing。
        l.pipeline.prepareRender(scene);
    }, -1);

    return <group ref={groupRef} visible={visible} />;
}
