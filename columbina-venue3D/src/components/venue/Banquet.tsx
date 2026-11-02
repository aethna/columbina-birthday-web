/**
 * Banquet.tsx —— 会场中央的「生日宴圆桌」（用户 m00002，2026-10-20 改圆桌）。
 *
 * 需求原话（task-12）：「改成圆桌（直径 3.2~3.6 m，16 人围坐），中央摆**大**蛋糕，
 *   大、豪华、多层、总高约 1.5~1.6 m（≈角色身高），保留烛火 emissive；桌上餐具食物
 *   要有宴会质感。主位顺序必须是「空 — 派蒙 — 荧 — 哥伦比娅 — 桑多涅」。」
 *
 * ★ 2026-10-23 第十轮（team round8-feast / t1）——用户原话：「切蛋糕场景，桌子扩大，
 *   人物坐的散开一些，太挤了。两个模型之间的距离控制在能再放一个模型。」
 *   直径 3.4 → **4.8**：座位圈 2.12 → 2.82 m，每席弧长 0.83 → **1.107 m**
 *   （人物模型最宽处约 0.55~0.6 m ⇒ 相邻两人之间还能再塞一个同尺寸模型，
 *   剩余净空约 0.107 m）。桌面陈设半径同乘 `FOOD_K = 4.8/3.4 = 1.412`，
 *   椅子/座次/主位索引语义全部不变（几何全由 `SEAT_R` 推出）。
 *
 * ── 素材来路 ────────────────────────────────────────────────────────────
 *   · 圆桌 `table_round.glb` —— Poly Haven **CC0**（原名 `round_wooden_table_01`，
 *     本地已在库，205 KB；归一化 1.393 × 1.000 × 1.393，单件含台面 + 中心柱脚）。
 *     旧的长桌 `table_banquet.glb`（火山方舟 Ark 图生 3D）**不再使用**，文件保留。
 *   · 大蛋糕 `Wedding_Cake_3tier_CCBY3.glb` —— **CC-BY 3.0**（三层婚礼蛋糕，
 *     1.927 × 1.967 × 1.490，minY = −0.955）。作者/来源见
 *     `public/venue/props/CREDITS-wedding-cake.md`。旧 `cake_moon.glb`（Ark 图生 3D）
 *     不再使用，文件保留。
 *   · 零食/饮料/果盘 —— Poly Haven CC0 的 20+ 件道具（`public/venue/props/*.glb`）。
 *
 * ── 为什么圆桌非得非等比缩放 ────────────────────────────────────────────
 *   `table_round.glb` 归一化后「直径 : 高 = 1.393 : 1」。要 ⌀4.8 m **且** 高 0.78 m
 *   只有分开缩：XZ × `TABLE_D / 1.393`、Y × `TABLE_H`。等比缩到 0.78 直径只剩
 *   1.09 m（16 人坐不下），等比缩到 ⌀4.8 则桌子高 3.45 m（荒谬）。
 *   代价：中心柱脚被横向拉宽约 4.4 倍（真实宴会长桌/圆桌本来就是粗柱脚）；
 *   台面厚度 0.083 × 0.78 = 0.065 m，仍属正常。
 *
 * ── 座次（16 席 = 环 16 位，主位那 1 席摆椅子但**空着**）─────────────────
 *   环位 `k = 0..15`，角度 `−90° + k·22.5°`（世界 xz 平面，`k=0` 在桌心正 −z 侧，
 *   正对哥伦比娅的站位 `CAKE_STAND_XZ = [0, −10]`）。座位圈半径 `TABLE_R + SEAT_D`
 *   = 2.82 m（周长 17.72 m ÷ 16 = **1.107 m/席**；改前 ⌀3.4 时是 2.12 m / 0.83 m）。
 *   `seatSpots()` 返回 16 席：前 15 个给 NPC（索引语义**刻意与长桌那版一致** ⇒
 *   `NpcCrowd.tsx` 的 `SEAT_ORDER` 不需要改），第 16 个（索引 15）是**主位 k=0**，
 *   只用来摆那把空椅子（哥伦比娅归 `MmdCharacter` 管、站在 (0,−10) 切蛋糕）。
 *
 * ── URL 开关（项目规矩：所有要 A/B 的量都得上 URL）────────────────────────
 *   ?banquet=0        整桌不加载
 *   ?bx= ?bz=         桌心世界坐标（米，缺省 0 / 0 —— 会场中心）
 *   ?byaw=<度>        桌子绕 Y 的朝向（缺省 0，长轴沿 X）
 *   ?bh=<m>           桌高（米，缺省 0.78）
 *   ?btabled=<m>      圆桌**直径**（米，缺省 4.8；第十轮从 3.4 放大）
 *   ?bfoodk=<k>       桌面陈设半径系数（缺省 `TABLE_D/3.4`，1 = 回到旧的固定半径）
 *   ?bcake=<m>        蛋糕真实**总高**（米，缺省 1.55；水平尺寸随之等比）
 *   ?bemis_cake=<k>   蛋糕自发光强度（**缺省 0 = 不自发光**，交给场景光照；第十轮 t3 从 0.26
 *                     改到 0。传 0.26 即回滚到旧观感。婚礼蛋糕无贴图、走 `emissive=color`）
 *   ?cakecool=1       **可逆配色开关**：把蛋糕材质 baseColor/emissive 乘 (0.90,0.93,1.00)
 *                     往月光冷白偏一档，压掉粉白婚礼配色与月夜冷调的冲突。
 *                     **缺省关**（0）⇒ 不传就是原来的粉白，加 `?cakecool=1` 才生效。
 *   ?bmoon=<n>        蛋糕**月亮装饰层**（缺省 1 = 开；第十轮 t4 重绘）。关闭 = 退回纯三层蛋糕。
 *                     组成：月面顶盖（几何环形山）+ 正面月牙托架 + 腰部 8 枚月相徽。
 *                     **完全不自发光**（明暗只来自场景光与凹陷法线），不受 `?bemis_cake` 影响。
 *   ?bmooncraters=<k> 环形山密度（缺省 1；0.5 稀 / 1.5 密），只调观感不换形态。
 *   ?bfood=0          只留桌子 + 蛋糕，不摆零食果盘（做 A/B 对照）
 *   ?bemis=<k>        道具自发光强度（缺省 0.34，与 `VenuePropsReal` 同源）
 *   ?bchair=<n>       给每席摆椅子（缺省 1 = 摆，与 `?npcpose=sit` 配套）
 *   ?bchairseat=<m>   **坐面高**（米，缺省 0.45）—— 椅子按这个量反推 scale，
 *                     不是按总高（旧 `?bchairh` 已废弃，见 `SEAT_H` 注释）
 *   ?bchairmix=0      椅子统一用同一款（缺省 1，但池里现在只有 1 款 ⇒ 等价）
 *   ?bchairback=<m>   椅子相对座位点朝桌心的位移（缺省 −0.12）
 *   ?bdebug=1         打印每件素材的加载/摆位明细
 *
 * ── 关于椅子（`public/venue/chairs/`，10 件 Poly Haven CC0）────────────────
 *   2026-10-14 用户 m01149 要求「找椅子模型和坐姿的素材，找出来先备用」。
 *   椅子已找齐并转好（见 `公用区\素材\椅子素材来源.md`）。
 *   ★ 2026-10-20 用户反馈（`公用区\10月20日反馈2.png`）：「椅子像很小的方凳、
 *     人坐得比椅面高、腿穿过椅面、部分悬空」⇒ 三个病根，全在 `SEAT_H` /
 *     `CHAIR_POOL` / 椅子脚地形 三处注释里写清了改法与理由。
 *
 * ── 坑（从 `VenuePropsReal.tsx` 抄来的，别再踩）───────────────────────────
 *   ① `GLTFLoader` 里 `material.color` 是 `baseColorFactor`（白），颜色全在
 *      贴图上 ⇒ **不能** `m.emissive = m.color * 0.14`（会给道具糊一层与贴图
 *      无关的平铺灰）。正确做法是 `m.emissiveMap = m.map` + `emissive` 置白。
 *   ② `MeshStandardNodeMaterial` **没有 `normalScale`**，写 `.copy()` 抛
 *      TypeError 且会被 try/catch 静默吞掉。
 *   ③ GLB 一律「高度 = 1、底面 y = 0、水平居中」⇒ `scale.setScalar(h)` 里的
 *      `h` 直接就是**真实高度（米）**，不用再乘任何系数。
 */

import * as THREE from 'three';
import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { QNUM, QSTR } from '../../core/utils/query';
import { hash01 } from '../../core/venueRing';
import { BANQUET_XZ } from '../../core/game/layout';
import { worldHeightCPU } from '../../core/worldRegions';

/* ════════════════════════════════════════════════════════════════════════════
 * 1. URL 开关与几何常量
 *
 *    这些常量**导出**给 `NpcCrowd.tsx` 用（`?npclayout=table` 的座次必须和
 *    桌子实际尺寸严格一致，两边各写一份迟早对不上）。
 * ════════════════════════════════════════════════════════════════════════════ */
export const BANQUET_ON = QNUM('banquet', 1)! > 0;
export const BANQUET_X = QNUM('bx', 0)!;
/* ★ 2026-10-23 第十轮（dev-sleeve / t7 构建时发现）：下面这些常量在 246/326 等行被
 *   引用，但全文件**没有一处定义** —— `vite build` 不报错（esbuild 不做跨文件自由变量
 *   检查，`BANQUET_YAW is not defined` 只在浏览器运行时报），于是整个页面在挂
 *   `__mmd` 之前就抛错、白屏。改成「从唯一真值推导」：
 *   `BANQUET_XZ` 与 `CAKE_STAND_XZ` 都在 `core/game/layout.ts`，长桌朝向是 90°。 */
export const BANQUET_Z = BANQUET_XZ[1];
export const BANQUET_YAW = 0.5 * Math.PI;

/** 桌高（米）。真实餐桌 0.75~0.78，取 0.78。 */
export const TABLE_H = QNUM('bh', 0.78)!;
/** ★ 圆桌直径（米）。
 *
 *  ★ 2026-10-23 第十轮（用户原话「桌子扩大，人物坐的散开一些，太挤了。
 *     两个模型之间的距离控制在能再放一个模型」）：
 *      改前 ⌀3.4 ⇒ `TABLE_R = 1.70`、`SEAT_R = 2.12`、16 席每席弧长 **0.83 m**；
 *      改后 ⌀4.8 ⇒ `TABLE_R = 2.40`、`SEAT_R = 2.82`、16 席每席弧长 **1.107 m**。
 *    为什么是 4.8 而不是更大：人物模型（裙摆最宽处）约 0.55~0.6 m 宽，
 *    「间距里还能再放一个」⇒ 每席弧长要 ≥ 2 × 0.6 = 1.2 m 才宽松、≥ 1.1 m 才够塞。
 *    ⌀ 每 +1 m ⇒ 弧长 +0.196 m（`π·Δ⌀/16`），⌀4.8 已是**能塞下 + 椅子不超出
 *    `HUB_CLEAR = 9.5` 中央空地**的折中；再大就得同步动 `NpcCrowd` 的坐姿前移量。
 *   ⚠️ 桌面半径 2.40 m 也把桌面陈设的半径档位整体放大 1.412 倍（见 `FOOD_K`），
 *      否则餐盘会全部缩到桌心、离桌沿空出一大圈。 */
export const TABLE_D = QNUM('btabled', 4.8)!;
export const TABLE_R = TABLE_D / 2;
/** 桌面陈设半径的**基准直径**（陈设 `LAYOUT` 里的 `onTable(r, …)` 半径都是按 ⌀3.4 写的）。
 *  改 `TABLE_D` 时陈设半径按 `TABLE_D / TABLE_FOOD_D` 等比跟随，保证「餐盘离桌沿
 *  0.14 m」这类相对关系不变。要回到旧的固定半径：`?bfoodk=1`。 */
const TABLE_FOOD_D = 3.4;
const FOOD_K = QNUM('bfoodk', TABLE_D / TABLE_FOOD_D)!;
/** 陈设极坐标半径 → 实际半径（米）。`onTable()` 内部对每个 `r` 都过这一层，
 *  这样「餐盘离桌沿 0.14 m」「内圈从蛋糕外 0.95 m 起」这些相对关系与 `TABLE_D` 解耦。 */
const R_TABLE = (r: number) => r * FOOD_K;
/** 圆桌素材归一化后的直径（`_tools/glb_bbox.py` 实测 `table_round.glb`）。 */
const TABLE_GLB_D = 1.393;

/** 蛋糕**总高**（米）。需求「约等于角色身高」（NPC 1.52~2.10 m）⇒ 1.55。
 *  模型原始 bbox 1.927 × 1.967 × 1.490 ⇒ 等比缩放 `s = CAKE_H / 1.967`，
 *  缩完水平约 1.52 × 1.17 m、占 ⌀3.4 桌面 45%（这就是「豪华大蛋糕」的分量）。 */
const CAKE_H = QNUM('bcake', 1.55)!;
/** 摆不摆零食/饮料/果盘。 */
const FOOD_ON = QNUM('bfood', 1)! > 0;
/** 道具自发光强度（会场夜里全靠它把道具从雾里拉出来）。 */
const EMIS = QNUM('bemis', 0.34)!;
/** 蛋糕自发光强度。旧月亮蛋糕靠它「自己在发光」（缺省曾是 0.55）；换成
 *  纯色材质的三层婚礼蛋糕后 0.55 会把奶油糊成一片死白 ⇒ 先降到 0.26。
 *
 *  ★ 2026-10-23 第十轮（team round8-feast / t3）—— 用户原话「蛋糕似乎在自发光，去掉」。
 *    婚礼蛋糕**没有贴图**，`prepMaterials()` 走的是 `emissive.copy(color)` 这条分支
 *    （见 :438-440）⇒ emissive 就是整块材质的颜色本身，任何 >0 的强度都会把蛋糕
 *    从场景光照里「拔出来」、自亮成一块平涂。缺省改成 **0**（完全交给受光）：
 *    蛋糕的明暗从此只由方向光/环境光与法线决定，才有正常的渐变与投影。
 *    **回滚**：`?bemis_cake=0.26`（旧的量）或任意值即可恢复自发光，代码不用改。
 *    烛火不受影响 —— 由 `candle_*` 道具承担（摆位时单独加倍，见 §③）。 */
const CAKE_EMIS = QNUM('bemis_cake', 0)!;
/** 可逆配色开关（`?cakecool=1`）：把蛋糕材质的 baseColor 与 emissive 同乘
 *  `(0.90, 0.93, 1.00)`，往月光冷白偏一档。**缺省关**，粉色婚礼配色原样保留；
 *  用户嫌粉时只加 URL 参数即可，不用改代码。乘的是同一个因子、且不碰贴图，
 *  所以随时能切回去（A/B 图见 `_logs/t12/cakecool_*.png`）。 */
const CAKE_COOL = QNUM('cakecool', 0)! > 0;
const CAKE_COOL_TINT = new THREE.Color(0.9, 0.93, 1.0);
const DEBUG = QNUM('bdebug', 0)! > 0;

/* ── 椅子（`public/venue/chairs/`，10 件 Poly Haven CC0）──────────────────
 * ★ 缺省 = 1（摆）。`NpcCrowd` 的 `?npcpose` 缺省已改成 `sit`，
 *   两边配套：坐下却没椅子会穿帮（人悬在半空）。
 *   要回看「站着围桌」的老样子：`?bchair=0&npcpose=stand`。 */
const CHAIR_ON = QNUM('bchair', 1)! > 0;
const CHAIR_MIX = QNUM('bchairmix', 1)! > 0;
/** **目标坐面高（米，离椅子脚底）**。这是椅子唯一该被对齐的量。
 *
 *  为什么改：旧代码用 `CHAIR_H`（椅子**总高**）统一缩放，可 6 款椅子的
 *  「坐面高 / 总高」差了整整一倍（`stool_painted` 0.994、`chair_armchair`
 *  0.419），同一个总高下凳子座面 0.92 m、餐椅座面 0.43 m ⇒ 用户 m00001 的
 *  反馈图（`公用区\10月20日反馈2.png`）里「椅子像很小的方凳、人大腿穿过椅面」。
 *
 *  0.45 m 的来源：`座る.vmd` 的坐姿是**烘死**的（`NpcCrowd.tsx` 只把脚贴地，
 *  没有座高参数），实测 15 席坐姿 `センター` 离脚底中位数 ≈ 0.42 m，
 *  髋关节到臀部下缘还有 3~5 cm ⇒ 坐面取 0.45 让臀「微陷」进椅面，
 *  既不悬空也不穿帮。真实餐椅坐面高也是 0.44~0.46。 */
const SEAT_H = QNUM('bchairseat', 0.45)!;
/** 椅子相对座位点的**前后挪动**（米）。座位点是「**站**在桌边的人」的位置 *  （离桌沿 `SEAT_D = 0.42`），而**坐**着的人躯干会比站着更靠近桌沿 ——
 *  所以椅子要**朝桌心挪**一点，不能照着站位摆（照站位摆会离桌沿 0.6 m，
 *  俯拍一看椅子全飘在桌外，`_logs/banquet/_chair_top_zoom.jpg` 就是这个症状）。
 *  负值 = 朝桌心。实测椅子 `chair_painted_01` 归一化深度 0.564、坐面在 +Z 侧
 *  ⇒ 坐面高 0.45 m 时（`scale ≈ 0.96`）前缘在椅心 +0.27 m。取 −0.12 ⇒
 *  椅心离桌沿 0.30 m、**前缘离桌沿 0.03 m**（基本贴住桌沿），是真实宴会的样子。 */
const CHAIR_BACK = QNUM('bchairback', -0.12)!;
const CHAIR_DIR = '/venue/chairs';
/** 椅子池。★ 2026-10-20 用户反馈后**收敛为单一款**：
 *  旧池 6 款里 3 款是矮凳（`stool_chinese / stool_painted / stool_wood_01`），
 *  按总高 0.92 m 缩放后座面高达 0.68~0.92 m（比坐姿臀部还高）⇒ 人像陷在凳子里，
 *  就是反馈图里「很小的方凳」。混搭还会让同一张桌的椅子大小不一。
 *  `chair_wooden_01` 是 2.27 m 高背宝座（归一化后水平只剩 0.30 m）⇒ 也排除。
 *  留 `chair_painted_01`：白漆木餐椅，与书桌那套已验收的
 *  `CHAIR_KEY = chair_painted_01` 同款，坐面比例也最接近真实餐椅（0.469）。 */
const CHAIR_POOL = ['chair_painted_01'];
/** 各款「坐面高 / 总高」实测比例（`_tools/chair_seat.py` 第三版算法：
 *  只统计法线朝上、面积最大的 y 分桶 ⇒ 权威）。留着给以后换款/混搭用。 */
const CHAIR_SEAT: Record<string, number> = {
    chair_painted_01: 0.469,
    chair_dining_02: 0.456,
    chair_armchair: 0.419,
    stool_chinese: 0.994,
    stool_painted: 0.994,
    stool_wood_01: 0.981,
    bench_painted: 0.742,
    stool_folding: 0.622,
};
/** 面朝补偿角（弧度）—— `_tools/chair_face.py` 实测值。缺省 0（已朝 +Z）。 */
const CHAIR_YAW_FIX: Record<string, number> = {
    chair_painted_02: -Math.PI / 2,
};

/* ════════════════════════════════════════════════════════════════════════════
 * 2. 素材表
 * ════════════════════════════════════════════════════════════════════════════ */
const P = '/venue/props';
/** 圆桌本体：Poly Haven CC0（原名 `round_wooden_table_01`，本地库里已有）。 */
const TABLE_URL = `${P}/table_round.glb`;
/** 三层婚礼蛋糕，**CC-BY 3.0**（署名见 `public/venue/props/CREDITS-wedding-cake.md`）。 */
const CAKE_URL = `${P}/Wedding_Cake_3tier_CCBY3.glb`;
/** ★ 2026-10-23 第十轮 t4（用户原话「蛋糕形态重绘，要月亮元素的」）。
 *
 *  为什么不是直接换回旧的 `cake_moon.glb`：那个 Ark 图生 3D 件是**单件 2.8 万面、
 *  1×1×0.94 m 的整块烘焙体**，换上去等于放弃「三层蛋糕」的造型，而且图生 3D 的
 *  细节在 1.55 m 尺度下是糊的。用户要的是**重绘**：保留蛋糕本体，把月亮做成
 *  **叠在上面的装饰层**。所以这里用程序化几何造一层「月球面」——
 *  `public/` 里不新增任何资源（避免动 asset 账本），也不吃 `?bemis_cake` 旋钮
 *  （这层**从不自发光**，明暗全来自场景光和环形山法线，符合 t3 的验收口径）。
 *
 *  三处月亮元素（缺省全开，`?bmoon=0` 一键回滚成原来的纯蛋糕）：
 *   ① **月面顶盖**：最上一层的顶面铺一层环形山半球（半径 `CAKE_MOON_R` = 蛋糕水平
 *      半径），环形山是**真实的几何凹陷**，不是贴图 ⇒ 任何机位都有明暗与轮廓；
 *   ② **月牙托架**：蛋糕正面（朝向主位/镜头的那一侧）立一枚浅色月牙，靠形状本身
 *      可辨，不依赖发光；
 *   ③ **月相环带**：中层腰部一圈 8 个「铭牌」形小徽，月相按真实盈亏顺序由缺到圆。
 *  全部跟着 `CAKE_H` 的缩放 `s` 走 ⇒ `?bcake` 仍只有一个总高旋钮。 */
const MOON_ON = QNUM('bmoon', 1)! > 0;
/** 环形山密度（0.5 = 稀、1.5 = 密）。`?bmooncraters=<k>`，只调观感不换形态。 */
const MOON_CRATERS = QNUM('bmooncraters', 1)!;

/** 桌面陈设。坐标是**桌面局部系**（米）：原点 = 桌心、y 起点 = 桌面高度 `TABLE_H`，
 *  最后由 `toWorld()` 绕桌心转 `BANQUET_YAW`。圆桌上一律用 `onTable(r, deg)`
 *  取点，不手写直角坐标（50 件陈设手写既没法保证正圆、也没法跟座次对齐）。
 *  `mirror !== false` 时同一件会镜像到 −z（长桌时代的遗留，圆桌版一律显式 `false`）。 */
interface PropInst {
    key: string;
    x: number;
    z: number;
    /** **期望的真实高度（米）**。`scale = h / NORM_H[key]`，见下面的表。 */
    h: number;
    /** 绕 Y 的朝向（弧度）。缺省用 `hash01` 给一个确定性的随机角。 */
    rot?: number;
    /** `false` = 只摆 +z 这一份（缺省镜像到 ±z 两份）。 */
    mirror?: boolean;
}

/**
 * ⚠️ 归一化例外表（`_tools/glbbox.py` 实测）。
 *
 * `ph-blender.py --normalize --ground` 名义上把每件缩成「高 = 1.0、底面 y = 0」，
 * 但有四件没做到 1.000。**不修正的话篮子会高 28% 顶到蛋糕**（1.283 倍）。
 * 单位：归一化后的实际高度（sizeY）。
 */
const NORM_H: Record<string, number> = {
    basket_wicker_02: 1.283,
    fruit_pear: 0.979,
    teaset_01: 0.992,
    goblets_brass: 0.997,
};
const nh = (key: string) => NORM_H[key] ?? 1;

const D2R = Math.PI / 180;

/** 第 k 个**环位**的角度（度）—— 与 `seatSpots()` 同一套：`k = 0` 在主位
 *  （桌心正 −z 侧，正对哥伦比娅站位），每席 +22.5°，k 增大朝主位**左手边**
 *  （世界 +x）。16 个环位刚好围一圈。 */
const SEAT_DEG = (k: number) => -90 + k * 22.5;

/** 桌上极坐标 → **局部系** x/z（再交给 `toWorld()`）。`r` 米、`deg` 度。
 *  ⚠️ `r` 是**基准半径**（按 ⌀3.4 桌面写的那套数字），实际半径一律经 `R_TABLE()`
 *  乘 `FOOD_K` —— 桌子放大后陈设跟着按比例外扩，不手改下面每一个数字。 */
function onTable(r: number, deg: number): { x: number; z: number } {
    const t = deg * D2R;
    const dx = Math.cos(t), dz = Math.sin(t);            // 世界系里的单位方向
    const c = Math.cos(BANQUET_YAW), s = Math.sin(BANQUET_YAW);
    const rr = R_TABLE(r);
    /* `toWorld` 是 x = lx·c + lz·s、z = −lx·s + lz·c ⇒ 这里用它的逆变换。 */
    return { x: rr * (dx * c - dz * s), z: rr * (dx * s + dz * c) };
}

/* 布局思路（圆桌）：① 每席面前一副餐具；② 桌心一圈共用菜（酒、壶、茶具、点心）；
 * ③ 蛋糕外侧 4 支蜡烛；④ 两处果盘。半径依据（**基准 ⌀3.4 那套，经 `R_TABLE` 缩放**）：
 * 蛋糕水平半宽 ≈ 0.76 m ⇒ 内圈从 r = 0.95 起；桌面半径 1.70 m ⇒ 餐盘 1.42、
 * 酒杯 1.56（离桌沿 0.14 m）。⌀4.8 时它们变成 2.006 / 2.203（离桌沿仍是 0.197 m，
 * 因为 `TABLE_D` 与 `FOOD_K` 同乘 1.412 ⇒ 所有相对间距按同一比例放大）。
 * 所有 `h` 都是**实物高度（米）**，`scale = h / nh(key)`。 */
const LAYOUT: PropInst[] = [];

/* ① 每席一副：16 席 ×（雕花木盘 + 黄铜高脚杯）。杯略偏右手边 +5.6°，不与盘叠。 */
for (let k = 0; k < 16; k++) {
    const d = SEAT_DEG(k);
    LAYOUT.push({ key: 'plate_carved', ...onTable(1.42, d), h: 0.045, mirror: false });
    LAYOUT.push({ key: 'goblets_brass', ...onTable(1.56, d + 5.6), h: 0.22, mirror: false });
}

/* ② 蛋糕外侧 4 支蜡烛（45° 间隔，正好落在两席之间，且避开 r=0.76 的蛋糕）。
 *  用 `candle_brass` 而不是 `candle_wood`：后者是**单材质**木质烛台（火苗和木头
 *   在同一张贴图里），`EMIS × 2.4` 只会把整根木头按贴图点亮、夜里读不出火光；
 *   `candle_brass` 有独立的 `brass_candleholders_flame` 材质（BLEND + 4 张贴图、
 *   3 处火苗网格）⇒ 自发光只落在火苗上，才是真正的烛光。 */
for (const d of [45, 135, 225, 315]) {
    LAYOUT.push({ key: 'candle_brass', ...onTable(0.98, d), h: 0.24, mirror: false });
}

/* ③ 桌心一圈共用菜：夹在 16 席之间（`SEAT_DEG(k + 0.5)` 这类半格角度），
 *  r 1.00~1.22 ⇒ 既压不到餐盘（1.42）、也不挤蛋糕（≤0.76）。 */
LAYOUT.push(
    { key: 'bottles_wine', ...onTable(1.04, SEAT_DEG(0.5)), h: 0.32, mirror: false },
    { key: 'bottles_wine', ...onTable(1.04, SEAT_DEG(8.5)), h: 0.32, mirror: false },
    { key: 'jug_metal', ...onTable(1.06, SEAT_DEG(4.5)), h: 0.28, mirror: false },
    { key: 'jug_clay', ...onTable(1.06, SEAT_DEG(12.5)), h: 0.26, mirror: false },
    { key: 'teaset_01', ...onTable(1.12, SEAT_DEG(15.5)), h: 0.21, mirror: false },
    { key: 'teaset_01', ...onTable(1.12, SEAT_DEG(1.5)), h: 0.21, mirror: false },
    { key: 'basket_wicker_02', ...onTable(1.20, SEAT_DEG(6.5)), h: 0.26, mirror: false },
    { key: 'snack_croissant', ...onTable(1.10, SEAT_DEG(6.0)), h: 0.08, mirror: false },
    { key: 'cake_strawberry', ...onTable(1.16, SEAT_DEG(2.5)), h: 0.12, mirror: false },
    { key: 'cake_carrot', ...onTable(1.16, SEAT_DEG(10.5)), h: 0.10, mirror: false },
    { key: 'bowl_wood_02', ...onTable(1.14, SEAT_DEG(13.5)), h: 0.16, mirror: false },
    { key: 'bowl_wood_01', ...onTable(1.14, SEAT_DEG(3.5)), h: 0.095, mirror: false },
);

/* ④ 两处果盘（雕花木盘 + 六样水果）：摆在 60° / 240°（正对两席之间的空档）。 */
for (const d of [60, 240]) {
    LAYOUT.push(
        { key: 'plate_carved', ...onTable(1.06, d), h: 0.045, mirror: false },
        { key: 'fruit_apple', ...onTable(1.02, d - 4), h: 0.085, mirror: false },
        { key: 'fruit_pomegranate', ...onTable(1.06, d + 3), h: 0.10, mirror: false },
        { key: 'fruit_pear', ...onTable(1.11, d - 1), h: 0.11, mirror: false },
        { key: 'fruit_lychee', ...onTable(1.00, d + 7), h: 0.045, mirror: false },
        { key: 'fruit_lime', ...onTable(1.04, d - 8), h: 0.055, mirror: false },
        { key: 'fruit_kiwi', ...onTable(1.10, d + 8), h: 0.06, mirror: false },
    );
}

/* ════════════════════════════════════════════════════════════════════════════
 * 2.5 座次 —— **导出的唯一真值**
 *
 *     `NpcCrowd.tsx` 的 `?npclayout=table` 直接调 `seatSpots()`，不自己算坐标。
 *     两边各写一份几何迟早对不上（桌子改 `?bh=` 座位就飘到桌外了）。
 * ════════════════════════════════════════════════════════════════════════════ */
/** 座位离桌沿的水平退让（米）—— 站姿的人脚尖离桌沿 0.42 m 看着最自然。 */
const SEAT_D = 0.42;
/** 座位圈半径（米）：桌面半径 + `SEAT_D`。
 *  ⌀4.8 ⇒ **2.82**（周长 17.72 m ÷ 16 = **1.107 m/席**；改前 ⌀3.4 ⇒ 2.12 / 0.83 m/席）。
 *  `ringSpot()` / 椅子 / `NpcCrowd.npcSeatSpot()` 全从这里取 ⇒ 只改 `TABLE_D` 就够了。 */
const SEAT_R = TABLE_R + SEAT_D;

/** 环位 k 的世界坐标 + 朝向桌心的 yaw。
 *  朝向约定：`yaw = 0` 时模型面朝 **+Z**，绕 Y 转 `a` 把前向量映到
 *  `(sin a, 0, cos a)` ⇒ 对准方向 `(dx,dz)` 要 `a = atan2(dx, dz)`。
 *  与 `NpcCrowd.scatterSpots()` 的 `atan2(-x, -z)`（对准原点）同一套约定。 */
function ringSpot(k: number): { x: number; z: number; yaw: number } {
    const t = SEAT_DEG(k) * D2R;
    const x = BANQUET_X + Math.cos(t) * SEAT_R;
    const z = BANQUET_Z + Math.sin(t) * SEAT_R;
    return { x, z, yaw: Math.atan2(BANQUET_X - x, BANQUET_Z - z) };
}

/**
 * 圆桌座次（世界坐标 + 朝向桌心的 yaw），**共 15 席 —— 主位那 1 席留给哥伦比娅**。
 *
 * 为什么只给 15：哥伦比娅归 `MmdCharacter` 管、位置走 `?char=`，缺省站在
 * `CAKE_STAND_XZ = [0, −10]`（主位正后方的 `CAKE_GAP = 0.92 m`，见 `BANQUET_Z`）。
 * 这一席**不返回给 `NpcCrowd`**（她不是 NPC，也没有椅子），免得她和 NPC 叠在一起。
 *
 * ★ 返回顺序**刻意沿用长桌那版的索引语义**，所以 `NpcCrowd.tsx` 的 `SEAT_ORDER`
 *   一个字都不用改（用户 m02541 的硬要求「主位左侧是空、派蒙、荧；右侧是桑多涅」）。
 *   环位 k：`k = 0` 是主位，k 增大朝主位**左手边**（世界 +x），每席 22.5°。
 *   下表坐标是缺省几何（桌心 (0,−6.61)、`SEAT_R = 2.82`，即第十轮 ⌀4.8 桌）算出来的，
 *   `yaw` 一律朝桌心。⚠️ 第十轮前的旧表（`SEAT_R = 2.12`）坐标全部内缩 0.70 m，
 *   只改这里的数字不改公式是没用的 —— 公式取 `SEAT_R`，表只作说明：
 *
 *   | seatIndex | k  | k 的方位              | 世界 (x, z)        | 这一席是谁（SEAT_ORDER）|
 *   |-----------|----|-----------------------|--------------------|--------------------------|
 *   | 0         | 7  | 左手边最远            | ( 1.079, −4.005)   | furina                   |
 *   | 1         | 6  | 左手边                | ( 1.994, −4.616)   | lauma                    |
 *   | 2         | 5  | 左手边                | ( 2.605, −5.531)   | lyney                    |
 *   | 3         | 4  | 左手边（正 +x）       | ( 2.820, −6.610)   | lynette                  |
 *   | 4         | 1  | 左手边**最近**        | ( 1.079, −9.215)   | **lumine（荧）**         |
 *   | 5         | 2  | 左手边                | ( 1.994, −8.604)   | **paimon（派蒙）**       |
 *   | 6         | 3  | 左手边                | ( 2.605, −7.689)   | **aether（空）**         |
 *   | —         | 0  | **主位**（正 −z）     | ( 0.000, −9.430)   | 哥伦比娅（站／无椅子）   |
 *   | 7         | 9  | 右手边最远            | (−1.079, −4.005)   | neuvillette              |
 *   | 8         | 10 | 右手边                | (−1.994, −4.616)   | naifuer                  |
 *   | 9         | 11 | 右手边                | (−2.605, −5.531)   | ineffa                   |
 *   | 10        | 12 | 右手边（正 −x）       | (−2.820, −6.610)   | arlecchino               |
 *   | 11        | 13 | 右手边                | (−2.605, −7.689)   | aino                     |
 *   | 12        | 14 | 右手边                | (−1.994, −8.604)   | flins                    |
 *   | 13        | 15 | 右手边**最近**        | (−1.079, −9.215)   | **sandrone（桑多涅）**   |
 *   | 14        | 8  | 主位**正对面**        | ( 0.000, −3.790)   | freminet                 |
 *
 *   ⇒ 主位四周是**一段连续弧**，且沿 k **递减**方向逐位读正好是任务要求的顺序：
 *      **空(k3) — 派蒙(k2) — 荧(k1) — 哥伦比娅(主位 k0) — 桑多涅(k15)**。
 *      这就是为什么左手边不能简单按 k 递增排：荧必须紧贴主位，空要退到第三席。
 */
export function seatSpots(): { x: number; z: number; yaw: number }[] {
    const ks: number[] = [];
    /* 左手边 7 席（k1~k7）要装 i=4,5,6 + i=0..3 这两段，**不能**按 k 递增排：
     * 任务要求「空 — 派蒙 — 荧 — 哥伦比娅 — 桑多涅」是连续弧，沿 k 递减读，
     * 所以荧(i=4) 必须紧贴主位 k1，空(i=6) 退到 k3。 */
    for (let i = 0; i <= 3; i++) ks.push(7 - i);   // i=0..3 → k7, k6, k5, k4（外段）
    ks.push(1, 2, 3);                              // i=4,5,6 → k1, k2, k3（贴主位）
    for (let i = 7; i <= 13; i++) ks.push(i + 2);   // i=7..13 → k9 … k15（右手边，i=13 最近主位）
    ks.push(8);                                     // i=14 主位正对面
    /* 索引 15 = **主位 k0**（哥伦比娅，空椅子）。
     * 2026-10-20 Lead 批复：整环缺一把会让人以为漏了人，所以把主位那一席也返回出来，
     * 椅子照摆、人照站（她站在 (0,−10) 切蛋糕）。
     * ⚠️ `NpcCrowd` 只用 `seats[seatIndex(id) % seats.length]`，`seatIndex` 只产 0..14，
     *    ⇒ 把主位**追加在末尾**对 15 个 NPC 的落点零影响（已核对两处消费点：
     *    `NpcCrowd.tsx:331/339` 与 `:477/480`）。 */
    ks.push(0);
    return ks.map(ringSpot);
}

/** 主位（环位 k=0）的落点：**椅子空着**，哥伦比娅站在它后面切蛋糕。 */
export const mainSeatSpot = () => ringSpot(0);

/** 给探针/调试看的一行摘要。 */
export const SEAT_INFO = () => ({
    seats: seatSpots().length,
    columbina: mainSeatSpot(),
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. 加载与摆位
 * ════════════════════════════════════════════════════════════════════════════ */

/** 每份素材只 `loadAsync` 一次，之后 `clone(true)`（与 `VenuePropsReal` 同）。 */
const CACHE: Record<string, THREE.Group | null> = {};

async function getAsset(loader: GLTFLoader, url: string, sb: string[]): Promise<THREE.Group | null> {
    if (url in CACHE) return CACHE[url];
    try {
        const g = await loader.loadAsync(url);
        CACHE[url] = g.scene;
        if (DEBUG) sb.push(`[banquet] 载入 ${url}`);
    } catch (e) {
        CACHE[url] = null;
        sb.push(`[banquet] !! 素材加载失败 ${url}: ${String(e)}`);
    }
    return CACHE[url];
}

/** 材质后处理 —— 见文件头坑 ①。 */
function prepMaterials(root: THREE.Object3D, emis: number) {
    root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        const mm = mesh.material as THREE.Material | THREE.Material[];
        for (const m of Array.isArray(mm) ? mm : [mm]) {
            const s = m as THREE.MeshStandardMaterial;
            if (!s || !(s as unknown as { isMaterial?: boolean }).isMaterial) continue;
            if (s.map) {
                s.emissiveMap = s.map;
                s.emissiveMap.colorSpace = s.map.colorSpace;
                s.emissive?.setRGB(1, 1, 1);
            } else if (s.emissive && s.color) {
                s.emissive.copy(s.color);
            }
            s.emissiveIntensity = emis;
            s.needsUpdate = true;
        }
    });
}

/** 桌面高度（世界 y）—— 在桌子 footprint 上采 `worldHeightCPU` 取**最高点**，
 *  保证没有一条桌腿陷进坡里（`MoonShip.tsx:86` 的 `placeOnTerrain` 同一套理由）。 */
function groundTop(cx: number, cz: number, yaw: number, halfL: number, halfW: number): number {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let y = -Infinity;
    for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
            const u = (i / 2) * halfW;
            const v = (j / 2) * halfL;
            const h = worldHeightCPU(cx + u * c + v * s, cz - u * s + v * c);
            if (h > y) y = h;
        }
    }
    return Number.isFinite(y) ? y : 0;
}

/** 局部 (x,z) → 世界 (x,z)，绕桌心转 `yaw`（与 `MoonShip.placeOnTerrain` 同约定）。 */
function toWorld(lx: number, lz: number, yaw: number): [number, number] {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return [BANQUET_X + lx * c + lz * s, BANQUET_Z - lx * s + lz * c];
}

/* ════════════════════════════════════════════════════════════════════════════
 * 椅子对高：**让每把椅子长到它那一位的臀部高度**（用户 m00001 反馈的根因）
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 为什么非要「按人算」而不是定一个常数：
 *   `NpcCrowd` 的坐姿是把 `座る.vmd`（BowlRoll，署名「フユネコ＆朱雀」）**烘焙**
 *   进骨骼的，`センター` 的下沉量、各 PMX 的骨架定义都不同 ⇒ 实测 15 席坐姿的
 *   「臀部离脚底」高度是 **0.374 ~ 0.648 m**（差了 27 cm）。定一个 0.45 m 的
 *   座面：矮的陷进椅面 8 cm，高的**悬空 20 cm** —— 悬空正是用户反馈里
 *   「人坐得比椅面高、腿穿过椅面」的观感来源。
 *
 * 为什么是「改椅子」而不是「改人」：
 *   `NpcCrowd.tsx` 不归本文件负责，而且把人整体下沉会让脚陷进地面。椅子是可缩放的
 *   静态道具：**座面高 = 臀高** 时，脚仍然踩地、椅脚也仍然踩地，两边都不动。
 *
 * 几何：`public/venue/chairs/*.glb` 都是「总高 1、底面 y = 0、水平居中」⇒ 缩放 s
 *   就是椅子总高，坐面高 = s × `CHAIR_SEAT[款]`。所以
 *       s = 目标坐面高 / 坐面比例          目标坐面高 = 臀(センター) − 地面 − 0.02
 *   减 0.02 是为了让臀部「压」进椅面一点点（完全等于会看起来悬着，压进去才像坐实）。
 *
 * 配对：椅子与人都摆在同一个 `seatSpots()` 上（人再朝桌心挪 `NPC_SIT_FWD=0.12`），
 *   所以按水平距离取最近的「`センター` 骨骼点」即可，0.6 m 之外不认。
 */
function fitChairsToNpc(scene: THREE.Scene, root: THREE.Group): {
    n: number;
    total: number;
    rows: { i: number; pelvis: number; seat: number; scale: number }[];
} {
    const v = new THREE.Vector3();
    const pelvises: { x: number; y: number; z: number }[] = [];
    const seen = new Set<unknown>();
    scene.traverse((o) => {
        const sm = o as THREE.SkinnedMesh;
        if (!sm.isSkinnedMesh || !sm.skeleton) return;
        if (seen.has(sm.skeleton)) return;
        seen.add(sm.skeleton);
        const b = sm.skeleton.bones.find((x) => (
            (x.userData as { mmdBoneName?: string }).mmdBoneName === 'センター' || x.name === 'センター'
        ));
        if (!b) return;
        const p = v.setFromMatrixPosition(b.matrixWorld);
        pelvises.push({ x: p.x, y: p.y, z: p.z });
    });
    const rows: { i: number; pelvis: number; seat: number; scale: number }[] = [];
    if (!pelvises.length) return { n: 0, total: 0, rows };
    for (const child of root.children) {
        if (!/^banquet_chair_/.test(child.name)) continue;
        const inner = child.userData.chairInner as THREE.Object3D | undefined;
        const frac = (child.userData.seatFrac as number) ?? 0.469;
        if (!inner) continue;
        let best: { x: number; y: number; z: number } | null = null;
        let bd = Infinity;
        for (const p of pelvises) {
            const d = (p.x - child.position.x) ** 2 + (p.z - child.position.z) ** 2;
            if (d < bd) { bd = d; best = p; }
        }
        if (!best || bd > 0.36) continue;       // 0.6 m 以外不认
        const base = worldHeightCPU(child.position.x, child.position.z);
        /* 理论座面 = 臀高（减 0.02 让臀部压进椅面一点，压进去才像坐实）。
         * 但**不按 100% 对齐**：15 席臀高从 0.36 跨到 0.65 m，全对齐会让同一张
         * 桌子上的椅子缩放从 0.75 跨到 1.40 —— 又变成「大小不一的家具」。
         * 折中：只吃掉 60% 的偏差，再把缩放夹在 0.85~1.25。剩下的 ±4 cm
         * 差异被裙摆/衣摆遮住，肉眼看不出来，椅子却还是同一套的样子。 */
        const want = best.y - base - 0.02;
        const target = 0.44 + (want - 0.44) * 0.6;
        const scale = THREE.MathUtils.clamp(target / frac, 0.85, 1.25);
        const seat = scale * frac;
        inner.scale.setScalar(scale);
        child.position.y = base;                // 椅脚永远踩自己的地形
        rows.push({
            i: Number(child.name.slice('banquet_chair_'.length)),
            pelvis: +best.y.toFixed(3),
            seat: +seat.toFixed(3),
            scale: +scale.toFixed(3),
        });
    }
    return { n: rows.length, total: pelvises.length, rows };
}

/* ════════════════════════════════════════════════════════════════════════════
 * 2.5 月亮装饰层（第十轮 t4）—— 全部程序化几何，不新增 public 资源
 * ════════════════════════════════════════════════════════════════════════════ */

function cakeEnvelope(
    root: THREE.Object3D, yBand: number | null, dy = 0.12,
): { rx: number; rz: number; n: number } {
    const parentInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    let rx = 0, rz = 0, n = 0;
    root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const p = mesh.geometry.attributes.position as THREE.BufferAttribute | undefined;
        if (!p) return;
        if (yBand !== null && Math.abs(o.position.y - yBand) > dy * 2) {
            /* 先做一层便宜的粗糙剔除：该网格原点离薄层太远就不扫它的顶点。 */
            if (Math.abs(o.position.y - yBand) > dy + 0.5) return;
        }
        m.multiplyMatrices(parentInv, mesh.matrixWorld);
        for (let i = 0; i < p.count; i++) {
            v.fromBufferAttribute(p, i).applyMatrix4(m);
            if (yBand !== null && Math.abs(v.y - yBand) > dy) continue;
            rx = Math.max(rx, Math.abs(v.x));
            rz = Math.max(rz, Math.abs(v.z));
            n++;
        }
    });
    return { rx, rz, n };
}

function crateredCap(radius: number, seg = 96): THREE.BufferGeometry {
    const geo = new THREE.SphereGeometry(radius, seg, Math.max(12, Math.round(seg * 0.42)),
        0, Math.PI * 2, 0, Math.PI * 0.42);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    /** 环形山表 = 确定性哈希打种子（判据 N 禁 `fract(sin())`，用项目自带的 `hash01`）。 */
    const craters: { x: number; y: number; z: number; r: number; d: number }[] = [];
    const n = Math.max(8, Math.round(34 * MOON_CRATERS));
    for (let i = 0; i < n; i++) {
        /* 球面均匀取点（顶盖只取上半球前 0.42π 的那一帽）。 */
        const u = hash01(i, 3, 71);
        const w = hash01(i, 5, 73);
        const ct = 1 - u * 0.42;                       // cos(theta) ∈ [0.58, 1]
        const st = Math.sqrt(Math.max(0, 1 - ct * ct));
        const ph = w * Math.PI * 2;
        const rr = radius * (0.10 + 0.26 * hash01(i, 7, 79));   // 环形山半径
        craters.push({
            x: st * Math.cos(ph) * ct, y: ct, z: st * Math.sin(ph) * ct,
            r: rr, d: radius * (0.020 + 0.030 * hash01(i, 11, 83)),
        });
    }
    for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const surf = radius;
        const nx = v.x / surf, ny = v.y / surf, nz = v.z / surf;
        let push = 0;
        for (const c of craters) {
            const dx = v.x - c.x * surf, dy = v.y - c.y * surf, dz = v.z - c.z * surf;
            const dist = Math.hypot(dx, dy, dz);
            if (dist > c.r) continue;
            /* 碗形凹面 + 边缘微隆（唇沿），比纯凹陷更像素描里的环形山。 */
            const t = dist / c.r;
            push = Math.max(push, c.d * (1 - t * t) - c.d * 0.18 * Math.sin(Math.PI * t));
        }
        if (!push) continue;
        const k = (surf - push) / surf;
        v.set(nx * surf * k, ny * surf * k, nz * surf * k);
        pos.setXYZ(i, v.x, v.y, v.z);
    }
    /* ★ 顶点色承担「月面对比度」：宴会夜场 `AmbientLight` 强度是 **0**，只有一盏
     *  冷色 DirectionalLight（实测 `?hours=12` 快照里 lights = [Directional i=1.9,
     *  Ambient i=0]）。浅色高粗糙度的月面在这种情况下**只吃直射光**，坑底与坑沿
     *  只差几帧灰阶，出图里整块融进奶油白 ⇒ 肉眼看不见（这就是第二版的症状）。
     *  这里直接按「相对球心的凹深」写 vertex color：坑越深越暗 ⇒ 不依赖环境光，
     *  任意机位、任意时段都能读出环形山的斑驳。 */
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
    const col = geo.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const depth = Math.max(0, radius - Math.hypot(x, y, z)) / (radius * 0.06);
        /* 0.42（坑底，明显暗）→ 1.0（坑沿外，月壤本色）。 */
        const shade = 1 - 0.58 * Math.min(1, depth);
        col.setXYZ(i, shade, shade, shade * 0.985);
    }
    col.needsUpdate = true;
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
}

function moonPhaseShape(k: number): THREE.Shape {
    /* 明区 = 半圆 ＋ 被椭圆切出的分界。k=0.5 时是整圆；k=0/1 时退化成一细条。
     * 椭圆的 x 半轴 = cos(相位) * r，相位 0..2π 映射到 0..1。 */
    const ph = (k % 1) * Math.PI * 2;
    const prev = Math.cos(ph);
    const sh = new THREE.Shape();
    const R = 0.5;
    /* 右半边圆（从 −90° 走到 +90°）。 */
    sh.moveTo(0, -R);
    sh.absarc(0, 0, R, -Math.PI / 2, Math.PI / 2, false);
    /* 从下极点沿「明暗分界椭圆」回到上极点：x = prev * R * cos(t)，y = R sin(t)。
     * `prev > 0` 时是凹向月心的亏凸月，`prev < 0` 时鼓出成残月。 */
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
        const t = -Math.PI / 2 + (i / steps) * Math.PI;
        sh.lineTo(prev * R * Math.cos(t), R * Math.sin(t));
    }
    sh.closePath();
    return sh;
}

function buildMoonDecor(
    s: number, envTop: { rx: number; rz: number }, envAll: { rx: number; rz: number }, sb: string[],
    cakeEnvelopeOk?: (yBand: number) => { rx: number; rz: number; n: number } | null,
): THREE.Group {
    const g = new THREE.Group();
    g.name = 'banquet_cake_moon';
    /* 蛋糕局部系：原点在模型 bbox 中心、minY = −0.955 ⇒ 顶面 y = 1.012。 */
    const TOP_Y = 1.012;
    const mean = (a: number, b: number) => (a + b) / 2;
    const topR = mean(envTop.rx, envTop.rz);

    /* ① 月面顶盖：半球帽**坐在顶面上**，半径 = 最上一层轮廓 × 0.72。
     *  `crateredCap` 生成的是上半球帽，帽底圆落在 `position.y`，所以这里就是「扣在
     *  蛋糕顶上」，不会被奶油吃掉（第二版按底层半径铺、还埋进 y 里 ⇒ 全看不见）。 */
    const capR = topR * 0.72;
    const moonMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.58, 0.57, 0.53),   // 月壤灰，**明显**深于奶油白
        roughness: 0.97, metalness: 0,
        vertexColors: true,                        // 环形山凹陷由顶点色压暗（见 crateredCap）
    });
    const cap = new THREE.Mesh(crateredCap(capR), moonMat);
    cap.name = 'moon_cap';
    cap.position.y = TOP_Y - 0.004;                 // 压 4 mm 进奶油，避免悬空缝
    g.add(cap);

    /* ② 月牙：浮在顶面**左侧、同高**，竖起来（面朝镜头），从正面看是「月亮托着蛋糕顶」。 */
    const CR = capR * 0.92;
    const crescent = new THREE.Shape();
    crescent.absarc(0, 0, CR, Math.PI * 0.5, Math.PI * 1.5, false);
    crescent.absarc(CR * 0.34, 0, CR * 0.88, Math.PI * 1.5, Math.PI * 0.5, true);
    crescent.closePath();
    const cresGeo = new THREE.ExtrudeGeometry(crescent, {
        depth: CR * 0.15, bevelEnabled: true, bevelSize: CR * 0.03,
        bevelThickness: CR * 0.03, bevelSegments: 2, curveSegments: 48,
    });
    const cresMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.70, 0.68, 0.62), roughness: 0.9, metalness: 0.03,
    });
    const cres = new THREE.Mesh(cresGeo, cresMat);
    cres.name = 'moon_crescent';
    /* 局部 −z 是镜头那一侧。放在顶盖**前方（−z）偏左**：顶层有一圈立柱，
     *  挂在正侧方会被柱子挡掉；朝镜头前方才能整块露出来，且上半截高出顶盖形成轮廓。 */
    cres.position.set(-capR * 0.55, TOP_Y + capR * 0.42, -capR * 1.30);
    cres.rotation.y = -0.20;
    g.add(cres);

    /* ③ 月相环带：8 枚月相徽**绕中层最宽腰围一圈**，做成「月亮腰带」。
     *  ⚠️ 两个踩过的位置坑：
     *   · 挂底层半径（第二版）⇒ 三层蛋糕是收腰宝塔，徽章全埋进体里；
     *   · 挂顶层半径（第三版）⇒ 徽章挤在顶层小圆盘上、还被顶层的**立柱**挡掉一半，
     *     出图里只剩几片灰影（实测 A/B 图：8 枚只看得见 3 枚，且与奶油裱花抢位）。
     *  ⇒ 取「整块蛋糕最宽处（envAll）× 1.06」放到奶油裱花**外侧**、y 落在中层腰线上，
     *     再加一圈深色薄环当"月亮轨道"，让这圈徽章读成一个整体而不是散点。 */
    /* 腰带所在薄层的实测轮廓（局部系 y≈0.30 ⇒ rx 0.5253 / rz 0.4984 / n 7366）。
     * ⚠️ 别用 `envAll`（整块最大半径 1.1664）当环半径 —— 那是底座外沿，环会飘在
     *  蛋糕外面一圈，出图里像一只悬浮的呼啦圈（实测第二版就是这样）。 */
    /* ⚠️ 第二十六轮 T1-I4 修：`cakeEnvelopeOk` 的形参是**可选**的
     *  （见 `:694  cakeEnvelopeOk?: (yBand: number) => …`），这里却直接调
     *  ⇒ 调用方不传就是 `TypeError: cakeEnvelopeOk is not a function`，
     *  整个蛋糕装饰构建中断（被外层 try/catch 吞掉就只剩一个没装饰的蛋糕）。
     *  改成可选链；`??` 的兜底本来就在，语义不变。 */
    const envMid = cakeEnvelopeOk?.(0.30) ?? { rx: mean(envAll.rx, envAll.rz), rz: mean(envAll.rx, envAll.rz), n: 0 };
    const midR = mean(envMid.rx, envMid.rz);
    /* 实测剖面对照（探针逐层扫描 8440 个蛋糕顶点，局部系最大半径 / m）：
     *   y 0.00 → 0.9824（底座，最宽）
     *   y 0.15 → 0.9059
     *   y 0.30 → 0.5389  ← 中层腰
     *   y 0.45 → 0.5433  ← 中层最宽（腰带就挂这层）
     *   y 0.60 → 空洞（层间台阶）
     *   y 0.75 → 0.3881  顶层
     *   y 1.00 → 0.4159  顶面
     * ⚠️ 前几版的错误：把徽章挂在 0.543（≈ 中层自身半径 0.5389）上，只比壁面外
     *  1.8 cm —— 那是奶油裱花的厚度，整圈被吃掉，出图里什么都看不见。
     *  腰带必须**明显离开壁面**才读得出来，但也不能太远（试过 ×1.42 ⇒ 徽章大得像
     *  套在蛋糕外面的呼啦圈，和蛋糕脱开）。取 ×1.24 ≈ 0.674，离壁 13 cm，正好在
     *  裱花之外、又还贴着蛋糕。徽章尺寸同步收小到 phaseR = midR × 0.20。 */
    const bandR = midR * 1.24;
    const bandY = 0.615;
    const phaseR = midR * 0.20;

    /* 轨道环：一圈很薄的深色环带，给月相徽一个共同基线（自发光 0）。 */
    const ringGeo = new THREE.TorusGeometry(bandR, phaseR * 0.085, 8, 128);
    ringGeo.rotateX(Math.PI / 2);
    const ringMat = new THREE.MeshStandardMaterial({
        /* 深月岩：夜场只有一盏冷方向光，颜色必须压得很深才读得出「暗」，否则会
         * 被高光洗成浅灰（实测第一版 `0.30` 在出图里是一圈发亮的白环）。 */
        color: new THREE.Color(0.11, 0.11, 0.13), roughness: 0.99, metalness: 0,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.name = 'moon_band';
    ring.position.y = bandY;
    g.add(ring);

    for (let i = 0; i < 8; i++) {
        const k = (i + 1) / 9;                     // 0.111 … 0.889，避开 k=0/1 的退化细条
        const geo = new THREE.ShapeGeometry(moonPhaseShape(k), 24);
        geo.scale(phaseR * 2, phaseR * 2, 1);      // `moonPhaseShape` 用的是 R=0.5
        const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
            /* 深月岩 + 双面：正面朝外，远侧那几枚也能从背面读出来。 */
            color: new THREE.Color(0.12, 0.12, 0.14), roughness: 0.99, metalness: 0, side: THREE.DoubleSide,
        }));
        const a = (i / 8) * Math.PI * 2;
        m.position.set(Math.sin(a) * bandR, bandY, Math.cos(a) * bandR);
        m.rotation.y = a;
        m.name = `moon_phase_${i}`;
        g.add(m);
    }
    sb.push(`[banquet] 月亮：顶盖 r=${capR.toFixed(3)} @y=${TOP_Y.toFixed(3)}（顶层实测轮廓 `
        + `${envTop.rx.toFixed(3)}×${envTop.rz.toFixed(3)}；整块 ${envAll.rx.toFixed(3)}×${envAll.rz.toFixed(3)}）、`
        + `月牙 R=${CR.toFixed(3)} @(-${(capR * 0.55).toFixed(3)}, ${(TOP_Y + capR * 0.42).toFixed(3)}, -${(capR * 1.30).toFixed(3)})、`
        + `月相徽 8 枚 @r=${bandR.toFixed(3)}/y=${bandY.toFixed(3)}（含轨道环）、`
        + `环形山 ${Math.max(8, Math.round(34 * MOON_CRATERS))} 个（几何凹陷 + 顶点色，非贴图）`
        + `、**自发光 0**（emissive=#000000，明暗只来自方向光与顶点色）`);
    /* 缩放 s：上面的数字都是「蛋糕局部系」的米，和蛋糕本体完全同一套。 */
    g.scale.setScalar(s);
    return g;
}

async function buildBanquet(sb: string[]): Promise<THREE.Group> {
    const root = new THREE.Group();
    root.name = 'banquet';
    const loader = new GLTFLoader();

    /* ── 桌面高度 ───────────────────────────────────────────────────────── */
    const y0 = groundTop(BANQUET_X, BANQUET_Z, BANQUET_YAW, TABLE_R, TABLE_R);
    /* 座次圈弧长读数（第十轮验收要的一行：改前 ⌀3.4 ⇒ SEAT_R 2.12 / 0.83 m/席）。 */
    const seatN = seatSpots().length;
    const arc = (2 * Math.PI * SEAT_R) / seatN;
    sb.push(`[banquet] 圆桌 桌心 (${BANQUET_X}, ${BANQUET_Z}) 地面 y=${y0.toFixed(3)}`
        + `｜直径 ${TABLE_D.toFixed(2)} m｜半径 ${TABLE_R.toFixed(3)} m｜高 ${TABLE_H} m`
        + `｜${seatN} 席（含主位空椅）｜座位圈 ${SEAT_R.toFixed(3)} m`
        + `｜每席弧长 ${arc.toFixed(3)} m`);
    if (DEBUG) sb.push(`[banquet] 餐桌陈设半径系数 ${FOOD_K.toFixed(3)}（基准 ⌀${TABLE_FOOD_D}）`);

    /* ── ① 桌子：单件圆桌，**非等比**缩放到「⌀TABLE_D × 高 TABLE_H」───────── */
    const tpl = await getAsset(loader, TABLE_URL, sb);
    if (tpl) {
        prepMaterials(tpl, EMIS);
        const c = tpl.clone(true);
        /* 归一化后「直径 : 高 = 1.393 : 1」⇒ 要 ⌀4.8 且高 0.78 只能分开缩
         * （等比缩到 0.78 直径只剩 1.09 m，坐不下 16 人；等比缩到 ⌀4.8 则桌高
         *  3.45 m）。模型顶面正好在 y = 1.0（台面下沿的螺栓件在 0.917~0.932），
         *  所以 Y 直接乘 `TABLE_H` 后桌面就在 `y0 + TABLE_H` 上，不用再补偏移。 */
        const kxz = TABLE_D / TABLE_GLB_D;
        c.scale.set(kxz, TABLE_H, kxz);
        const g = new THREE.Group();
        g.add(c);
        g.position.set(BANQUET_X, y0, BANQUET_Z);
        g.rotation.y = BANQUET_YAW;
        g.name = 'banquet_table_0';
        root.add(g);
    } else {
        return root;
    }

    /* ── ② 蛋糕（桌心，三层婚礼蛋糕）────────────────────────────────────── */
    const cakeTpl = await getAsset(loader, CAKE_URL, sb);
    if (cakeTpl) {
        prepMaterials(cakeTpl, CAKE_EMIS);
        /* ★ t3：`CAKE_EMIS` 缺省 0 时 `emissiveIntensity = 0` ⇒ emissive 项整体乘 0，
         *  等价于「没有自发光」，但材质仍是标准受光材质（保留 ?bemis_cake 旋钮可回滚）。 */
        /* 可逆配色（`?cakecool=1`，缺省关）：只乘颜色因子、不碰贴图 ⇒ 随时能切回粉白。
         * 同时乘 `emissive`，否则「减法只在受光面上生效、自发光还是粉的」，两色打架。 */
        if (CAKE_COOL) {
            cakeTpl.traverse((o) => {
                const mesh = o as THREE.Mesh;
                if (!mesh.isMesh) return;
                const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                for (const m of list) {
                    const s = m as THREE.MeshStandardMaterial;
                    if (s.color) s.color.multiply(CAKE_COOL_TINT);
                    if (s.emissive) s.emissive.multiply(CAKE_COOL_TINT);
                }
            });
        }
        const c = cakeTpl.clone(true);
        /* ⚠️ 踩坑（第十轮 t4 实测）：`clone(true)` 进来的网格**没有 matrixWorld**，
         *  `Box3.setFromObject()` 会按 `matrixWorld`（还停在单位阵）量体积 ⇒ 量出的是
         *  「未缩放、未落位」的烘焙空间。所以下面量 world 尺寸之前必须先 `updateMatrixWorld`，
         *  否则月亮装饰的位置/半径全被算错（第一版就是这样把月面顶盖摊成了几米宽的盾牌）。 */
        cakeTpl.updateMatrixWorld(true);
        /* 模型原始 bbox：1.927(x) × 1.967(y) × 1.490(z)，**minY = −0.955**（不是 0！）。
         * ⇒ 先按目标总高等比缩放，再把「底部」抬到桌面：`position.y = −minY × s`
         *   = 0.955 × s。忘了这一步蛋糕会**陷进桌面 0.75 m**（只露出顶上一层）。 */
        const s = CAKE_H / 1.967;
        c.scale.setScalar(s);
        c.position.y = 0.955 * s;
        /* 落位后重算一次 matrixWorld —— `cakeEnvelope()` 靠它把顶点从烘焙空间换算到
         * 「蛋糕局部系（原点=桌面中心）」，这里量出来的数直接用给月亮装饰。 */
        c.updateMatrixWorld(true);
        const envAll = cakeEnvelope(c, null);
        /* ★ 顶层轮廓（蛋糕局部系）。⚠️ 踩坑（第十轮 t4 实测）：原来写死 `yBand=0.86`，
         *  但 `cakeEnvelope` 有一层粗剔除 `|o.position.y - yBand| > dy + 0.5` ⇒
         *  `0.86 + 0.62 = 1.48` 之外全跳；而这块蛋糕的网格都是整体式（原点在自身
         *  中心、`position.y≈0`），全部被剔掉 ⇒ 返回 **n = 0、rx = rz = 0** ⇒
         *  `capR = topR * 0.72 = 0` ⇒ 月面顶盖半径 0、顶点全塌在原点（出图里什么都
         *  看不见）。实测各薄层读数（n 为命中顶点数）：
         *      y=+0.86 ⇒ rx 0.0000 / rz 0.0000 / n 0      ← 原写法，空集
         *      y=+0.60 ⇒ rx 0.3401 / rz 0.3279 / n 2275
         *      y=+0.30 ⇒ rx 0.5253 / rz 0.4984 / n 7366
         *  ⇒ 改成「自上而下试几档、取第一个非空薄层」，并且空集时兜底 envAll，
         *  任何情况下都不会再出现半径 0。 */
        let envTop = cakeEnvelope(c, 0);
        for (const band of [0.60, 0.86, 0.40, 0.20]) {
            const e = cakeEnvelope(c, band);
            if (e.n > 0 && e.rx > 0 && e.rz > 0) { envTop = e; break; }
        }
        if (!(envTop.rx > 0 && envTop.rz > 0)) envTop = envAll;
        const g = new THREE.Group();
        g.add(c);
        const [wx, wz] = toWorld(0, 0, BANQUET_YAW);
        g.position.set(wx, y0 + TABLE_H, wz);
        g.rotation.y = BANQUET_YAW + 0.42;
        g.name = 'banquet_cake';
        root.add(g);
        sb.push(`[banquet] 蛋糕 ${CAKE_H} m 高（水平 ${(1.927 * s).toFixed(2)} × ${(1.490 * s).toFixed(2)} m`
            + `、底面抬 ${(0.955 * s).toFixed(3)} m、顶到离地 ${(y0 + TABLE_H + CAKE_H).toFixed(2)} m`
            + `、配色 ${CAKE_COOL ? '冷白（?cakecool=1）' : '原粉白'}）`);
        /* ★ 第十轮 t4：月亮装饰层（月面顶盖 + 月牙托架 + 月相环带）。
         *  挂在同一个 `banquet_cake` 组下 ⇒ 随蛋糕一起平移/转向/缩放，
         *  `?bcake` 仍然是唯一的总高旋钮。`?bmoon=0` 一键退回原蛋糕。 */
        if (MOON_ON) {
            /* 薄层轮廓取用器：腰带要贴腰身，不能用整块最大半径。 */
            const envAt = (yBand: number) => {
                const e = cakeEnvelope(c, yBand);
                return e.n > 0 && e.rx > 0 ? e : null;
            };
            g.add(buildMoonDecor(s, envTop, envAll, sb, envAt));
        }
        /* ?bmoondbg=1 临时诊断：在蛋糕正上方 3 m 放一颗红球。看不清 = 场景源不是这份。 */
        if (QNUM('bmoondbg', 0)! > 0) {
            const dbg = new THREE.Mesh(
                new THREE.SphereGeometry(0.5, 24, 16),
                new THREE.MeshBasicMaterial({ color: 0xff0040 }),
            );
            dbg.name = 'moon_dbg';
            dbg.position.set(0, CAKE_H + 1.5, 0);
            g.add(dbg);
            sb.push('[banquet] ★ 诊断球已加（?bmoondbg=1）');
        }
    }

    /* ── ③ 零食 / 饮料 / 果盘 ───────────────────────────────────────────── */
    if (FOOD_ON) {
        const cache: Record<string, THREE.Group | null> = {};
        let n = 0;
        for (const it of LAYOUT) {
            if (!(it.key in cache)) {
                cache[it.key] = await getAsset(loader, `${P}/${it.key}.glb`, sb);
            }
            const t = cache[it.key];
            if (!t) continue;
            /* 烛火：蜡烛整件（蜡体 + 火苗）走同一份贴图，`EMIS` 再乘 2.4 ⇒ 夜里
             * 桌心那一圈蜡烛才读得出「在亮」（用户要求「保留现有烛火 emissive」）。 */
            prepMaterials(t, it.key.startsWith('candle') ? EMIS * 2.4 : EMIS);

            /* 同一件素材被摆多次 ⇒ 每摆一次都要 `clone`，否则后一次会改掉前一次的
             * `scale` / `position`（`Object3D` 只有一份变换）。 */
            const sides = it.mirror === false ? [it.z] : [it.z, -it.z];
            for (const lz of sides) {
                const c = t.clone(true);
                /* `it.h` 是**期望的真实高度（米）**，而 GLB 的实际高度是 `nh(key)` 倍
                 * （`--normalize` 对四件没做到 1.0，见 `NORM_H`）⇒ 必须除掉。
                 * 不除的话 `basket_wicker_02` 会高 28%（0.334 m 而不是 0.26 m）。 */
                c.scale.setScalar(it.h / nh(it.key));
                const g = new THREE.Group();
                g.add(c);
                const [wx, wz] = toWorld(it.x, lz, BANQUET_YAW);
                g.position.set(wx, y0 + TABLE_H, wz);
                /* 朝向：确定性哈希（判据 N 禁 `fract(sin())`），`rot` 优先。 */
                g.rotation.y = it.rot ?? hash01(it.x * 100, lz * 100, 31) * Math.PI * 2;
                g.name = `banquet_${it.key}_${n++}`;
                root.add(g);
            }
        }
        sb.push(`[banquet] 桌面陈设 ${n} 件（${new Set(LAYOUT.map((i) => i.key)).size} 种素材）`);
    }

    /* ── ④ 椅子（`?bchair=1`，缺省摆）────────────────────────────────── */
    if (CHAIR_ON) {
        /* ★ 用户 m02724 定版（以此为准）：
         *   「所有 NPC 是坐姿，而唯独哥伦比娅本人**没有椅子**，是**站着**的，
         *     留出的是**中央主位**给哥伦比娅切蛋糕用。」
         * ⇒ 她本人不坐，但 2026-10-20 Lead 批复补一条：**主位那把椅子要摆**，
         *   否则整环 16 位缺一把、看着像漏了人。所以 `seatSpots()` 现在返回 16 席
         *   （前 15 席给 NPC，第 16 席 = 主位 k=0，椅子空着）。
         *   哥伦比娅仍站在它后面 1.27 m 的 `CAKE_STAND_XZ = [0, −10]` 切蛋糕。 */
        const seats = seatSpots();
        let nc = 0;
        let minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < seats.length; i++) {
            const sp = seats[i];
            const key = CHAIR_MIX
                ? CHAIR_POOL[Math.floor(hash01(i, 17, 43) * CHAIR_POOL.length) % CHAIR_POOL.length]
                : CHAIR_POOL[0];
            const url = `${CHAIR_DIR}/${key}.glb`;
            const t = await getAsset(loader, url, sb);   // 自带缓存，同款只 load 一次
            if (!t) continue;
            prepMaterials(t, EMIS);
            const c = t.clone(true);
            /* ★ 按**坐面高**缩放，不再按总高：`scale = 目标坐面高 / 该款坐面比例`。
             * 这样换款也不会出现「凳子座面 0.92 m、餐椅 0.43 m」的错位。
             * 这里的 `SEAT_H` 只是**初值**：真正的高度随后由 `fitChairsToNpc()`
             * 按「坐在这一席的那位」的臀部高度自动对（见函数注释）。 */
            const seatFrac = CHAIR_SEAT[key] ?? 0.45;
            c.scale.setScalar(SEAT_H / seatFrac);
            const g = new THREE.Group();
            g.add(c);
            /* 记下内层节点与坐面比例，供运行期对高用（`Object3D.userData` 不参与
             * 渲染，也不会被 clone 到别处）。 */
            g.userData.chairInner = c;
            g.userData.seatFrac = seatFrac;
            /* 椅子摆在「人的位置」往**桌心反方向**退 `CHAIR_BACK` 米 —— 座位点
             * 是人站的位置（离桌沿 `SEAT_D`），椅子要再退一点才不与人重叠。 */
            const yaw = sp.yaw;                       // 该席面朝桌心
            const bx = -Math.sin(yaw) * CHAIR_BACK;   // 面朝 (sin yaw, cos yaw) ⇒ 退是取负
            const bz = -Math.cos(yaw) * CHAIR_BACK;
            const cx = sp.x + bx;
            const cz = sp.z + bz;
            /* ★ 椅子脚踩**该席自己的地形高度**，不是桌心 footprint 的最高点。
             * 旧代码用 `y0`（桌子 footprint 上取最高点 0.342），会场地面高低差
             * 0.05~0.09 m ⇒ 边缘几席的椅子脚离地悬空（用户反馈里「部分悬空」）。
             * NPC 那边是各自按地形贴脚的（`NpcCrowd` 的 holder y），椅子必须跟人
             * 用同一个地面，否则人和椅子会一高一低。 */
            const gy = worldHeightCPU(cx, cz);
            g.position.set(cx, gy, cz);
            /* 椅子也要面朝桌心：`yaw = 0` 面朝 +Z，对准 (dx,dz) 取 `atan2(dx,dz)`
             * （`seatSpots()` 已经按「朝桌心」给好了，这里只管加该款的朝向补偿）。 */
            g.rotation.y = yaw + (CHAIR_YAW_FIX[key] ?? 0);
            g.name = `banquet_chair_${i}`;
            root.add(g);
            minY = Math.min(minY, gy);
            maxY = Math.max(maxY, gy);
            nc++;
        }
        sb.push(`[banquet] 椅子 ${nc} 把（${new Set(CHAIR_POOL).size > 1 ? '混搭' : CHAIR_POOL[0]}`
            + `，坐面 ${SEAT_H} m、scale ${(SEAT_H / (CHAIR_SEAT[CHAIR_POOL[0]] ?? 0.45)).toFixed(3)}）`
            + `｜席面地形 y ${minY.toFixed(3)}~${maxY.toFixed(3)}`);
    }

    root.updateMatrixWorld(true);
    return root;
}

/* ════════════════════════════════════════════════════════════════════════════
 * 4. 组件
 * ════════════════════════════════════════════════════════════════════════════ */
export function Banquet({ visible = true }: { visible?: boolean }) {
    const [group, setGroup] = useState<THREE.Group | null>(null);
    const scene = useThree((s) => s.scene);

    /* ── 探针：坐姿几何核对（无头出图脚本用）────────────────────────────────
     * 为什么放在这儿：`NpcCrowd.tsx` 不归本文件负责，但「人到底有没有坐在
     * 椅面上、脚有没有踩地、膝盖有没有顶到桌板」必须用**骨骼的世界 y** 说话，
     * 不能靠看截图猜。借 `useThree().scene` 从场景里读，不动 NPC 那边的代码。
     *
     * 返回 `{ chairs: [...], npcs: [...] }`：
     *   · `chairs[i]` = 每把椅子的世界包围盒（`seat` 由外观决定，不含坐面高度，
     *     坐面比例见 `CHAIR_SEAT`）；
     *   · `npcs[i]` = 每个坐姿角色的 `センター / 下半身(髋) / 左ひざ(膝) /
     *     左足首(踝) / 上半身 / 頭` 世界 y。地面高度同时给，方便算「离地多少」。 */
    useEffect(() => {
        const w = window as unknown as Record<string, unknown>;
        w.__banquetScene = scene;
        w.__banquetProbe = () => {
            const box = new THREE.Box3();
            const v = new THREE.Vector3();
            const chairs: unknown[] = [];
            const npcs: unknown[] = [];
            const seen = new Set<unknown>();
            scene.traverse((o: THREE.Object3D) => {
                if (/^banquet_chair_/.test(o.name)) {
                    box.setFromObject(o);
                    chairs.push({
                        name: o.name,
                        top: +box.max.y.toFixed(3),
                        bot: +box.min.y.toFixed(3),
                        h: +(box.max.y - box.min.y).toFixed(3),
                        x: +o.position.x.toFixed(3),
                        z: +o.position.z.toFixed(3),
                    });
                    return;
                }
                const sm = o as THREE.SkinnedMesh;
                if (!sm.isSkinnedMesh) return;
                const sk = sm.skeleton;
                if (!sk || seen.has(sk)) return;
                seen.add(sk);
                const bones = sk.bones;
                const find = (n: string) => bones.find(
                    (b) => (b.userData as { mmdBoneName?: string }).mmdBoneName === n || b.name === n,
                );
                const at = (n: string) => {
                    const b = find(n);
                    return b ? +v.setFromMatrixPosition(b.matrixWorld).y.toFixed(3) : null;
                };
                const hip = at('下半身');
                if (hip === null) return;
                /* 是谁的人：往上爬到「父节点就是 scene」的那层，就是 `NpcCrowd`
                 * 摆人的 holder（一个 `<group>` 放在座位点上）。它的世界 y 就是
                 * **该席的地面高度**，所有骨高减去它才是「离地多少」。 */
                let top: THREE.Object3D = sm;
                while (top.parent && top.parent !== scene) top = top.parent;
                const wp = v.setFromMatrixPosition(top.matrixWorld);
                const hy = +wp.y.toFixed(3);
                box.setFromObject(sm);
                /* holder 的 x/z 在多数模型上是 0（真正的位置更内层），所以用
                 * **包围盒中心**来认座：和 `banquet_chair_i` 的 (x,z) 比距离即可。 */
                npcs.push({
                    id: top.name || '(anon)',
                    x: +((box.min.x + box.max.x) / 2).toFixed(3),
                    z: +((box.min.z + box.max.z) / 2).toFixed(3),
                    groundY: hy,
                    foot: +box.min.y.toFixed(3),
                    cen: at('センター')!,
                    hip, knee: at('左ひざ'), ank: at('左足首'),
                    up: at('上半身'), head: at('頭'),
                });
            });
            return {
                chairs,
                npcs,
                ground: +worldHeightCPU(BANQUET_X, BANQUET_Z).toFixed(3),
            };
        };
        /* 手动重跑「椅子对高」（出图脚本里 `window.__banquetFit()` 即可）。 */
        w.__banquetFit = () => (group ? fitChairsToNpc(scene, group) : null);
    }, [scene, group]);

    useEffect(() => {
        if (!BANQUET_ON) return;
        let cancelled = false;
        const sb: string[] = [];
        buildBanquet(sb).then((g) => {
            if (cancelled) return;
            sb.forEach((s) => console.log(s));
            setGroup(g);
        }).catch((e) => {
            console.error('[banquet] 构建失败', e);
        });
        return () => { cancelled = true; };
    }, []);

    /* 与 `VenuePropsReal` 同：相机退到 120 m 外就整体剔除（地形盘半宽只有
     * `TERRAIN_AREA/2 = 80 m`，再远会看到桌子悬在盘外）。 */
    const HIDE_R = 120;
    useFrame(({ camera }) => {
        if (!group) return;
        const dx = camera.position.x - BANQUET_X;
        const dz = camera.position.z - BANQUET_Z;
        group.visible = visible && dx * dx + dz * dz < HIDE_R * HIDE_R;
    });

    /* ── 椅子按人「长高」（见 `fitChairsToNpc` 的注释）─────────────────────
     * 为什么是每 N 帧重试而不是建完桌就量一次：
     *   · NPC 模型是异步加载的，宴会桌建好的那一刻人还没到位；
     *   · 坐姿要 `setPhase('feast')` 之后才把 `座る.vmd` 的姿态解算进骨骼，
     *     之前 `センター` 还在站立高度（量了会把椅子撑成一米三）。
     * 每 12 帧量一次、15 把全对上就停，最多试到第 900 次（≈15 s）。
     *
     * 量不到人时椅子保持 `SEAT_H` 初值 —— 所以这个特性**只加分不减分**。 */
    const fitTick = useRef(0);
    const fitDone = useRef(false);
    const fitLast = useRef(-1);
    useFrame(() => {
        if (!group || fitDone.current) return;
        /* 前 20 s 每 12 帧试一次（人要一个个加载进来），之后降到每 60 帧，
         * 25 s 还没凑齐 15 就收工（先对上的那几把保持，不会回退）。 */
        const period = fitTick.current < 1200 ? 12 : 60;
        const tick = fitTick.current++;
        if (tick % period !== 0) return;
        const r = fitChairsToNpc(scene, group);
        /* 只在「配上的把数」变化时打一行，免得每 0.2 s 刷屏；全员配上（含把站着
         * 的哥伦比娅算进去的那一份）或跑到 50 s 就收工。 */
        if (r.n !== fitLast.current) {
            fitLast.current = r.n;
            console.log(`[banquet] 椅子对高 ${r.n}/${r.total} 席（座面 = 该席坐姿臀高 ×0.6 软对齐，scale 夹 0.85~1.25）｜`
                + r.rows.map((x) => `#${x.i} 臀${x.pelvis}/座面${x.seat}`).join(' '));
        }
        if (r.n >= r.total || tick > 3000) fitDone.current = true;
    });

    if (!group) return null;
    return <primitive object={group} visible={visible} />;
}

/** 探针：给 `_tools/webgpu-shot.mjs --eval` 读，确认桌子真的建出来了。 */
if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__banquet = () => ({
        on: BANQUET_ON,
        d: +TABLE_D.toFixed(3),
        r: +TABLE_R.toFixed(3),
        seatR: +SEAT_R.toFixed(3),
        h: TABLE_H,
        cake: CAKE_H,
        food: FOOD_ON,
        items: FOOD_ON ? LAYOUT.length : 0,
        chair: CHAIR_ON,
        chairN: CHAIR_ON ? seatSpots().length : 0,
        /** 主位（不摆椅子那席）的世界坐标，供座次核对。 */
        main: SEAT_INFO().columbina,
    });
}
