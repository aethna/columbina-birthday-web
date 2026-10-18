/**
 * forestProc —— 森林里**不需要下载**的几件道具，用几何体直接造出来。
 *
 * ── 为什么是程序化的 ────────────────────────────────────────────────
 * 用户要的森林素材清单里有「蘑菇」，但 **Poly Haven 一件蘑菇都没有**
 * （`_tools/polyhaven-fetch.py --list` 521 个模型里搜不到 mushroom / fungus / toadstool），
 * 下载源（ambientCG / Kenney / Quaternius）要么没有、要么授权/格式对不上。
 * 蘑菇本身形状极简（一根圆柱 + 一个扁球冠），与其去找素材不如直接造，
 * 而且**颜色是我们自己定的**，正好对上用户「对照着调色就行」的要求。
 * 石板路同理：Poly Haven 的 `stone_01` 是一块天然石，做不出「切好的石板」。
 *
 * ── 参考色（`公用区\背景素材\素材\`）────────────────────────────────
 * `背景素材2.png`：地面橙、树冠钴蓝、**石板路是奶白色**、蘑菇是淡蓝。
 * `背景素材4.png`：地面砖红、树冠青绿、**白色伞状蘑菇**、石砌建筑。
 * ⇒ 蘑菇两种：白色伞菌 + 淡蓝小菌。石板：奶白偏暖。
 *
 * ── 约定 ────────────────────────────────────────────────────────────
 * 每个 parts 的几何体**底面已经落在 y = 0**（`Forest.tsx` 还会再统一贴一次地，
 * 但不依赖它）。`name` 会进 `groupsByMat` 的 key，必须唯一。
 */
import * as THREE from 'three/webgpu';

export interface ProcPart {
    name: string;
    material: THREE.MeshStandardNodeMaterial;
    geometry: THREE.BufferGeometry;
}

function stoneMat(name: string, color: string, roughness = 0.90, flat = false): THREE.MeshStandardNodeMaterial {
    const m = new THREE.MeshStandardNodeMaterial();
    m.name = name;
    m.color = new THREE.Color(color);
    m.roughness = roughness;
    m.metalness = 0;
    m.flatShading = flat;
    return m;
}

/** 一个伞菌：圆柱菌柄 + 车削出来的伞盖。整体高度 = `stemH + capR * 0.62`。 */
function mushroom(
    name: string,
    capColor: string,
    gillColor: string,
    capR: number,
    stemH: number,
    stemR: number,
): ProcPart[] {
    /* 菌柄。`--ground` 那套在这儿手动做：平移到底面 y = 0。 */
    const stem = new THREE.CylinderGeometry(stemR * 0.78, stemR * 1.15, stemH, 10, 1);
    stem.translate(0, stemH / 2, 0);

    /* 伞盖用 Lathe：从顶点往外拉一圈，边缘再往下垂一点点 —— 比半球更像伞。 */
    const h = capR * 0.62;
    const profile: THREE.Vector2[] = [
        new THREE.Vector2(0.000, h),
        new THREE.Vector2(capR * 0.30, h * 0.96),
        new THREE.Vector2(capR * 0.58, h * 0.82),
        new THREE.Vector2(capR * 0.80, h * 0.58),
        new THREE.Vector2(capR * 0.94, h * 0.28),
        new THREE.Vector2(capR * 1.00, h * 0.06),
        new THREE.Vector2(capR * 0.96, -capR * 0.06),
    ];
    const cap = new THREE.LatheGeometry(profile, 18);
    cap.translate(0, stemH, 0);
    cap.computeVertexNormals();

    /* 菌褶：伞盖正下方一片薄的圆盘，单独一个材质方便给个浅色，
     * 这一片是「从下往上看蘑菇」时唯一能看见的东西。 */
    const gill = new THREE.CircleGeometry(capR * 0.92, 18);
    gill.rotateX(Math.PI / 2);
    gill.translate(0, stemH + h * 0.02, 0);

    return [
        { name: `${name}_stem`, material: stoneMat(`${name}_stem`, gillColor, 0.95), geometry: stem },
        { name: `${name}_cap`, material: stoneMat(`${name}_cap`, capColor, 0.72), geometry: cap },
        { name: `${name}_gill`, material: stoneMat(`${name}_gill`, gillColor, 0.98), geometry: gill },
    ];
}

/** 奶白色伞菌（`背景素材4.png`）。整高 ≈ 0.42 m。 */
function mushroomA(): ProcPart[] {
    return mushroom('mush_a', '#efe7d8', '#d8cbb4', 0.26, 0.26, 0.030);
}

/** 淡蓝小菌（`背景素材2.png`）。整高 ≈ 0.19 m。 */
function mushroomB(): ProcPart[] {
    return mushroom('mush_b', '#a9c4d6', '#8fa6bb', 0.13, 0.11, 0.018);
}

/** 石板：七边形切石，底面贴地。直径 0.92 m、厚 0.13 m。 */
function slabPart(): ProcPart[] {
    const g = new THREE.CylinderGeometry(0.46, 0.41, 0.13, 7, 1);
    g.translate(0, 0.065, 0);
    /* 顶面抖一下：`CylinderGeometry` 的顶点顺序是「侧面按段 × 上下环」，
     * 直接把**上半环**（y > 0.05）的 y 抬落几毫米，石板就不会像压出来的饼。 */
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y > 0.05) {
            const k = Math.sin(i * 12.9898) * 43758.5453;
            pos.setY(i, y + ((k - Math.floor(k)) - 0.5) * 0.022);
        }
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();

    /* ⚠️ 2026-10-10（用户 m07705「石板路为什么是白色自发光的？」）：
       它**没有**发光 —— `stoneMat` 不设 emissive，`FOREST_EMIS` 也只作用在
       `makeCutoutMaterial`（草花卡片）上。看着像自发光的原因是两条叠在一起：
       ① 反照率 `#cfc7b8` 是接近白的浅灰（线性 0.63），正午直射一照就顶到 0.9+；
       ② 森林道具 `castShadow = receiveShadow = false`（`Forest.tsx` 的 `add()`），
          石板既不自阴影、也不接收旁边的树影，于是和周围暗红的裸地一比就是「发光」。
       修法：反照率压到中灰石色、粗糙度拉满。 */
    return [{ name: 'f_slab', material: stoneMat('f_slab', '#8d877c', 0.97, true), geometry: g }];
}

/** 按 `FOREST_ASSETS[key].proc` 造件。名字对不上就返回空数组（静默，不抛）。
 *
 *  ⚠️⚠️ **必须归一化成「高度 = 1、底面 y = 0」**，和下载来的 GLB 同一套约定。
 *  `Forest.tsx` 的实例矩阵是 `_s.set(h*sxz, h, h*sxz)` —— `h` 是**米**，
 *  它同时缩放三个轴。上面这些几何体是按**真实尺寸**建的（石板直径 0.92 m、
 *  厚 0.13 m），不归一化就会被 `h = 0.13` 缩成 12 cm 的小方块。
 *  （这个坑和「`gMin/gMax` 是倍率不是米」是同一族：**量纲**。） */
export function buildProcAsset(name: string): ProcPart[] {
    let parts: ProcPart[];
    switch (name) {
        case 'mush_a': parts = mushroomA(); break;
        case 'mush_b': parts = mushroomB(); break;
        case 'slab': parts = slabPart(); break;
        default: return [];
    }
    let top = 0;
    for (const p of parts) {
        p.geometry.computeBoundingBox();
        top = Math.max(top, p.geometry.boundingBox!.max.y);
    }
    if (top > 1e-6 && Math.abs(top - 1) > 1e-6) {
        const k = 1 / top;
        for (const p of parts) p.geometry.scale(k, k, k);
    }
    for (const p of parts) {
        p.geometry.computeBoundingBox();
        p.geometry.computeBoundingSphere();
    }
    return parts;
}
