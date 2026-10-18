'use client';

import { useEffect } from 'react';
import { useGameStore } from '../core/store/gameStore';
import { WebGPUCanvas } from '@core';
import { DistortedCircle } from '@core';
import { Bgm } from '@core';
import { useShortcut } from '@core/hooks/useShortcut';

const tracks = [
    { id: 'grass_field', url: '/audio/grass_field.mp3', volume: 1.5 },
    { id: 'noise', url: '/audio/noise.m4a', volume: 0.1}
]
export default function AudioButton() {
    const listener = useGameStore(s => s.audioListener);
    const isGameStarted = useGameStore((state) => state.isGameStarted);
    const isSoundOn = useGameStore((state) => state.isSoundOn);
    const setIsSoundOn = useGameStore((state) => state.setIsSoundOn);

    const radius = 10;
    const size = 45;

    useEffect(() => {
        if (isGameStarted) {
            setIsSoundOn(true);
        }
    }, [isGameStarted]);

    /* ⚠️ 键位冲突修复（2026-10-17）：这里原本是 `useShortcut('m', …)`，
       而 `ui/WorldMap.tsx:38-47` 也监听 window keydown 的 `m` 用来开合大地图。
       两边都是 window 级监听、都不 `stopPropagation`（也拦不住 —— 同一元素上的
       多个监听器互不影响），于是**按一次 M 会同时切 BGM 和弹地图**。
       现在 M 留给大地图（M = Map，且地图更常用），BGM 改 **B**（BGM）。
       `ui/LoadingScreen.tsx:244-248` 的按键说明只列了 WASD / SHIFT / C / 鼠标，
       没有列 M，所以不需要同步改文档。 */
    useShortcut('b', () => {
        setIsSoundOn(!isSoundOn);
    });

    return (
        <WebGPUCanvas
            width={size}
            height={size}
            style={{ position: 'fixed', bottom: 0, right: 0, zIndex: 20 }}
        >
            {/* Interaction Layer (Invisible Hitbox) */}
            <mesh
                onClick={() => setIsSoundOn(!isSoundOn)}
                onPointerOver={() => {
                    document.body.style.cursor = 'pointer';
                }}
                onPointerOut={() => {
                    document.body.style.cursor = 'auto';
                }}
                visible={false} // Invisible but captures events
            >
                <circleGeometry args={[radius * 1.2, 32]} />
                <meshBasicMaterial />
            </mesh>

            <Bgm listener={listener} active={isSoundOn} tracks={tracks} />

            {/* Visual Layer */}
            <group>
                {[12.35, 0.58, 3.67].map((seed, i) => (
                    <DistortedCircle
                        key={i}
                        radius={radius}
                        distortionStrength={isSoundOn ? 1 : 0}
                        seed={seed}
                    />
                ))}
            </group>
        </WebGPUCanvas>
    );
}