/**
 * RegionProps —— 新区域（月球 / 浅海）的散置道具：月岩、礁石、遗迹。
 *
 * ── 为什么这个组件比 `VenuePropsReal` 简单得多 ────────────────────────
 * 会场那套道具必须跟角色碰撞、跟树环公式对齐；新区域**是有限圆盘**
 * （`REGIONS` 里 moon / sea 都是 r = 120 米），位置是死的 ⇒
 * 一次性在世界坐标里摆好，**不需要跟相机流式加载**。
 *
 * ── 关键：y 从哪来（这是整套区域系统的兑现点）────────────────────────
 * `scatterRegion()` 内部调 `worldHeightCPU(x,z)` 把高度算好了放进 `ScatterItem.y`。
 * 而 GPU 侧 `getWorldHeight()`（`core/shaders/worldHeight.ts`）与它**逐位同式**：
 * 新区域的基础 FBM 被 `(1 - mask)` 淡出到 0，只留解析式的环形山 / 盆地 / 微起伏。
 * 所以在 `regionWeight >= minWeight` 的地方 CPU 与 GPU 严格相等
 * ⇒ **道具精确贴地，不浮不埋**。
 *   会场那边是做不到了（基础 FBM 是 MaterialX 噪声，JS 复刻不出逐位一致），
 *   所以会场道具仍然是 `y = 0` 写死 —— 那里地形只有 ±0.55 米，蒙得过去。
 *
 * ── 摆位分四组 ──────────────────────────────────────────────────────
 *   月球·坑底碎岩   150 件  小、密、只摆平处（maxSlope 0.45）
 *   月球·坑缘巨石    26 件  大、稀、不限坡度（坑缘很陡）
 *   月球·环状遗迹     8 件  对齐背景素材 7 里那些环形遗构
 *   浅海·礁石        90 件  将来灌水之后就是出水的礁石
 *
 * 素材全部是 Poly Haven CC0（见 `VenuePropsReal.tsx` 文件头），
 * GLB 已归一化成「高度 = 1、底面贴地」⇒ **scale 直接就是米**。
 */
import { useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import {
    vec3, vec4, float, dot,
    positionLocal, modelWorldMatrix, cameraViewMatrix, cameraPosition, normalView,
    texture, uv,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { QNUM } from '../../core/utils/query';
import { REGION_BY_ID, scatterRegion, type ScatterItem } from '../../core/worldRegions';
import { loadMoonRegolith, type GroundMaps } from '../../core/textures/groundMaps';
import { uSunDir } from '../../core/shaders/uniforms';

/* ★★★ 月岩走和地面**同一套 Lommel-Seeliger**（用户 m04461 点名要的「遗留问题」之一）。
 *
 * 为什么必须接：地面材质在 `Terrain.tsx` 里乘了一个 `0.785/(μ0+μ)` 的 LS 因子
 * （正午水平视角约 **0.75 倍 Lambert**），而石头走的是标准 PBR（= 1.0 倍 Lambert）
 * ⇒ **两者恒差 1/0.75 ≈ 1.33 倍**，正午一看石头就比月壤白一截，像贴上去的。
 * 上一轮只能靠手调 `m.color` 的 0.74 乘子去「猜」这个差 —— 那是把一个视角相关的量
 * 硬编成常数，换个太阳高度就不对了。这里改成真算。
 *
 * ⚠️ 常量必须和 `Terrain.tsx` 的 `MOON_LS_*` 用**同名 URL 参数**，否则两个开关会打架。 */
const ROCK_LS_ON = QNUM('ls', 1)! > 0 ? 1 : 0
const ROCK_LS_GAIN = QNUM('lsgain', 0.95)!
const ROCK_LS_CAP = QNUM('lscap', 3.2)!
const ROCK_LS_SURGE = QNUM('lsurge', 0.30)!

/** 夜空里道具偏暗，给个整体增益（`?regiongain=` 可覆盖） */
const GAIN = QNUM('regiongain', 1.0)!;
/** 自发光补光强度。必须让自发光**跟着贴图走**（见 `VenuePropsReal.tsx` 的 EMIS 注释），
 *  否则会糊上一层与贴图无关的灰。新区域比会场亮（月壤受太阳直射），所以给得比 0.34 低。 */
const EMIS = QNUM('regionemis', 0.16)!;

/**
 * ⭐ 月壤碎石的自发光强度（2026-10-09 新增，用户 m03192/m03199「月壤的岩石不行…和月壤配色风格不搭边」）。
 *
 * 旧版碎石直接沿用 `EMIS = 0.16`，而且 `emissiveMap = albedo`。
 * 那等于在**受光之外**又平铺一层 16% 的反照率常量 —— 石头于是**不随光照变化**：
 * 太阳压低、月壤被 Lommel-Seeliger 打亮或压暗时，石头永远那么亮那么白，
 * 看起来就是「一堆塑料疙瘩糊在照片上」。**这才是「不搭边」的真凶，不是色相。**
 * 月岩和月壤本来就是同一种物质（粒径不同而已），受光必须一致 ⇒ 自发光压到近乎 0，
 * 让石头**完全靠场景光照**，与地面同呼吸。`?stoneemis=` 可覆盖。
 */
const STONE_EMIS = QNUM('stoneemis', 0.0)!;

/**
 * ★ 色偏。第 5 轮渲出来是**土黄色的一堆沙漠巨石**，不像月球。
 * Poly Haven 那套 `moon_rock_*` 贴图本身是暖棕的岩石照片，
 * 直接铺在灰蓝月壤上非常跳。这里统一往「冷灰」压：
 * 反照率乘 `(0.50, 0.54, 0.60)`（蓝通道留得多 ⇒ 偏冷），自发光也跟着换色，
 * 否则 `emissiveMap = map` 会把贴图那层暖棕又加回来。
 * `?regiontint=1` 可关掉做对照。
 */
const TINT_ON = QNUM('regiontint', 1)! > 0;
const TINT = new THREE.Color(0.50, 0.54, 0.60);

/** 只列新区域用得到的几件（url 与 `VenuePropsReal.tsx` 的 ASSETS 一致） */
const ASSETS: Record<string, { url: string; h: number }> = {
    rock_a: { url: '/venue/real/rock_a.glb', h: 0.50 },
    rock_b: { url: '/venue/real/rock_b.glb', h: 0.42 },
    rock_c: { url: '/venue/real/rock_c.glb', h: 0.38 },
    rock_d: { url: '/venue/real/rock_d.glb', h: 1.00 },
    fort_wall: { url: '/venue/real/fort_wall.glb', h: 4.2 },
    fort_gate: { url: '/venue/real/fort_gate.glb', h: 6.0 },
    fort_tower: { url: '/venue/real/fort_tower.glb', h: 5.4 },
};

interface Group {
    name: string;
    items: ScatterItem[];
}

/**
 * 散置方案。**必须确定性**（`scatterRegion` 内部用 `Math.imul` 的 PCG 哈希，
 * 不是 `fract(sin())` —— 判据 N），否则每次刷新道具都会换位置，截图无法复现。
 */
function planGroups(): Group[] {
    const moon = REGION_BY_ID.moon;
    // ⚠️ 2026-10-11 删海（m05607）后 `REGION_BY_ID.sea` 已是 `undefined`。
    //    原来的守卫 `if (!moon || !sea) return []` 会让**整组月球碎石消失**，
    //    因为 `undefined` 是 falsy ⇒ 直接返回空数组。
    if (!moon) return [];

    return [
        // 月球 · 月壤上的碎石子。
        // ⚠️⚠️ 2026-10-09 改（用户 m03199 逐字：「月壤不用做那么大石块，沙地/土地+碎石子就行」）。
        //    上一版是 260 件 0.22~0.95 m + 另外 10 件 **2.0~4.5 m 的巨石**
        //    （`moon-boulder`，这一版**整组删掉**）—— 渲出来是「一片沙漠里蹲着一堆大石包」，
        //    不是月壤。真实月面在人的尺度上就是**沙土 + 指甲盖到拳头大的碎石**，
        //    大石头只出现在坑缘与陡坡上，而那种尺度应该由**环形山几何本身**表达，
        //    不该靠摆模型（摆了也不对：模型是地球砂岩的形，不是月岩的形）。
        //    现在：高度压到 0.09~0.34 m（≈ 拳头大），件数提到 420 件、最小间距收到 1.9 m，
        //    读起来才是「地面上洒了一层碎石」而不是「几块大石头」。
        //    ⚠️ 件数不能无脑往上加：`buildRegionProps` 是 `src.clone(true)` 逐件 clone，
        //       不是实例化 ⇒ 一件 = 至少一次 draw call。420 件已经接近这条路的预算上限。
        //    ⚠️⚠️ 2026-10-11 用户 m07134：「月壤区域整个缩小，只留下一个装飞船的坑」。
        //       月球区域从 r=120 缩到 r=40（且圆心挪到坑心），可散布面积小了 9 倍
        //       （π·120² = 45239 m² → π·26.8² = 2256 m²，26.8 是 `minWeight=0.92` 的边界）。
        //       件数必须跟着缩，否则同一块地上石头密度变 9 倍：**420 → 180**。
        {
            name: 'moon-field',
            items: scatterRegion(moon, 180, ['rock_a', 'rock_b', 'rock_c', 'rock_d'], {
                salt: 21, hMin: 0.09, hMax: 0.34,
                minGap: 1.9, innerGap: 3.0, maxSlope: 0.60, minWeight: 0.92,
            }),
        },
        // ⚠️⚠️ 2026-10-09 用户 m04735：「浅海中去掉石头只有水」「飞船周围出现了莫名的石门」
        //  ⇒ **`sea-reef`（90 件礁石）与 `moon-ruin`（8 件遗迹）两组整组删掉。**
        //  浅海那组本来是想做「灌水后露出水面的礁石」，但用户要的是**只有水**。
        //  月坑那组摆的是会场那套 `fort_wall / fort_gate / fort_tower`（原神风格的石门/城墙），
        //  摆到月壤上就是「一圈莫名其妙的石门」，与月面完全不是一套语汇 —— 删。
    ];
}

/**
 * ⭐ 「月面皮肤」：把会场那套暖砂岩（`rock_a..d` 本来是红色沙漠岩）换成真正的月壤。
 *
 * 用户 m01700/m01545 连着两轮说「画质和原本的草地差的不是一个档次」。
 * 其中一个具体、便宜且明显的病灶就是：**月球的石头是橘黄色的**。
 * 原来只做了 `m.color.multiply(TINT)`（`TINT = (0.50,0.54,0.60)`），
 * 那只是把贴图**乘暗**，乘不改变色相 —— 暖砂岩乘完还是暖砂岩，
 * `V5_moon_lowsun.png` 里整片橘色巨石蹲在灰月壤上，一眼就出戏。
 *
 * 这里直接**换贴图**：albedo / normal / roughness 全换成已经下载好的
 * Poly Haven `moon_dusted_01`（真月壤扫描，CC0）—— 那是现成资源，
 * 比给石头单独建模或调色都便宜，而且一换就是「同一种材料」。
 * 每个 mesh 克隆一份材质和贴图参数，避免和浅海那批石头互相踩。
 */
function applyMoonSkin(root: THREE.Group, maps: GroundMaps): void {
    /* ⚠️ `repeat` 的物理含义：这张贴图是 **2 m 见方**的真实月壤扫描，
       `maps.tile = 2.6` ⇒ 1 个 UV 单位 = 2.6 m。石头现在是 0.09~0.34 m 的碎石，
       整块石头只占 2.6 m 里的十分之一 ⇒ **repeat 必须远小于 1** 才对得上颗粒尺度。
       旧值 2.4 意味着「2.6 m 的贴图塞进 0.1 m 的石头」，纹路被拉成 26 倍密度的细沙噪声，
       在 0.2 m 的屏幕上就是一片糊 —— 这也是「塑料感」的一半来源。
       现在取 1.0：0.2 m 的石头上铺 2.6 m 的贴图，颗粒比石头本身还大，
       效果是**石头本身是均匀的一色**（正确：这么小的碎石在真实照片里就是一个小色块），
       靠 PBR 明暗而不是靠花纹来读。 */
    const ALB_REPEAT = 1.0;
    const alb = maps.albedo.clone();
    alb.repeat.set(ALB_REPEAT, ALB_REPEAT); alb.needsUpdate = true;
    const nrm = maps.normal.clone();
    nrm.repeat.set(ALB_REPEAT, ALB_REPEAT); nrm.needsUpdate = true;
    const rgh = maps.rough.clone();
    rgh.repeat.set(ALB_REPEAT, ALB_REPEAT); rgh.needsUpdate = true;

    root.traverse((o: any) => {
        if (!o.isMesh) return;
        const old = o.material as any;
        if (!old) return;
        /* ⚠️ 必须换成 `MeshStandardNodeMaterial`：`colorNode` 是 TSL 才有的入口，
           普通 `MeshStandardMaterial` 上写它会被**静默忽略**（vite 只转译不查类型）。
           `applyMoonSkin` 只被 `moon-*` 组调用 ⇒ 会场与浅海的石头零回归。 */
        const m = new THREE.MeshStandardNodeMaterial();
        m.side = old.side ?? THREE.FrontSide;
        m.map = alb;
        m.normalMap = nrm;
        m.roughnessMap = rgh;
        m.roughness = 1.0;
        m.metalness = 0.0;
        // ⭐ 这一行是「石头仍然发橘」的真凶，不是 TINT 的问题：
        //   `moon_dusted_01_diff_2k.jpg` 自身的逐通道均值是 **R 0.4950 / G 0.4686 / B 0.4295**
        //   —— 这张真实月壤扫描本身就带暖偏。但**这层暖偏是正确的**（月壤光谱随波长上升），
        //   所以这里不再像月面地形那样把它除掉，而是让石头保持同一族色相。
        //   ⚠️ 2026-10-09 重算（用户 m02280 重做月面配色之后）：
        //      旧目标是 (0.40,0.42,0.46) —— 那是配**旧的冷蓝月面 `#5d6570`** 定的，
        //      现在月面底色换成暖中性灰 `#7d7666`=(0.49,0.46,0.40)，石头若还用冷蓝就是「两块料」。
        //      真实月球上**岩石与月壤反照率本来就接近**（都是同一批物质，只是粒径不同），
        //      所以目标改为比月陆略暗一点的同族暖灰 ≈ (0.42,0.395,0.35)：
        //          乘子 = 目标 ÷ 贴图均值 = (0.85, 0.84, 0.82)   ← 近乎中性、微暖
        //   ⚠️ 第一版给的是 (1.05,1.17,1.40)，正午一看石头白得像冰块（`V8_moon_noon.png`）。
        //   ⚠️ 2026-10-09 二次修正：0.85 → **0.74**。
        //      去掉自发光提亮之后，正午一比石头还是比月壤**亮约 34%**（`FIX_noon_stand.png`）。
        //      根因不在色调而在**BRDF 不同**：地面走 Lommel-Seeliger（正午水平视角下只有
        //      0.785/(μ0+μ) ≈ 0.75 倍 Lambert），石头走标准 PBR（= 1.0 倍 Lambert）
        //      ⇒ 两者的比值恒为 1/0.75。这里先把石头压暗 13% 把差距拉到可接受，
        //      **真正的修法是把同一套 LS 也接到石头的 `colorNode` 上**（记在「还留着的」里）。
        m.color.setRGB(0.74, 0.73, 0.71);
        /* ★★★ 真正的修法（承上面 178-183 行的说明）：把地面那套 Lommel-Seeliger
           接到石头的 `colorNode` 上，别再拿常数 0.74 去猜那个和视角相关的量。 */
        if (ROCK_LS_ON) {
            const worldPos = modelWorldMatrix.mul(vec4(positionLocal, float(1.0))).xyz
            const Lv = cameraViewMatrix.transformDirection(uSunDir).normalize()
            const Vv = cameraViewMatrix.transformDirection(cameraPosition.sub(worldPos)).normalize()
            const mu0 = dot(normalView, Lv).max(float(0.0))
            const mu = dot(normalView, Vv).max(float(0.0))
            const ls = float(1.0).div(mu0.add(mu).max(float(0.05))).min(float(ROCK_LS_CAP))
            const surge = float(1.0).add(
                dot(Lv, Vv).max(float(0.0)).pow(float(8.0)).mul(float(ROCK_LS_SURGE)),
            )
            /* ⚠️⚠️ 2026-10-09 用户 m04735：「月壤的石子不对，石头不会白色自发光」——
               真凶就在这里：**`colorNode` 会把默认的 `color × map` 整个换掉**。
               我第一版写的是 `vec3(0.74,0.73,0.71) * ls`，于是 `m.map` 那张月壤贴图
               被**静默丢弃** ⇒ 石头变成一片没有任何纹理的 0.74 纯灰，
               而 0.74 的线性反照率比月面底色 `#7d7666` 的 ~0.19 亮了近 4 倍
               ⇒ 看上去就是「白色自发光」。
               修法：把贴图手动乘回来 —— `texture(alb, uv()).rgb`。 */
            const albedo = texture(alb, uv()).rgb
            m.colorNode = vec3(0.74, 0.73, 0.71)
                .mul(albedo)
                .mul(ls.mul(float(ROCK_LS_GAIN)).mul(surge))
        }
        if (m.emissive) {
            /* ⚠️⚠️ 2026-10-09 用户 m04735：「石头不会白色自发光」。
               旧版是 `emissiveMap = alb`（一张均值 ≈0.47 的亮贴图）+ `emissive` 常数 ——
               等于给石头加了一层**与光照完全无关**的常量提亮：正午白、黄昏一样白、
               夜里也白，看着就是自发光塑料片。
               现在**整个关掉**（`?stoneemis=` 默认 0）：石头和地面同呼吸，
               明暗只由场景光照决定。 */
            m.emissive.setRGB(0, 0, 0);
            m.emissiveIntensity = STONE_EMIS;
        }
        m.needsUpdate = true;
        o.material = m;
    });
}

async function buildRegionProps(sb: string[]): Promise<THREE.Group> {
    const loader = new GLTFLoader();
    const cache: Record<string, THREE.Group | null> = {};

    // 月面皮肤用到的三张真月壤贴图（和 Terrain.tsx 用的是同一组文件）
    let regolith: GroundMaps | null = null;
    try { regolith = await loadMoonRegolith(); }
    catch (e) { sb.push(`[region-props] 月壤贴图加载失败，月球石头保持原样: ${e}`); }

    const getAsset = async (key: string, moonSkin = false): Promise<THREE.Group | null> => {
        const ck = (moonSkin && regolith ? 'moon:' : 'plain:') + key;
        if (ck in cache) return cache[ck];
        const def = ASSETS[key];
        if (!def) { cache[ck] = null; return null; }
        try {
            const gltf = await loader.loadAsync(def.url);
            const root = gltf.scene as THREE.Group;
            if (moonSkin && regolith) {
                // 走「换整张皮」的路：阴影与材质全部由 applyMoonSkin 接管
                root.traverse((o: any) => {
                    if (!o.isMesh) return;
                    o.castShadow = false;
                    o.receiveShadow = false;
                });
                applyMoonSkin(root, regolith);
                return (cache[ck] = root);
            }
            root.traverse((o: any) => {
                if (!o.isMesh) return;
                o.castShadow = false;
                o.receiveShadow = false;
                const m = o.material as any;
                if (m && m.color) {
                    m.color.multiplyScalar(GAIN);
                    if (TINT_ON) m.color.multiply(TINT);
                    if (m.emissive) {
                        if (m.map) {
                            m.emissiveMap = m.map;
                            m.emissiveMap.colorSpace = m.map.colorSpace;
                            if (TINT_ON) m.emissive.setRGB(TINT.r, TINT.g, TINT.b);
                            else m.emissive.setRGB(1, 1, 1);
                        } else {
                            m.emissive.copy(m.color);
                        }
                        m.emissiveIntensity = EMIS;
                    }
                    m.needsUpdate = true;
                }
            });
            return (cache[ck] = root);
        } catch (e) {
            sb.push(`[region-props] 素材加载失败 ${key} (${def.url}): ${e}`);
            return (cache[ck] = null);
        }
    };

    const out = new THREE.Group();
    out.name = 'region-props';

    for (const g of planGroups()) {
        const holder = new THREE.Group();
        holder.name = `region-props-${g.name}`;
        let n = 0;
        // 月球的三组道具全部换成真月壤皮肤；浅海礁石保留会场那套暖色石头
        const moonSkin = g.name.startsWith('moon-') && !!regolith;
        for (const it of g.items) {
            const src = await getAsset(it.key, moonSkin);
            if (!src) continue;
            const h = new THREE.Group();
            // ★ 就是这一行：y 用 CPU 算出来的高度，和 GPU 位移逐位一致
            h.position.set(it.x, it.y, it.z);
            h.rotation.y = it.rot;
            // GLB 已归一化成高度 1 ⇒ scale 直接是米
            h.scale.set(Math.max(0.01, it.h) * it.sxz, it.h, Math.max(0.01, it.h) * it.sxz);
            h.add(src.clone(true));
            holder.add(h);
            n++;
        }
        out.add(holder);
        sb.push(`[region-props] ${g.name}: ${n}/${g.items.length} 件`);

        if (n) {
            // 抽查一件，把「CPU 高度 vs GPU 高度」的差值打到日志里供核对
            const a = g.items[0];
            sb.push(`[region-props] ${g.name} 样点 (${a.x.toFixed(2)}, ${a.z.toFixed(2)})`
                + ` y=${a.y.toFixed(4)} h=${a.h.toFixed(2)}`);
        }
    }
    return out;
}

export function RegionProps({ visible = true }: { visible?: boolean }) {
    const [group, setGroup] = useState<THREE.Group | null>(null);
    useEffect(() => {
        let dead = false;
        const sb: string[] = [];
        buildRegionProps(sb)
            .then((g) => {
                sb.forEach((s) => console.log(s));
                if (!dead) setGroup(g);
            })
            .catch((e) => console.log('[region-props] 构建失败 ' + e));
        return () => { dead = true; };
    }, []);
    /* ★★ 距离剔除 —— 与 `VenuePropsReal` 同一件事（用户 m02260 / m02439）。
       月岩散置在月球区（中心 0,-196、半径 40）里，地形盘半宽 80 m，
       相机离月球中心超过 140 m 时它们已经在地形盘外，直接不发 draw call。 */
    const HIDE_R = 140;
    const MOON_CX = 0, MOON_CZ = -196;
    useFrame(({ camera }) => {
        if (!group) return;
        const dx = camera.position.x - MOON_CX, dz = camera.position.z - MOON_CZ;
        group.visible = visible && dx * dx + dz * dz < HIDE_R * HIDE_R;
    });
    if (!group) return null;
    return <primitive object={group} visible={visible} />;
}
