import { QSTR } from './utils/query';

/* ===== 会场配色 =====
 *
 * 色号来源有两处，都不是拍脑袋定的：
 *   · 天空四档 —— 老线 `路线A-three.js/app/src/main.js` 里那张 4×256 渐变 canvas，
 *     断点是对用户给的游戏内截图逐像素取出来的（取样记录见那段注释）。
 *   · 草叶 / 地面 —— 老线 `config.js` 的 colors 段与 `xsj-assets.js` 的草毯色。
 *
 * ?sky=fe 切回参考库 False Earth 的星夜（对照组用），缺省走会场天色。
 */
export type SkyMode = 'night' | 'day' | 'fe';

/* ★ 缺省是**星夜**，不是亮青天。
 *   用户 m05233 原话：「会场本就是霜月，月亮上的天，本就是夜空。所以，原网页的夜空
 *   我们可以直接用。」——参考库 False Earth 的星空本来就是这场景该有的天，
 *   之前我拿老线 `?xsj=1` 那套亮青天当缺省是搞反了。
 *   `?sky=day` 保留亮青天做对照；`?sky=fe` 是完全不摆月亮/星球的纯参考库画面。 */
export const SKY_MODE: SkyMode = (() => {
    const v = QSTR('sky');
    if (v === 'fe') return 'fe';
    if (v === 'day' || v === 'venue') return 'day';
    return 'night';
})();

/** 月亮 / 光晕 / 远景星球：星夜与白天都摆，只有 `?sky=fe` 不摆。 */
export const MOON_ON = QSTR('moon') !== '0';

export const VENUE = {
    /** 天顶 / 中段 / 近地平 / 地平 —— 越靠地平越亮越淡 */
    sky: ['#52aab5', '#82d8da', '#b8f2ee', '#c4f7f0'] as const,
    /** 雾色必须等于天空地平那一档，否则远景会发黑 */
    fog: { color: '#c4f7f0', density: 0.003 },
    /** 草叶尖端 / 根部 */
    grass: {
        tip: '#e07038',
        base: '#7a3418',
        /* 参考库那套草叶材质参数（roughness .35 / metalness .5 / emissive #61ffef）是给
         * 夜色星空配的「潮湿金属感」，搬到亮青天下会糊出一层青白色绒光，
         * 与老线路线A的哑光草叶差得远。会场模式改成哑光、无自发光、弱环境反射。 */
        roughness: 0.92,
        metalness: 0.0,
        emissive: '#000000',
        envMapIntensity: 0.35,
    },
    /** 会场地面。取的是老线摆位表 `公用区\素材\wujien-layout.json` 的
     *  `params.groundDisc = '#8f3c1a'`（红褐月沙），不是 `config.js` 那条通用灰蓝 —— 
     *  乌吉恩圈的地面本来就是红褐色的。 */
    ground: '#8f3c1a',
    /** 会场地面比参考库的荒原平整得多（老线是半径 34 m 的台地，中央 9.5 m 是净空），
     *  地形起伏大了废墟台座会被埋进土里。参考库缺省 1.5。 */
    terrainAmp: 0.55,
    planet: '#c9d8ff',
    moon: '#dfe9ff',
    /** 主光偏暖白（= 老线 config.js 的 lightKey 0xfff4e0） */
    sunColor: '#fff4e0',
};

/* ===== 道具材质族（树木 / 石头 / 蘑菇 / 废墟）=====
 *
 * 数值**全部照抄**老线 `路线A-three.js/app/src/xsj-assets.js:159-225` 那张 TUNING 表。
 * 用户 m05233：「加建筑，树木的时候格外注意。贴图，材质等，我们版本的质感是不如那边
 * 的场景的。所以直接复制进去极其违和。你需要调整，或重做。」——那张表就是老线调了
 * 好几轮的答案，照抄比在这里瞎调靠谱。
 *
 * `grayMap` 是最关键的一条：Dahua 的 Leaf 漫反射是一张**鲑鱼红的扇形叶簇油画**，
 * 不是抠好的 alpha 图；原神用 _ColorSet LUT 把它的**明度**映射成颜色、贴图自带的红
 * 被替换掉。所以正确做法 = 只取明度（grayMap），染色全交给 material.color。
 * 不这么做树冠就是一块鲑鱼红的盘子（首版实测就是）。
 */
export interface PropTune {
    color: string;
    roughness: number;
    metalness: number;
    alphaTest?: number;
    doubleSide?: boolean;
    /** 贴图先转成明度图再乘 color */
    grayMap?: boolean;
}

export const PROP_FAMILY: Record<string, keyof typeof PROP_TUNE> = {
    Area_Yq_Tree_XSJ_Dahua_01_Bark: 'bark',
    Area_Yq_Tree_XSJ_Yuantuo_01_Bark: 'bark',
    Area_Yq_Tree_XSJ_Dahua_02_Leaf_Lod0: 'leaf',
    Area_Yq_Tree_Lut_XSJ_Yuantuo_01_Leaf_Lod0: 'bush',
    Area_Yq_Botany_XSJ_Beikemogu_02_Lod0: 'mushroom',
    Area_Yq_Rock_XSJ_Ground_L_02_Lod0_Tint: 'stone',
    Area_Yq_Rock_XSJ_Ground_M_01_Lod0_Tint: 'stone',
    Area_Yq_Stem_XSJ_Yuanzhu_01: 'stone',
    '@ruin:大门石_01.png': 'ruin',
    '@ruin:柱子石_01.png': 'ruin',
    '@ruin:祭坛石_01.png': 'ruin',
};

export const PROP_TUNE = {
    /** 精怪树干：原神给 (1.1,1.1,1.1) 会让树干变成一根大白柱子，压成中性亮灰 */
    bark: { color: '#cdd4dc', roughness: 0.88, metalness: 0 },
    /** 树冠叶：青蓝（原神树冠是青蓝色团状 + 青蓝垂枝），取明度后染色 */
    leaf: { color: '#7ad8e4', roughness: 0.85, metalness: 0, alphaTest: 0.35, doubleSide: true, grayMap: true },
    /** 灌木：_ColorSetIndex=3 对应的青蓝写死，否则贴出来是墨绿+紫的花斑 */
    bush: { color: '#2db3ce', roughness: 0.75, metalness: 0, alphaTest: 0.45, doubleSide: true, grayMap: true },
    stone: { color: '#ffffff', roughness: 0.95, metalness: 0 },
    mushroom: { color: '#ffffff', roughness: 0.9, metalness: 0 },
    ruin: { color: '#ffffff', roughness: 0.9, metalness: 0 },
} satisfies Record<string, PropTune>;

export function propTune(matName: string): PropTune & { family: string } {
    const fam = PROP_FAMILY[matName] ?? 'ruin';
    return { ...(PROP_TUNE as any)[fam], family: fam };
}
