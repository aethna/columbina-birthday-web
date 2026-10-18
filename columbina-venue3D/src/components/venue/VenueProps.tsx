/**
 * VenueProps —— 把老线（路线A-three.js）会场的树木 / 石头 / 蘑菇 / 废墟建筑
 * 搬进新线。素材由 `_tools/venue-assets.py` 在构建期从
 * `公用区\素材\xsj_pack` 挑出来放进 `public/venue/`，运行时只读 manifest.json。
 *
 * ★ 用户 m05233：「加建筑，树木的时候格外注意。贴图，材质等，我们版本的质感是不如
 *   那边的场景的。所以直接复制进去极其违和。你需要调整，或重做。」
 *   ——所以这里**不是**把贴图原样贴上就完事，做了三件事：
 *
 *   1. **按材质族套老线 TUNING 表**（`core/venuePalette.ts` 的 `PROP_TUNE`，
 *      数值逐条照抄 `xsj-assets.js:159-225`）。树皮 0xcdd4dc、树冠 0x7ad8e4、
 *      灌木 0x2db3ce —— 不套的话树干是一根大白柱子、树冠是墨绿+紫的花斑。
 *   2. **grayMap**：树冠/灌木的漫反射**先转成明度图**再乘 `material.color`。
 *      缘由（老线注释）:Dahua 的 Leaf 漫反射是一张**鲑鱼红的扇形叶簇油画**，
 *      不是抠好的 alpha 图；原神用 _ColorSet LUT 把它的**明度**映射成颜色，
 *      贴图自带的那层红是被替换掉的。首版没做这一步，树冠就是一片鲑鱼红。
 *   3. **树冠按层叠**（逐字照抄 `xsj-assets.js:2459-2484`）：球面剖面缩放 +
 *      每层绕 y/x/z 微转 + 水平微偏。少了这层树冠就是一个扁片；只绕 y 转就是
 *      几张平行的盘子。
 *
 * 两条从老线抄过来的规矩：
 *  · **UNIT = 0.1**。`jobs[].scale` 已是「米/网格单位」绝对值；`extras[].sc` 是
 *    相对系数，要再乘 unit（老线 `UNIT * rj.sc`）。
 *  · **底面对齐**。同批网格原点五花八门（有的在底、有的在腰），不能手工填 y，
 *    必须读包围盒 `minY` 再 `-minY * scale`。
 *
 * ★ 第 4 件事：**给道具补 normal / roughness / AO，消掉「纸片感」**。
 *   素材只有一张平涂 diffuse，夜里渲出来像纸片。构建期
 *   `_tools/derive-pbr.py` 把 albedo 亮度当高度场派生三个量，
 *   再按 ProceduralTerrains（SurfaceTextureAtlas.js:161-176）的做法
 *   **打包进一张 RGBA 图**，文件名 `<原名>_nra.png`：
 *
 *       R = normal.x     G = normal.y     B = roughness     A = ao
 *
 *   一次采样拿到三个量，省两次纹理读取。接法见下面 material 循环里的注释。
 */
import { useEffect, useState } from 'react';
import * as THREE from 'three/webgpu';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
// TSL：normal / roughness / AO 三件套全部手工接，理由见 material 循环里的注释
import { texture, uv, vec3, vec2, float, mix, normalMap, clamp } from 'three/tsl';
import { QFLAG, QNUM } from '../../core/utils/query';
import { propTune } from '../../core/venuePalette';

const OBJ = new OBJLoader();

/** 老线默认只摆前 10 件废墟（`?ruinbits=1` 才摆全部 15 件残块） */
const RUIN_MAIN = 10;

/** 打包图总开关：`?nra=0` 关掉 normal/roughness/AO。
 *  一是用来拍「补图前 / 补图后」的对照图，二是留个逃生开关：万一某批贴图
 *  派生出问题、画面发怪，不用改代码就能先关掉。 */
const NRA_ON = QNUM('nra', 1)! > 0;

/** ── 打包图 `<原名>_nra.png` 的调参 ──────────────────────────────────
 *  NRA_NORMAL_SCALE：法线强度。0 = 法线失效（等于没接），1 = 按派生时的 strength 原样。
 *                    `?nrak=` 可覆盖（无头截图拍强弱对照用）。
 *  NRA_AO_STRENGTH ：AO 生效比例（0~1）。夜里本来就暗，遮蔽开猛了整场会发黑。
 *                    `?nraao=` 可覆盖，`?nraao=1` 是派生出来的原样。
 *  NRA_ROUGH_MID / NRA_ROUGH_GAIN：B 通道的中性点与调制幅度，见 material 循环。
 */
const NRA_NORMAL_SCALE = QNUM('nrak', 1.0)!;
const NRA_AO_STRENGTH = QNUM('nraao', 0.7)!;
const NRA_ROUGH_MID = 0.85;
const NRA_ROUGH_GAIN = 1.2;

interface MatRec {
    map?: string;
    ai?: string;
    alphaTest?: number;
    side?: number;
    color?: number[];
    /** normal/roughness/AO 打包图的文件名（R=nx G=ny B=rough A=ao）；没有则 null */
    nra?: string | null;
}

interface MeshEntry {
    root: THREE.Group;
    minY: number;
    tris: number;
}

/** 位置 → 稳定的伪随机角度。老线的树是 `rot: null`（随机），
 *  我们要的是可复现：同一次导出、同一张图永远是同一个角度。 */
function hashRot(x: number, z: number): number {
    const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    return (s - Math.floor(s)) * Math.PI * 2;
}

/** 把贴图的 RGB 换成明度、保留 A 通道 —— 老线 TUNING 里的 `grayMap`。
 *  见文件头第 2 条。在浏览器里做（一次、按路径缓存），避免动构建脚本。 */
function toGray(tex: THREE.Texture): THREE.Texture {
    const img = tex.image as (HTMLImageElement | ImageBitmap | undefined);
    const w = (img as any)?.width | 0;
    const h = (img as any)?.height | 0;
    if (!w || !h) return tex;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    if (!g) return tex;
    g.drawImage(img as any, 0, 0);
    const d = g.getImageData(0, 0, w, h);
    const a = d.data;
    for (let i = 0; i < a.length; i += 4) {
        const l = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
        a[i] = a[i + 1] = a[i + 2] = l;
    }
    g.putImageData(d, 0, 0);
    const out = new THREE.CanvasTexture(cv);
    out.colorSpace = THREE.SRGBColorSpace;
    out.wrapS = out.wrapT = THREE.RepeatWrapping;
    out.anisotropy = 8;
    out.needsUpdate = true;
    return out;
}

async function buildVenueProps(sb: string[]): Promise<THREE.Group> {
    const man = await (await fetch('/venue/manifest.json')).json();
    const unit: number = man.unit ?? 0.1;

    // ── 贴图（带明度转换缓存）──────────────────────────────
    const tl = new THREE.TextureLoader();
    const texCache: Record<string, THREE.Texture> = {};
    const getTex = async (n: string, gray: boolean, data = false) => {
        const bare = n.replace(/\.(png|jpg|jpeg|tga)$/i, '');
        const key = bare + (gray ? '#g' : data ? '#d' : '');
        if (!texCache[key]) {
            const t = await tl.loadAsync(`/venue/tex/${bare}.png`);
            // ★ `_nra.png` 是**数据贴图**，绝不能设成 SRGBColorSpace ——
            //   那会把 R/G/B 做一次 sRGB→线性 解码，法线和粗糙度就全错了。
            t.colorSpace = data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            t.anisotropy = 8;
            texCache[key] = gray ? toGray(t) : t;
        }
        return texCache[key];
    };

    // ── 材质（一个材质名一份，全场共享；按族套 TUNING）─────
    const mats: Record<string, THREE.Material> = {};
    const famCount: Record<string, number> = {};
    for (const [name, r] of Object.entries<MatRec>(man.materials || {})) {
        const tune = propTune(name);
        famCount[tune.family] = (famCount[tune.family] || 0) + 1;
        const m = new THREE.MeshStandardNodeMaterial();
        const src = r.ai || r.map;
        if (src) m.map = await getTex(src, !!tune.grayMap);
        m.color = new THREE.Color(tune.color);
        m.roughness = tune.roughness;
        m.metalness = tune.metalness;
        m.alphaTest = tune.alphaTest ?? r.alphaTest ?? 0;
        m.side = tune.doubleSide || r.side === 2 ? THREE.DoubleSide : THREE.FrontSide;

        // ── normal / roughness / AO 三件套 ──────────────────────────────
        // 打包图 `<原名>_nra.png`： R=normal.x  G=normal.y  B=roughness  A=ao
        //
        // 为什么**不能**用 material.normalMap / aoMap / roughnessMap：
        //   WebGL 那套约定是 aoMap 读 .r、roughnessMap 读 .g、metalnessMap 读 .b；
        //   可这张图 R 通道装的是 normal.x、A 通道才是 ao，通道位置全对不上。
        //   而且这是 NRA 打包，不是 ORM 打包，套 ORM 的接法只会读出垃圾。
        //   所以三个量全部用 TSL 从对应通道里显式取。
        if (r.nra && NRA_ON) {
            // ★ 打包图是**可选增强**：万一它没生成、或者服务器还没把它发出来
            //   （dev server 的 public 文件清单问题，见 README §3.6），
            //   绝不能让整个会场道具层跟着崩掉 —— 这一份退回只有漫反射就行。
            const nt = await getTex(r.nra, false, /* data = */ true).catch((e) => {
                console.warn(`[venue] 打包图加载失败，${name} 退回纯漫反射：${r.nra}`, e);
                return null;
            });
            if (!nt) {
                mats[name] = m;
                continue;
            }
            const nra = texture(nt, uv());

            // ① 法线：R/G 当 xy，z 给常量 1。
            //    NormalMapNode 内部会先做 `node * 2 - 1`，所以这里必须喂 **[0,1] 的编码值**；
            //    喂进去之后它算出的是 (2r-1, 2g-1, 2*1-1) = (nx, ny, 1)，
            //    正好是参考算法里的 `nz = 1`，归一化和 TBN 变换由它自己做。
            //    （千万别在外面先解码成 (nx,ny,1) 再传进来，会被二次解码。）
            m.normalNode = normalMap(
                vec3(nra.r, nra.g, float(1.0)),
                vec2(NRA_NORMAL_SCALE, NRA_NORMAL_SCALE),
            );

            // ② 粗糙度：0.182 里 `roughnessNode` 会**替换** material.roughness（不是相乘），
            //    所以必须自己把它乘回去，否则上面按材质族调的 roughness 就白调了。
            //    又因为 B 通道的中位数天然落在 0.85 附近（B = 0.95 - 0.22*lum），
            //    直接相乘会让全场整体变光滑、发亮；这里改以 0.85 为**中性点**做相对调制
            //    （±0.12 的偏差放大 NRA_ROUGH_GAIN 倍），neutral 处就等于原来的调参。
            m.roughnessNode = clamp(
                float(tune.roughness)
                    .mul(nra.b.sub(NRA_ROUGH_MID).mul(NRA_ROUGH_GAIN).add(1.0)),
                0.04, 1.0,
            );

            // ③ AO：`aoNode` 是个 float **乘子**（1 = 不遮蔽），而且接受任意节点
            //    （NodeMaterial.js 里 aoNode 优先于 aoMap）。
            //    打包图的 A 已经在 [0.70, 1] 之间，再按 NRA_AO_STRENGTH 收一档：
            //    夜里本来就暗，遮蔽开满了整场会发黑。
            m.aoNode = mix(float(1.0), nra.a, NRA_AO_STRENGTH);
        }

        mats[name] = m;
    }

    // ── 网格（每份只加载一次，之后 clone）──────────────────
    const cache: Record<string, MeshEntry | null> = {};
    const getMesh = async (name: string): Promise<MeshEntry | null> => {
        if (name in cache) return cache[name];
        try {
            const root = await OBJ.loadAsync(`/venue/mesh/${name}`);
            const matName = (man.meshMaterial || {})[name];
            let minY = Infinity, tris = 0;
            root.traverse((o: any) => {
                if (!o.isMesh) return;
                o.material = mats[matName] || new THREE.MeshStandardNodeMaterial({ color: 0x9a9a9a });
                if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
                minY = Math.min(minY, o.geometry.boundingBox.min.y);
                const idx = o.geometry.index;
                tris += (idx ? idx.count : o.geometry.attributes.position.count) / 3;
            });
            return (cache[name] = {
                root,
                minY: Number.isFinite(minY) ? minY : 0,
                tris: Math.round(tris),
            });
        } catch (e) {
            sb.push(`网格加载失败 ${name}: ${e}`);
            return (cache[name] = null);
        }
    };

    const group = new THREE.Group();
    group.name = 'venue-props';
    let placed = 0, tris = 0;

    /** 树冠加层 —— 逐字照抄老线 `xsj-assets.js:2459-2484`。
     *  位置/缩放/旋转都在**网格单位**里（子节点跟着 holder 的 scale 走）。 */
    const addLeafLayers = (base: THREE.Object3D, holder: THREE.Group, jb: any, leafTris: number) => {
        const layers = jb.leafLayers || 0;
        for (let k = 1; k <= layers; k++) {
            const copy = base.clone(true);
            const t = k / (layers + 1);                        // 0..1：这层在球里的高度比
            copy.position.y = k * (jb.leafLayerDY || 5);
            copy.scale.setScalar(Math.sqrt(Math.max(0.12, 1 - t * t * 0.95)));  // 球面剖面
            copy.rotation.y = k * 1.15;
            copy.rotation.x = (k % 2 ? 1 : -1) * 0.085 * k;    // 层间交叉，剪影才鼓成一坨
            copy.rotation.z = (k % 3 ? -1 : 1) * 0.070 * k;
            copy.position.x += 0.42 * (((k * 2) % 3) - 1);     // 水平微偏，让几层不同心
            copy.position.z += 0.42 * (((k * 2 + 1) % 3) - 1);
            holder.add(copy);
            tris += leafTris;
        }
    };

    // ── 树木 / 石头 / 蘑菇（layout.jobs）───────────────────
    for (const jb of man.jobs || []) {
        const s = jb.scale ?? unit;
        const [x, y, z] = jb.pos || [0, 0, 0];
        const holder = new THREE.Group();
        holder.rotation.y = jb.rot ?? hashRot(x, z);
        holder.scale.setScalar(s);
        holder.position.set(x, 0, z);

        let any = false;
        for (const slot of ['bark', 'mat'] as const) {
            if (!jb[slot]) continue;
            const me = await getMesh(jb[slot]);
            if (!me) continue;
            holder.add(me.root.clone(true));
            holder.position.y = y - me.minY * s;
            tris += me.tris;
            any = true;
        }
        if (jb.leaf) {
            const me = await getMesh(jb.leaf);
            if (me) {
                const base = me.root.clone(true);   // 第 0 层
                holder.add(base);
                tris += me.tris;
                addLeafLayers(base, holder, jb, me.tris);
                any = true;
            }
        }
        if (any) { group.add(holder); placed++; }
    }

    // ── 废墟建筑（layout.extras）───────────────────────────
    const RUINBITS = QFLAG('ruinbits');
    let ruinN = 0;
    for (const ex of man.extras || []) {
        if (ex.kind !== 'ruin' || !ex.obj) continue;
        if (!RUINBITS && ruinN >= RUIN_MAIN) break;
        const me = await getMesh(ex.obj);
        if (!me) continue;
        const s = unit * (ex.sc || 1);
        const [x, y, z] = ex.pos || [0, 0, 0];
        const holder = new THREE.Group();
        holder.scale.setScalar(s);
        holder.rotation.y = ex.rot ?? 0;
        holder.position.set(x, y - me.minY * s, z);
        holder.add(me.root.clone(true));
        group.add(holder);
        tris += me.tris;
        placed++; ruinN++;
    }

    const fams = Object.entries(famCount).map(([k, v]) => `${k}×${v}`).join(' ');
    sb.push(`[venue] 摆放 ${placed} 件（废墟 ${ruinN} 件）/ 约 ${(tris / 1000).toFixed(0)}k 三角 / 材质 ${Object.keys(mats).length} 份（${fams}）/ unit=${unit}`);
    return group;
}

export function VenueProps({ visible = true }: { visible?: boolean }) {
    const [group, setGroup] = useState<THREE.Group | null>(null);
    useEffect(() => {
        let dead = false;
        const sb: string[] = [];
        buildVenueProps(sb)
            .then((g) => {
                sb.forEach((s) => console.log(s));
                if (!dead) setGroup(g);
            })
            .catch((e) => console.log('[venue] 构建失败 ' + e));
        return () => { dead = true; };
    }, []);
    if (!group) return null;
    return <primitive object={group} visible={visible} />;
}

/** 供 App.tsx 的 `?props=0` 用 */
export const PROPS_ON = QNUM('props', 1)! > 0;
