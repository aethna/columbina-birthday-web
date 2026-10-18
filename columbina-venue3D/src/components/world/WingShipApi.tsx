/**
 * WingShipApi —— 用**火山方舟 Ark 的图生 3D** 生成的那艘带翼飞船（用户 m03431 / m03778）。
 *
 * ── 为什么要走 API（三条路的结论）──────────────────────────────────────
 * 用户 m03778（逐字）：「建模太不还原。我建议你去找参考图生成建模的免费AI或者直接找
 * 类似的成品。另外这个模型，应该在原神本地游戏数据里有。三条路一起做」
 *
 *   路 2（本地原神素材）：**已穷举三条 dump，确认没有这艘船。**
 *       `公用区\素材\yq_probe\Mesh` 搜 `Ndkl|NodKrai` 命中 30 个、搜 `fly|Hover|Glide`
 *       命中 25 个、搜 `Ship|Ark|Boat` 也过了一遍，没有带翼飞船；
 *       `公用区\霜月素材\`（2391 个文件）里所有 `Property_Ani*` 只有
 *       `Prop_Lunaris{Fruit,Shield,Core,Boost,PT}*` 与 `Prop_MoonFairy{Flower,Hat}_01`
 *       —— 都是道具/植被，没有船。
 *   路 3（本地 Hunyuan3D）：本机 `D:\ComfyUI_ROB3700\ComfyUI` **自带 Hunyuan3D 2.1**
 *       （`comfy\ldm\hunyuan3dv2_1\hunyuandit.py`），卡是 RTX 4070 Ti SUPER 16 GB，
 *       但 `models\` 是空的、权重要 7.37 GB（`Comfy-Org/hunyuan3D_2.1_repackaged`）。
 *       留作兜底，本轮没下。
 *   路 1（图生 3D API）：**成了。**
 *       `POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks`
 *       body `{"model":"doubao-seed3d-2-0-260328","content":[{"type":"image_url",
 *       "image_url":{"url":"data:image/jpeg;base64,..."}}]}`
 *       ⇒ 212 秒 succeeded，回一个 zip，里面是 26.9 MB 的 `mesh_textured_pbr.glb`。
 *       凭据用本机环境变量 `ARK_API_KEY`，
 *       **不用注册新账号、不用装 torch、不用下几十 G 权重**。
 *
 * 输入图是 `路线A-webgpu\_logs\world\SHIPREF_single.png`（1024²）——
 * 用 `_tools\ship_ref.py`（Seedream 5.0，图生图）从用户给的截图反推出来的干净单视图。
 * 生成脚本 `_tools\ship3d.py`，探针 `_tools\ship3d_probe.py`。
 *
 * ── 模型本体的朝向与尺寸（**必须先量再摆**）────────────────────────────
 * GLB 静态 bbox：`x∈[-0.50,0.50]`（长 1.000）、`y∈[-0.070,0.070]`（高 0.140）、
 * `z∈[-0.317,0.317]`（展 0.635）。296,312 顶点 / 499,834 三角 / 2 张 PNG 贴图。
 * ⇒ **长边在 X 轴**，而 `placeOnTerrain()` 的约定是「长边沿局部 Z、短边沿局部 X」
 *   （它内部 `u = ±halfW` 走局部 X、`v = ±halfL` 走局部 Z）。
 *   所以中间夹一层 `inner` 把模型转 90° 摆正，`outer` 才交给 `placeOnTerrain`。
 *
 * ⚠️ 不能直接把旋转/缩放写在交给 `placeOnTerrain` 的那个对象上 ——
 *    它内部会 `obj.rotation.set(0, yaw, 0)` 和 `obj.position.set(...)`，**整个覆盖**。
 *
 * ── 为什么走 `?url` 而不用 public（老坑）─────────────────────────────
 * `vite.config.js` 的 `server.watch.ignored` 覆盖整个 public 目录 ⇒ 往里加文件必须
 * 重启 dev server 才认。走 `src/assets/` + Vite 的 `?url` 就吃 HMR。
 *
 * ⚠️ 写块注释时**不要让「星号+斜杠」连续出现**（别拿通配符去描述目录），
 *    那会提前把注释关掉（本轮踩过一次，报 `Unexpected reserved word`）。
 */
import { useEffect, useState } from 'react';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { QNUM } from '../../core/utils/query';
import { CRATERS, worldHeightCPU } from '../../core/worldRegions';
import { placeOnTerrain } from './MoonShip';

import shipGlbUrl from '../../assets/wingship_api/Ship01.glb?url';

/** 总开关。**默认开**（这是用户点名要的那艘船）；`?wapi=0` 关掉。 */
export const WAPI_ON = QNUM('wapi', 1)! > 0;

/** 船在坑里的落点（世界坐标 XZ），默认就是 CRATERS[0] 的圆心。 */
const API_X = QNUM('wx', CRATERS[0].x)!;
const API_Z = QNUM('wz', CRATERS[0].z)!;

/** **最长水平边**的世界米数。26 m 对着 r=46 的坑是「大件但不塞满」。 */
const API_LEN = QNUM('wlen', 26)!;

/** 把模型本体的长边转到局部 Z 轴所需的偏航角（度）。量错就改这个。 */
const API_ROT = QNUM('wrot', -90)!;

/** 绕竖直轴的停放朝向（度）。 */
const API_YAW = QNUM('wyaw', -24)!;

/** 离地余隙（米）。⚠️ 有 `API_BURY` 之后这个基本只用于微调，默认 0。 */
const API_LIFT = QNUM('wlift', 0)!;

/**
 * **埋深（米）** —— 用户 m04461：「飞船模型下移，半截埋进土，能看到翅膀就行」。
 *
 * 用 `_tools\glbwings.mjs` 量过这台模型的三向尺寸与机翼高度（归一化后 ×26 m）：
 *   展 1.0000 (X) × 长 0.6349 (Z) × 高 0.1399 (Y)  ⇒ 世界 26.0 × 16.5 × 3.64 m
 *   **展向最外侧 25% 的机翼顶点**：y ∈ [-0.0273, +0.0361]
 *     ⇒ 相对龙骨底面 = **1.11 m ~ 2.76 m**
 *   ⚠️ 所以**埋深超过 1.11 m 机翼尖就全没了**，超过 2.76 m 连机翼根都没了。
 *   龙骨/发动机舱在展向 25%~33% 处，低到 y = -0.0699（就是底面），中线船体只有
 *   y ∈ [-0.0329, +0.0699]（0.96 m ~ 3.64 m）—— 也就是说**船肚子本来就悬在龙骨上方 1 m**。
 *   埋 1.05 m 正好把发动机舱和龙骨吃掉、机翼自下缘起完整露出来。
 * `?wbury=` 调；给 0 = 原样趴在地上，给负数 = 浮起来。
 *
 * ⚠️⚠️★ 2026-10-10（用户 m05344「坑范围缩小，只需要把飞船放里面就行了」）
 *   **默认值 0.90 → 0.30**。原因不是「埋得不够深」，而是**坑变小了**：
 *   环形山半径 46 → 24 m 之后，坑壁在船翼尖所在的 13 m 处已经抬升了 `d·169/r²`。
 *   翼尖只在龙骨上方 1.48 m ⇒ 原来那 0.90 m 的埋深会让翼尖扎进坑壁上。
 *   推导见 `core/worldRegions.ts` 里 `CRATERS` 上方那段「约束 A / 约束 B」。
 *   一句话：**「坑明显」+「翼尖露出」+「坑小」三者数学上不相容**（要坡度 ≥0.3
 *   且翼尖不埋，radius 得 ≥44 m）。本轮选择保「坑明显 + 翼尖露出」，把船抬高。
 *   想回到旧手感用 `?wbury=0.90`。
 */
const API_BURY = QNUM('wbury', 0.30)!;

const API_ROUGH = QNUM('wrough', 0.34)!;
const API_METAL = QNUM('wmetal', 0.45)!;
/** 自发光强度。GLB 没有 emissive 贴图，这里只给一点点，纯为夜景不塌成黑块。 */
const API_EMIS = QNUM('wemis', 0.05)!;

async function buildApi(sb: string[]): Promise<THREE.Group | null> {
    let gltf: any;
    try {
        gltf = await new GLTFLoader().loadAsync(shipGlbUrl);
    } catch (e) {
        sb.push(`[wingship-api] GLB 加载失败: ${e}`);
        return null;
    }

    const inner = new THREE.Group();
    inner.add(gltf.scene);
    inner.rotation.y = (API_ROT * Math.PI) / 180;

    // ── 用一次 bbox 量出「转正之后」的水平尺寸，据此定缩放与半长半宽 ──
    const probe = new THREE.Group();
    probe.add(inner);
    probe.updateMatrixWorld(true);
    const b0 = new THREE.Box3().setFromObject(probe);
    const s0 = b0.getSize(new THREE.Vector3());
    const span = Math.max(s0.x, s0.z);
    if (!(span > 1e-6)) {
        sb.push('[wingship-api] bbox 退化，放弃');
        return null;
    }
    const k = API_LEN / span;
    inner.scale.setScalar(k);

    probe.updateMatrixWorld(true);
    const b1 = new THREE.Box3().setFromObject(probe);
    const s1 = b1.getSize(new THREE.Vector3());
    // 模型原点基本在几何中心 ⇒ 整体下移，让最低点落在 group 原点上
    inner.position.y = -b1.min.y;

    const halfL = s1.z / 2;
    const halfW = s1.x / 2;
    sb.push(
        `[wingship-api] 原始 ${s0.x.toFixed(3)}x${s0.y.toFixed(3)}x${s0.z.toFixed(3)}` +
        ` × ${k.toFixed(3)} ⇒ ${s1.x.toFixed(2)}x${s1.y.toFixed(2)}x${s1.z.toFixed(2)} 米` +
        `  (半长 ${halfL.toFixed(2)} / 半宽 ${halfW.toFixed(2)})`,
    );

    let meshCount = 0;
    gltf.scene.traverse((o: any) => {
        if (!o.isMesh) return;
        meshCount++;
        const src = o.material as THREE.MeshStandardMaterial;
        const m = new THREE.MeshStandardNodeMaterial();
        if (src?.map) m.map = src.map;
        if (src?.normalMap) m.normalMap = src.normalMap;
        if (src?.aoMap) m.aoMap = src.aoMap;
        m.roughness = API_ROUGH;
        m.metalness = API_METAL;
        m.emissive.setRGB(0.60, 0.66, 0.82); // 冷白，避免夜景纯黑
        m.emissiveIntensity = API_EMIS;
        m.side = THREE.FrontSide;
        o.material = m;
        o.castShadow = false;
        o.receiveShadow = false;
    });
    sb.push(`[wingship-api] 网格 ${meshCount} 个`);

    const outer = new THREE.Group();
    outer.add(inner);
    // 注意：placeOnTerrain 会覆盖 outer 的 position/rotation，所以模型自身的
    // 旋转与缩放必须待在 inner 上（上面已经这么做）。
    // 这里 lift 传 0，位置随后自己接管（见下）。
    placeOnTerrain(outer, API_X, API_Z, API_YAW, 0, halfL, halfW);

    // ── 半埋（用户 m04461）──────────────────────────────────────────────
    // 不用 placeOnTerrain 算出来的位置：它取的是**船底 footprint 的最高点** `yMax`
    // + lift，埋深会随 footprint 大小和坑壁起伏漂移，没法预期。
    // 改成以**船中心正下方的地形高度**为基准，底面正好落在它下面 API_BURY 米处。
    // 姿态（俯仰/横滚）仍然沿用上面那一次最小二乘拟合的结果。
    const hGround = worldHeightCPU(API_X, API_Z);
    outer.position.y = hGround + API_LIFT - API_BURY;
    sb.push(
        `[wingship-api] 地面 ${hGround.toFixed(3)} m，埋深 ${API_BURY} m` +
        ` ⇒ 底面 y=${outer.position.y.toFixed(3)}，船顶 y=${(outer.position.y + s1.y).toFixed(3)}` +
        `（船高 ${s1.y.toFixed(2)} m，机翼露出 ${(s1.y - API_BURY).toFixed(2)} m）`,
    );
    return outer;
}

export function WingShipApi({ visible = true }: { visible?: boolean }) {
    const [obj, setObj] = useState<THREE.Group | null>(null);

    useEffect(() => {
        if (!WAPI_ON) return;
        let dead = false;
        const sb: string[] = [];
        buildApi(sb)
            .then((o) => { if (!dead && o) setObj(o); })
            .catch((e) => console.warn('[wingship-api] 构建失败:', e))
            .finally(() => { for (const s of sb) console.info(s); });
        return () => { dead = true; };
        // ⚠️ 这里**不能**加清理去 dispose 几何体：useMemo/一次性构建出来的资源
        //    挂在 React 19 StrictMode 的「挂载→清理→再挂载」上会被提前释放，
        //    但对象还在场景里照常提交 draw call ⇒
        //    `TypeError: Failed to execute 'setIndexBuffer' ... not of type 'GPUBuffer'`。
        //    船整个 app 生命周期都在场上，本来也不需要释放。
    }, []);

    if (!WAPI_ON || !obj) return null;
    return (
        <group visible={visible}>
            <primitive object={obj} />
        </group>
    );
}
