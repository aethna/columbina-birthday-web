/**
 * 月亮形状的火漆印 —— 信封上的封口（用户原话：「信封上的火漆应为月亮形状」）。
 *
 * ── 为什么是「弯月 + 滴边」而不是一个圆饼上盖个月亮图案 ──────────────
 * 用户要的是**火漆本身是月亮形状**，不是"圆的火漆上有个月亮"。所以那摊压出来的
 * 蜡自己就是一弯新月，剪影直接抓眼。
 *
 * ── 几何：两个圆的差集，但**角度是算出来的**，不是调出来的 ────────────
 * 新月 = 大圆（外弧）减去一个偏心的圆（"咬掉"那一口）。两个圆的交点就是月牙的
 * 两个**尖角**，它的位置有闭式解，别靠手调：
 *
 *     cos θ = (R² + d² - r²) / (2·R·d)        θ = 尖角在外圆上的极角
 *
 * 取 R=40、r=40、d=22 得 θ ≈ 74.0°，尖角落在 (57.0, 64±38.5)。
 * 厚薄比 ≈ 0.29（月牙中线处厚 22，通高 77）—— 再厚就变成牛角包，再薄小尺寸下
 * 会糊成一条线。（第一版取 d=24.5 时厚 26.5，实测截图读成"胖 C"，太钝。）
 *
 * ── 尖角必须**保住**，这是上一版翻车的地方 ──────────────────────────
 * 上一版给整圈轮廓都加了随机半径抖动 + 5 处"滴瘤"，结果尖角被顶钝、外圈全是疙瘩，
 * 整体读成了**牛角包**。现在改成：抖动幅度乘一个 `sin(πt)^0.7` 的**两端归零**的
 * 包络 —— 弧中间（胖的地方）该抖就抖，越靠近尖角越收敛到 0。滴瘤也只允许出现在
 * 弧中段。形状是"不规则的手压蜡"，但剪影仍然是干净的新月。
 *
 * ── 浮雕感怎么来 ─────────────────────────────────────────────────
 * 真火漆是**压**出来的：凸起的图案左上受光、右下投影。所以月亮画三遍，共用同一套
 * 几何、只换灌进去的颜色：
 *   ① 深色版偏移 (+1.6, +1.8) —— 投影
 *   ② 浅色版偏移 (-1.4, -1.6) —— 受光边
 *   ③ 本体版偏移 (0, 0)      —— 中间调渐变，盖住中间只留两圈错位出来的边
 * 顺序不能反：本体必须最后画，否则投影会盖在自己的亮面上。
 *
 * ── 为什么用离屏 canvas 而不是 Path2D ──────────────────────────────
 * 新月的形状没法用一次 `fill()` 画出来：`evenodd` 只对**完全包含**的内圆有效，
 * 偏心咬掉的那块会算错。所以走离屏 canvas：先填新月路径，再用 `source-in` 灌色。
 * 三个偏移版本各调一次，几何只有一份。
 */

/** 设计尺寸。所有坐标按它写，输出时整体缩放。 */
const DESIGN = 128;

/** 火漆配色（绛红偏紫 —— 夜空/月亮主题里，红是最能跳出来的暖色）。 */
const WAX_DEEP = '#43101f';
const WAX_MID = '#7a1f33';
const WAX_LIT = '#9c2f45';
/** 压出来的月亮：象牙白偏暖，不用纯白（纯白在深红上会像贴纸）。 */
const MOON_LIT = '#f6e4bd';
const MOON_MID = '#dcc194';
const MOON_DEEP = '#8d6a3c';

/* ── 新月几何（见文件头推导） ── */
/** 外弧：月亮凸出去的那一面 */
const OX = 46, OY = 64, R = 40;
/** 咬掉的那一口：偏心的圆。d = BX-OX = 22（咬得更深 → 月牙更细更利） */
const BX = 68, BY = 64, RB = 40;
/** 两个尖角在外圆上的极角（上方那个是 2π-θ，所以外弧要从大角往小角扫） */
const TH = Math.acos((R * R + (BX - OX) * (BX - OX) - RB * RB) / (2 * R * (BX - OX)));
/** 外弧：从上方尖角 → 扫过左侧 180° → 下方尖角（角度递减） */
const A_OUT0 = Math.PI * 2 - TH;
const A_OUT1 = TH;
/**
 * 内弧：从下方尖角 → 扫过左侧 180° → 上方尖角，把路径闭合。
 *
 * 尖角相对咬合圆心的两个角度是 ±PSI（x 分量相同、y 分量相反）。从 +PSI
 * **逆时针**（角度递增）经 π 走到 2π-PSI —— t=0.5 落在角度 π，即咬合圆的
 * 最左点 x = BX - RB = 32.5，那才是"被咬掉的痕迹"该在的位置。
 *
 * 千万别让角度从 +PSI 线性降到 -PSI：那样 t=0.5 取到角度 0，也就是咬合圆的
 * **最右点**（x = 108.5），凹面直接画反 —— 月牙会变成一个两头尖的梭形。
 */
const PSI = Math.atan2(Math.sin(TH) * R - (OY - BY), OX - BX + Math.cos(TH) * R);
const A_BITE0 = PSI;
const A_BITE1 = Math.PI * 2 - PSI;

/**
 * 浮雕相对蜡本体的缩放。必须 < 1，见第 4 步的注释。
 * 0.72 是「红边还看得见」与「月亮够大够清楚」的折中。
 */
const RELIEF = 0.72;
/** 月牙包围盒中心（外弧最左 OX-R=6、最右尖角 ≈61.4；上下 OY±36.9）——浮雕绕它缩放，
    绕画布中心缩会让月牙整体往左下漂 */
const CX = (OX - R + (OX + Math.cos(TH) * R)) / 2;
const CY = OY;

/** 确定性伪随机 —— 火漆是**一个**静态资源，每次渲染必须是同一枚印章。 */
function sealRnd(): () => number {
    let s = 0x1f2e3d4c;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/**
 * 新月路径：外弧 + 内弧，两段各自采样后用二次曲线连。
 *
 * `taper` 是这里的关键：`sin(πt)^0.7` 在 t=0 和 t=1（两个尖角）处为 0，
 * 中间最大。抖动和滴瘤都乘它，于是"胖的地方不规则、尖的地方精确"。
 *
 * ⚠️ **几何必须先算好、再喂给每一层**（返回点数组，而不是直接往 ctx 上画）。
 * 上一版让 `crescentLayer` 内部各自调 `sealRnd()` —— 于是投影、蜡本体、压痕、
 * 浮雕四层拿到的是**四串不同的随机数**，轮廓互相错开，叠在一起就成了糊边。
 * 现在 `waxSealDataURL` 只建一次几何，所有层共用。
 */
function buildCrescent(rnd: () => number): {
    outer: Array<[number, number]>;
    inner: Array<[number, number]>;
} {
    const N = 48;

    /* 滴瘤：只挑中段的位置，且**不碰尖角**。真火漆压下去会从边上挤出几坨，
       但绝不会从尖角挤出来 —— 尖角是模具的边缘。
       幅度从 0.10~0.19 收到 0.05~0.10：第一版挤得太狠，剪影读成了疙瘩。 */
    const drips = Array.from({ length: 4 }, () => 0.18 + rnd() * 0.64);
    const dripR = drips.map(() => 0.05 + rnd() * 0.05);

    /** 环形的"离最近滴瘤多远"，用来把滴瘤加成一个个鼓包 */
    const dripBump = (t: number): number => {
        let sum = 0;
        for (let i = 0; i < drips.length; i++) {
            const dist = Math.abs(t - drips[i]);
            if (dist < 0.075) sum += dripR[i] * (1 - dist / 0.075);
        }
        return sum;
    };

    const outer: Array<[number, number]> = [];
    const inner: Array<[number, number]> = [];
    for (let i = 0; i <= N; i++) {
        const t = i / N;
        const taper = Math.pow(Math.sin(Math.PI * t), 0.7);

        /* 外弧 */
        const a = A_OUT0 + (A_OUT1 - A_OUT0) * t;
        const ro = R * (1 + taper * ((rnd() - 0.5) * 0.035 + dripBump(t)));
        outer.push([OX + Math.cos(a) * ro, OY + Math.sin(a) * ro]);

        /* 内弧：滴瘤**不**加在这边 —— 内弧是"被咬掉"的痕迹，
           它再鼓出来会把月牙的凹面糊掉，形状立刻不成立 */
        const b = A_BITE0 + (A_BITE1 - A_BITE0) * t;
        const ri = RB * (1 + taper * (rnd() - 0.5) * 0.03);
        inner.push([BX + Math.cos(b) * ri, BY + Math.sin(b) * ri]);
    }
    return { outer, inner };
}

/** 采样点 → 用中点二次曲线串成平滑闭合路径 */
function tracePath(ctx: CanvasRenderingContext2D, outer: Array<[number, number]>, inner: Array<[number, number]>): void {
    const stroke = (pts: Array<[number, number]>) => {
        const n = pts.length - 1;
        ctx.lineTo(pts[0][0], pts[0][1]);
        for (let i = 0; i < n; i++) {
            const mx = (pts[i][0] + pts[i + 1][0]) / 2;
            const my = (pts[i][1] + pts[i + 1][1]) / 2;
            ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
        }
        ctx.lineTo(pts[n][0], pts[n][1]);
    };

    ctx.beginPath();
    stroke(outer);
    stroke(inner);
    ctx.closePath();
}

/**
 * 造一层「新月」：返回一张只有新月部分不透明、且被 `paint` 灌满色的离屏 canvas。
 * `dx/dy` 用来做浮雕的错位；`geo` 是所有层共用的同一份几何。
 */
function crescentLayer(
    dx: number, dy: number,
    geo: { outer: Array<[number, number]>; inner: Array<[number, number]> },
    paint: (c: CanvasRenderingContext2D, s: number) => void,
): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    cv.width = DESIGN;
    cv.height = DESIGN;
    const c = cv.getContext('2d');
    /* 拿不到 context 就返回空画布 —— 调用方 drawImage 一张空图，视觉上只是没有火漆，
       比整封信炸掉强。 */
    if (!c) return cv;

    c.save();
    c.translate(dx, dy);

    /* ① 新月路径填成实心 */
    c.fillStyle = '#000';
    tracePath(c, geo.outer, geo.inner);
    c.fill();

    /* ② 灌色：只在还留着的地方上色 */
    c.globalCompositeOperation = 'source-in';
    paint(c, DESIGN);

    c.restore();
    return cv;
}

/** 画一枚月亮形状的火漆印（默认 128×128），返回 PNG dataURL。 */
export function waxSealDataURL(size = 128): string {
    if (typeof document === 'undefined') return '';
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    const k = size / DESIGN;
    if (k !== 1) ctx.scale(k, k);

    /* ★ 几何只算一次，所有层共用 —— 见 buildCrescent 的注释：每层各摇一次
       随机数会让四层轮廓互相错开，叠出来就是一圈糊边。 */
    const geo = buildCrescent(sealRnd());

    /* ── 1. 投影：整块蜡在纸上的影子（比蜡本身更暗更糊） ── */
    const shadow = crescentLayer(1.8, 2.6, geo, (c, s) => {
        c.fillStyle = 'rgba(40,10,20,0.42)';
        c.fillRect(0, 0, s, s);
    });
    ctx.globalAlpha = 0.85;
    ctx.drawImage(shadow, 0, 0);
    ctx.globalAlpha = 1;

    /* ── 2. 蜡本体：外深内亮的径向渐变，边缘自然变暗 ── */
    const wax = crescentLayer(0, 0, geo, (c, s) => {
        const g = c.createRadialGradient(30, 42, 4, 46, 68, 62);
        g.addColorStop(0, WAX_LIT);
        g.addColorStop(0.45, WAX_MID);
        g.addColorStop(1, WAX_DEEP);
        c.fillStyle = g;
        c.fillRect(0, 0, s, s);
    });
    ctx.drawImage(wax, 0, 0);

    /* ── 3. 边缘压痕：再叠一层蜡的剪影，用 blur 糊成一圈光晕，再裁回蜡的形状 ——
       只留内侧那圈暗，外圈不会糊出一圈脏边。
       （为什么不用 stroke：路径填完就结束了，路径没法跨函数传出来。） */
    const rim = crescentLayer(0, 0, geo, (c, s) => {
        c.fillStyle = WAX_DEEP;
        c.fillRect(0, 0, s, s);
    });
    ctx.save();
    /* 用蜡本体做蒙版：光晕只允许出现在蜡**内部** */
    ctx.globalCompositeOperation = 'source-atop';
    ctx.globalAlpha = 0.5;
    ctx.filter = 'blur(3px)';
    ctx.drawImage(rim, 0, 0);
    ctx.restore();

    /* ── 4. 浮雕：深→浅→本体 三层错位 ──
       ⚠️ 必须**缩一圈**再压（RELIEF < 1）。跟蜡本体一样大的话，这三层会把整块蜡
       盖满 —— 结果是"一枚奶油色的月牙"，火漆的红一点都看不见（上一版就这么翻车的）。
       缩 0.72 后四周留出一圈红边，浮雕才读成"压进蜡里的图案"。
       缩放中心取月牙的包围盒中心 (CX, CY)，不是画布中心 —— 绕画布中心缩会让
       月牙整体往左下漂。 */
    const rel = (dx: number, dy: number, col: string, alpha: number) => {
        const layer = crescentLayer(dx, dy, geo, (c, s) => {
            c.fillStyle = col;
            c.fillRect(0, 0, s, s);
        });
        ctx.globalAlpha = alpha;
        ctx.drawImage(layer, 0, 0);
        ctx.globalAlpha = 1;
    };

    ctx.save();
    ctx.translate(CX, CY);
    ctx.scale(RELIEF, RELIEF);
    ctx.translate(-CX, -CY);
    /* 偏移量先放大 1/RELIEF，缩放后回到设计值（约 1.6 / 1.4 px）——
       否则小尺寸下浮雕会被一起缩没 */
    rel(1.6 / RELIEF, 1.8 / RELIEF, MOON_DEEP, 0.9);   // 投影：右下压深
    rel(-1.4 / RELIEF, -1.6 / RELIEF, MOON_LIT, 0.95); // 受光：左上提亮
    const moon = crescentLayer(0, 0, geo, (c, s) => {
        const g = c.createLinearGradient(14, 24, 74, 104);
        g.addColorStop(0, MOON_LIT);
        g.addColorStop(0.5, MOON_MID);
        g.addColorStop(1, '#b08f5e');
        c.fillStyle = g;
        c.fillRect(0, 0, s, s);
    });
    ctx.drawImage(moon, 0, 0);

    /* ── 5. 压印的凹点：沿月牙**中线**戳一圈，真火漆印章的常见细节。
          半径取 R*0.62 是因为月牙中线大约在外弧与内弧的正中（6 → 32.5，中点 ≈ 19；
          从外圆心量出去 ≈ 25 ≈ 0.62R）。角度范围避开两个尖角。
          画在同一个缩放变换里，才会跟着浮雕一起缩。 ── */
    const rnd = sealRnd();
    for (let i = 0; i < 6; i++) {
        const a = 2.0 + (i / 5) * 2.3;
        const rr = R * 0.62 + (rnd() - 0.5) * 5;
        const px = OX + Math.cos(a) * rr;
        const py = OY + Math.sin(a) * rr;
        ctx.fillStyle = 'rgba(60,16,30,0.5)';
        ctx.beginPath();
        ctx.arc(px + 0.9, py + 1.1, 2.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(236,196,180,0.34)';
        ctx.beginPath();
        ctx.arc(px - 0.7, py - 0.9, 2.3, 0, Math.PI * 2);
        ctx.fill();
    }

    /* ── 6. 顶面高光：一道压扁的椭圆反光，把蜡"立"起来。
          位置挑在月牙上段偏左 —— 那里是蜡最厚的地方，打光最像真的。 ── */
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = '#ffd9c8';
    ctx.beginPath();
    ctx.ellipse(30, 40, 13, 6, -0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    return canvas.toDataURL('image/png');
}
