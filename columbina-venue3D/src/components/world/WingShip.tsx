/**
 * WingShip —— 停在月球环形山里的「带翼飞船」（用户 m03431）。
 *
 * ── 为什么这艘是自己建的模 ──────────────────────────────────────────
 * 用户给的参考图是 `公用区\背景素材\素材\背景素材10.png`：一艘银色飞镖形
 * 飞船，中央嵌一颗**多面切割的蓝色发光宝石**，两侧是**细长后掠的刀形机翼**
 * （前缘带金色镶边），机头伸出一根**细长黑色尖锥**，尾下方一个小喷口。
 *
 * 先把本机素材库翻遍了：
 *   · `公用区/素材/yq_probe/Mesh` 里所有 `MoonShip*` / `Ship` / `Boat` /
 *     `Fly` / `Hover` / `Glide` / `Ndkl` 网格；
 *   · 结论是**只有一艘月牙形小舟**（`Property_Ani_Prop_MoonShip_01`），
 *     跟参考图这艘带翼飞船**完全不是一个东西**（那艘仍在 `MoonShip.tsx` 里，
 *     默认关掉，`?ship=1` 可以调出来）。
 *   ⇒ 本机**没有**这艘船的现成素材，只能建。
 *
 * 用户原话给了两条路：「让作图API配合你，进行建模。不行的话，网上很多给
 * 参考图出建模的免费网页AI」。本机**没有图生 3D 的凭据**（`AGENTS` 里只有
 * 火山方舟 Seedream，那是**图生图**）。所以走的是第一条：
 *   `_tools/ship_ref.py` 拿参考截图喂给 Seedream，让它反推出一张**正交三视图**
 *   （`路线A-webgpu/_logs/world/SHIPREF_turnaround.png`：左俯视 / 中侧视 / 右正视），
 *   再**照着三视图把比例量出来**建成几何体。
 *
 * ⚠️ 三维建模这类活，最怕的不是算不出来，是**没有正投影**。一艘船只给一张
 *    斜侧透视图，机翼的后掠角、上反角、翼型厚度全是猜的；三视图一到手，
 *    这三个量就变成「量出来的数」。这是本轮唯一的关键动作。
 *
 * ── 几何构成（全部是解析几何，没有外部文件）─────────────────────────
 *   1. `buildHull()`   沿 Z 放样 12 个「圆角菱形」横截面（尾部尖 → 中部最粗 → 前部收细）
 *   2. `buildSpike()`  机头那根细长黑锥（占全长 30%）
 *   3. `buildWing(±1)` 每侧 9 个展向站位的刀形薄板；截面 6 点，**前缘两块面板单独成组**
 *                      给金色材质（`addGroup` 分材质，不用两套 mesh）
 *   4. `buildCrystal()` 低面数球压成椭球 + 逐三角面法线 ⇒ 多面切割感；
 *                      外加一圈银色托座
 *   5. `buildThruster()` 尾部下方的小锥 + 自发光圆盘
 *   6. 脊线上 6 颗小蓝灯
 *
 * ── 落点 ────────────────────────────────────────────────────────────
 * 落在 `CRATERS[0]`（`(0, -196, r=46, depth=7.5, rim=2.2)`，全场最大的坑），
 * 复用 `MoonShip.tsx` 导出的 `placeOnTerrain`：采样船底 5×5 网格取最高点当 y，
 * 最小二乘拟合坡度当俯仰/横滚。月球区基础 FBM 被 `(1-mask)` 淡出成 0 ⇒
 * CPU 与 GPU 逐字相等 ⇒ 船精确坐在碗底。
 *
 * ⚠️ 写块注释时**绝不能让「星号+斜杠」连续出现**（比如拿 glob 去描述 public 目录）——
 *    那会提前把块注释关掉，报的是莫名其妙的 `Unexpected reserved word`（坑 38）。
 *    这里用「public 目录」这种中文写法绕开。
 */
import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { QNUM } from '../../core/utils/query';
import { CRATERS } from '../../core/worldRegions';
import { placeOnTerrain } from './MoonShip';

/** 总开关。**默认关** —— 用户 m03778 指出手搓版「建模太不还原」，现在默认渲染的是
 *  Ark 图生 3D 那个真模型（`WingShipApi.tsx`）。想看这版加 `?wing=1`。 */
export const WING_ON = QNUM('wing', 0)! > 0;

/** 船长（米）。参考图里这艘船是「大件」：第一轮给 17 m 缩在 r=46 的坑里像个模型玩具，
 *  放大到 26 m 才有「停在坑底的一艘船」的体量感（翼展随之 29 m，坑直径 92 m）。 */
const WING_LEN = QNUM('winglen', 26)!;

const WING_X = QNUM('wingx', CRATERS[0].x)!;
const WING_Z = QNUM('wingz', CRATERS[0].z)!;
const WING_YAW = QNUM('wingyaw', -24)!;
const WING_LIFT = QNUM('winglift', 0.06)!;

/** 机翼上反角（度）。从正视三视图量出来约 22°。 */
const WING_DIHEDRAL = QNUM('wingdihedral', 22)!;

/** 机翼从船身伸出多少（占船长的比例，单侧）。三视图里翼展 ≈ 1.12 倍船长。 */
const WING_SPAN = QNUM('wingspan', 0.560)!;

/** 材质 */
const WING_ROUGH = QNUM('wingrough', 0.30)!;
const WING_METAL = QNUM('wingmetal', 0.55)!;
const WING_EMIS = QNUM('wingemis', 0.02)!;
/** 宝石自发光强度。⚠️ 给到 2.6 时会被 PostFX 的 bloom（阈值 0.90）整个吃掉 ——
 *  出图是一坨没有切面的白蓝光斑。降到 1.15 才既发光又留得住多面切割的棱。 */
const GEM_EMIS = QNUM('gememis', 1.15)!;

// ── 颜色：参考图是「银色珍珠漆 + 金色前缘 + 深色尖锥 + 蓝宝石」 ──────────
const C_SKIN = 0xd8dce2; // 船身银
const C_SKIN2 = 0xa9b0ba; // 暗部银（翼下、托座）
const C_GOLD = 0xb08a4a; // 前缘金边
const C_DARK = 0x24272d; // 尖锥黑
const C_GEM = 0x1f6fe0; // 宝石蓝

/** 船身放样站位：`[u, 半宽, 半高, 中心y]`，单位都是「船长比例」，u=0 尾 / u=1 头。
 *  第一轮给的半宽/半高太瘦（0.074/0.041），俯视看只剩两片翅膀在飘、船身完全读不出来，
 *  这一轮整体加粗：半宽 ×1.24、半高 ×1.5，船身才立得住。 */
const HULL_STATIONS: ReadonlyArray<readonly [number, number, number, number]> = [
    [0.020, 0.009, 0.009, 0.040],
    [0.070, 0.038, 0.027, 0.035],
    [0.150, 0.062, 0.042, 0.026],
    [0.250, 0.080, 0.052, 0.017],
    [0.360, 0.090, 0.060, 0.009],
    [0.460, 0.092, 0.062, 0.003],
    [0.540, 0.088, 0.058, -0.001],
    [0.610, 0.075, 0.050, -0.004],
    [0.670, 0.060, 0.039, -0.005],
    [0.710, 0.042, 0.028, -0.005],
    [0.740, 0.028, 0.019, -0.003],
    [0.775, 0.015, 0.011, 0.000],
];

/** 截面环的采样点数（绕一圈）。8 点足够看出「上方略平、下方带龙骨」。 */
const RING_N = 10;

/** u（船长比例）→ 局部 z 坐标（米，L=1 时）。u=0.5 是船中部。 */
function uToZ(u: number) {
    return (u - 0.5) * 0.94;
}

/**
 * 造一个「圆角菱形」截面环。
 * 参考图的船身不是椭圆柱：**上面偏平、下面有龙骨**、左右偏薄。
 * 用一个指数 p<1 的超椭圆再对 y 做非对称拉伸就能出来。
 */
function ringAt(hw: number, hh: number, yc: number): THREE.Vector3[] {
    const P = 0.68; // 越小越「方」；0.68 出来是圆角菱形
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < RING_N; i++) {
        const a = (i / RING_N) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const x = hw * Math.sign(ca) * Math.pow(Math.abs(ca), P);
        let y = hh * Math.sign(sa) * Math.pow(Math.abs(sa), P);
        if (y < 0) y *= 1.35; // 下半拉长 ⇒ 龙骨
        pts.push(new THREE.Vector3(x, y + yc, 0));
    }
    return pts;
}

/**
 * 把放样站位连成三角面。
 * **不做索引复用**：每个三角形自己三个顶点，`computeVertexNormals()` 出来就是
 * 分面（faceted）法线 —— 正好是参考图那种「金属棱面」观感，比平滑着色更像实物。
 */
function buildHull(): THREE.BufferGeometry {
    const rings = HULL_STATIONS.map(([u, hw, hh, yc]) => {
        const r = ringAt(hw, hh, yc);
        const z = uToZ(u);
        for (const p of r) p.z = z;
        return r;
    });

    const pos: number[] = [];
    const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    };
    for (let s = 0; s < rings.length - 1; s++) {
        for (let k = 0; k < RING_N; k++) {
            const k2 = (k + 1) % RING_N;
            push(rings[s][k], rings[s][k2], rings[s + 1][k2]);
            push(rings[s][k], rings[s + 1][k2], rings[s + 1][k]);
        }
    }
    // 尾端封口（头端被尖锥盖住，不用封）
    const tail = rings[0];
    for (let k = 1; k < RING_N - 1; k++) push(tail[0], tail[k], tail[k + 1]);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
}

/** 机头那根细长黑锥。带一点下俯，跟侧视图一致。 */
function buildSpike(): THREE.BufferGeometry {
    const g = new THREE.ConeGeometry(0.018, 0.30, 8, 1, false);
    // ConeGeometry 的轴是 +Y、底面在 -h/2、尖在 +h/2。转成「沿 +Z 指前」。
    g.rotateX(Math.PI / 2);
    g.translate(0, -0.004, uToZ(0.85));
    return g;
}

/**
 * 造一侧机翼。`sign` = +1 右 / −1 左。
 *
 * 展向参数 s∈[0,1]：
 *   前缘 z = root 0.20 → tip −0.36 （后掠 46.6°）
 *   后缘 z = root −0.14 → tip −0.39（后掠 25.3°）
 *   ⇒ 弦长 0.34 → 0.03，收到一个尖
 * 截面 6 点，其中「前缘→上表面」「下表面→前缘」两块面板单独成组 = 金边。
 *
 * 返回值是**一整块**几何体，带两个 group：
 *   group 0 = 银色主体（materialIndex 0）
 *   group 1 = 金色前缘（materialIndex 1）
 */
function buildWing(sign: number): THREE.BufferGeometry {
    const SEC: ReadonlyArray<readonly [number, number]> = [
        [0.00, 0.00], // 0 前缘
        [0.35, 0.50], // 1 上表面最高
        [0.82, 0.22], // 2 上表面靠后
        [1.00, 0.00], // 3 后缘
        [0.82, -0.22], // 4 下表面靠后
        [0.35, -0.50], // 5 下表面最低
    ];
    const NS = 9; // 展向站位
    // 展向站位。注意：这里的 le / te 已经是**船长归一化后的 z 坐标**（±0.47 是首尾），
    // 不再经过 uToZ —— uToZ 只服务「沿船长排布的站位表」（船身/尖锥/宝石）。
    const dih = Math.tan((WING_DIHEDRAL * Math.PI) / 180);

    const silver: number[] = [];
    const gold: number[] = [];
    const inner: number[] = []; // 上表面内侧那一条：用暗银，给机翼一点分块，别整片死白

    // 先把所有站位的截面点算出来
    const rings: THREE.Vector3[][] = [];
    for (let i = 0; i < NS; i++) {
        const s = i / (NS - 1);
        const x = sign * (0.030 + WING_SPAN * s);
        const y = Math.abs(x) * dih; // 上反角：离船身越远抬得越高
        const le = 0.19 - 0.53 * s;
        const te = -0.15 - 0.22 * s;
        const chord = le - te;
        const th = 0.026 * (1 - 0.80 * s);
        rings.push(
            SEC.map(([frac, n]) => new THREE.Vector3(x, y + n * th, le - frac * chord)),
        );
    }

    const emit = (buf: number[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
        buf.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    };
    for (let i = 0; i < NS - 1; i++) {
        for (let k = 0; k < 6; k++) {
            const k2 = (k + 1) % 6;
            const a = rings[i][k], b = rings[i][k2];
            const c = rings[i + 1][k2], d = rings[i + 1][k];
            // 分段材质：
            //   k=0（前缘→上表面）与 k=5（下表面→前缘）= 金色前缘镶边
            //   k=1（上表面内侧那一条）= 暗银，机翼分块
            //   其余 = 亮银
            const buf = k === 0 || k === 5 ? gold : k === 1 ? inner : silver;
            emit(buf, a, b, c);
            emit(buf, a, c, d);
        }
    }

    // ⚠️ group 必须是**连续**的索引区间，所以三块缓冲区要按材质顺序拼：
    //    亮银(0) → 金(1) → 暗银(2)
    const pos = silver.concat(gold, inner);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const nSilver = silver.length / 3;
    const nGold = gold.length / 3;
    const nInner = inner.length / 3;
    g.addGroup(0, nSilver, 0);
    g.addGroup(nSilver, nGold, 1);
    g.addGroup(nSilver + nGold, nInner, 2);
    return g;
}

/** 宝石核心在船上的位置（船长归一化 z）与它坐的高度。
 *  侧视图里它在船中部略偏前。船身加粗后上表面抬到 y≈0.065 ⇒ 宝石跟着抬高。 */
const GEM_Z = 0.022;
const GEM_Y = 0.074;

/**
 * 中央的蓝宝石核心。
 * 用低面数球（8×6 段）压成椭球，**逐面法线** ⇒ 一眼就是「多面切割」而不是玻璃球。
 */
function buildCrystal(): THREE.BufferGeometry {
    const g = new THREE.SphereGeometry(1, 8, 6);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
        p.setXYZ(i, p.getX(i) * 0.044, p.getY(i) * 0.038, p.getZ(i) * 0.068);
    }
    g.translate(0, GEM_Y, GEM_Z);
    const flat = g.toNonIndexed();
    flat.computeVertexNormals();
    return flat;
}

/** 宝石底部的银色托座（一圈扁环，把宝石「镶」进船身）。 */
function buildCollar(): THREE.BufferGeometry {
    const g = new THREE.CylinderGeometry(0.062, 0.052, 0.020, 12, 1, true);
    g.scale(0.78, 1, 1.35);
    g.translate(0, GEM_Y - 0.026, GEM_Z);
    return g;
}

/**
 * 背脊：船顶上一条细长立起来的薄刀。
 * 参考图的侧视图里船背有一条明显隆起的脊线 —— 只靠放样出来的圆润船身，
 * 一盏方向光打上去就是一片死白，什么结构都读不出来。加这条脊立刻有「船」的样子。
 */
function buildSpine(): THREE.BufferGeometry {
    // ⚠️ y 必须**高过船身顶面**才看得见。u=0.40 处船身半高 ≈0.0608、中心 y≈0.0066
    //    ⇒ 顶面在 y≈0.0674。第一版把脊放在 y=0.055（半高 0.013 ⇒ 顶到 0.068），
    //    几乎完全埋进船身里，出图一道脊都看不见。现在抬到 0.074，露出约 2 cm（归一化）。
    const g = new THREE.BoxGeometry(0.010, 0.022, 0.34);
    g.translate(0, 0.070, uToZ(0.40));
    return g;
}

/** 尾下方的小喷口：一圈深色锥 + 一片自发光圆盘。
 *  ⚠️ 同 `buildSpine`：u=0.30 处船身底面在 y≈-0.0617，所以锥口必须挂到 -0.068 以下，
 *     第一版给的 -0.012 是塞在船肚子里面的，出图根本看不到喷口。 */
function buildThruster(): { cone: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
    const z = uToZ(0.30);
    const cone = new THREE.CylinderGeometry(0.038, 0.030, 0.036, 10, 1, true);
    cone.rotateX(Math.PI); // 口朝下
    cone.translate(0, -0.068, z);
    const glow = new THREE.CircleGeometry(0.030, 12);
    glow.rotateX(Math.PI / 2); // 水平、法线朝下
    glow.translate(0, -0.086, z);
    return { cone, glow };
}

export function WingShip({ visible = true }: { visible?: boolean }) {
    const built = useMemo(() => {
        if (!WING_ON) return null;

        const matSkin = new THREE.MeshStandardNodeMaterial();
        matSkin.color.setHex(C_SKIN);
        matSkin.roughness = WING_ROUGH;
        matSkin.metalness = WING_METAL;
        matSkin.emissive.setRGB(0.42, 0.48, 0.62);
        matSkin.emissiveIntensity = WING_EMIS;

        const matSkin2 = new THREE.MeshStandardNodeMaterial();
        matSkin2.color.setHex(C_SKIN2);
        matSkin2.roughness = Math.min(1, WING_ROUGH + 0.18);
        matSkin2.metalness = WING_METAL;
        matSkin2.emissive.setRGB(0.30, 0.35, 0.46);
        matSkin2.emissiveIntensity = WING_EMIS;

        const matGold = new THREE.MeshStandardNodeMaterial();
        matGold.color.setHex(C_GOLD);
        matGold.roughness = 0.26;
        matGold.metalness = 0.88;
        matGold.emissive.setRGB(0.20, 0.14, 0.05);
        matGold.emissiveIntensity = 0.05;

        const matDark = new THREE.MeshStandardNodeMaterial();
        matDark.color.setHex(C_DARK);
        matDark.roughness = 0.52;
        matDark.metalness = 0.62;

        const matGem = new THREE.MeshStandardNodeMaterial();
        matGem.color.setHex(C_GEM);
        matGem.roughness = 0.12;
        matGem.metalness = 0.0;
        matGem.emissive.setRGB(0.14, 0.46, 0.95);
        matGem.emissiveIntensity = GEM_EMIS;
        matGem.flatShading = true;

        const matGlow = new THREE.MeshStandardNodeMaterial();
        matGlow.color.setHex(0x0a1626);
        matGlow.roughness = 0.4;
        matGlow.emissive.setRGB(0.20, 0.72, 1.0);
        matGlow.emissiveIntensity = 1.6;

        // ⚠️ 全部 DoubleSide，两个原因：
        //   1. 左翼是右翼**取镜像**生成的（x 取负）⇒ 三角形绕序反了 ⇒ 单面渲染时左翼只剩背面。
        //      与其事后翻绕序，不如直接双面（薄板本来也该双面）。
        //   2. 托座 / 喷口用的是 openEnded 的柱面，单面从内侧看是空的。
        for (const m of [matSkin, matSkin2, matGold, matDark, matGem, matGlow]) {
            m.side = THREE.DoubleSide;
        }

        const root = new THREE.Group();

        // ⚠️ 船身几何体**没有分 group** —— 传材质数组进去会一个面都不画
        //    （three 渲染数组材质时是遍历 geometry.groups 的，空 groups ⇒ 什么都不渲染）。
        //    所以这里只给单材质。要分色只能像机翼那样自己 addGroup。
        root.add(new THREE.Mesh(buildHull(), matSkin));
        root.add(new THREE.Mesh(buildSpine(), matSkin2));
        root.add(new THREE.Mesh(buildSpike(), matDark));
        root.add(new THREE.Mesh(buildCollar(), matSkin2));
        root.add(new THREE.Mesh(buildCrystal(), matGem));

        // 机翼材质数组顺序必须跟 `buildWing()` 里 addGroup 的顺序一致：
        //   0 亮银 / 1 金 / 2 暗银
        const wingGeo = buildWing(1);
        const wingL = buildWing(-1);
        root.add(new THREE.Mesh(wingGeo, [matSkin, matGold, matSkin2]));
        root.add(new THREE.Mesh(wingL, [matSkin, matGold, matSkin2]));

        const thr = buildThruster();
        root.add(new THREE.Mesh(thr.cone, matDark));
        root.add(new THREE.Mesh(thr.glow, matGlow));

        // 脊线上 6 颗小蓝灯（参考图船背有一串点光）。
        // ⚠️ 船身是 p=0.68 的「圆角菱形」，横向一偏表面就掉得很快
        //    （x=0.030 处顶面只有 y≈0.031），所以灯**必须骑在背脊中线上**，
        //    左右各偏 0.07 会飘在船身外面的半空里。
        const lightGeo = new THREE.SphereGeometry(0.008, 6, 4);
        for (let i = 0; i < 6; i++) {
            const u = 0.28 + i * 0.075;
            const m = new THREE.Mesh(lightGeo, matGlow);
            m.position.set(i % 2 === 0 ? 0.006 : -0.006, 0.076, uToZ(u));
            root.add(m);
        }

        root.traverse((o: any) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });

        root.scale.setScalar(WING_LEN);
        // 半长/半宽按实际包围盒给（船长 0.94、翼展 1.12），让落点采样覆盖到翼尖
        // 半长/半宽必须是**世界米**（`placeOnTerrain` 拿它们直接采样世界坐标），
        // 船身归一化半长 0.47、单侧翼展 WING_SPAN ⇒ 乘船长还原。
        placeOnTerrain(
            root, WING_X, WING_Z, WING_YAW, WING_LIFT,
            0.47 * WING_LEN,
            (WING_SPAN + 0.06) * WING_LEN,
        );

        let tris = 0;
        root.traverse((o: any) => {
            if (o.isMesh && o.geometry?.attributes?.position) {
                tris += o.geometry.attributes.position.count / 3;
            }
        });
        console.info(`[wingship] 建成：船长 ${WING_LEN} m，三角面 ${Math.round(tris)}，上反角 ${WING_DIHEDRAL}°`);
        return root;
    }, []);

    // ⚠️⚠️ 这里**故意什么都不清理**。
    //
    // 一开始写了个「卸载时 dispose 所有 geometry」的 effect：
    //     useEffect(() => () => { built?.traverse(o => o.geometry?.dispose?.()) }, [built])
    // 结果整页炸成空白 —— 报的是
    //     TypeError: Failed to execute 'setIndexBuffer' on 'GPURenderPassEncoder':
    //                parameter 1 is not of type 'GPUBuffer'
    //
    // 原因是 **React 19 dev 的 StrictMode 会把 effect 跑两遍**（挂载 → 清理 → 再挂载），
    // 而 `useMemo` **不会**跟着重建 —— 于是「被 dispose 掉的那批几何体」还挂在场景里，
    // 每帧照样提交 draw call，只是 GPUBuffer 已经没了。
    //
    // 判据：**useMemo 造出来的资源，绝不能挂在 effect 的清理里释放**；
    //       要么跟 `useMemo` 同生命周期，要么用真正只跑一次的卸载钩子。
    //       （`Effects.tsx:138` 记的是同一类 StrictMode 坑，可以对照看。）
    //
    // 这艘船整个 app 生命周期都在场上，本来也没有释放的必要。

    if (!WING_ON || !built) return null;
    return (
        <group visible={visible}>
            <primitive object={built} />
        </group>
    );
}
