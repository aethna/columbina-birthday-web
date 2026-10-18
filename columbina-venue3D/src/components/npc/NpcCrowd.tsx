/**
 * NpcCrowd.tsx —— 会场里的「原神角色群像」（用户 m00002）。
 *
 * 需求原话：「D:\DSH工作区\哥伦比娅生日会3D\公用区\模型，全部下载完毕。
 *   把所有模型（除了哥伦比娅）放进地图，静态站立姿势即可。
 *   位置随机分散，但是别太远。」
 *
 * ── 为什么不把 `MmdCharacter` 复制 15 份 ─────────────────────────────────
 *   1. `MmdCharacter.tsx` 的 `?pmx=` / `?char=` / `?motion=` 全是**模块级常量**
 *      （`const PMX_URL = QSTR('pmx') ?? '/columbina/少女.pmx'`），一个实例只能挂
 *      一个模型；15 个实例会全部站在同一组坐标上。
 *   2. 它每次挂载都 `createMmdTslPipeline()` 新建一条管线 + 一盏 MMD 专用光，
 *      15 份就是 15 条管线、15 盏灯。
 *   3. 它自带步态（430 行）、收尾站立（150 行）、布料弹簧骨、树/船碰撞、键盘
 *      输入……本任务一行都用不到。
 *
 * ── 这里的做法：一条共享管线 + 15 个模型 + 一次性烘焙的静态站姿 ──────────
 *   · 管线：`createMmdTslPipeline` 内部维护 `attached[]`，`attach()` 可挂多个模型
 *     （`node_modules/@yohawing/three-mmd-loader/dist/webgpu/pipeline.js:67`）。
 *     唯一的硬约束：**所有模型必须共用同一个 `light` 实例**，否则
 *     `if (light && light !== attachOptions.light) throw 'MMD_TSL_PIPELINE_LIGHT_MISMATCH'`。
 *   · 站姿：不逐帧跑动画。加载期把 `miao/05_standard_loop.vmd` 在 K 个相位上求
 *     **符号对齐的平均四元数**（`MmdCharacter` 的 `?armpose=1` 就是这个做法，
 *     见它的 `:1812-1864`），腿链再额外换回绑定姿势（identity）⇒ 双臂自然垂下、
 *     双腿站直。烘焙完把骨位置复位成绑定值（丢掉 VMD 的根位移），此后再也不调
 *     `model.update`。
 *   · 于是每帧只剩一次 `pipeline.prepareRender(scene)`；15 个静态模型比一个
 *     哥伦比娅还便宜（她没有一帧是静止的）。
 *
 * ── 复用到 `MmdCharacter` 的三条铁律（一条都不能省） ─────────────────────
 *   ① 身高：`模型原始高 × 固定比例`（这里 `NPC_SCALE = 1.62/20.52 = 0.078947`，
 *      正是哥伦比娅那条线实测出来的「MMD 单位 → 米」）。**用固定比例而不是
 *      「每个都归一到 1.62 m」** —— 后者会把派蒙拉成大人身高。
 *   ② 贴地：`root.position.y = -box.min.y * NPC_SCALE`。
 *   ③ 白色影子代理：`pipeline.attach()` 内部固定调 `createMmdTslShadowCaster()`，
 *      造一个**纯白** `MeshBasicNodeMaterial` 代理挂到 `model.mesh` 子节点并
 *      `proxy.layers.set(1)`。哥伦比娅那边「纯白剪影」的历史根因就在这。必须
 *      逐模型摘掉（`c.userData.mmdTslShadowCaster`）。
 *
 * ── 站立待机微动（用户 m01170 第一项）────────────────────────────────────
 *   烘焙出来的站姿是**死的**，15 个人像 15 尊蜡像。§6 在基准姿势之上每帧叠
 *   一层极小的程序化摆动（呼吸 / 躯干摇摆 / 头 / 手臂），骨头全部选在**腰以上**
 *   ⇒ 髋以下一根不碰，脚绝对钉在地上。时间源取 `uTime.value` 而不是自己的
 *   累加时钟，这样 `?tfreeze=<秒>` 一样能把它定格，A/B 对照才成立。
 *
 * ── URL 开关（项目的规矩：所有要 A/B 的量都得上 URL） ────────────────────
 *   ?npc=0            整个群像不加载
 *   ?npcmotion=<url>  换站立参考动作（缺省哥伦比娅的 `05_standard_loop.vmd`）
 *   ?npcarmk=<n>      站姿平均采样的相位数（2..24，缺省 8）
 *   ?npcidle=0        关掉待机微动（`0` 时与烘焙姿势**逐位相同**，做对照）
 *   ?npcidle=<k>      待机微动幅度倍率（缺省 1）
 *   ?npcidlespeed=<k> 待机微动速度倍率（缺省 1）
 *   ?npcscale=<s>     全局缩放（缺省 0.078947）
 *   ?npcik=1          站姿烘焙时开足 IK（缺省关 —— 与哥伦比娅那条线一致）
 *   ?npcoutline=0     关描边放大壳（15 个角色 = 一倍 draw call，缺省开）
 *   ?npcr0= / ?npcr1= 散布半径范围（米，缺省 8 / 25）
 *   ?npcgap=<m>       两个角色之间的最小间距（缺省 2.8）
 *   ?npcn=<?>         只摆前 N 个（调试用；缺省全部 15 个）
 *   ?npcyaw=0|1|2     朝向：0 = 全部朝 +Z、1 = 完全随机、2 = 面朝会场中心（缺省 2）
 *   ?npcseed=<n>      散布种子（缺省 7）
 *   ?npcgrid=1        验收模式：一字排开（`?npcgridstep=` 间距 1.9 m、
 *                     `?npcgridz=` 行位置 -6、`?npcgridyaw=` 朝向 0 = 面对 +Z 侧镜头）
 *   ?mmdproxy=1       保留白色影子代理（只在诊断「白壳」问题时用）
 *
 * ── ★ prop 覆盖（游戏流程用，用户 m02541）────────────────────────────────
 *   `pose` / `layout` / `n` 三个 prop 可以**逐实例**覆盖上面那些模块级缺省值。
 *
 *   为什么必须加这个：URL 是**全局**的，而游戏流程要求同一个页面里先后出现
 *   **两套不同烘焙**的群像 —— 委托阶段是「站姿 + 撒满地图」，宴会阶段是
 *   「坐姿 + 围长桌」。如果只能靠 URL 切，那就得整页重载两次，玩家会看到
 *   白屏 + 进度条（用户体验很差），而且状态全丢。
 *   有了 prop，`GameLayer` 就能用 `<NpcCrowd key="npc-stand" pose="stand"
 *   layout="ring"/>` 和 `<NpcCrowd key="npc-sit" pose="sit" layout="table"/>`
 *   分别挂两次（`key` 不同 ⇒ React 会卸载旧的、挂新的，各自重新烘焙）。
 *
 *   ⚠️ 覆盖是**加载期一次性**的：改了 prop 必须换 `key` 才会重新烘焙。
 *      原地改 prop 不会让已烘好的姿势变 —— 这是刻意的（重新烘焙要几秒，
 *      而且坐姿那条路绝不能再走「腿链抹回绑定姿势」，见 `:657`）。
 */
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { ThreeMmdLoader } from '@yohawing/three-mmd-loader';
import { createMmdTslPipeline } from '@yohawing/three-mmd-loader/webgpu';
import { QNUM, QSTR } from '../../core/utils/query';
import { uTime } from '../../core/shaders/uniforms';
import { SUN_REF } from '../DirectionalLight';
import { worldHeightCPU } from '../../core/worldRegions';
import { hash01, treeColliders } from '../../core/venueRing';
/* 座次几何的**唯一真值**在 `Banquet.tsx`（`seatSpots()`）—— 桌子改 `?bh=` /
 * `?bseg=` 时座位会跟着走，两边不会对不上。 */
import { BANQUET_ON, seatSpots } from '../venue/Banquet';

/* ════════════════════════════════════════════════════════════════════════════
 * 1. URL 开关
 * ════════════════════════════════════════════════════════════════════════════ */
export const NPC_ON = QNUM('npc', 1)! > 0;
/** 基准姿势：`stand`（缺省，老的站立线）/ `sit`（围长桌坐下）。
 *
 *  坐姿素材来自 `公用区\素材\坐姿\`（调研见 `调研报告_坐姿素材.md`）。
 *  用的是 BowlRoll 的 `座る.vmd`（纯坐姿 idle，可自由使用/改変，署名「フユネコ＆朱雀」），
 *  已拷到 `public/motion/sit_idle.vmd`。
 *
 *  ⚠️ 这个 VMD 的 `左ひざ`/`右ひざ`/`左足首`/`右足首` **FK 轨全是 0**（只有 2 个关键帧），
 *  腿部姿势**完全由 `足ＩＫ` 解算得出**。所以坐姿烘焙必须：
 *    ① 开 IK（`iko.ik = true`）；
 *    ② **不能**像站姿那样把腿链换回绑定姿势（那一步是站姿专用的）。
 *  已实测：15 个原神 PMX **全部带 `左足ＩＫ`/`右足ＩＫ`**（`_tools/pmx_has_bone.py`），
 *  所以这套 IK 驱动在 15 个角色上都成立。
 *
 *  ★ 缺省值 = `sit`：用户 m00002 的原话是「可以围坐所有 NPC + 哥伦比娅」，
 *  而 `?npclayout` 缺省也已经是 `table`（围宴会桌）。两处配套才对得上。
 *  要回到 §0.8 的「站立环带群像」基线：`?npcpose=stand&npclayout=ring`。
 *
 *  ⚠️ 这两个常量只是**URL 缺省值**。`GameLayer` 会用 `pose` / `layout` prop
 *     逐实例覆盖它们 —— 见文件头「★ prop 覆盖」。 */
const NPC_POSE = (QSTR('npcpose') ?? 'sit').toLowerCase();
/** 坐姿动作（`?npcsitmotion=` 可换） */
const NPC_SIT_MOTION = QSTR('npcsitmotion') ?? '/motion/sit_idle.vmd';
/** 坐姿烘焙的采样帧区间（`座る.vmd` 第 45–110 帧是完全静止的坐姿段，
 *  取内缩一点的 50–105 更稳）。帧号是 30 fps 制。 */
const NPC_SIT_F0 = QNUM('npcsitf0', 50)!;
const NPC_SIT_F1 = QNUM('npcsitf1', 105)!;
/** 坐下后整体朝桌心挪多少米（站位点是「站在桌边的人」，坐姿的臀要落到椅子中心）。
 *  椅子中心离桌沿 0.30 m、站位点离桌沿 `SEAT_D = 0.42 m`（`Banquet.tsx`）
 *  ⇒ 朝桌心挪 0.12 m 正好让臀落在椅心。 */
const NPC_SIT_FWD = QNUM('npcsitfwd', 0.12)!;
/** 站姿参考动作（哥伦比娅那条线的循环待机）。做成常量是为了让 `sit` 这个
 *  **逐实例**判据能选它 —— 原来是一句 `QSTR('npcmotion') ?? (NPC_SIT ? ... : ...)`，
 *  那样 `NPC_SIT` 就固化进模块级了，两套群像没法共存。 */
const NPC_STAND_MOTION = '/columbina/miao/05_standard_loop.vmd';
/** URL 覆盖（两套群像共用同一个 URL；逐实例覆盖走 prop）。 */
const NPC_MOTION_URL = QSTR('npcmotion');
const NPC_ARM_K = Math.max(2, Math.min(24, Math.round(QNUM('npcarmk', 8)!)));
const NPC_SCALE = QNUM('npcscale', 0.078947)!;
const NPC_IK = QNUM('npcik', 0)! > 0;
const NPC_OUTLINE = QNUM('npcoutline', 1)! > 0;
const NPC_R0 = QNUM('npcr0', 8)!;
const NPC_R1 = QNUM('npcr1', 25)!;
const NPC_GAP = QNUM('npcgap', 2.8)!;
const NPC_SEED = Math.round(QNUM('npcseed', 7)!);
const NPC_YAW = Math.round(QNUM('npcyaw', 2)!);
/** 站位布局：`table`（缺省）= 围宴会桌坐；`ring` = 老的 r=8~25 环带散布。
 *  保留 `ring` 是因为「15 人环带群像」是 §0.8 的既有验收基线（`_logs/npc/`），
 *  改缺省会把它推翻 —— 要对照就 `?npclayout=ring`。 */
const NPC_LAYOUT = (QSTR('npclayout') ?? 'table').toLowerCase();
const NPC_LIMIT = Math.max(1, Math.round(QNUM('npcn', 15)!));
/** 球面「加算」层改加算混合（与 `MmdCharacter` 的 `?mmdadd` 对应，`0` 关掉做对照） */
const NPC_ADD = QSTR('npcadd') !== '0';
/** 漫反射贴图自带 alpha 的材质开 alphaTest（与 `?mmdalpha` 对应） */
const NPC_ALPHA = QSTR('npcalpha') !== '0';
/** 逐模型打印材质修正明细（15 个角色 × 若干材质，平时太吵） */
const DEBUG = QNUM('npcdebug', 0)! > 0;
/** 站立待机微动开关（`?npcidle=0` 关掉，与烘焙姿势逐位对照） */
const NPC_IDLE = QNUM('npcidle', 1)! > 0;
/** 微动幅度倍率 */
const NPC_IDLE_AMP = QNUM('npcidleamp', 1)!;
/** 微动速度倍率 */
const NPC_IDLE_SPEED = QNUM('npcidlespeed', 1)!;
/** 哥伦比娅站在 `?char=` 缺省位（0, 0, -10）—— 别人别跟她叠在一起 */
const COLUMBINA_XZ: [number, number] = [0, -10];
const COLUMBINA_KEEPOUT = 3.0;

/* ════════════════════════════════════════════════════════════════════════════
 * 2. 角色名册
 *
 *    素材由 `_tools/copy_npc_models.py` 从 `公用区\模型\<角色>_by_原神_<hash>\`
 *    拷到 `public/models/<id>/`，主 .pmx 一律改名为 `main.pmx`。
 *    改名是安全的：加载器解析贴图走
 *      `dist/three/textures.js:1033  new URL(normalizeMmdTexturePath(p), new URL('.', modelUrl))`
 *    —— 基准是 **pmx 自己的 URL**，与文件名无关；贴图按 PMX 里写的相对路径
 *    （`tex\颜.png` 之类）同目录摆放即可，不需要改 PMX、也不需要自定义 resolver。
 *
 *    `name` 只用于日志与探针，不参与渲染。
 * ════════════════════════════════════════════════════════════════════════════ */
interface NpcDef { id: string; name: string }

const ROSTER: NpcDef[] = [
    { id: 'furina', name: '芙宁娜' },
    { id: 'lauma', name: '菈乌玛' },
    { id: 'lyney', name: '林尼' },
    { id: 'lynette', name: '琳妮特' },
    { id: 'neuvillette', name: '那维莱特' },
    { id: 'naifuer', name: '奈芙尔' },
    { id: 'lumine', name: '女主角·荧' },
    { id: 'sandrone', name: '桑多涅' },
    { id: 'ineffa', name: '伊涅芙' },
    { id: 'arlecchino', name: '阿蕾奇诺' },
    { id: 'aino', name: '爱诺' },
    { id: 'flins', name: '菲林斯' },
    { id: 'freminet', name: '菲米尼' },
    { id: 'aether', name: '空' },
    { id: 'paimon', name: '派蒙' },
];

const urlOf = (id: string) => `/models/${id}/main.pmx`;

/* ════════════════════════════════════════════════════════════════════════════
 * 3. 站位散布
 *
 *    「随机分散，但是别太远」的量化：会场是一块半径 62 m 的霜月草原，外围
 *    29 m 处有一圈 26 棵树（`core/venueRing.ts` 的 `ringCfg().r`），圈内是空地。
 *    所以把人撒在 **半径 8~25 m 的环带**里 —— 一圈人把哥伦比娅围在中间，
 *    从任何一个机位都能一屏看全，又不至于挤成一堆。
 *
 *    散点用 `venueRing.hash01`（PCG 整数混合）而不是 `Math.random()`：
 *    判据 N 明令禁止 `fract(sin(...))`，而且固定种子才做得了 A/B 对照。
 *    黄金角（2.399963…）负责「分散」，`hash01` 负责「随机」。
 * ════════════════════════════════════════════════════════════════════════════ */
interface NpcSpot { x: number; z: number; yaw: number }

/**
 * 站位算法的全部输入（**只有这几个**）。
 *
 * 为什么把散点参数也做成参数而不是继续读模块常量：`GameLayer` 要在一个页面里
 * 先后挂两套群像（委托阶段撒满地图 / 宴会阶段围长桌），两套的 `layout`、`sit`、
 * 半径、间距都不同。做成入参之后 `scatterSpots` 才是**纯函数**，同一份输入
 * 永远给同一份站位 —— 这正是项目判据 A（A/B 截图必须可复现）要的。
 */
interface ScatterOpts {
    /** `table` = 围宴会桌；其余 = 环带散布。 */
    layout: string;
    /** 坐姿时朝桌心挪 `NPC_SIT_FWD`（见下面的推导）。 */
    sit: boolean;
    r0: number;
    r1: number;
    gap: number;
    seed: number;
    /** 0 = 全部朝 +Z、1 = 完全随机、2 = 面朝会场中心。 */
    yaw: number;
    /**
     * ★ 直接给定整张站位表（逐席，长度 = 人数）。
     *
     * 为什么要有这条口子：`GameLayer` 需要**先在别处拿到落点**（拿它注册 F 键互动点、
     * 拿它画小地图指引箭头），然后才挂群像。若让两边各跑一次散点算法，
     * 只要有一个参数对不上就会出现「提示说按 F 打招呼，人却在十米外」。
     * 给定表之后，散点算法只在这里跑一次、结果原样落位，两边天然一致。
     */
    fixed?: NpcSpot[];
}

function scatterSpots(n: number, o: ScatterOpts): NpcSpot[] {
    const GOLDEN = 2.399963229728653;
    const trees = treeColliders(0.6); // 树干半径 + 0.6 m 缓冲
    const out: NpcSpot[] = [];

    /* ★ 外部给定整张表：直接落位，本文件不再算任何坐标。
     * 见 `ScatterOpts.fixed` 的注释 —— 这是让互动点与模型落点永不脱钩的唯一手段。 */
    if (o.fixed && o.fixed.length) {
        for (let i = 0; i < n; i++) out.push(o.fixed[i % o.fixed.length]);
        return out;
    }

    /* 验收专用（`?npcgrid=1`）：一字排开，一张图看全所有人的站姿。圆环布局里
     * 近处的人会挡住远处的人，所以取证机位用这一排。缺省 `?npcgridyaw=π` 让
     * 它们面朝 **−Z**，正好对着放在 +Z 侧、朝 −Z 看的镜头（朝向定义见 §3 尾部）。 */
    if (QNUM('npcgrid', 0)! > 0) {
        const step = QNUM('npcgridstep', 1.9)!;
        const z = QNUM('npcgridz', -6)!;
        const gy = QNUM('npcgridyaw', 0)!;
        for (let i = 0; i < n; i++) {
            out.push({ x: (i - (n - 1) / 2) * step, z, yaw: gy });
        }
        return out;
    }

    /* 宴会座次（`layout === 'table'`，URL 缺省开）：把 15 个 NPC 收到桌边围坐。
     * 第 16 席（+x 端）是哥伦比娅，她归 `MmdCharacter` 管、缺省就站在那
     * （见 `Banquet.tsx` 的 `BANQUET_Z` 推导），所以这里只取 15 席。
     * 站位与朝向全部来自 `seatSpots()`，本文件不自己算坐标。 */
    if (o.layout === 'table' && BANQUET_ON) {
        const seats = seatSpots();
        for (let i = 0; i < n; i++) {
            /* ⚠️ 座位**不是**按名册序号顺排，而是由 `SEAT_ORDER` 指定（主位左右手边
             * 有固定邻居，见 `SEAT_ORDER` 的注释）。这里必须跟 `npcSeatSpot()` 用
             * 同一个映射 —— 两边不一致就是「提示指向 A、模型坐在 B」那类 bug 的温床。
             * 走 `spots` prop 时根本不会进这个分支（`o.fixed` 在上面就 return 了），
             * 这条分支只服务 `?npclayout=table` 的单挂调试。 */
            const rid = ROSTER[i % ROSTER.length]?.id ?? '';
            const s = seats[seatIndex(rid) % seats.length];
            /* 朝向对准桌心，再叠一点确定性抖动，免得 15 个人像仪仗队一样齐。 */
            const j = (hash01(i, 5, o.seed + 4) - 0.5) * 0.42;
            const yaw = s.yaw + j;
            /* 坐姿时朝桌心挪一点：座位点是「站着的人」的位置（离桌沿 `SEAT_D = 0.42`），
             * 而坐下后臀要落到椅面中心（`Banquet.tsx` 的 `CHAIR_BACK = -0.12`
             * ⇒ 椅心离桌沿 0.30 m）。不挪的话人坐在椅子前沿上。
             * 方向 = 桌心方向，`yaw = 0` 面朝 +Z ⇒ 前向量 `(sin yaw, cos yaw)`。 */
            const f = o.sit ? NPC_SIT_FWD : 0;
            out.push({
                x: s.x + Math.sin(yaw) * f,
                z: s.z + Math.cos(yaw) * f,
                yaw,
            });
        }
        return out;
    }

    for (let i = 0; i < n; i++) {
        let spot: [number, number] | null = null;
        for (let k = 0; k < 400; k++) {
            const u = hash01(i, k, o.seed);
            const v = hash01(i, k, o.seed + 1);
            const a = i * GOLDEN + (u - 0.5) * 0.9;
            const r = o.r0 + (o.r1 - o.r0) * Math.sqrt(v);
            const x = Math.sin(a) * r;
            const z = Math.cos(a) * r;
            if (Math.hypot(x - COLUMBINA_XZ[0], z - COLUMBINA_XZ[1]) < COLUMBINA_KEEPOUT) continue;
            let ok = true;
            for (const p of out) {
                if (Math.hypot(x - p.x, z - p.z) < o.gap) { ok = false; break; }
            }
            if (ok) {
                for (const t of trees) {
                    if (Math.hypot(x - t.x, z - t.z) < t.r + 0.6) { ok = false; break; }
                }
            }
            if (ok) { spot = [x, z]; break; }
        }
        // 兜底：黄金角纯几何位置（几乎不会走到这里，出现了就说明 GAP 设太大）
        if (!spot) {
            const a = i * GOLDEN;
            const r = (o.r0 + o.r1) * 0.5;
            spot = [Math.sin(a) * r, Math.cos(a) * r];
            console.warn(`[npc] #${i} 400 次都撞了，退回黄金角默认位`);
        }
        const [x, z] = spot;
        let yaw: number;
        if (o.yaw === 0) yaw = 0;
        else if (o.yaw === 1) yaw = hash01(i, 3, o.seed + 2) * Math.PI * 2;
        // 朝向实测（`_logs/npc/yaw0.png` vs `yawPI.png`，2×3 对照）：`yaw = 0` 时
        // 模型面朝 **+Z**（yaw0 那张能看到脸，yawPI 那张只有后脑勺）。
        // 绕 Y 转 `a` 把前向量 (0,0,1) 映到 (sin a, 0, cos a)，要让它对准会场中心
        // 方向 (-x,-z)/r ⇒ a = atan2(-x, -z)。
        // ⚠️ 别被单张近景误导：`?npc=1&npcn=1` 的对照才是决定性的。
        else yaw = Math.atan2(-x, -z) + (hash01(i, 4, o.seed + 3) - 0.5) * 0.5;
        out.push({ x, z, yaw });
    }
    return out;
}

/* ════════════════════════════════════════════════════════════════════════════
 * 3′. 站位对外查询（★ 2026-10-14 新增：让「互动点」和「模型落点」永不脱钩）
 *
 *     为什么必须加这两个导出：`GameLayer` 要在 NPC 身上注册 F 键互动点
 *     （打招呼 / 接委托 / 交委托），而互动点的坐标是**它自己算的**
 *     （原先直接读 `layout.ts` 的 `npcXZ(id)`）。但本文件的实际落点走的是
 *     `scatterSpots()` —— 黄金角散布，跟 `layout.ts` 的极坐标表**根本不是一回事**。
 *     两边各算各的 ⇒ 玩家会看到「提示说按 F 打招呼，人却在十米外」。
 *
 *     所以把落点算法收敛成两个**导出函数**：本文件自己用它们摆人，
 *     `GameLayer` 用它们注册互动点。同一个 id 永远给同一组坐标。
 *
 *     `ring` = 委托阶段的环带散布；`table` = 宴会阶段的桌边座次。
 *     两张表都按 `ROSTER` 的顺序索引 —— **顺序本身就是映射的一部分**，
 *     改了 `ROSTER` 的次序，座次会跟着变（这是有意的：座次本来就该跟名册走）。
 * ════════════════════════════════════════════════════════════════════════════ */

/** 某个 NPC 在**委托阶段**（环带散布）的世界落点。查不到返回 `null`。 */
export function npcRingSpot(id: string): NpcSpot | null {
    const i = ROSTER.findIndex((d) => d.id === id);
    if (i < 0) return null;
    const spots = scatterSpots(ROSTER.length, {
        layout: 'ring',
        sit: false,
        r0: NPC_R0, r1: NPC_R1, gap: NPC_GAP, seed: NPC_SEED, yaw: NPC_YAW,
    });
    return spots[i] ?? null;
}

/* ★ 主位左右手边的固定邻居（用户 m02541 原话：「主位左侧是空，派蒙，荧。右侧是桑多涅。
 *   这几个固定位置，其余位置随意。」）
 *
 *   方向推导（别凭感觉，照这个推）：
 *     · 主位在世界 `[0, -10.0]`（`layout.ts` 的 `CAKE_STAND_XZ`），哥伦比娅站在那儿
 *       **朝桌子看**（世界 +Z 方向，见 `GameLayer` 切蛋糕时 `teleport(..., 0, -6.61)`）。
 *     · 面向 +Z 时她的**左手边是世界 +X**、右手边是 −X（`right = forward × up`，
 *       forward=(0,0,1)、up=(0,1,0) ⇒ right=(−1,0,0)）。
 *     · `seatSpots()` 返回的 15 席里：
 *         索引 0..6  = 长桌 +z 侧（`lz > 0`）⇒ 世界 x ≈ **+0.8** ⇒ **主位左手边**；
 *                      组内索引越大越靠主位（索引 6 最近，世界 z = −9.0）。
 *         索引 7..13 = 长桌 −z 侧（`lz < 0`）⇒ 世界 x ≈ **−0.8** ⇒ **主位右手边**；
 *                      同样索引 13 最近。
 *         索引 14    = 长桌 −x 端（世界 z ≈ −3.2）⇒ 主位**正对面的远端**。
 *     ⇒「左侧最近三席」= 索引 6 / 5 / 4，「右侧最近一席」= 索引 13。
 *
 *   下面这张表按**座位索引**列出坐谁（roster id）。改座次只改这张表，
 *   **不要改 `ROSTER` 的次序** —— 那是名册，互动注册、任务列表顺序都依赖它。
 *   若哪天发现左右反了，把 4..6 与 13 的对应关系对调即可（其余人随意）。 */
const SEAT_ORDER: readonly string[] = [
    'furina', 'lauma', 'lyney', 'lynette',                    // 0..3   左手边远端
    'lumine', 'paimon', 'aether',                             // 4..6   左手边靠主位：荧 / 派蒙 / 空
    'neuvillette', 'naifuer', 'ineffa', 'arlecchino', 'aino', 'flins',   // 7..12  右手边远端
    'sandrone',                                               // 13     右手边靠主位
    'freminet',                                               // 14     主位正对面的远端
];

/** roster id → 座位索引。表只有 15 项且只在加载期调一次，线性查足够。 */
function seatIndex(id: string): number {
    const k = SEAT_ORDER.indexOf(id);
    return k < 0 ? 0 : k;
}

/** 某个 NPC 在**宴会阶段**（桌边座次）的世界落点。查不到返回 `null`。 */
export function npcSeatSpot(id: string): NpcSpot | null {
    const i = ROSTER.findIndex((d) => d.id === id);
    if (i < 0) return null;
    const seats = seatSpots();
    if (!seats.length) return null;
    /* 座位由 `SEAT_ORDER` 指定（主位左右手边有固定邻居），**不是**按名册序号顺排。 */
    const s = seats[seatIndex(id) % seats.length];
    /* 抖动仍按**名册序号**取（跟着人走，换座位不会换抖动），
     * 与 `scatterSpots` 的 table 分支**必须逐字一致**，否则又脱钩。
     * `seed + 4` 里的 `seed` 就是 `NPC_SEED`（见上面的 `scatterOpts`）。 */
    const j = (hash01(i, 5, NPC_SEED + 4) - 0.5) * 0.42;
    const yaw = s.yaw + j;
    const f = NPC_SIT_FWD;
    return { x: s.x + Math.sin(yaw) * f, z: s.z + Math.cos(yaw) * f, yaw };
}

/** 名册顺序（`GameLayer` 要按这个顺序生成站位表）。**不要改它的次序**。 */
export const NPC_ROSTER: ReadonlyArray<{ id: string; name: string }> = ROSTER;

/**
 * 委托阶段的**完整站位表**（15 席，与 `ROSTER` 一一对应）。
 *
 * 为什么要单独导出而不是让 `GameLayer` 逐个调 `npcRingSpot`：
 * ① 「空和派蒙站在一起，视为一个 NPC」（用户 m02541 原话）—— 派蒙必须贴着空站，
 *     而不是自己占一个黄金角位置。这件事只能在这张表里做，`scatterSpots` 不认识人名。
 * ② `GameLayer` 要拿**同一份数组**去注册互动点，逐个查会各算各的、还可能顺序错位。
 *
 * 派蒙的偏移取「空的位置 + 右后方 0.62 m」：两人同框、不重叠，从正面看是一个组合。
 */
export function npcStandSpots(): NpcSpot[] {
    const base = ROSTER.map((d) => npcRingSpot(d.id));
    const aetherIdx = ROSTER.findIndex((d) => d.id === 'aether');
    const a = aetherIdx >= 0 ? base[aetherIdx] : null;
    return base.map((s, i) => {
        if (!s) return { x: 0, z: 0, yaw: 0 };
        const d = ROSTER[i];
        if (d.id !== 'paimon' || !a) return s;
        /* 站在空的右手边稍后：前向量是 (sin yaw, cos yaw)，右向量是 (cos yaw, -sin yaw)。 */
        const rx = Math.cos(a.yaw), rz = -Math.sin(a.yaw);
        const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
        return { x: a.x + rx * 0.62 - fx * 0.30, z: a.z + rz * 0.62 - fz * 0.30, yaw: a.yaw };
    });
}

/** 宴会阶段的**完整座次表**（15 席，与 `ROSTER` 一一对应）。 */
export function npcSeatSpots(): NpcSpot[] {
    return ROSTER.map((d) => npcSeatSpot(d.id) ?? { x: 0, z: 0, yaw: 0 });
}

/* ════════════════════════════════════════════════════════════════════════════
 * 4. 站姿烘焙用到的骨名表
 *
 *    与 `MmdCharacter.tsx:3074-3079` 同一张表。为什么必须连 `D`（变形）骨一起
 *    处理：MMD 的规矩是「有 `D` 对应骨时顶点蒙皮绑在 `D` 骨上」，普通骨只负责
 *    「付与」给裙摆之类的次级骨。只改普通骨 ⇒ 付与链下一帧又把 `D` 骨算回动画
 *    值，而画面里那条腿读的正是 `D` 骨 ⇒ 改了等于没改。
 * ════════════════════════════════════════════════════════════════════════════ */
const LEG_NAMES = [
    '左足', '左足D', '右足', '右足D',
    '左ひざ', '左ひざD', '右ひざ', '右ひざD',
    '左足首', '左足首D', '右足首', '右足首D',
    '左つま先', '左足先EX', '右つま先', '右足先EX',
];

/** 坐姿烘焙时**保留 Y 位移**的根链骨名（其余骨的 translation 一律丢弃）。
 *
 *  `座る.vmd` 的 `センター` 在坐下时下沉 ~4 单位（≈ 0.32 m），这是「坐」与「站」的
 *  高度差，必须留。`グルーブ` 是它的父级（多数 PMX 里是全零），一起留着不影响。
 *  `下半身` 也留着 —— 有些模型把坐姿的骨盆下沉写在这一层。 */
const SIT_ROOT_BONES = new Set(['センター', 'グルーブ', '下半身']);

/** 加载器 `dist/three/skeleton.js:11` 写的是 `bone.name = englishName || name`
 *  ⇒ 有英文名的骨，`bone.name` **不是** PMX 里的日文名；原始名被
 *  `dist/three/index.js:642` 存进 `bone.userData.mmdBoneName`。两个都比一遍。 */
const rawName = (b: THREE.Bone) => (b.userData as { mmdBoneName?: string } | undefined)?.mmdBoneName ?? b.name;

/* ── 4b. 站立待机微动骨表（用户 m01170 第一项） ─────────────────────────────
 *
 *  烘焙出来的站姿是死的 ⇒ 15 个人像 15 尊蜡像。这里在基准姿势之上每帧叠一层
 *  极小的摆动。三条设计约束：
 *
 *  ① **只动 `上半身` 及其后代。** 15 个模型的骨名普查（`window.__npc.bones()`，
 *     2026-10-14）确认 `上半身` 全部存在，而 `首` / `頭` / `肩` / `腕` / `ひじ`
 *     都在它下面；髋以下（`下半身` / `足` / `ひざ` / `足首`）一根都不在里面
 *     ⇒ **脚绝对钉在地上**，不需要重做贴地。`センター` / `グルーブ` 也不能碰：
 *     它们是全身的根，一动腿就跟着动。
 *  ② **是「叠加」不是「接管」。** 每根骨记住烘焙出来的基准四元数 `q0`，
 *     每帧写 `q = q0 × Δq`。所以 `?npcidle=0` 时能与烘焙结果**逐位相同**。
 *  ③ 骨局部轴 = 模型静止时的轴（PMX 的骨结构没有静止旋转字段，见 §4）
 *     ⇒ `X` = 前后俯仰、`Y` = 左右转头、`Z` = 左右侧倾。
 *
 *  表项 = `[轴 0=X/1=Y/2=Z, 幅度(弧度), 频率(周期 = IDLE_PERIOD / freq 秒)]`。
 *  频率取无理数比（1 / 0.5 / 0.31 / 0.23 / 0.17）让四个循环错开，免得看出节拍。
 *  幅度量级：0.017 rad ≈ 1.0°，0.035 rad ≈ 2.0° —— 是「呼吸」，不是「跳舞」。 */
type IdleTerm = [axis: 0 | 1 | 2, amp: number, freq: number];

const IDLE_PERIOD = 4.0; // 基准周期（秒）

const IDLE_BONES: Record<string, IdleTerm[]> = {
    // 呼吸：胸腔前后起伏 + 一点点左右重心偏移
    '上半身': [[0, 0.017, 1.0], [2, 0.008, 0.5]],
    // 上段脊柱跟着走，幅度递减（各模型的 `上半身1` / `上半身2` / `上半身3` 命名不一，
    // 三行都写；`find` 只命中实际存在的那几根）
    '上半身1': [[0, 0.007, 1.0]],
    '上半身2': [[0, 0.007, 1.0]],
    '上半身3': [[0, 0.007, 1.0]],
    // 颈：反相抵消一点俯仰（头别跟着点），慢速左右张望
    '首': [[0, -0.009, 1.0], [1, 0.035, 0.23]],
    // 头：比颈更慢一点的独立小动作
    '頭': [[1, 0.028, 0.31], [0, 0.010, 0.17]],
    // 肩 / 腕 / ひじ：手臂极小幅摆动。符号左右相反（`左` = 模型自己的左 = +X 侧，
    // 绕 +Z 转正角把下垂的手臂末端推向 +X ⇒ 左正右负 = 两侧同时外张）。
    '左肩': [[2, 0.013, 1.0]],
    '右肩': [[2, -0.013, 1.0]],
    '左腕': [[2, 0.028, 0.5], [0, 0.012, 0.5]],
    '右腕': [[2, -0.028, 0.5], [0, 0.012, 0.5]],
    '左ひじ': [[2, -0.016, 0.5]],
    '右ひじ': [[2, 0.016, 0.5]],
};

/** 一根被微动接管的骨：基准姿势 + 它的项表 */
interface IdleBone { b: THREE.Bone; q: THREE.Quaternion; p: THREE.Vector3; terms: IdleTerm[] }

/** 一个角色的微动装置。`torso` 是子树刷新起点（`上半身`）——
 *  只推它以下的 `matrixWorld`，腿那一支连算都不用算。 */
interface IdleRig {
    torso: THREE.Bone;
    bones: IdleBone[];
    skel: THREE.Skeleton | undefined;
    /** 每个角色一个相位偏移，15 个人不会同拍呼吸 */
    phase: number;
    /** 每个角色一个幅度系数（0.7~1.3），免得像复制粘贴 */
    amp: number;
}

/* 逐帧要用的临时对象，放模块级 —— 别在 useFrame 里 new（GC 抖动）。 */
const IDLE_AXIS = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const IDLE_DQ = new THREE.Quaternion();

/** 把一帧的微动写进骨架。
 *
 *  顺序是硬性的，三步都不能少（与烘焙同源，见 §5.5 ⑤）：
 *    ① 逐骨写 `quaternion` 后**必须** `b.updateMatrix()` —— MMD 骨
 *       `matrixAutoUpdate === false`（判据 P），`updateMatrixWorld` 不会从
 *       `quaternion` 重算 `matrix`；
 *    ② 再自顶向下推 `matrixWorld`（从 `上半身` 起，腿那一支是脏不了的不必碰）；
 *    ③ 最后 `skeleton.update()` —— WebGPU 的蒙皮走
 *       `SkinningNode.update(frame)` → `skeleton.update()`
 *       （`three/build/three.webgpu.js:17923`），它只做
 *       `boneMatrices[i] = bone.matrixWorld × boneInverses[i]`，输入就是第 ② 步。 */
function applyIdle(rig: IdleRig, w: number): void {
    for (const ib of rig.bones) {
        const b = ib.b;
        b.quaternion.copy(ib.q);
        for (const [ax, amp, freq] of ib.terms) {
            const a = amp * rig.amp * Math.sin(w * freq + rig.phase);
            if (a === 0) continue;
            IDLE_DQ.setFromAxisAngle(IDLE_AXIS[ax], a);
            b.quaternion.multiply(IDLE_DQ);
        }
        b.position.copy(ib.p);
        b.updateMatrix();
    }
    rig.torso.updateMatrixWorld(true);
    rig.skel?.update();
}

/* ════════════════════════════════════════════════════════════════════════════
 * 5. 组件
 * ════════════════════════════════════════════════════════════════════════════ */
interface LiveNpc {
    pipeline: any;
    loader: ThreeMmdLoader | null;
    clip: any;
    loop: number;
    ready: boolean;
    /** 逐个模型的落地结果，给探针与报告用 */
    placed: { id: string; name: string; x: number; z: number; h: number; mats: number; bones: number }[];
    errors: string[];
    /** 材质修正计数（探针读，用来证明修正真的跑到了每个模型上） */
    addFix: number;
    alphaFix: number;
    /** 站立待机微动的装置，一人一份（`?npcidle=0` 时恒为空数组） */
    idle: IdleRig[];
}

export function NpcCrowd({
    visible = true,
    pose,
    layout,
    n,
    spots,
}: {
    visible?: boolean;
    /** 覆盖 `?npcpose=`（`stand` / `sit`）。**加载期一次性**，改了要换 `key` 才生效。 */
    pose?: string;
    /** 覆盖 `?npclayout=`（`table` / `ring`）。同上。 */
    layout?: string;
    /** 覆盖 `?npcn=`（摆几个）。同上。 */
    n?: number;
    /**
     * ★ 直接给定整张站位表（与 `ROSTER` 逐位对应）。
     *
     * `GameLayer` 必须传它 —— 互动点坐标和模型落点必须来自同一份数组，
     * 否则会出现「提示说按 F 打招呼，人却在十米外」。不传时退回本文件自己的
     * 散点算法（老 URL 演示线 `?npc=1` 仍然可用）。见 `ScatterOpts.fixed`。
     */
    spots?: NpcSpot[];
}) {
    /* ── 逐实例常量：prop 优先，URL 兜底 ─────────────────────────────
     * 见文件头「★ prop 覆盖」。这四个 + `scatterOpts` 是 `pose`/`layout`/`n`
     * 唯一影响到的量，其余（缩放 / 描边 / 材质修正）两套群像完全一致。 */
    const sit = (pose ?? NPC_POSE) === 'sit';
    const lay = (layout ?? NPC_LAYOUT).toLowerCase();
    const limit = Math.max(1, Math.round(n ?? NPC_LIMIT));
    const motionUrl = NPC_MOTION_URL ?? (sit ? NPC_SIT_MOTION : NPC_STAND_MOTION);
    const scatterOpts: ScatterOpts = {
        layout: lay,
        sit,
        r0: NPC_R0, r1: NPC_R1, gap: NPC_GAP, seed: NPC_SEED, yaw: NPC_YAW,
        fixed: spots,
    };

    const groupRef = useRef<THREE.Group>(null);
    /* `useFrame` 的回调闭包只建一次，读不到新的 prop ⇒ 用 ref 兜住
     * （`?env=0` 切环境时整群要真的停下来） */
    const visibleRef = useRef(visible);
    visibleRef.current = visible;
    const gl = useThree((s) => s.gl);
    const scene = useThree((s) => s.scene);
    const live = useRef<LiveNpc>({
        pipeline: null, loader: null, clip: null, loop: 0,
        ready: false, placed: [], errors: [], addFix: 0, alphaFix: 0, idle: [],
    });

    useEffect(() => {
        if (!NPC_ON) return;
        let cancelled = false;
        const L = live.current;

        (async () => {
            /* ── 5.1 等太阳 ────────────────────────────────────────────────
             * MMD 的 TSL 管线每帧从它绑定的灯读方向与颜色
             * （`pipeline.js` 的 `syncLightUniforms`：`lightColor = light.color ×
             *   light.intensity`）。会场的太阳 intensity = 2.0，直接拿来会把
             * `litBase` 与镜面顶穿（MMD 的默认量级是
             * `MMD_TSL_DEFAULT_LIGHT_COLOR = 154/255 = 0.604`），所以另建一盏
             * **不进 scene** 的定向光，每帧拷太阳的位置与朝向。
             * `DirectionalLight` 在 Suspense 内可能晚挂，所以轮询 `SUN_REF`。 */
            let sun = SUN_REF.current;
            for (let i = 0; i < 400 && !sun; i++) {
                await new Promise((r) => setTimeout(r, 25));
                if (cancelled) return;
                sun = SUN_REF.current;
            }
            if (!sun) {
                L.errors.push('等不到 DirectionalLight（SUN_REF.current 一直是 null）');
                console.warn('[npc] 等不到 DirectionalLight，群像不加载');
                return;
            }

            const mmdLight = new THREE.DirectionalLight(sun.color.clone(), 1.0);
            mmdLight.position.copy(sun.position);
            mmdLight.target.position.copy(sun.target.position);
            mmdLight.updateMatrixWorld(true);
            mmdLight.target.updateMatrixWorld(true);

            /* ── 5.2 共享管线 ─────────────────────────────────────────────
             * `createMmdTslPipeline` 会 `await renderer.init()` 并校验真 WebGPU
             * 后端，回退 WebGL 会抛 `MMD_TSL_PIPELINE_NATIVE_WEBGPU_REQUIRED`。 */
            let pipeline: any;
            try {
                pipeline = await createMmdTslPipeline(gl as any, {
                    light: mmdLight,
                    selfShadowEnabled: false,
                    appendOutlineGroups: NPC_OUTLINE,
                });
            } catch (e) {
                L.errors.push(`createMmdTslPipeline 失败：${String(e)}`);
                console.error('[npc] 建管线失败', e);
                return;
            }
            if (cancelled) { pipeline.dispose?.(); return; }
            L.pipeline = pipeline;

            /* ── 5.3 参考动作（只加载一次，15 个模型共用） ─────────────────
             * 用一个**走路循环**当站立参考，是因为这些原神模型都是标准 MMD 骨名，
             * 而哥伦比娅那套 `miao/05_standard_loop.vmd` 自带「双臂垂下 + 迈步」
             * 的完整姿势；把相位平均掉、再把腿换回绑定姿势，就得到静止站姿。
             * 绑定时用「符号对齐的平均四元数」而不是「取某一帧」：单帧的迈步姿势
             * 是走路中段，两条腿一前一后，站着会像定格。 */
            const loader = new ThreeMmdLoader();
            L.loader = loader;
            let clip: any = null;
            let loop = 1.5;
            try {
                const motion: any = await loader.loadAnimation(motionUrl);
                clip = motion?.animation ?? motion;
                // `maxFrame` 是加载器给的末帧号（30 fps 制）
                const maxFrame = clip?.metadata?.maxFrame;
                loop = (typeof maxFrame === 'number' && maxFrame > 0 ? (maxFrame + 1) / 30 : 1.5);
            } catch (e) {
                L.errors.push(`loadAnimation(${motionUrl}) 失败：${String(e)}`);
                console.error('[npc] 参考动作加载失败', e);
                return;
            }
            L.clip = clip;
            L.loop = loop;
            console.log(`[npc] 参考动作 ${motionUrl}：循环 ${loop.toFixed(4)} s，`
                + `骨骼轨 ${Object.keys(clip?.boneTracks ?? {}).length} 条`);

            /* ── 5.4 站位 ────────────────────────────────────────────────── */
            const defs = ROSTER.slice(0, limit);
            const spots = scatterSpots(defs.length, scatterOpts);
            const host = groupRef.current;
            if (!host) return;

            /* ── 5.5 逐个加载 + 烘焙站姿 ─────────────────────────────────── */
            for (let i = 0; i < defs.length; i++) {
                if (cancelled) return;
                const def = defs[i];
                const spot = spots[i];
                const url = urlOf(def.id);
                try {
                    const model: any = await loader.loadModel(url, pipeline.createModelLoadOptions());
                    if (cancelled) return;

                    /* ① 固定比例缩放 + 贴地（见文件头铁律 ①②） */
                    model.root.updateMatrixWorld(true);
                    const box = new THREE.Box3().setFromObject(model.root);
                    const rawH = Math.max(0.001, box.max.y - box.min.y);
                    const s = NPC_SCALE;
                    model.root.scale.setScalar(s);
                    model.root.position.y = -box.min.y * s;

                    /* ② 独立容器：站位只设一次，不动 model.root 的 x/z */
                    const holder = new THREE.Group();
                    const y = worldHeightCPU(spot.x, spot.z);
                    holder.position.set(spot.x, y, spot.z);
                    holder.rotation.y = spot.yaw;
                    holder.add(model.root);
                    host.add(holder);

                    /* ③ 挂到共享管线（会 dispose 原材质 + 建白色影子代理） */
                    pipeline.attach(model, { light: mmdLight });

                    /* ④ 摘掉白色影子代理（见文件头铁律 ③） */
                    if (QSTR('mmdproxy') !== '1') {
                        for (const c of [...(model.mesh?.children ?? [])]) {
                            if ((c as any)?.userData?.mmdTslShadowCaster) model.mesh.remove(c);
                        }
                    }

                    /* ④′ 材质后处理 —— 与 `MmdCharacter.tsx:2031-2097` 同一套修正。
                     *
                     * 为什么必须在 `attach` **之后**：`replaceMmdModelMaterialsWithTsl`
                     * 会为每个源材质 `new` 一个 TSL 节点材质并整体替换 `mesh.material`
                     * （原材质连同上面的属性一起被 dispose）。所以改早了等于没改。
                     *
                     * 为什么 NPC 之前头发是错的：这两个修正原本只写在哥伦比娅那条线里，
                     * `NpcCrowd` 一个都没抄 —— 15 个原神模型里凡是有「髮+」加算层的
                     * （芙宁娜/菈乌玛/林尼/琳妮特/奈芙尔/桑多涅/爱诺/菲林斯/菲米尼/荧
                     * 共 10 个），那一层就被加载器按**不透明**画，把底下的真发整片盖住。
                     * 桑多涅最明显（`tex\sp.png` 实测 meanRGB=(180,167,169)、meanA=16.1
                     * ⇒ 近乎全透明，全部内容来自 `spa\hair_s.bmp` 的加算）。 */
                    const mm: any = (model.mesh as any).material;
                    const ms: any[] = Array.isArray(mm) ? mm : [mm];

                    /* ④′① 球面「加算」层必须真的加算 */
                    if (NPC_ADD) {
                        let nAdd = 0;
                        ms.forEach((m, mi) => {
                            const meta = m?.userData?.mmdMaterial;
                            if (meta?.sphereMode !== 'add') return;
                            // 只动「加载器当成不透明」的那份：`transparencyMode==='alphaBlend'`
                            // 的本来就按透明画，改成加算会把它变成一层发光。
                            if (meta.transparencyMode && meta.transparencyMode !== 'opaque') return;
                            m.transparent = true;
                            m.blending = THREE.AdditiveBlending;
                            m.depthWrite = false;
                            m.needsUpdate = true;
                            nAdd++;
                            if (DEBUG) {
                                console.log(`[npc]   ${def.id} 加算层 #${mi}「${meta.name || '?'}」→ Additive`
                                    + `（球面 ${String(meta.sphereTexturePath || '').split(/[\\/]/).pop()}）`);
                            }
                        });
                        L.addFix += nAdd;
                    }

                    /* ④′② 漫反射贴图自带 alpha 的材质开 alphaTest。
                     * 用 alphaTest 而不是 transparent：前者只丢弃透明像素、其余照旧走
                     * 不透明队列，**没有排序问题**（transparent 会把整只模型拖进透明队列，
                     * 三千多根发丝会互相穿插错乱）。 */
                    if (NPC_ALPHA) {
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
                        ms.forEach((m) => {
                            if (m?.blending === THREE.AdditiveBlending) return;
                            const t = m?.map ?? m?.userData?.mmdTslTextureReferences?.diffuseMap;
                            if (!t) return;
                            const k = String(t.uuid);
                            if (!(k in seen)) seen[k] = alphaOf(t);
                            const a = seen[k];
                            if (a !== null && a < 200) {
                                m.alphaTest = 0.5;
                                m.needsUpdate = true;
                                L.alphaFix++;
                            }
                        });
                    }

                    /* ⑤ 烘焙静态站姿 */
                    const skel = (model.mesh as any)?.skeleton as THREE.Skeleton | undefined;
                    const bones: THREE.Bone[] = (skel?.bones ?? []) as THREE.Bone[];
                    let mats = 0;
                    model.root.traverse((o: any) => { if (o.isMesh) mats += Array.isArray(o.material) ? o.material.length : 1; });

                    if (bones.length && clip) {
                        model.setAnimation(clip);
                        const bindPos = bones.map((b) => b.position.clone());
                        const sum = bones.map(() => new THREE.Quaternion(0, 0, 0, 0));
                        const sumP = bones.map(() => new THREE.Vector3());
                        // 每个模型一份自己的 morphOverrides —— 共享同一个对象
                        // 有被运行时写坏的风险（`dist/runtime/mmdAnimRuntime.js` 会读它）
                        const iko: Record<string, unknown> = (NPC_IK || sit)
                            ? { ik: true }
                            : { ik: false, morphOverrides: { indices: new Int32Array([0]), weights: new Float32Array([0]) } };

                        /* 采样区间：站姿扫整个循环（相位平均 ⇒ 静立的基准姿势）；
                         * 坐姿只扫「静止坐姿段」—— `座る.vmd` 第 45–110 帧姿态完全不变，
                         * 取内缩一点的 50–105（`?npcsitf0/f1=`）避开头尾的过渡帧。 */
                        const t0 = sit ? NPC_SIT_F0 / 30 : 0;
                        const t1 = sit ? NPC_SIT_F1 / 30 : loop;

                        for (let k = 0; k < NPC_ARM_K; k++) {
                            model.update(t0 + (k / NPC_ARM_K) * (t1 - t0), iko);
                            for (let bi = 0; bi < bones.length; bi++) {
                                const q = bones[bi].quaternion;
                                const a = sum[bi];
                                // ★ 符号对齐：四元数 q 与 -q 表示同一个旋转，直接累加
                                //   会让反相位的半波互相抵消成零四元数（归一化后变成
                                //   乱七八糟的姿势）。MmdCharacter 的 ARM_POSE 也是这么做的。
                                const sg = (a.x * q.x + a.y * q.y + a.z * q.z + a.w * q.w) < 0 ? -1 : 1;
                                a.x += sg * q.x; a.y += sg * q.y; a.z += sg * q.z; a.w += sg * q.w;
                                sumP[bi].add(bones[bi].position);
                            }
                        }
                        // 腿链 → 绑定姿势（identity；PMX 的骨结构里没有静止旋转字段，
                        // 所以单位四元数就是绑定姿势 —— 见 MmdCharacter.tsx:3106-3110）
                        //
                        // ⚠️ 坐姿**绝不能**走这一步：`座る.vmd` 的 `左ひざ/右ひざ/左足首/右足首`
                        //    FK 轨全是 0（作者只用 `足ＩＫ` 驱动腿），腿上这唯一一份有效姿势
                        //    就是 IK 解算写进这些骨头的四元数，抹成 identity 就变回站姿了。
                        const legSet = new Set<THREE.Bone>();
                        if (!sit) {
                            for (const n of LEG_NAMES) {
                                const b = bones.find((x) => x.name === n || rawName(x) === n);
                                if (b) legSet.add(b);
                            }
                        }
                        for (let bi = 0; bi < bones.length; bi++) {
                            const b = bones[bi];
                            const a = sum[bi];
                            const len = Math.hypot(a.x, a.y, a.z, a.w);
                            if (legSet.has(b) || len < 1e-6) b.quaternion.identity();
                            else b.quaternion.set(a.x / len, a.y / len, a.z / len, a.w / len);
                            // 丢掉 VMD 的根位移（センター/グルーブ 的 translation 轨），
                            // 否则每个模型都会按走路轨迹歪到一边去。
                            //
                            // 坐姿例外：**只有根链的 Y** 要留 —— 那就是「坐下时身体下沉多少」。
                            // `座る.vmd` f55 实测 `センター` pos=(0.00, -4.05, 3.40) 单位
                            // （PMX 里约 20 单位 = 1.62 m ⇒ 4.05 单位 ≈ 0.32 m，正好是
                            // 「站着髋高 ~0.9 m → 坐着 ~0.55 m」的下沉量）。丢了它人就会
                            // 悬在站姿高度上、屁股浮在椅面上方。
                            // X/Z 照样丢（那是走路轨迹）；`足ＩＫ` 的 position 也照样丢 ——
                            // 烘焙完的 FK 腿骨四元数已经是 IK 的解，没人会再跑一次 IK。
                            if (sit && SIT_ROOT_BONES.has(rawName(b))) {
                                // VMD 的 translation 轨是**绝对位置**（不是增量），
                                // 所以直接取采样均值即可；X/Z 仍然用绑定位置。
                                const p = sumP[bi].multiplyScalar(1 / NPC_ARM_K);
                                b.position.set(bindPos[bi].x, p.y, bindPos[bi].z);
                            } else {
                                b.position.copy(bindPos[bi]);
                            }
                            b.updateMatrix();
                        }
                        // 判据 P：MMD 骨 `matrixAutoUpdate === false`，`updateWorldMatrix`
                        // 不会重算 `matrix` ⇒ 上一步必须先逐根 `updateMatrix()`，再自顶
                        // 向下推 `matrixWorld`。
                        model.root.updateMatrixWorld(true);
                        skel?.update();

                        /* ⑥ 挂上站立待机微动（用户 m01170 第一项）
                         *
                         * 此刻 `bones[*].quaternion` 就是**烘焙好的基准姿势**，
                         * 直接抄下来当 `q0`。之后再没人调 `model.update`，所以
                         * 这份基准是稳定的；`?npcidle=0` 时干脆不建 rig，
                         * 渲染结果与烘焙完一模一样，方便逐位对照。 */
                        if (NPC_IDLE) {
                            const torso = bones.find((x) => x.name === '上半身' || rawName(x) === '上半身');
                            if (torso) {
                                const rigBones: IdleBone[] = [];
                                for (const [name, terms] of Object.entries(IDLE_BONES)) {
                                    const b = bones.find((x) => x.name === name || rawName(x) === name);
                                    if (!b) continue;
                                    rigBones.push({ b, q: b.quaternion.clone(), p: b.position.clone(), terms });
                                }
                                // 相位与幅度一人一份：拿 id 做一个稳定的散列，
                                // 不用 Math.random（每次刷新站位就变，没法复现）
                                const h = hash01(0, i, 0x9e37);
                                L.idle.push({
                                    torso, bones: rigBones, skel,
                                    phase: h * Math.PI * 2,
                                    amp: NPC_IDLE_AMP * (0.7 + hash01(1, i, 0x85eb) * 0.6),
                                });
                                if (DEBUG) {
                                    console.log(`[npc]   ${def.id} 微动骨 ${rigBones.length} 根 `
                                        + `(相位 ${(h * 360).toFixed(0)}°，幅度 ×${(0.7 + hash01(1, i, 0x85eb) * 0.6).toFixed(2)})`);
                                }
                            } else {
                                L.errors.push(`${def.id}: 找不到「上半身」，微动跳过`);
                            }
                        }

                        L.placed.push({
                            id: def.id, name: def.name, x: +spot.x.toFixed(2), z: +spot.z.toFixed(2),
                            h: +(rawH * s).toFixed(3), mats, bones: bones.length,
                        });
                        console.log(`[npc] ${def.name}(${def.id}) 就位 `
                            + `(${spot.x.toFixed(1)}, ${worldHeightCPU(spot.x, spot.z).toFixed(2)}, ${spot.z.toFixed(1)}) `
                            + `身高 ${(rawH * s).toFixed(3)} m（原始 ${rawH.toFixed(2)} 单位）`
                            + ` 骨 ${bones.length} 材质 ${mats}`);
                    } else {
                        L.errors.push(`${def.id}: 骨架 ${bones.length} 根 / clip ${clip ? 'ok' : 'null'}`);
                        console.warn(`[npc] ${def.id} 没有骨架或没有动作，只能停在绑定姿势`);
                    }
                } catch (e) {
                    L.errors.push(`${def.id}: ${String(e)}`);
                    console.error(`[npc] ${def.id} 加载失败`, e);
                }
            }

            L.ready = true;
            console.log(`[npc] 群像就绪：${L.placed.length}/${defs.length} 个角色，`
                + `管线 attached = ${Array.isArray(pipeline.attached) ? pipeline.attached.length : '?'}`
                + `${L.errors.length ? `，失败 ${L.errors.length} 个：${L.errors.join(' | ')}` : ''}`);
        })();

        /* ── 卸载清理 ────────────────────────────────────────────────────
         * ⚠️⚠️ 2026-10-17 修：这里原来只有 `cancelled = true` —— 只打断了**加载**，
         * 已经把模型挂上场景的那一份 GPU 资源一个都没还：
         *   15 套 MMD（每套 ~30 万顶点 + 十几张 `tex/*.bmp` 贴图）+ 1 个 TSL 管线
         *   （含 shadow proxy 与 `pipeline.attached` 里的全部材质引用）。
         *
         * 而这个组件的卸载**不是偶发**：`components/game/GameLayer.tsx:264-265` 用
         * `key="npc-stand"` / `key="npc-sit"` 让「站着」和「坐着」两套群像互斥挂载，
         * 委托阶段一推进就换 key ⇒ **必然销毁重建一次**；dev 下 StrictMode 双挂载
         * 再翻一倍。旧的 `pipeline.dispose?.()` 只在 `:686` 那条「还没 attach 就被
         * 取消」的早退路径上出现过，正常走完加载的那份永远没人 dispose。
         *
         * 顺序：先管线（它持有 attached 模型与材质映射），再按场景图兜底遍历
         * 几何/材质/贴图（管线没覆盖到的部分也不漏），最后清引用。
         * 只遍历**本组件自己的 group**（`groupRef`），不碰 `scene` ——
         * 场景里还有别的组件的东西。 */
        return () => {
            cancelled = true;
            const L2 = live.current;
            try {
                L2.pipeline?.dispose?.();
            } catch (e) {
                console.warn('[npc] pipeline.dispose 抛错（忽略并继续清理模型）', e);
            }
            groupRef.current?.traverse((o: any) => {
                if (!o?.isMesh) return;
                o.geometry?.dispose?.();
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                for (const m of mats) {
                    if (!m) continue;
                    // 材质上的贴图（MMD 的 diffuse / sphere / toon 全都是贴图）
                    for (const k in m) {
                        const v: any = (m as any)[k];
                        if (v && v.isTexture) v.dispose?.();
                    }
                    m.dispose?.();
                }
            });
            L2.pipeline = null;
            L2.loader = null;
            L2.clip = null;
            L2.placed.length = 0;
            L2.idle.length = 0;
            L2.ready = false;
        };
        /* `sit` / `lay` / `limit` / `scatterOpts` 都是加载期一次性的：改了必须换 `key`。 */
    }, [gl, scene]);

    /* 每帧只提交一次：`prepareRender` 会遍历 **全部** attached 模型做
     * 稀疏 morph / 材质状态 / 接收者可见性同步 —— 一个管线一次就够。
     * 优先级 0：晚于哥伦比娅的 -1，早于 PostFX 的 1。
     *
     * ⚠️ 别试图「因为角色是静止的」就把这里节流。实测（`_logs/npc/perf*.jsonl`，
     * 1400×820、`?cam=0,10,30&look=0,1,-8`）：把 `prepareRender` 改成 2 s 一次
     * 是 29.8 fps，逐帧是 30.1 fps —— **一点没救回来**（在噪声内），反而会让
     * `syncLightUniforms()` 一起变慢（太阳在动时 MMD 光向会滞后）。真正的开销是
     * 15 个 SkinnedMesh 自己的骨骼蒙皮与 draw call，逐模型线性：
     *   `?npc=0` 128.4 / 1 个 99.8 / 3 个 74.3 / 6 个 51.9 / 8 个 42.9 / 15 个 30.1 fps
     * ⇒ 保持逐帧。要提帧率只有两条：`?npcoutline=0`（37.8 fps，砍掉一半
     * draw call）或 `?npcn=<N>`（少摆几个）。 */
    useFrame(() => {
        const L = live.current;
        /* `visible` 为假时整群不渲染（`WorldController` 的 `?env=0` 会关掉），
         * 这时候再刷骨骼纯属白烧 —— 直接跳过。注意不能只靠 `<group visible>`：
         * three 只跳过 **draw**，`useFrame` 里这一坨照样每帧跑。 */
        if (!visibleRef.current) return;
        /* 站立待机微动：先写骨、再 `skeleton.update()`、最后 `prepareRender`。
         * 顺序不能反 —— `prepareRender` 之后紧接着就是渲染，中间再没有刷
         * 骨骼矩阵的机会。时间源用共享的 `uTime`（单调、带整数回绕，见
         * `MmdCharacter` 的帧循环注释），于是 `?tfreeze=` 一钉，微动也跟着定住，
         * 截图可以复现。 */
        if (L.idle.length) {
            const w = (uTime.value as number) * NPC_IDLE_SPEED * (Math.PI * 2 / IDLE_PERIOD);
            for (const rig of L.idle) applyIdle(rig, w);
        }
        if (L.pipeline) L.pipeline.prepareRender(scene);
    }, 0);

    /* 探针：给无头脚本读数（`window.__npc.list()`）
     *
     * `front()` 是「朝向」的**决定性判据**，不靠肉眼看图：
     *   模型的「左目」在世界里相对「右目」偏 +X 还是 −X，唯一地决定了前向量
     *   是 +Z 还是 −Z —— 右手系（Y 上）里 `右 = 上 × 后向`：
     *     前 = +Z ⇒ 后 = −Z，右 = (0,1,0)×(0,0,−1) = (−1,0,0) ⇒ **左目在 +X**
     *     前 = −Z ⇒ 后 = +Z，右 = (0,1,0)×(0,0,1) = (+1,0,0) ⇒ **左目在 −X**
     *   返回值的 `dx > 0` ⇒ yaw=0 时面朝 +Z。`yaw` 是把 (0,0,1) 旋到前向所需的角，
     *   可直接拿去算「面朝会场中心」的正确公式。 */
    useEffect(() => {
        (window as unknown as { __npc?: unknown }).__npc = {
            on: NPC_ON,
            ready: () => live.current.ready,
            count: () => live.current.placed.length,
            list: () => live.current.placed,
            errors: () => live.current.errors,
            loop: () => live.current.loop,
            /* 材质修正的证据：`?npcadd=0` / `?npcalpha=0` 时这两个数会掉下来，
             * 可以直接用来二分「头发不对」到底是加算层还是 alphaTest。 */
            matfix: () => ({ add: live.current.addFix, alpha: live.current.alphaFix }),
            /* 逐模型的材质快照 —— 判断某个角色头发为什么不对时不用再猜 */
            mats: (idx = 0) => {
                const host = groupRef.current;
                if (!host || !host.children.length) return null;
                const holder = host.children[Math.max(0, Math.min(host.children.length - 1, idx))] as THREE.Group;
                const out: unknown[] = [];
                holder.traverse((o: any) => {
                    if (!o.isMesh) return;
                    const arr = Array.isArray(o.material) ? o.material : [o.material];
                    arr.forEach((m: any, mi: number) => {
                        const meta = m?.userData?.mmdMaterial ?? {};
                        out.push({
                            i: mi,
                            name: meta.name ?? '?',
                            sphere: meta.sphereMode ?? 'none',
                            sph: String(meta.sphereTexturePath ?? '').split(/[\\/]/).pop() || '',
                            tm: meta.transparencyMode ?? '?',
                            transparent: !!m.transparent,
                            blending: m.blending,
                            depthWrite: !!m.depthWrite,
                            alphaTest: m.alphaTest ?? 0,
                            visible: m.visible !== false,
                        });
                    });
                });
                return out;
            },
            /* 骨骼名清单 —— 设计待机微动时要知道 15 个模型到底有哪些躯干骨
             * （模型作者不同，命名未必一致）。`re` 是可选的正则过滤。 */
            bones: (idx = 0, re?: string) => {
                const host = groupRef.current;
                if (!host || !host.children.length) return null;
                const holder = host.children[Math.max(0, Math.min(host.children.length - 1, idx))] as THREE.Group;
                let skel: THREE.Skeleton | undefined;
                holder.traverse((o: any) => { if (!skel && o.isSkinnedMesh) skel = o.skeleton; });
                const all = ((skel?.bones ?? []) as THREE.Bone[]).map(rawName);
                if (!re) return all;
                const rx = new RegExp(re);
                return all.filter((n) => rx.test(n));
            },
            front: (idx = 0) => {
                const host = groupRef.current;
                if (!host || !host.children.length) return null;
                const holder = host.children[Math.max(0, Math.min(host.children.length - 1, idx))] as THREE.Group;
                let skel: THREE.Skeleton | undefined;
                holder.traverse((o: any) => { if (!skel && o.isSkinnedMesh) skel = o.skeleton; });
                const bones: THREE.Bone[] = (skel?.bones ?? []) as THREE.Bone[];
                const find = (n: string) => bones.find((b) => b.name === n || rawName(b) === n);
                const L = find('左目') ?? find('左眼');
                const R = find('右目') ?? find('右眼');
                if (!L || !R) {
                    return { err: '找不到左右目骨', names: bones.map(rawName).filter((n) => /目|眼|肩/.test(n)).slice(0, 20) };
                }
                const pa = new THREE.Vector3().setFromMatrixPosition(L.matrixWorld);
                const pb = new THREE.Vector3().setFromMatrixPosition(R.matrixWorld);
                const dx = pa.x - pb.x;
                return {
                    dx: +dx.toFixed(5),
                    forwardPlusZ: dx > 0,
                    yaw0: holder.rotation.y,
                    axes: {
                        '左目': [+pa.x.toFixed(3), +pa.y.toFixed(3), +pa.z.toFixed(3)],
                        '右目': [+pb.x.toFixed(3), +pb.y.toFixed(3), +pb.z.toFixed(3)],
                    },
                };
            },
            /* 一次问清全部 15 个：谁的朝向与别人不一致（模型作者不同，可能有例外） */
            frontAll: () => {
                const host = groupRef.current;
                if (!host) return [];
                const out: unknown[] = [];
                for (let i = 0; i < host.children.length; i++) {
                    const f = (window as any).__npc.front(i);
                    out.push({ i, id: live.current.placed[i]?.id ?? '?', dx: f?.dx, plusZ: f?.forwardPlusZ, yaw0: f?.yaw0, err: f?.err });
                }
                return out;
            },
            /* 站立待机微动的读数 —— 证明「微动真的接上了」而不是只有代码。
             * `?npcidle=0` 时 `idle()` 返回空数组。 */
            idle: () => live.current.idle.map((r, i) => ({
                i,
                id: live.current.placed[i]?.id ?? '?',
                torso: rawName(r.torso),
                bones: r.bones.length,
                phase: +r.phase.toFixed(3),
                amp: +r.amp.toFixed(3),
            })),
            /* 某个角色此刻的骨世界坐标快照。
             *
             * 这是**微动是否真的动起来**的决定性判据：同一帧里 `q` 抄的是基准，
             * 隔几秒再问一次，若 `首` / `頭` / `左腕` 的世界坐标有变化 ⇒ 骨
             * 确实在动。若全都逐位相同 ⇒ rig 没跑（或 `?npcidle=0`）。
             * 注意：读的是 `matrixWorld`，所以 `applyIdle` 里那三步刷新
             * （`updateMatrix` → `updateMatrixWorld` → `skeleton.update`）
             * 缺任何一步，这里都会露馅。 */
            idleProbe: (idx = 0) => {
                const host = groupRef.current;
                if (!host || !host.children.length) return null;
                const holder = host.children[Math.max(0, Math.min(host.children.length - 1, idx))] as THREE.Group;
                let skel: THREE.Skeleton | undefined;
                holder.traverse((o: any) => { if (!skel && o.isSkinnedMesh) skel = o.skeleton; });
                const bones: THREE.Bone[] = (skel?.bones ?? []) as THREE.Bone[];
                const out: Record<string, number[]> = {};
                for (const n of ['センター', '下半身', '上半身', '首', '頭', '左腕', '右腕', '左足', '左ひざ', '左足首', '右足', '右ひざ', '右足首']) {
                    const b = bones.find((x) => x.name === n || rawName(x) === n);
                    if (!b) continue;
                    const p = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
                    out[n] = [+p.x.toFixed(5), +p.y.toFixed(5), +p.z.toFixed(5)];
                }
                return { id: live.current.placed[idx]?.id ?? '?', w: +uTime.value.toFixed(4), pos: out };
            },
        };
    }, []);

    return <group ref={groupRef} visible={visible} />;
}
