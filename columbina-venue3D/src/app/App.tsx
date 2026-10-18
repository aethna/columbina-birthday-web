import { Environment, PerformanceMonitor } from "@react-three/drei";
import { LevaWrapper, AudioManager, KeyboardMapper } from "@core";
import { Canvas, useLoader, useThree } from "@react-three/fiber";
import { useEffect, Suspense, useMemo, useState } from "react";
import { DirectionalLight } from "../components/DirectionalLight";
import { WebGPURenderer } from "three/webgpu";
import Effects from "../components/Effects/Effects";
import { useGameStore } from "../core/store/gameStore";
import { CameraViewControl } from "../components/camera/CameraViewControl";
import { DeviceDetector } from "../core/utils/DeviceDetector";
import { UI } from "../ui/UI";
import { WorldController } from "../components/WorldController";
import { createContext } from "react";
import * as THREE from "three/webgpu";
import { input, keyBindings } from "../core/input/controls";
import { CursorKey } from "../core/input/CursorKey";
import { PointerHold } from "../core/input/PointerHold";
import { useShortcut } from "@core/hooks/useShortcut";
import { AudioLoader } from 'three';
import { QS, QNUM, QVEC } from '../core/utils/query';
import DevStamp from '../components/DevStamp';
import { worldHeightCPU } from '../core/worldRegions';

/** ★★ 开发版状态角标开关：缺省开，`?stamp=0` 关（截图取证时想干净就关掉） */
const STAMP_ON = QNUM('stamp', 1)! > 0;

/**
 * ★★★ 后处理链二选一（2026-10-17 修）。
 *
 * 背景：本项目曾有**两条**后处理链同时挂着 ——
 *   · `components/PostFX.tsx`：自研 TSL 管线（ACES 色调映射 + 辉光 + 径向光柱），
 *     `useFrame(cb, 1)` 接管渲染，2026-10-13 按用户 m04061 的反馈精调过阈值；
 *   · `components/Effects/Effects.tsx`：更早的链（Reinhard + DOF + SMAA），
 *     同样 `useFrame(cb, 1)` 接管渲染，2026-10-11 之后没再更新。
 *
 * 两条链都拿 priority = 1 ⇒ R3F 只按挂载顺序依次回调、**不会互斥**，于是：
 *   ① 同一帧把整个场景完整光栅化两遍（外加各自 bloom / DOF / SMAA 的若干 pass）；
 *   ② `PostFX` 先渲染、`Effects` 后渲染 ⇒ **最终上屏的是 Effects 的图**，
 *      `PostFX` 里那些精调过的 ACES 与阈值 1.15 实际上一直被覆盖掉；
 *   ③ 两个 toneMapping（ACES vs Reinhard）与两套曝光语义（线性 vs `^4`）打架。
 *
 * 现在缺省只留 `PostFX`（更新的那条、WebGPU 原生 TSL、带实测注释）。
 * 想回到旧链做 A/B 对照就加 `?pple=1` —— 旧链保留不删，因为它还带着 DOF / SMAA
 * 两个 `PostFX` 目前没有的效果，将来若要移植过来可以当参照。
 */
const LEGACY_PP = QNUM('pple', 0)! > 0;

useLoader.preload(AudioLoader,
    ['/audio/fs_grass1.mp3',
        '/audio/fs_grass2.mp3',
        '/audio/fs_grass3.mp3',
        '/audio/fs_grass4.mp3',
        '/audio/fs_grass5.mp3']);

useLoader.preload(AudioLoader, ['/audio/wave01.mp3']);

/* ===== 验收机位（URL 参数，保证截图可复现） =====
 * ?dpr=1         锁定像素比 —— 同时关掉 PerformanceMonitor 自适应（它会让 dpr 每帧漂移，截图不可复现）
 * ?cam=x,y,z     固定机位（给了它就不挂 CameraViewControl，改由 StaticLook 定视点）
 * ?look=x,y,z    固定视点
 * ?fov=52        视场角
 */
const FIX_DPR = QS.get('dpr') === null ? null : QNUM('dpr', 1);
const FIX_CAM = QS.get('cam') ? QVEC('cam', [20, 20, 30]) : null;
const FIX_LOOK = QVEC('look', [0, 0, 0]);
const FIX_FOV = QNUM('fov', 45);
export { FIX_DPR, FIX_CAM, FIX_LOOK, FIX_FOV };
/** 固定机位时景深该对焦到哪 —— 默认取「机位到视点」的距离，也可用 ?focus= 覆盖。
 *  不这么做的话，没有角色时 autofocus 永远不更新，focusDist 停在 0，整屏糊掉。 */
export const FOCUS_DIST: number | null = (() => {
    const v = QNUM('focus');
    if (v !== null) return v;
    if (!FIX_CAM) return null;
    return Math.hypot(FIX_CAM[0] - FIX_LOOK[0], FIX_CAM[1] - FIX_LOOK[1], FIX_CAM[2] - FIX_LOOK[2]);
})();

function StaticLook({ target }: { target: [number, number, number] }) {
    const { camera } = useThree();
    useEffect(() => {
        camera.lookAt(target[0], target[1], target[2]);
        camera.updateMatrixWorld(true);
    }, [camera, target]);
    return null;
}

/** 诊断钩子：把 scene / renderer / camera 挂到 window.__dsh，供无头截图脚本 --eval 读取。
 *  这样「光标没法看控制台」也能程序化验证场景内容（对象类型计数、光照、草材质 envMap 等）。 */
function Diag() {
    const { scene, gl, camera } = useThree();
    useEffect(() => {
        const w = window as any;
        /* ★ 地形高度探针：无头脚本用 window.__dshProbe(x,z) 读 CPU 高度，
           用来给 ?cam= 定落地高度（换周期丘陵之后丘陵峰值变了，
           写死 y=1.7 会把相机埋进土里 —— 出图会看到「地面在头顶上」）。 */
        w.__dshProbe = (x: number, z: number) => worldHeightCPU(x, z);
        const lights: any[] = [];
        const shortMeshes: any[] = [];
        const counts: Record<string, number> = {};
        scene.traverse((o: any) => {
            counts[o.type] = (counts[o.type] || 0) + 1;
            if (o.isLight) lights.push({ type: o.type, intensity: o.intensity, pos: o.position.toArray().map((n: number) => +n.toFixed(3)) });
            const pos = o.geometry?.attributes?.position;
            if (o.isMesh && pos && pos.count <= 32) {
                shortMeshes.push({
                    verts: pos.count,
                    indexCount: o.geometry.index ? o.geometry.index.count : 0,
                    count: o.count,
                    hasIndirect: !!o.geometry.indirect,
                    envMap: o.material?.envMap ? 'yes' : 'no',
                    roughness: o.material?.roughness,
                    metalness: o.material?.metalness,
                });
            }
        });
        w.__dsh = {
            THREE, scene, gl, camera,
            counts: () => counts,
            env: () => (scene.environment ? (scene.environment as any).name || 'yes' : 'none'),
            lights: () => lights,
            grass: () => shortMeshes,
            render: () => gl.info?.render ?? null,
        };
        console.log('[dsh] diag ready');
    }, [scene, gl, camera]);
    return null;
}

export const BeamSceneContext = createContext<THREE.Scene | null>(null);

export default function App() {
    const beamScene = useMemo(() => new THREE.Scene(), []);
    const [dpr, setDpr] = useState(FIX_DPR ?? 1);

    const toggleCameraMode = useGameStore((state) => state.toggleCameraMode);
    const setGpuError = useGameStore((state) => state.setGpuError);
    const setAudioListener = useGameStore((state) => state.setAudioListener);
    const gpuError = useGameStore((state) => state.gpuError);

    // Check WebGPU support on mount
    useEffect(() => {
        const checkWebGPU = async () => {
            if (!navigator.gpu) {
                setGpuError("WEBGPU NOT SUPPORTED");
                console.error("WebGPU is not supported in this browser");
                return;
            }
            try {
                const adapter = await navigator.gpu.requestAdapter();
                if (!adapter) {
                    setGpuError("NO GPU ADAPTER FOUND");
                    console.error("No GPU adapter found");
                    return;
                }
                console.log('WebGPU initialized successfully');
                setGpuError(null); // Clear any previous errors
            } catch (e) {
                setGpuError("GPU INIT FAILED");
                console.error("WebGPU initialization failed:", e);
            }
        };
        checkWebGPU();
    }, [setGpuError]);

    useShortcut('c', () => {
        toggleCameraMode();
    });

    return <>
        <LevaWrapper collapsed={true} initialHidden={true} />
        <DeviceDetector />
        <UI />
        <KeyboardMapper input={input} keyMap={keyBindings} />
        {/* ★ 按住 ALT 呼出鼠标指针 + 冻结转视角（用户 m05698）。只挂全局监听、返回 null，
            和 `<KeyboardMapper/>` 同一套路。见 src/core/input/CursorKey.tsx 顶部注释。 */}
        <CursorKey />
        {/* ★★ 互动期间强制呼出鼠标指针 + 冻结视角与人物移动（用户 m00002，2026-10-17）。
            四个界面（信纸 / 对话框 / 合影 / 相册）打开时占住指针，关掉即释放；
            F 键互动那一类由 `core/game/interact.ts` 自己占。同样只挂订阅、返回 null。 */}
        <PointerHold />
        {/* ★★ 开发版状态角标：`?stamp=0` 关。把「哪份代码 / 功能开关 / URL 里带了什么参数」
            直接画在屏幕上 —— 验收者开不了 F12，这是唯一能自查「功能到底有没有生效」的窗口。
            见 src/components/DevStamp.tsx 顶部的长注释。 */}
        {STAMP_ON && <DevStamp />}


        {!gpuError && (
            <Canvas
                camera={{
                    fov: FIX_FOV,
                    near: 0.1,
                    far: 200,
                    position: FIX_CAM ?? [20, 20, 30]
                }}
                gl={(canvas) => {
                    const renderer = new WebGPURenderer({
                        ...canvas as any,
                        powerPreference: "high-performance",
                        antialias: true,
                        alpha: true,
                    });
                    renderer.setClearColor('#000000');
                    renderer.autoClear = true;
                    // renderer.inspector = new Inspector();
                    renderer.sortObjects = false;

                    return renderer.init().then(() => renderer);
                }}
                dpr={dpr}
            >
                <AudioManager onListenerCreated={setAudioListener} />
                <Diag />

                {FIX_DPR === null && (
                    /* ★★★ 「98% GPU 占用」的元凶就在这三行（用户 m02901）。
                       `PerformanceMonitor` 的 `bounds` 是**目标帧率区间**，不是分辨率的上下限：
                         · fps > bounds[1] ⇒ 调**高** dpr（`onChange` 收到 factor↑）
                         · fps < bounds[0] ⇒ 调**低** dpr
                       原来是 `bounds={() => [28, 32]}` ⇒ **它会把分辨率一路推到 fps 掉到
                       28~32 为止**。在 RTX 40 上就是 1→2（2800×1760）然后锁在 78 fps、
                       帧时间 12.8 ms，GPU 打满 —— 等于「故意把机器压到 30 帧」。
                       （实测：dpr 1 = 1400×880 = 8.3 ms/120 fps；dpr 2 = 2800×1760 = 12.8 ms/78 fps。）

                       现在改成**只做帧率保护、永不超采样**：
                         · 目标区间 [50, 58]，够 58 就不再往上推；
                         · `onChange` 里把 dpr 夹在 [0.75, 1.0] —— 弱显卡会自动降分辨率保帧率，
                           强显卡（本机）就停在 dpr 1，GPU 有一半余量。
                       想手动要 4K 级画面就加 `?dpr=2`（此时这个监控器整个不挂）。 */
                    <PerformanceMonitor
                        bounds={() => [50, 58]}
                        onFallback={() => setDpr(0.75)}
                        onChange={({ factor }) => {
                            const targetDpr = Math.min(1.0, Math.max(0.75, 1 + 0.5 * factor));
                            setDpr(targetDpr);
                        }}
                    />
                )}

                <BeamSceneContext.Provider value={beamScene}>
                    <WorldController />

                    <Suspense fallback={null}>
                        <color attach="background" args={['#000000']} />
                        {FIX_CAM
                            ? <StaticLook target={FIX_LOOK} />
                            : <CameraViewControl />}
                        <Environment
                            files="/textures/potsdamer_platz_1k_nb.hdr"
                            environmentIntensity={0.5}
                        />
                        <DirectionalLight />
                        {/* 后处理只挂一条：缺省 PostFX（由 WorldController 内部挂载），
                            `?pple=1` 才换回旧链 —— 理由见文件头部 LEGACY_PP 的长注释。
                            ⚠️ 两条同时挂会让场景每帧渲两遍、且后跑的覆盖先跑的色调映射。 */}
                        {LEGACY_PP && <Effects />}
                    </Suspense>
                </BeamSceneContext.Provider>
            </Canvas>
        )}
    </>
}
