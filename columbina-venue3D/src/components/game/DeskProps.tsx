/**
 * DeskProps.tsx —— 生日会任务①「写邀请函」的两件道具：**书桌** + **信箱**。
 *
 * 流程：先走到书桌按 F 写 11 封邀请函，写完信箱才出现，再走过去按 F 投递。
 * ⇒ 两件道具的**出现时机不同**，所以除了整组总开关 `visible`，信箱还有一份自己的
 *   `mailboxVisible`（挂载点在 `GameLayer.tsx:226`，值来自 `showMailbox`）。
 *
 * ── 素材与真实尺寸 ──────────────────────────────────────────────────────
 *   两件都是 `_tools/ph-blender.py --normalize --ground` 的产物：
 *   **高度被归一化到 1.0**（不是「宽 1 高 1 深 1 的立方体」）⇒ scale 就等于真实高度。
 *     · `desk_n7.glb`      原始 1.719 × 1.000 × 0.825 ⇒ ×0.75 = 1.289 × 0.750 × 0.619 m
 *     · `mailbox_flag.glb` 原始 0.162 × 1.000 × 0.488 ⇒ ×1.15 = 0.187 × 1.150 × 0.561 m
 *   （以上尺寸是解析 GLB 的 JSON chunk、递归应用节点旋转后算出的**世界** bbox，不是访问器原始值）
 *
 *   ★★ 2026-10-17 再换素材（用户 m00718「写邀请函的书桌太小太简陋。换一个。」）：
 *   上一版 `desk_n7`（Poly Haven `small_wooden_table_01`）真实尺寸只有
 *   **1.289 × 0.750 × 0.619 m** —— 一张小边桌，摆上信纸和烛台就显得挤，用户说「太小太简陋」。
 *   现在换成 **`desk_n17.glb`**（Poly Haven `WoodenTable_01`，CC0，382 三角，`img=3` 贴图齐全）：
 *   归一化 bbox **3.279 × 1.000 × 1.197** ⇒ ×0.75 = **2.459 × 0.750 × 0.898 m**，
 *   宽了近一倍、深了近 45%，是真正能摊开写字的书桌；桌面木纹、桌腿横撑在近景里都立得住。
 *   选型过程：12 个候选同机位出图比对（`_logs/deskpick/`）+ 7 个近景复拍（`_logs/deskpick2/`），
 *   入围的还有 `desk_n5`（灰蓝漆木桌，偏北欧）、`desk_n9`（深红木办公桌，偏暗）、
 *   `desk_n15`（中式茶几，太矮）、`desk_n1`（中式长条案，翘头太中式）、
 *   `desk_a`（金属办公桌，太现代）、`desk_n20`（哥特雕花柜式，太压抑）、`desk_n10`（近乎无纹理，过白）。
 *   `?deskurl=` 可随时 A/B 回去，旧图都在 `_logs/deskpick*`。
 *
 *   ★ 2026-10-15 换素材（用户 m05737「书桌过于简陋且没有颜色」）：
 *   旧素材 `desk_wood.glb` 的根因是 **`img=0`，一张贴图都没有** —— 两个材质只有裸色
 *   `DarkWood base=[0.13,0.08,0.04]` / `Wood base=[0.20,0.12,0.07]`，两个都是近黑深棕。
 *   月夜光照下顶面只靠自发光抬起一点（当时 `EMIS=0.06`，现已提到 0.55），看上去就是「一块灰扑扑的平板」。
 *
 *   ⚠️ **不要写成「转换时丢了贴图」**（本节初版就是这么写的，归因错了）：
 *   `desk_wood.glb` 的出处**不是** Poly Haven 的 `wooden_table_02`，而是
 *   **poly.pizza / Quaternius「Desk」PublicID `V86Go2rlnq`（CC0 1.0）** ——
 *   判据是它与 `desk_n13.glb` **MD5 逐字节相同**（`7400E523DD8AF19C083A7C2A9051AF4B`，均 140176 B），
 *   而这个模型**出厂就只有两个裸色材质、`images=0`** ⇒ **源本身就没有颜色可言**，
 *   从来不存在「转换丢贴图」这回事。
 *   （真正对应 `wooden_table_02` 的是 `desk_wooden.glb`，只有 196 三角，也已排除。）
 *
 *   换成 Poly Haven `small_wooden_table_01` 转出的 `desk_n7.glb`：**`img=3`（底色/法线/AO-Rough 贴图齐全）**，
 *   **3410 三角**，浅木纹 + 抽屉 + 横档。`desk_wood.glb` 保留在目录里不删，`?deskurl=` 可随时 A/B 回去。
 *   同批候选还有 `desk_n1`(中式长条案 2.596 宽) / `desk_n2`(五斗抽屉柜) / `desk_n3`(床头柜) /
 *   `desk_n5`(灰蓝漆木桌) / `desk_n6`(圆桌) / `desk_n8`(餐桌带桌布)，
 *   最省事的兜底是 `desk_n21.glb`（同源 `wooden_table_02` 补回 1024 贴图，与 `desk_wooden` 同 bbox 可 1:1 互换）。
 *   全部 21 个候选的逐项数据与推荐排序见 `公用区\素材\书桌素材来源.md`。
 *
 *   ⚠️ **本文件初版注释里的「749 三角」是错的，真值 3410** ——
 *   根因是 `_tools/glbinfo.py` 把 glTF 规范的 `indices` 键误写成 `index`，
 *   取不到就静默走 `verts // 3` 分支，**把顶点数当三角数输出**（全项目的历史三角数都偏小约 3 倍，已修）。
 *
 *   ⚠️ 「信箱原点在几何中心、要抬 0.488×scale/2」这条**实测不成立，别照抄**：
 *   早期备选 `mailbox_b.glb` 的 POSITION 访问器确实是 y∈[-0.2441, +0.2441]，但那个 mesh
 *   挂在一个带 `R = (-0.7071, 0, 0, 0.7071)`（绕 X 转 −90°）的节点下，转完 +Z 变 +Y，
 *   `gltf.scene` 实测 bbox 是 `min.y = 0` —— **本来就贴地**。
 *   现有 4 个备选（desk_a / desk_wood / mailbox_b / mailbox_flag）实测**全部** min.y = 0，
 *   但下面照旧用 `inner.position.y = -box.min.y` **现算**：
 *   写死任何一个数都会在素材重导之后浮空或埋进土里。
 *
 * ── URL 开关（项目规矩：所有要 A/B 的量都得上 URL）─────────────────────
 *   ?desk=0            整组不渲染
 *   ?deskglow=0        关掉书桌/信箱脚下的发光指引环
 *   ?deskscale=<k>     书桌缩放倍率（缺省 1.0，乘在 0.75 上）
 *   ?mbscale=<k>       信箱缩放倍率（缺省 1.0，乘在 1.15 上）
 *   ?deskurl=<url>     换书桌素材（备选：desk_a / desk_console / desk_school / desk_wooden）
 *   ?mburl=<url>       换信箱素材（备选：mailbox_a / mailbox_b / mailbox_c / mailbox_e / mailbox_f）
 *   ?deskemis=<k>      自发光强度（缺省 0.06）
 *   ?desklift=<m>      离地抬升（缺省 0；地形是起伏网格，桌腿啃进坡里时用它救场）
 *   ?deskdebug=1       打印加载/落位明细
 */
import { useEffect, useMemo, useRef, type JSX } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
    DESK_XZ, DESK_YAW, MAILBOX_XZ, MAILBOX_YAW,
} from '../../core/game/layout';
import { worldHeightCPU } from '../../core/worldRegions';
import { QNUM, QSTR } from '../../core/utils/query';

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 常量
 *
 * ⚠️ 必须排在下面「URL 开关」之前 —— 那边是 `const` 顶层求值，
 *    顺序倒了就是模块加载期的 ReferenceError（TDZ）。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 书桌真实高度（米）。GLB 高度已归一化到 1.0 ⇒ 这个值直接就是 scale。
 *  ★ 2026-10-18（用户 m00863 任务6）：换成自建的「月牙石桌」`/venue/game/moon_table.glb`
 *  （`_tools/moon-table-build.py` 生成，顶点色、无贴图），桌面高 0.78 m。
 *  旧的木桌 `desk_n17.glb` 仍在 `public/venue/game/` 里，`?deskurl=/venue/game/desk_n17.glb` 可 A/B 回去。 */
const DESK_H = 0.75;   // 月牙凹槽底（= 桌面）的**世界高度**，= 0.431（模型内实测）× MOON_SCALE
/** 信箱真实高度（米）。同上。 */
const MB_H = 1.15;

/** 指引环的离地抬升（米）。地形是三角网格，环贴着 y=地面 会 z-fighting 闪。 */
const RING_LIFT = 0.012;
/** 书桌环半径（米）。★ 换 `desk_n17`（半宽 1.230）后从 1.15 提到 1.75 ——
 *  否则光圈整圈落在桌面投影**里面**，看不出「绕着桌子」，只剩桌下一圈亮边。
 *  ★ 2026-10-18 换月牙石桌后收到 1.30：新桌面 1.55 × 0.92（半宽 0.775 / 半深 0.46），
 *  1.30 刚好落在投影外侧、又不会被宴会长桌的椅子挡住。 */
const RING_DESK_R = 1.45;
/** 信箱环半径（米）：本体宽 0.54 m，圈太大就显得空旷、看不出标的是哪件。 */
const RING_MB_R = 0.65;
/** 环的基准不透明度 + 呼吸幅度/角速度（用户要「远远就能看见」，所以要一直亮）。 */
const RING_BASE_OP = 0.55;
const RING_AMP = 0.20;
const RING_SPEED = 2.0;
/** 暖金（书桌）/ 淡青（信箱）—— 与 `CollectProps` 的暖族/冷族发光件同一色系。 */
const RING_COLOR_DESK = 0xe8d8a8;
const RING_COLOR_MB = 0x9fd8e8;

/* ══════════════════════════════════════════════════════════════════════════
 * 1. URL 开关
 * ══════════════════════════════════════════════════════════════════════════ */

/** 总开关。`?desk=0` 时组件返回 `null`（连 group 都不建）。 */
const DESK_ON = QNUM('desk', 1)! > 0;
/** 发光指引环开关。缺省开。 */
const GLOW_ON = QNUM('deskglow', 1)! > 0;
/** 缩放倍率：真实高度 × 倍率。 */
/* ⚠️ 2026-10-18：moon_table.glb 是图生 3D 直出后**已经归一化到真实米数**的
 * （_tools/glb-postprocess.py --width 1.55），所以这里不再是「归一化高度 × 系数」，
 * 直接就是缩放系数 1.0。DESK_H 改作「桌面（凹槽底）高度」，只给陈设定位用。 */
// 2026-10-18：模型原始 bbox 高 1.436 m、凹槽底只有 0.431 m —— 直接摆进场景等于把写字面
// 压到膝盖以下，还给 0.5~0.8 m 的草叶挡住了开口。放大 1.74 × 后凹槽底 ≈ 0.75 m（正常写字台高），
// 整体 2.70 × 2.50 × 1.05 m。
const MOON_SCALE = 1.74;
const DESK_SCALE = QNUM('deskscale', MOON_SCALE)!;
const MB_SCALE = MB_H * QNUM('mbscale', 1)!;
/** 素材地址可覆盖 —— 同目录还有 11 个备选，不换素材就没法做 A/B 选型。 */
const DESK_URL = QSTR('deskurl', '/venue/game/moon_table.glb')!;
const MB_URL = QSTR('mburl', '/venue/game/mailbox_flag.glb')!;
/** 自发光强度。GLB 没有 emissive 贴图，只给一点点，纯为夜景不塌成黑块。 */
const EMIS = QNUM('deskemis', 0.55)!;
/** 离地抬升（米）。缺省 0 = 底面正好落在地形高度上。 */
const LIFT = QNUM('desklift', 0)!;
const DEBUG = QNUM('deskdebug', 0)! > 0;

/* ══════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-18 椅子与坐姿整组删除（用户 m00863 任务1）
 *
 * 需求原文：「坐下的动作不对。直接删了。不坐了。连写邀请函时的椅子，
 *           桌子一并删除。」（桌子这一半改用下面的月牙石桌，见任务6）
 *
 * 已经删掉的东西（不要手贱加回来）：
 *   · `CHAIR_ON / CH_H / CH_SEAT_RATIO / CHAIR_KEY / CHAIR_FWD / CHAIR_YAW_FIX /
 *     CHAIR_DIR / chairXZ()` —— 原来这里有 75 行推导（坐面实测、前移补偿 A/B）；
 *   · `DeskProps` 里的 `chairRef` 与那一次 `buildOne(... chair_painted_01 ...)`；
 *   · `MmdCharacter.tsx` 的整套坐姿机（`LETTER_SIT` / `sit_seq.vmd` 播放头 /
 *     `SIT_DOWN / SIT_UP_FROM / SIT_UP_END` 状态机）；
 *   · `layout.ts` 的 `DESKSIT_BACK / DESKSIT_SIDE / DESK_CHAIR_XZ / DESK_CHAIR_YAW`。
 *
 * `public/motion/sit_seq.vmd` 与 `public/venue/chairs/*.glb` 两个文件保留 ——
 * 宴会那 15 把椅子还在用 `venue/chairs`，动作文件留着不占运行时成本（不加载）。
 * ══════════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════════════
 * 2. 素材加载（与 `Banquet.tsx:278` 的 `getAsset` / `prepMaterials` 同一套）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 每个 url 只 `loadAsync` 一次，之后 `clone(true)`。 */
const CACHE: Record<string, THREE.Group | null> = {};

/**
 * 材质后处理 —— **只在首次 load 后做一次**。
 *
 * ⚠️ 这里改的是 `gltf.scene` 里的**共享**材质对象（`clone(true)` 出来的副本共用它们）。
 *    所以放进 `getAsset`、在写 `CACHE` 之前调一次就够；若挪到「每次 clone 之后」再调，
 *    今天这几行是幂等的看不出问题，哪天有人把它改成累加式写法就会叠加，属于埋雷。
 *
 * 为什么不重建材质（像 `WingShipApi.tsx:150` 那样 `new MeshStandardNodeMaterial()`）：
 * 那边是图生 3D 的船，贴图要重设；这两件 GLB 的 baseColor/normal 贴图 GLTFLoader
 * 已经接好（WebGPU 下 `MeshStandardMaterial` 会自动映射成 `MeshStandardNodeMaterial`），
 * 重建反而要手动搬 map/aoMap。这里只动 emissive 三个字段。
 */
function prepMaterials(root: THREE.Object3D): void {
    root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        // 本项目不开阴影（AGENT.md），显式关掉：免得哪天开了阴影才发现道具在投影
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        const mm = mesh.material as THREE.Material | THREE.Material[] | null;
        if (!mm) return;
        /* ★ 2026-10-18：月牙石桌（图生 3D 直出、烘焙了水彩贴图）要**克制**提亮。
         * 它走下面 `s.map` 那条分支的话，`emissiveMap = map` + 纯白自发光 × 0.55
         * 会把冰蓝水彩整片洗白（同一个坑顶点色版本已经踩过一次）。
         * 这里按 mesh 名字（`glb-postprocess.py` 里写死 `MoonTable`）单独给一档冷蓝弱光。 */
        const calm = mesh.name === 'MoonTable' || mesh.parent?.name === 'MoonTable';
        for (const m of Array.isArray(mm) ? mm : [mm]) {
            const s = m as THREE.MeshStandardMaterial;
            if (!s.isMaterial || !s.emissive) continue;
            if (calm) {
                s.emissiveMap = s.map;
                s.emissive.setRGB(0.05, 0.11, 0.20);
                s.emissiveIntensity = 0.32;
                s.needsUpdate = true;
                continue;
            }
            /* ★ 有贴图 / 没贴图，提亮写法必须分开（2026-10-15 换 `desk_n7` 时发现）。
             *
             * `GLTFLoader` 读出来的 `material.color` 是 glTF 的 `baseColorFactor`，
             * 而这两个候选素材的 `baseColorFactor` **都是白色** —— 颜色**全在贴图上**。
             * 所以「按原色发光」那种写法 `s.emissive.copy(s.color)` 在这里等于
             * 发纯白的光，会把木纹洗成一片死白（`Banquet.tsx` 记过同一个坑）。
             *
             * 正确做法：把底色贴图接给 `emissiveMap`、`emissive` 设白、
             * 强度交给 `EMIS` —— 贴图自带明暗，木纹与抽屉阴影都还在。
             * 旧素材 `desk_wood.glb` 是 `img=0`（无贴图），才需要退回纯色发光那条分支。 */
            if (s.map) {
                s.emissiveMap = s.map;
                s.emissive.setRGB(1, 1, 1);
            } else if (s.vertexColors) {
                /* ★ 2026-10-18 第三条分支：顶点色模型（自建的月牙石桌 `moon_table.glb`）。
                 * 它没有贴图、颜色全在 `COLOR_0` 里。走下面那条「暖白」分支的后果是实测过的：
                 * 冰蓝的桌面被 0.55 × 暖白自发光洗成**纯白一片**（`_logs/deskshot/desk_wide.png`
                 * 第一版就长这样），顶点色等于白做。这里给一点冷蓝、强度压到 0.3，
                 * 既能在月夜里抬起轮廓，又不盖掉本体颜色。 */
                s.emissive.setRGB(0.10, 0.22, 0.45);
                s.emissiveIntensity = 0.30;
                s.needsUpdate = true;
                continue;
            } else {
                // 暖白。同 `WingShipApi.tsx:156` 的冷白做法，这里偏暖 —— 书桌/信箱是暖色道具
                s.emissive.setRGB(0.72, 0.68, 0.58);
            }
            s.emissiveIntensity = EMIS;
            s.needsUpdate = true;
        }
    });
}

/** 拿模板（首次真加载，之后走 `CACHE`）。失败返回 `null`，**绝不抛**。 */
async function getAsset(url: string, sb: string[]): Promise<THREE.Group | null> {
    if (url in CACHE) return CACHE[url];
    try {
        const gltf = await new GLTFLoader().loadAsync(url);
        prepMaterials(gltf.scene);
        CACHE[url] = gltf.scene;
        sb.push(`[desk-props] 载入 ${url}`);
    } catch (e) {
        CACHE[url] = null;
        sb.push(`[desk-props] !! 素材加载失败 ${url}: ${String(e)}`);
    }
    return CACHE[url];
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 单件道具的装配
 * ══════════════════════════════════════════════════════════════════════════ */

interface RingSpec {
    /** 环半径（米） */
    r: number;
    /** 共享材质。呼吸由组件里的 `useFrame` 写它的 `opacity` */
    mat: THREE.MeshBasicMaterial;
}

/**
 * 装一件道具：`落位 group` → `inner`（缩放 + 贴地）→ 模板副本，外加脚下那圈发光标识。
 *
 * `ring = null` ⇒ 不建发光环（椅子用，见 `buildChair`）。
 *
 * ⚠️ 缩放/贴地必须写在 `inner` 上，不能写在 `g` 上：`g` 的 position/rotation 是落位用的，
 *    两件事写在同一个对象上，以后谁改一边都会把另一边带歪（同 `WingShipApi.tsx:37`）。
 *
 * 加载失败时**不抛**，只 `console.warn` 并返回一个空 group —— 玩家仍然能走到点位按 F，
 * 场景不会因为一件道具挂掉整块黑屏。
 */
async function buildOne(
    url: string,
    scale: number,
    xz: [number, number],
    yaw: number,
    ring: RingSpec | null,
    geo: THREE.BufferGeometry,
    sb: string[],
): Promise<THREE.Group> {
    const g = new THREE.Group();
    const [x, z] = xz;
    // 高度必须现取：会场中心 `worldHeightCPU` 恒为 0，但这两件在 r≈8 m 的外圈，
    // 写死 y = 0 会浮空或埋进土里（同 `CollectProps.tsx:751` 的理由）
    g.position.set(x, worldHeightCPU(x, z) + LIFT, z);
    g.rotation.y = yaw;

    const tpl = await getAsset(url, sb);
    if (tpl) {
        const inner = new THREE.Group();
        inner.add(tpl.clone(true));
        inner.scale.setScalar(scale);
        inner.updateMatrixWorld(true);
        // 用一次 bbox 量出最低点再下移，让底面落在 group 原点上。
        // ★ 不要写死：书桌得 +0.000、信箱得 +0.000，但两者的**原始**坐标轴完全不一样
        //   （信箱的 mesh 挂在 −90° 绕 X 的节点下，肉眼读 glTF JSON 极易把 y 轴认错）
        const box = new THREE.Box3().setFromObject(inner);
        inner.position.y = -box.min.y;
        g.add(inner);

        const s = box.getSize(new THREE.Vector3());
        sb.push(
            `[desk-props] ${url} 高度 1.000 × ${scale.toFixed(3)}`
            + ` ⇒ ${s.x.toFixed(3)} × ${s.y.toFixed(3)} × ${s.z.toFixed(3)} m`
            + `，落位 (${x}, ${g.position.y.toFixed(3)}, ${z}) yaw=${yaw.toFixed(3)}`,
        );
    } else {
        console.warn(`[desk-props] ${url} 没能加载，本件道具只保留脚下的发光标识`);
    }

    if (GLOW_ON && ring) {
        const m = new THREE.Mesh(geo, ring.mat);
        m.rotation.x = -Math.PI / 2;   // RingGeometry 默认躺在 XY 平面，转平才贴地
        m.scale.setScalar(ring.r);     // 几何是「内 0.86 / 外 1」的单位环，靠缩放定半径
        m.position.y = RING_LIFT;      // 相对 `g`（原点已在地面）⇒ 绝对高度 = 地面 + 1.2 cm
        m.name = `guide-ring-${ring.r}`;
        g.add(m);
    }
    return g;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3b. 桌面陈设（写邀请函的书桌总得摊点东西在上面）
 *
 * 为什么要有这一节：光换模型只能解决「没颜色」，解决不了「简陋」——
 * 一张空桌子摆在月夜里，不管木纹多清楚，看过去还是「一张空桌子」。
 * 用户 m05737 的原话是「过于简陋且没有颜色」，两半都要接。
 *
 * 素材复用宴会那批（`public/venue/props/*.glb`，Poly Haven CC0，都已 `--normalize --ground`）：
 * **高度归一化到 1.0** ⇒ `h` 这个字段直接就是米。四件例外（`teaset_01` 等）不在本表里。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 一件桌面陈设。坐标是**书桌局部系**（原点在桌面中心正下方的地面，y 向上）。 */
interface DeskItem {
    /** `/venue/props/<key>.glb` */
    key: string;
    /** 真实高度（米）。GLB 高度已归一化到 1 ⇒ 这个值就是 scale。 */
    h: number;
    x: number;
    z: number;
    /** 绕 Y 的朝向（弧度）。缺省 0。 */
    rot?: number;
}

/**
 * 桌面陈设表。
 *
 * ★ 2026-10-18（用户 m00863 任务6）换成自建月牙石桌后**重新排了一遍**：
 *   新桌面实尺 1.55 × 0.92 m（半宽 0.775 / 半深 0.46），比原来那张 `desk_n17`
 *   （2.459 × 0.898）窄了 0.9 m，原来 ±1.10 的横坐标会直接悬空到桌外。
 *
 *   还有一条**几何约束**：这张桌子的「月牙咬口」在局部 **−Z**（`_tools/moon-table-build.py`
 *   的 `--bite-off`），也就是**背对玩家**那一侧 —— 所以陈设只能摆在 z ≥ −0.10 这半边，
 *   摆到 z < −0.2 就会悬在咬口的空气里。
 *
 * 布局意图：左簇是烛台 + 小碟（夜色里唯一的光）、右簇是墨水瓶 + 羽毛笔、
 * 中间偏右摊开信纸与压纸信封。**刻意留出中间一大片空** —— 玩家按 F 写的就是那里。
 */
const DESK_ITEMS: DeskItem[] = [
    // ★ 2026-10-18：月牙石的**平整写字面只有中间约 0.48 m 宽**（凹口两侧就开始上翘），
    //   而信纸已经吃到 0.46 m —— 所以三件道具全部挪到两侧的斜面上，谁都不许压纸。
    { key: 'candle_brass', h: 0.20, x: -0.34, z: 0.02, rot: 0.3 },
    { key: 'jug_clay', h: 0.085, x: 0.31, z: -0.10, rot: -0.5 },
    { key: 'plate_carved', h: 0.016, x: -0.27, z: -0.14, rot: 1.1 },
];

/** 信纸尺寸（米）。A4 是 0.297×0.210，这里略小一点更像信笺。 */
// 2026-10-18：书桌换成 1.74× 放大的月牙石（凹口内宽约 1.1 m），原来 0.28×0.20 的信纸
// 在碗里小得像张邮票 —— 换成接近 A3 的 0.46×0.32，也是「写邀请函」该有的纸。
const PAPER_W = 0.46;
const PAPER_D = 0.32;
/** 信纸离桌面的厚度（米）。用 Box 而不是 Plane —— Plane 没有厚度，斜看会穿帮。 */
const PAPER_T = 0.0025;

/** 给程序化建的物件套上同款材质处理（同 `prepMaterials`，只是这些没有贴图）。 */
function tintMaterial(m: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    m.emissive.copy(m.color);
    m.emissiveIntensity = EMIS;
    m.roughness = 0.85;
    m.metalness = 0.0;
    return m;
}

/**
 * 建桌面陈设。返回一个 group，**调用方负责挂到书桌的落位 group 上**
 * （挂上去就自动跟着 `yaw` 转，不用在这里再算一遍朝向）。
 *
 * `scale` = 书桌真实高度（m），也就是桌面的 y —— 因为桌 GLB 的底面贴在 y=0。
 */
async function buildDeskTop(scale: number, sb: string[]): Promise<THREE.Group> {
    const top = new THREE.Group();
    top.name = 'desk-top';
    const y = scale + 0.001;   // 抬 1 mm：与桌面共面会 z-fighting 闪

    // ① GLB 陈设：并行加载，一件失败不影响其余（`getAsset` 内部吞异常返 null）
    const loaded = await Promise.all(DESK_ITEMS.map((it) => getAsset(`/venue/props/${it.key}.glb`, sb)));
    loaded.forEach((tpl, i) => {
        const it = DESK_ITEMS[i];
        if (!tpl) return;
        const holder = new THREE.Group();
        holder.position.set(it.x, y, it.z);
        holder.rotation.y = it.rot ?? 0;
        const inner = tpl.clone(true);
        inner.scale.setScalar(it.h);
        holder.add(inner);
        top.add(holder);
    });

    /* ② 摊开的信纸。这是「写邀请函」这个动作的视觉锚点 ——
     *    没有它，玩家走到桌前按 F 时画面里没有任何「正在写信」的暗示。
     *    颜色取 UI 信纸那套米白（`LetterPaper.tsx` 的纸底色），让 3D 与 UI 对得上。 */
    const paperMat = tintMaterial(new THREE.MeshStandardMaterial({ color: 0xe8dcc0 }));
    const paper = new THREE.Mesh(new THREE.BoxGeometry(PAPER_W, PAPER_T, PAPER_D), paperMat);
    // ★ 2026-10-18 月牙石桌：信纸摆在桌面正中偏玩家侧（局部 +Z），且往 −X 让出右边给墨水瓶
    paper.position.set(-0.03, y + PAPER_T / 2, 0.08);
    paper.rotation.y = 0.16;       // 略微歪一点，比工工整整更像有人刚写过
    paper.name = 'desk-paper';
    top.add(paper);

    /* ③ 压纸的信封（就是玩家要写 11 封的那种）。做出「已经写好一封了」的暗示。 */
    const envMat = tintMaterial(new THREE.MeshStandardMaterial({ color: 0xdcc9a4 }));
    const env = new THREE.Mesh(new THREE.BoxGeometry(0.155, 0.004, 0.105), envMat);
    env.position.set(0.02, y + 0.006, -0.17);
    env.rotation.y = -0.42;
    env.name = 'desk-envelope';
    top.add(env);

    /* ④ 羽毛笔：细杆斜插在墨水瓶里（笔尖朝下、泡在瓶中，所以**不做**笔尖）。
     *
     *    用程序化几何而不是找素材 —— 一根杆子就够了，而且笔的**指向**得跟着桌面走。
     *
     *    ⚠️ 这里刻意不做笔尖。第一版做了，位置写死在 `(0.278, y+0.028, -0.128)`，
     *       而笔杆底端实际在 `(0.279, y+0.002, -0.176)`（= 中心 − 半长 × 轴向）——
     *       差了 2.6 cm 高、4.8 cm 远，等于在墨水瓶边上悬了个锥体。
     *       真实羽毛笔插在瓶里时笔尖本来就看不见，做它只会错。 */
    const penMat = tintMaterial(new THREE.MeshStandardMaterial({ color: 0xd8cbb0 }));
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0032, 0.0045, 0.16, 6), penMat);
    // 笔杆底端落在墨水瓶（`jug_clay`，见 `DESK_ITEMS`）的瓶口里 ⇒ x/z 必须跟着它一起改
    shaft.position.set(0.31, y + 0.075, -0.10);
    shaft.rotation.set(0.34, 0, -0.26);   // 往墨水瓶里倾
    shaft.name = 'desk-pen';
    top.add(shaft);

    sb.push(
        `[desk-props] 桌面陈设 ${DESK_ITEMS.length} 件 GLB + 信纸/信封/羽毛笔，桌面高 ${scale.toFixed(3)} m`,
    );
    return top;
}

/** 探针：无头截图脚本 `_tools/webgpu-shot.mjs --eval` 可读 `window.__deskProps()`（同 `CollectProps.tsx:817`）。 */
let LAST_STATS: Record<string, unknown> = {};
if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__deskProps = () => LAST_STATS;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 组件
 * ══════════════════════════════════════════════════════════════════════════ */

export function DeskProps(
    { visible = true, mailboxVisible = true }: { visible?: boolean; mailboxVisible?: boolean },
): JSX.Element | null {
    const deskRef = useRef<THREE.Group>(null);
    const mbRef = useRef<THREE.Group>(null);

    /* 几何/材质用 `useMemo` 缓存：每次 render 新建会反复在 GPU 上申请 buffer，
     * 而这两份东西整个 app 生命周期都在场上（同 `WingShipApi.tsx:199` 的理由），
     * 所以**不要**在 effect 的清理里 dispose。 */
    const ringGeo = useMemo(() => new THREE.RingGeometry(0.86, 1, 24, 1), []);
    // 指引环必须「不吃光照、一直亮」⇒ MeshBasicMaterial，不能换成 StandardMaterial
    const deskRingMat = useMemo(() => new THREE.MeshBasicMaterial({
        color: RING_COLOR_DESK, transparent: true, opacity: RING_BASE_OP,
        side: THREE.DoubleSide, depthWrite: false,
    }), []);
    const mbRingMat = useMemo(() => new THREE.MeshBasicMaterial({
        color: RING_COLOR_MB, transparent: true, opacity: RING_BASE_OP,
        side: THREE.DoubleSide, depthWrite: false,
    }), []);

    useEffect(() => {
        if (!DESK_ON) return;
        const deskRoot = deskRef.current;
        const mbRoot = mbRef.current;
        if (!deskRoot || !mbRoot) return;

        let dead = false;
        const sb: string[] = [];
        // 两件并行加载：串行会把首屏多拖一个 RTT（GLB 都在 public 下，vite 直接供）
        Promise.all([
            buildOne(DESK_URL, DESK_SCALE, DESK_XZ, DESK_YAW, { r: RING_DESK_R, mat: deskRingMat }, ringGeo, sb),
            buildOne(MB_URL, MB_SCALE, MAILBOX_XZ, MAILBOX_YAW, { r: RING_MB_R, mat: mbRingMat }, ringGeo, sb),
        ]).then(async ([desk, mailbox]) => {
            if (dead) return;
            /* 桌面陈设挂到 `desk` **里面**，不是挂到 `deskRoot` 上 ——
             * `desk` 已经带着落位（位置 + yaw），挂进去就自动跟着转，
             * 挂外面就得自己重算一遍同样的平移旋转（那是重复真值，早晚会不同步）。
             * ⚠️ 必须 await 完再 add：`desk` 是空 group 时也能 add，但加载是异步的，
             *    提前 add 会让先建好的陈设先出现、桌面后出现，闪一下。 */
            /* ⚠️ 传 `DESK_H`（桌面高度）而不是 `DESK_SCALE`（缩放系数）：陈设要摆在月牙凹槽底，
   * 不是摆在「模型高度 × 缩放」上。两者的数值今天恰好都是 1 附近，混用不会当场报错，
   * 但模型一换就全错位。 */
  const top = await buildDeskTop(DESK_H, sb);
            if (dead) return;
            desk.add(top);
            deskRoot.add(desk);
            mbRoot.add(mailbox);
            /* 桌面陈设的件数单独报出来 —— 「换了书桌但陈设没挂上」这种半成品
             * 在截图里跟「完全没做」长得一模一样（`0.11.5` 记过同类坑）。
             * 用 `top.children.length` 而不是遍历名字：`desk-top` 的直接子节点
             * 就是「3 件 GLB 落位 group + 信纸 + 信封 + 笔 + 笔尖」7 个，不含 GLB 私有层级。 */
            LAST_STATS = {
                deskScale: DESK_SCALE, mbScale: MB_SCALE, glow: GLOW_ON,
                deskTop: top.children.length,
                log: sb,
            };
            if (DEBUG) for (const s of sb) console.info(s);
        }).catch((e) => {
            // `buildOne` 内部已经把加载失败吞成空 group，能走到这里说明是别的意外
            console.warn('[desk-props] 构建失败:', e);
        });
        // ⚠️ 清理里**不能** dispose 几何/材质/GLB：React 19 StrictMode 会跑
        //    「挂载 → 清理 → 再挂载」，提前释放会让还在场景里的对象提交空的 GPU buffer
        //    （`WingShipApi.tsx:199` 记的是同一个坑）。
        return () => { dead = true; };
    }, [ringGeo, deskRingMat, mbRingMat]);

    useFrame((state) => {
        // 呼吸：只写这两份**共享材质**的 opacity，每帧 2 次属性写入，不遍历场景
        // （同 `CollectProps.tsx:801` 的做法）。用 BasicMaterial + 手动呼吸，而不是挂点光源 ——
        // 月夜场景的光源预算很紧，路标不值得占一个灯。
        if (!DESK_ON || !GLOW_ON) return;
        const o = RING_BASE_OP + RING_AMP * Math.sin(state.clock.elapsedTime * RING_SPEED);
        deskRingMat.opacity = o;
        mbRingMat.opacity = o;
    });

    if (!DESK_ON) return null;
    return (
        <group visible={visible}>
            {/* 书桌：一直在场，**不受** `mailboxVisible` 影响 */}
            <group ref={deskRef} />
            {/* 信箱：写完 11 封邀请函才出现 ⇒ 由 `mailboxVisible` 单独控。
                ⚠️ 只是 `visible=false`，GLB 照常加载 —— 切回来时零等待，
                   也不会因为反复挂卸把 `CACHE` 里的模板搞脏。 */}
            <group ref={mbRef} visible={mailboxVisible} />
        </group>
    );
}
