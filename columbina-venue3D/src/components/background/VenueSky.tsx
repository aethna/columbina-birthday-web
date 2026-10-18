import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { float, mix, positionWorld, smoothstep, vec3 } from 'three/tsl';
import { QCOL, QNUM, QSTR } from '../../core/utils/query';
import { SKY_MODE, MOON_ON, VENUE } from '../../core/venuePalette';

/* ===== 会场天空 =====
 *
 * ★ 缺省是**星夜**（参考库 False Earth 的 `StarrySky`），不是亮青天。
 *   用户 m05233：「会场本就是霜月，月亮上的天，本就是夜空。所以，原网页的夜空
 *   我们可以直接用。」——所以 `night` 模式下这个组件**只负责月亮**，
 *   天穹交给参考库原本的星空。
 *
 * ?sky=night（缺省）星空 + 月亮；?sky=day 亮青天渐变 + 月亮；?sky=fe 纯参考库画面
 * ?sky0..sky3=rrggbb  覆盖白天四档天色
 * ?moon=0   关掉月亮
 * ?fog=0.011 ?fcol=c4f7f0  雾密度与雾色（只在 day 模式生效）
 */

export { SKY_MODE };

/** 四档天色的缺省值 —— 见 core/venuePalette.ts */
const STOPS: Array<[number, string, string]> = [
    [0.00, 'sky0', VENUE.sky[0]],   // 天顶：青绿
    [0.40, 'sky1', VENUE.sky[1]],   // 中段：亮青
    [0.72, 'sky2', VENUE.sky[2]],   // 近地平：淡青
    [1.00, 'sky3', VENUE.sky[3]],   // 地平：与雾同色
];

const FOG_COLOR = QCOL('fcol', VENUE.fog.color)!;
const FOG_DENSITY = QNUM('fog', VENUE.fog.density)!;
const PLANET_COLOR = QCOL('planet', VENUE.planet)!;

function const3(hex: string) {
    const c = new THREE.Color(hex);
    return vec3(c.r, c.g, c.b);
}

/** 亮青天渐变 —— 只在 `?sky=day` 生效 */
export function VenueSky() {
    const { scene } = useThree();
    const day = SKY_MODE === 'day';

    useEffect(() => {
        if (!day) return;
        const prevBg = scene.backgroundNode;
        const prevFog = scene.fog;

        const cols = STOPS.map(([, key, dflt]) => const3(QCOL(key, dflt)!));
        // t：0 = 天顶，0.5 = 地平，1 = 天底 —— 与老线那张 4×256 渐变 canvas 的 v 对齐
        const dir = (positionWorld as any).normalize();
        const t = float(0.5).sub(dir.y.mul(0.5)).clamp(0, 1);
        let col: any = cols[0];
        col = mix(col, cols[1], smoothstep(STOPS[0][0], STOPS[1][0], t));
        col = mix(col, cols[2], smoothstep(STOPS[1][0], STOPS[2][0], t));
        col = mix(col, cols[3], smoothstep(STOPS[2][0], STOPS[3][0], t));

        scene.backgroundNode = col;
        scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

        return () => {
            scene.backgroundNode = prevBg;
            scene.fog = prevFog;
        };
    }, [scene, day]);

    return null;
}

/** 月亮 / 光晕 / 远景星球 —— 星夜与白天都摆，只有 `?sky=fe` 不摆。
 *  几何与位置照抄老线 `路线A-three.js/app/src/main.js:434-459` 的夜空件，
 *  **只有半径变了**：老线把月亮放在 `(-46,46,-150)`、半径 26，从会场地面的
 *  标准机位看出去张角 2·atan(26/150) ≈ 19.7° —— 占画面四成高，是一堵白墙不是月亮。
 *  老线 `?xsj=1` 时整体关掉，所以这个尺寸从没露过面。现在缺省半径 20（≈16°），
 *  是一颗读得出大陆的大地球。`?earthsize=` 可整体缩放（`?moonsize=` 作兼容别名）。 */
const MOON_LEGACY = QSTR('moonsize') !== null ? (QNUM('moonsize', 20) ?? 20) : null;

/* ===== 天空里那颗大球：从「白圆盘」换成**真实地球** =====
 *
 * 用户 m07996：「夜空的太阳（好像是太阳吧）还是个白色圆盘。在月球，往天上看
 * 应该看到地球。用太空地球图片替换那个圆盘。」
 *
 * 原来那颗球是纯色 `meshBasicMaterial`（`VENUE.moon = #dfe9ff`）⇒ 一颗没有任何
 * 细节的白圆盘。现在换成 NASA Blue Marble 系的等距柱状投影贴图（three.js 官方
 * examples 里那几张，公有领域），外加一层云和一圈大气辉光。
 *
 * 素材（`路线A-webgpu\public\sky\`）：
 *   earth_atmos_2048.jpg    512,606 B  地表颜色（含极冠、海洋、沙漠）
 *   earth_clouds_1024.png   226,113 B  云（白 + 透明通道，等距柱状）
 *   earth_normal_2048.jpg   336,774 B  地形法线（留给以后用）
 *   earth_specular_2048.jpg 223,421 B  海洋高光（留给以后用）
 *
 * ⚠️ **必须用 `meshBasicMaterial`（不受光）**，不是 `meshStandardMaterial`。
 *    一开始想当然用了 standard，指望「被太阳照亮 ⇒ 自带晨昏线」，结果：
 *    会场那盏太阳把整颗球**曝到纯白**，大陆完全读不出来，`?earthrot=` 转多少度
 *    两张图在球心取到的像素都一模一样（205,201,197）。查 `_tools\probe-earth.js`
 *    才确认贴图本身没问题（2048×1024、mapReady=true、挂在材质上），纯粹是曝光
 *    把颜色压平了。用户的诉求是「看到地球」，所以让贴图原色直出。
 *    `?earthlit=1` 可以换回 standard 看晨昏线对照。
 *
 * ⚠️ **贴图必须用 `TextureLoader.load()` 的同步返回值**，不能 `useState` 里 set。
 *    见下面 `useSkyTexture` 的注释 —— 这是「球面纯白」的真正元凶。
 *
 * 开关：
 *   ?earth=0        回到旧的白圆盘（做 A/B 用）
 *   ?earthlit=1     改用受光材质（有晨昏线，但会曝白）
 *   ?earthmap=      换地表贴图 URL
 *   ?cloudmap=      换云贴图 URL（给个不存在的路径可关掉云）
 *   ?earthsize=20   半径（缺省 20；`?moonsize=` 作兼容别名）
 *   ?earthrot=252   绕 Y 轴朝向（度，缺省 252 = 非洲正对镜头）
 *   ?earthtilt=23.4 自转轴倾角（度，缺省 23.4）
 *   （`?earthglow=` 已随大气壳一起去掉，见下面那段注释）
 */
const EARTH_ON = QNUM('earth', 1)! > 0;
/** 用受光的 standard 材质（有晨昏线但会被曝白）/ basic 材质（原色直出）。缺省 basic。 */
const EARTH_LIT = QNUM('earthlit', 0)! > 0;
const EARTH_R = QNUM('earthsize', MOON_LEGACY ?? 20)!;
/** 朝向：让**非洲正对镜头**（u≈0.55 / 东经 18°，即「蓝色弹珠」那张的脸）。
 *  经验公式 `u_中心 = 0.25 − rot/360`，所以 rot252 正好把非洲转到 +Z 方向。
 *  另外三个候选实测：rot0 = 美洲，rot180 = 印度洋（不太认得出），rot288 = 非洲偏东。 */
const EARTH_ROT = QNUM('earthrot', 252)!;
const EARTH_TILT = QNUM('earthtilt', 23.4)!;
const EARTH_MAP = QSTR('earthmap') ?? '/sky/earth_atmos_2048.jpg';
const CLOUD_MAP = QSTR('cloudmap') ?? '/sky/earth_clouds_1024.png';

const EARTH_POS: [number, number, number] = [-46, 46, -150];
/** 远景那颗无名小星球（老线就有）。`?planet2=0` 关掉。 */
const PLANET2_ON = QNUM('planet2', 1)! > 0;

/** 同步返回一个 Texture 对象、图片到货后自己补 `needsUpdate`。
 *
 *  ⚠️ **不要写成 `useState` + `setTex`**：第一帧 `map` 还是 `undefined`，
 *  材质据此编好了一份「没有贴图节点」的程序；等图片到了再把 `material.map`
 *  赋上去，three 不会因为这一句就重建程序（`Material.setValues` 不碰
 *  `needsUpdate`）⇒ **球面永远是纯白**，`?earthrot=` 转多少度都一样。
 *  这正是 2026-10-05 那两张「rot0 / rot90 像素完全相同」的原因。
 *  `TextureLoader.load()` 是**同步返回 Texture 实例**的（空图，图到了自己
 *  `needsUpdate=true`），所以材质从第一帧起就带着贴图节点。 */
function useSkyTexture(url: string, srgb = true) {
    return useMemo(() => {
        const t = new THREE.TextureLoader().load(url, (tex) => {
            tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            tex.anisotropy = 4;
            tex.needsUpdate = true;
        }, undefined, () => { /* 图没到就当没有，别把整个场景打死 */ });
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = 4;
        return t;
    }, [url, srgb]);
}

export function MoonProps() {
    if (SKY_MODE === 'fe' || !MOON_ON) return null;
    return <MoonPropsInner />;
}

function MoonPropsInner() {
    const k = EARTH_R / 26;          // 老线的月亮半径是 26
    const surface = useSkyTexture(EARTH_MAP, true);
    const clouds = useSkyTexture(CLOUD_MAP, true);
    const tilt = THREE.MathUtils.degToRad(EARTH_TILT);
    const yaw = THREE.MathUtils.degToRad(EARTH_ROT);

    return (
        <group>
            {/* ── 主角：地球 ───────────────────────────────────────── */}
            {EARTH_ON ? (
                <group position={EARTH_POS} rotation={[0, yaw, tilt]}>
                    <mesh>
                        <sphereGeometry args={[EARTH_R, 96, 64]} />
                        {/* ⚠️ **必须是 basic（不受光）**，不能用 standard。
                         *  实测：`meshStandardMaterial` + 会场那盏太阳 ⇒ 整颗球被
                         *  曝到纯白，`?earthrot=` 转多少度都读不出大陆（两张图在球心
                         *  取到的像素完全相同，205,201,197）。原因见
                         *  `_tools\probe-earth.js` 的结论：贴图挂上了、也解码好了
                         *  （2048×1024、mapReady=true），纯粹是**曝光**把颜色压平了。
                         *  用户 m07996 要的是「看到地球」，不是「看到一颗被照亮的球」，
                         *  所以这里让贴图原色直出。
                         *  `?earthlit=1` 可以换回 standard 材质看晨昏线对照。 */}
                        {EARTH_LIT ? (
                            <meshStandardMaterial
                                map={surface}
                                roughness={1}
                                metalness={0}
                                fog={false}
                            />
                        ) : (
                            <meshBasicMaterial map={surface} fog={false} />
                        )}
                    </mesh>
                    <mesh scale={1.012}>
                        <sphereGeometry args={[EARTH_R, 96, 64]} />
                        <meshBasicMaterial
                            map={clouds}
                            transparent
                            opacity={0.35}
                            depthWrite={false}
                            fog={false}
                        />
                    </mesh>
                    {/* ⚠️ 大气辉光壳**已按用户 m08676 要求删掉**。
                     *  原来这里是 `scale={1.055}` 的一层背面渲染 + 加法混合的淡蓝壳
                     *  （`EARTH_GLOW = #4d8fe0`, opacity 0.5）。
                     *  不管怎么调，从地面看出去它都读成**地球外面套了一个实心蓝圈**
                     *  —— 因为可加算的壳在弦长最厚的地方（正好是边缘）亮度最高，
                     *  而球心方向被地球本身挡住了，于是天然形成一个亮环。
                     *  真实的大气是从球体**内部**往外散射的渐晕（边缘处逐渐变薄），
                     *  不是一圈等宽的壳，这里索性不做 —— 干净的贴图球反而更像照片。
                     *  要临时加回来的话，`?earthglow=` 已经没用了，得改代码。 */}
                </group>
            ) : (
                <group>
                    <mesh position={EARTH_POS}>
                        <sphereGeometry args={[EARTH_R, 48, 32]} />
                        <meshBasicMaterial color={VENUE.moon} fog={false} />
                    </mesh>
                    <mesh position={EARTH_POS}>
                        <sphereGeometry args={[34 * k, 32, 24]} />
                        <meshBasicMaterial
                            color={PLANET_COLOR}
                            transparent
                            opacity={0.14}
                            fog={false}
                            side={THREE.BackSide}
                        />
                    </mesh>
                </group>
            )}

            {/* ── 远景小星球（另一颗，不动）────────────────────────────
             *  老线给的半径是 16 × k，在 `earthsize=20` 下折合 12.3 —— 从地面看出去
             *  张角 5.6°，和地球（16°）差不多抢眼，而且是一颗**没有贴图的灰圆盘**，
             *  正好又变成用户 m07996 嫌弃的那类东西。这里缩到 9 × k、透明度压到
             *  0.22、推到 -320，只当远景点缀。`?planet2=0` 可以整个关掉。 */}
            {PLANET2_ON ? (
                <mesh position={[150, 96, -320]}>
                    <sphereGeometry args={[9 * k, 32, 24]} />
                    <meshBasicMaterial color={PLANET_COLOR} transparent opacity={0.22} fog={false} />
                </mesh>
            ) : null}
        </group>
    );
}
