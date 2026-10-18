/**
 * 生日会游戏流程 —— 世界布局（**唯一真值**）。
 *
 * ── 为什么单独一个文件 ─────────────────────────────────────────────
 * 书桌 / 信箱 / NPC 站位 / 采集点 / 交互点的坐标会被**四处同时读**：
 * ① 3D 道具组件（`components/game/**`）
 * ② NPC 站位（`components/npc/NpcCrowd.tsx`）
 * ③ 小地图指引箭头（`ui/MiniMap.tsx`）
 * ④ 交互系统（`core/game/interact.ts`）
 * 散在各自文件里一定会对不上，所以在这里定死，谁都不许自己算。
 *
 * ── 坐标系 ────────────────────────────────────────────────────────
 * 世界 -Z = 北，世界 +X = 东（与 `ui/minimapState.ts` 的 `yaw` 零点一致）。
 * 极坐标约定：`a` 单位是**度**，`0` = 正南(+Z)，顺时针增大到 `90` = 正东(+X)。
 * 即 `x = sin(a)·r`、`z = cos(a)·r` —— 与 `polar()` 一致。
 *
 * ── 朝向约定 ──────────────────────────────────────────────────────
 * 项目铁律：`yaw = 0` 时模型面朝 **+Z**。所以「站在 P 点看向 Q 点」的
 * `yaw = atan2(Qx − Px, Qz − Pz)`（见 `yawTo()`）。这条与
 * `NpcCrowd.scatterSpots()` 的 `Math.atan2(-x, -z)`（面朝场心）是同一套约定。
 *
 * ── 场地尺度（实测，见 `继续任务.MD` §0.8 / §0.10）─────────────────
 * 会场是半径 **62 m** 的圆盘；中心 **r ≤ 9.5 m** 是空地（不放树）；
 * 树环在 **r = 29 m**（26 棵，`?ring=` / `?ringn=`）；地形盘半宽 80 m。
 * 所以：
 *   · 书桌 / 信箱 / 出生点  → r ≈ 9~11 m（中心广场，不与树打架）
 *   · NPC 站位              → r = 17.5~23.5 m（树环内侧，玩家绕场一圈能挨个找到）
 *   · 采集点                → r = 28~41 m（树环外侧，得走一段路）
 * 「委托点位和 NPC 的距离不要太近也不要太远」⇒ 实测都在 **14~22 m**。
 */

export interface Polar {
    /** 方位角（度）。0 = 正南(+Z)，顺时针增大，90 = 正东(+X)。 */
    a: number;
    /** 半径（米）。 */
    r: number;
}

/** 极坐标 → 世界 XZ。 */
export function polar(a: number, r: number): [number, number] {
    const t = (a * Math.PI) / 180;
    return [Math.sin(t) * r, Math.cos(t) * r];
}

/** 站在 `(fromX, fromZ)` 看向 `(toX, toZ)` 时的 `yaw`（项目约定 `yaw=0` 面朝 +Z）。 */
export function yawTo(fromX: number, fromZ: number, toX: number, toZ: number): number {
    return Math.atan2(toX - fromX, toZ - fromZ);
}

/** 场心（生日会会场原点）。 */
export const HUB_XZ: [number, number] = [0, 0];

/* ==================================================================
 * 一、中心广场：出生点 / 书桌 / 信箱
 * ================================================================== */

/** 玩家（哥伦比娅）出生点。面向场心。 */
export const SPAWN_XZ: [number, number] = [0, -11];
export const SPAWN_YAW = yawTo(SPAWN_XZ[0], SPAWN_XZ[1], HUB_XZ[0], HUB_XZ[1]);

/**
 * 书桌（写邀请函的地方）。西侧，面朝场心。
 *
 * ★ 2026-10-18（用户 m00863 任务6）：从 `[-7.2, -4.2]` 再往西挪到 `[-8.6, -3.2]` ——
 *   要求是「放在会场边上点，避开切蛋糕的桌子」。宴会长桌占 `z ∈ [-9.58, -3.64]、x ≈ ±0.8`
 *   （`BANQUET_XZ` + `BANQUET_YAW = 90°` 推出的世界包围盒），蛋糕台在 `[0, -10.0]`；
 *   新位置离场心 9.2 m、离长桌最近点仍有 7.9 m，桌子发光环（半径 1.30）碰不到长桌的椅子。
 *   为什么要挪：换月牙石桌（1.55 m 宽，桌面比旧木桌窄 0.9 m）之后，旧位置正好被
 *   宴会长桌东端那把椅子挡掉半个视角，玩家站在桌前只能看见桌子的一半。
 *
 * ⚠️ `DESK_YAW` 是「书桌 → 场心」的方向 ⇒ 桌子**局部 +Z 朝场心**、玩家站在 +Z 侧，
 *    所以月牙石桌的「咬口」（模型局部 −Z）正好背对玩家 —— 有意的，别改模型朝向。
 */
export const DESK_XZ: [number, number] = [-8.6, -3.2];
export const DESK_YAW = yawTo(DESK_XZ[0], DESK_XZ[1], HUB_XZ[0], HUB_XZ[1]);

/** 信箱（投递邀请函的地方）。东侧，面朝场心。 */
export const MAILBOX_XZ: [number, number] = [7.2, -4.2];
export const MAILBOX_YAW = yawTo(MAILBOX_XZ[0], MAILBOX_XZ[1], HUB_XZ[0], HUB_XZ[1]);

/** 互动判定半径（米）—— 玩家进到这个圈里就弹出「按 F …」提示。 */
export const REACH = 2.6;

/**
 * 写邀请函时玩家被「摆」到书桌前的哪个位置（米，离桌心）。
 *
 * 书桌在 `DESK_XZ`，玩家站在「书桌 → 场心」那条连线上再往外这么远。
 * ★ 2026-10-17（用户 m00718 任务2 加椅子）：**保持 1.15 不变**。
 *   最初按「坐下会把身体往后挪、所以要站远点」改成了 1.30 —— 方向搞反了：
 *   坐姿的向后位移是让**骨盆**退到椅子上，不是让人站得更远（见 `DESKSIT_BACK`）。
 */
export const DESK_STAND_D = 1.15;

/* ★ 2026-10-18（用户 m00863 任务1「不坐了」）：这里原来还有 `DESKSIT_BACK / DESKSIT_SIDE /
 * DESK_CHAIR_XZ / DESK_CHAIR_YAW` 四个导出，用来把椅子摆到「坐定后的骨盆位置」。
 * 坐姿机与椅子都已删除，这四个常量一并删掉 —— 留着只会让人以为椅子上还坐着人。 */
/* ==================================================================
 * 二、NPC 站位（委托阶段：15 个 NPC 站姿撒满地图）
 * ================================================================== */

/**
 * NPC 绕场顺序（**同时决定任务列表里委托的排列顺序**，改这里就改了玩家绕场的方向）。
 * 派蒙不单列 —— 按用户要求「空和派蒙站在一起，视为一个 NPC」，她的台词并进 `aether`。
 */
export const NPC_ORDER = [
    'lauma', 'lyney', 'lynette', 'freminet', 'neuvillette', 'furina', 'ineffa',
    'lumine', 'aether', 'aino', 'naifuer', 'flins', 'sandrone', 'arlecchino',
] as const;

const NPC_N = NPC_ORDER.length;

/**
 * 每个 NPC 的站位。半径在 17.5~23.5 m 之间轮转（`(i*7)%5` 给出 0,2,4,1,3 的错落），
 * 方位角均匀铺满一圈 —— 保证「绕场一圈能把 14 个人挨个找到」，又不会站成一排。
 */
export const NPC_SPOTS: Record<string, Polar> = Object.fromEntries(
    NPC_ORDER.map((id, i) => [id, { a: 10 + (360 / NPC_N) * i, r: 17.5 + ((i * 7) % 5) * 1.5 }]),
) as Record<string, Polar>;

/** 取某个 NPC 的世界 XZ。找不到时返回场心（不该发生，便于暴露拼写错误）。 */
export function npcXZ(id: string): [number, number] {
    const p = NPC_SPOTS[id];
    if (!p) return [HUB_XZ[0], HUB_XZ[1]];
    return polar(p.a, p.r);
}

/* ==================================================================
 * 三、采集 / 互动点位（委托阶段）
 * ================================================================== */

/**
 * 每个采集点的位置。多数点位 1 处；`litter`（伊涅芙「散落的小物件」×5）有 5 处，
 * 所以统一用数组表示。方位角大体跟着对应 NPC 走，半径拉到树环外面。
 */
export const POINT_SPOTS: Record<string, Polar[]> = {
    /* 琳妮特〈茶。十二杯。〉—— 野茶丛 */
    tea: [{ a: 36, r: 34 }],
    /* 林尼〈帽子里的礼物〉—— 虹彩蔷薇 ×3。
     * ★ 必须是 **3 处**：委托 2 的 `count = 3`。2026-10-17 之前这里只有 1 处，
     *   于是必须对着同一株连按三次 F（画面上一朵没少、计数却在涨），
     *   与下面 `mushroom` 那条注释描述的是同一个 bug —— 当时只补了蘑菇，漏了蔷薇与灯。 */
    rose: [{ a: 58, r: 35 }, { a: 62, r: 36 }, { a: 66, r: 34 }],
    /* 菲米尼〈水下的灯〉—— 水下的一点光 */
    lamp: [{ a: 88, r: 38 }],
    /* 那维莱特〈雨檐之下的一滴水〉—— 月泉 */
    spring: [{ a: 114, r: 35 }],
    /* 芙宁娜〈导演的第一条指示：灯〉—— 月灵灯 ×3。
     * ★ 同上：委托 6 的 `count = 3`，必须 3 处。 */
    lantern: [{ a: 136, r: 36 }, { a: 140, r: 37 }, { a: 144, r: 35 }],
    /* 伊涅芙〈清扫程序·会场版〉—— 散落的小物件 ×5（五处散开） */
    litter: [
        { a: 166, r: 30 }, { a: 172, r: 33 }, { a: 178, r: 29 },
        { a: 184, r: 34 }, { a: 190, r: 31 },
    ],
    /* 荧〈替我看一眼终点〉—— 夜路的尽头 */
    roadend: [{ a: 210, r: 40 }],
    /* 空〈派蒙的蛋糕〉—— 生日蛋糕（委托阶段先摆在广场南侧的小桌上） */
    cake_slice: [{ a: 236, r: 28 }],
    /* 爱诺「池塘捉鱼」—— 浅水坑 */
    fish: [{ a: 262, r: 36 }],
    /* 奈芙尔「打一桶清水」—— 取水处 */
    water: [{ a: 288, r: 35 }],
    /* 菲林斯「采集野花」—— 花丛 */
    flower: [{ a: 314, r: 37 }],
    /* 桑多涅「会发光的蘑菇」—— 发光蘑菇 ×2。
     * ★ 必须是 **2 处**：委托 13 的 `count = 2`（文案「采两朵」）。
     *   只有 1 处时 `enabled` 判据 `collected < need` 仍为真 ⇒ 玩家得对着同一丛
     *   连按两次 F，画面上一朵没少但计数在涨，像是 bug。两处各自一朵才对得上文案。 */
    mushroom: [{ a: 340, r: 34 }, { a: 346, r: 32 }],
    /* 菈乌玛「拾取干柴」—— 干柴堆 */
    firewood: [{ a: 6, r: 39 }],
};

/** 取某个采集点的全部世界 XZ（`litter` 返回 5 个）。 */
export function pointXZ(id: string): Array<[number, number]> {
    const list = POINT_SPOTS[id];
    if (!list) return [];
    return list.map((p) => polar(p.a, p.r));
}

/** 取某个采集点的**代表位置**（多点的取第一个）—— 给「距离提示」「箭头」这类单点用途。 */
export function pointXZ1(id: string): [number, number] {
    const l = pointXZ(id);
    return l.length ? l[0] : [HUB_XZ[0], HUB_XZ[1]];
}

/* ==================================================================
 * 四、切蛋糕阶段（委托全完成后，会场中央刷新坐姿 NPC + 长桌 + 蛋糕）
 * ================================================================== */

/** 宴会长桌的桌心（与 `Banquet.tsx` 的 `?bz` 缺省一致）。 */
export const BANQUET_XZ: [number, number] = [0, -6.61];

/**
 * 哥伦比娅切蛋糕时站的**中央主位** —— 长桌 **+x 端**（`Banquet.seatSpots()` 特意不返回的那一席，
 * 见 §0.10.2）。
 *
 * ★ 用户 m02724 定的最终版（**以此为准**）：
 *   「所有 NPC 是坐姿，而唯独哥伦比娅本人**没有椅子**，是**站着**的，
 *     留出的是**中央主位**给哥伦比娅切蛋糕用。」
 * ⇒ 15 个 NPC 坐下（配 15 把椅子），哥伦比娅这一席**不摆椅子**、她**站着**切蛋糕。
 *   `Banquet.tsx` 的椅子循环必须**只遍历 `seatSpots()`（15 席）**，
 *   不要把 `SEAT_INFO().columbina` 也拼进去（那是 §0.10 那版的写法，已被这条推翻）。
 *
 * ★★ 2026-10-15 修正：这里原本写的是 `[3.39, -6.61]` —— **坐标轴写反了**。
 *
 * 长桌在 `BANQUET_YAW = 90°` 下，`toWorld(lx, lz)` 是
 *   `x = BANQUET_X + lx*cos90 + lz*sin90 = BANQUET_X + lz`
 *   `z = BANQUET_Z - lx*sin90 + lz*cos90 = BANQUET_Z - lx`
 * ⇒ **局部 `lx` 走的是世界 Z 轴**，不是世界 X。
 * 哥伦比娅的主位在局部 `lx = +(TABLE_LEN/2 + SEAT_D) = +3.39`、`lz = 0`（就是
 * `seatSpots()` 特意不返回的那一席），代进去：
 *   `x = 0 + 0 = 0`，`z = -6.61 - 3.39 = -10.0`
 * 恰好等于 `COLUMBINA_XZ = [0, -10]`（`NpcCrowd.tsx`）与 `?char=0,0,-10` 的旧缺省，
 * 也正好是桌沿 `z = -6.61 - 2.97 = -9.58` 往外 `SEAT_D = 0.42` m ⇒ **三点自洽**。
 *
 * 旧值 `[3.39, -6.61]` 把 `lx` 当成了世界 X，落点在长桌**东侧半腰**（离桌沿仅 0.44 m），
 * 既不是主位、也和「站在桌端切蛋糕」的画面完全不符。
 */
export const CAKE_STAND_XZ: [number, number] = [0, -10.0];

/** 蛋糕在长桌上的位置（桌心，桌面局部原点）。 */
export const CAKE_XZ: [number, number] = [BANQUET_XZ[0], BANQUET_XZ[1]];

/* ==================================================================
 * 五、小地图指引
 * ================================================================== */

export interface GuideTarget {
    /** 显示名（小地图下方的指引文字）。 */
    label: string;
    x: number;
    z: number;
}

/** 把 `[x, z]` 包成指引目标。 */
export function guide(label: string, xz: [number, number]): GuideTarget {
    return { label, x: xz[0], z: xz[1] };
}

export const DESK_GUIDE = guide('书桌', DESK_XZ);
export const MAILBOX_GUIDE = guide('信箱', MAILBOX_XZ);
export const CAKE_GUIDE = guide('生日蛋糕', CAKE_STAND_XZ);
