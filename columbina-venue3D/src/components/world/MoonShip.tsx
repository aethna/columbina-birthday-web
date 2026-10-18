/**
 * MoonShip —— 停泊在月球环形山里的「月船」（用户 m03431）。
 *
 * ── 素材从哪来（★ 关键：**不是自己建的模**）────────────────────────────
 * 用户给了参考图 `公用区\背景素材\素材\背景素材10.png`（一张原神截图，
 * 描边/UID 都在），要求「建模放进月壤的坑里」。
 * 但**不用建模，也不用 AI 图生 3D** —— 真素材就在本机：
 *
 *   `公用区/素材/yq_probe/Mesh/Property_Ani_Prop_MoonShip_01_Lod0.obj`   1,026,596 B  7,536 三角面
 *   `公用区/素材/yq_probe/Texture2D/Property_Ani_Prop_MoonShip_01_Diffuse.png`  606,209 B
 *   `公用区/素材/yq_probe/Texture2D/Property_Ani_Prop_MoonShip_01_Normal.png`   839,893 B
 *   `公用区/素材/yq_probe/Texture2D/Property_Ani_Prop_MoonShip_01_SMBE.png`     352,432 B
 *
 * 判定依据：`MoonShip_01_Diffuse` 打开就是**白象牙船身 + 淡紫面板 + 金色镶边 +
 * 青/紫宝石核心**，与参考图逐项对得上；而 `MoonShip_02_Diffuse` 是一张
 * **云朵/树叶的 sprite 图集**（那是别的东西，不是船）。所以取 01。
 * 另有 `Eff_Model_Quest_MoonShip_Glow_01..07` / `_Wave_01..04` 七组辉光壳，
 * 那是原神拿来叠光效的，本轮先不用（见「还留着的」）。
 *
 * 这正好落实用户 m01242 定下的方向：「总不能写实海面、月球风格地貌全网没有能用的，
 * 一定要你从头建模？」——**能捡现成的就捡现成的**。（会场那边也一样，见 `VenuePropsReal.tsx`。）
 *
 * ── 为什么用 `?raw` + OBJLoader 而不是丢 `public/` ────────────────────
 * `vite.config.js` 的 `server.watch.ignored` 覆盖了整个 public 目录 ⇒
 * **往 public 里加文件必须重启 dev server 才认**（这是踩过多次的老坑）。
 * 走 `src/assets/` + Vite 的 `?raw` / `?url` 导入就吃 HMR，**不用重启**。
 *
 * ⚠️ 写注释时**不要在块注释里出现「星号+斜杠」的连续两字符**（比如拿 glob 通配符
 *    去描述 public 目录）—— 那会**提前把块注释关掉**，剩下的字变成代码，
 *    报的是莫名其妙的 `Unexpected reserved word`。本轮就这么翻过一次车。
 *
 * ── 落点与姿态 ─────────────────────────────────────────────────────
 * 落在 `CRATERS[0]`（`(0, -196, r=46, depth=7.5, rim=2.2)`）—— 全场最大的那个坑。
 * 坑底是个**碗**（不是平的），所以 y / 俯仰 / 横滚全部由
 * `worldHeightCPU` **采样船底 5×5 网格**算出来：
 *   y   = 采样到的最高点 + 一点点余隙（保证不陷进地面）
 *   pitch/roll = 最小二乘拟合出的地面坡度
 * 因为月球区基础 FBM 被 `(1-mask)` 淡出成 0，`worldHeightCPU` 与 GPU 的
 * `getWorldHeight()` **逐位相等** ⇒ 船**精确坐在坑底**，不浮不穿。
 */
import { useEffect, useState } from 'react';
import * as THREE from 'three/webgpu';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { QNUM } from '../../core/utils/query';
import { CRATERS, worldHeightCPU } from '../../core/worldRegions';

import shipObjRaw from '../../assets/moonship/MoonShip_01.obj?raw';
import diffUrl from '../../assets/moonship/MoonShip_01_Diffuse.png';
import normUrl from '../../assets/moonship/MoonShip_01_Normal.png';

/** 总开关。**默认关**（用户 m03431 点名要的是参考图那艘带翼飞船 ⇒ 见 `WingShip.tsx`，
 *  它默认占了 `CRATERS[0]`）。想把这艘月牙小舟调出来看，加 `?ship=1`。 */
export const SHIP_ON = QNUM('ship', 0)! > 0;

/** 船整体缩放。OBJ 原始最长边 9.178 ⇒ 1.7 倍 ≈ 15.6 米（对着 r=46 的坑，是「大件」但不塞满） */
const SHIP_SCALE = QNUM('shipscale', 1.7)!;

/** 船在坑里的落点（世界坐标 XZ）。默认就是 CRATERS[0] 的圆心，`?shipx= ?shipz=` 可挪 */
const SHIP_X = QNUM('shipx', CRATERS[0].x)!;
const SHIP_Z = QNUM('shipz', CRATERS[0].z)!;

/** 绕 Y 轴的朝向（度）。0 = 船头朝 +Z */
const SHIP_YAW = QNUM('shipyaw', 32)!;

/** 船底相对地面的抬升（米）。正数 = 微微悬停，负数 = 压进地里 */
const SHIP_LIFT = QNUM('shiplift', 0.05)!;

/** 材质：船身很亮，但**不要镜面成镜子**。参考图是哑光珍珠漆 + 局部金边。 */
const SHIP_ROUGH = QNUM('shiprough', 0.38)!;
const SHIP_METAL = QNUM('shipmetal', 0.12)!;

/** 船体自发光。原神是靠 `SMBE` 的 B 通道标出发光区的；
 *  本轮先给一个**很弱**的整船自发光当夜景兜底（与碎石同理，见 `RegionProps.tsx` 的 STONE_EMIS），
 *  真正的宝石核心辉光留给下一轮。 */
const SHIP_EMIS = QNUM('shipemis', 0.03)!;

/**
 * 把物体贴到地形上。
 *
 * 坑底是个碗 ⇒ 直接把船摆平会**一头扎进土里**（船有 15 米长，碗底 46 米宽，
 * 两端的高度差可以有 1~2 米）。所以：
 *   1. 在船底footprint（按 yaw 旋转后的 5×5 网格）上采一遍 `worldHeightCPU`；
 *   2. 取最高点当 y ⇒ 保证**没有任何一角低于地面**；
 *   3. 用 x/z 方向的一阶差分拟合坡度 ⇒ pitch/roll。
 */
export function placeOnTerrain(
    obj: THREE.Object3D, x: number, z: number, yawDeg: number, lift: number,
    halfL: number, halfW: number,
) {
    const yaw = (yawDeg * Math.PI) / 180;
    const c = Math.cos(yaw), s = Math.sin(yaw);

    let yMax = -Infinity;
    // 最小二乘拟合 h ≈ a·u + b·v（u = 船体局部 X，v = 船体局部 Z）
    let n = 0, Su = 0, Sv = 0, Suu = 0, Svv = 0, Suv = 0, Sh = 0, Shu = 0, Shv = 0;

    for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
            const u = (i / 2) * halfW;
            const v = (j / 2) * halfL;
            // 局部 → 世界
            const wx = x + u * c + v * s;
            const wz = z - u * s + v * c;
            const h = worldHeightCPU(wx, wz);
            if (h > yMax) yMax = h;
            n++; Su += u; Sv += v; Suu += u * u; Svv += v * v; Suv += u * v;
            Sh += h; Shu += h * u; Shv += h * v;
        }
    }

    // 解 2×2 正规方程 [Suu Suv; Suv Svv][a;b] = [Shu - Su·Sh/n; Shv - Sv·Sh/n]
    const mu = Su / n, mv = Sv / n, mh = Sh / n;
    const A11 = Suu - n * mu * mu, A22 = Svv - n * mv * mv, A12 = Suv - n * mu * mv;
    const b1 = Shu - n * mu * mh, b2 = Shv - n * mv * mh;
    const det = A11 * A22 - A12 * A12;
    const a = det > 1e-9 ? (b1 * A22 - b2 * A12) / det : 0; // ∂h/∂u
    const b = det > 1e-9 ? (b2 * A11 - b1 * A12) / det : 0; // ∂h/∂v

    obj.position.set(x, yMax + lift, z);
    // 先 yaw，再按坡度低头/侧倾（顺序不能反：坡度是在**已经转好的局部轴**上量的）
    obj.rotation.set(0, yaw, 0);
    obj.rotateX(-b); // 局部 +Z 上坡 ⇒ 抬头
    obj.rotateZ(a);  // 局部 +X 上坡 ⇒ 右倾
    obj.updateMatrixWorld(true);
}

async function buildShip(sb: string[]): Promise<THREE.Group | null> {
    let root: THREE.Group;
    try {
        root = new OBJLoader().parse(shipObjRaw) as THREE.Group;
    } catch (e) {
        sb.push(`[moonship] OBJ 解析失败: ${e}`);
        return null;
    }

    const tex = new THREE.TextureLoader();
    let diff: THREE.Texture | null = null;
    let norm: THREE.Texture | null = null;
    try {
        [diff, norm] = await Promise.all([tex.loadAsync(diffUrl), tex.loadAsync(normUrl)]);
    } catch (e) {
        sb.push(`[moonship] 贴图加载失败，船会用纯色: ${e}`);
    }

    if (diff) {
        diff.colorSpace = THREE.SRGBColorSpace;
        diff.anisotropy = 8;
        diff.wrapS = diff.wrapT = THREE.ClampToEdgeWrapping;
    }
    if (norm) {
        // 原神的 Normal 图是标准切线空间 GL 约定（R/G 已居中），直接用
        norm.anisotropy = 8;
        norm.wrapS = norm.wrapT = THREE.ClampToEdgeWrapping;
    }

    let meshCount = 0;
    root.traverse((o: any) => {
        if (!o.isMesh) return;
        meshCount++;
        const m = new THREE.MeshStandardNodeMaterial();
        if (diff) m.map = diff;
        if (norm) m.normalMap = norm;
        m.roughness = SHIP_ROUGH;
        m.metalness = SHIP_METAL;
        m.color.setRGB(1.0, 1.0, 1.0);
        m.emissive.setRGB(0.55, 0.62, 0.80); // 冷白，避免夜景纯黑
        m.emissiveIntensity = SHIP_EMIS;
        m.side = THREE.FrontSide;
        o.material = m;
        o.castShadow = false;
        o.receiveShadow = false;
    });
    sb.push(`[moonship] 网格 ${meshCount} 个，三角面见 obj 头注释`);

    root.scale.setScalar(SHIP_SCALE);
    placeOnTerrain(root, SHIP_X, SHIP_Z, SHIP_YAW, SHIP_LIFT, 4.6 * SHIP_SCALE, 2.0 * SHIP_SCALE);
    return root;
}

export function MoonShip({ visible = true }: { visible?: boolean }) {
    const [obj, setObj] = useState<THREE.Group | null>(null);

    useEffect(() => {
        if (!SHIP_ON) return;
        let dead = false;
        const sb: string[] = [];
        buildShip(sb)
            .then((o) => { if (!dead && o) setObj(o); })
            .catch((e) => console.warn('[moonship] 构建失败:', e))
            .finally(() => { for (const s of sb) console.info(s); });
        return () => { dead = true; };
    }, []);

    if (!SHIP_ON || !obj) return null;
    return (
        <group visible={visible}>
            <primitive object={obj} />
        </group>
    );
}
