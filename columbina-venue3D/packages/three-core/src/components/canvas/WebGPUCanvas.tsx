'use client';

import React, { ReactNode } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrthographicCamera } from '@react-three/drei';
import { WebGPURenderer } from 'three/webgpu';

interface WebGPUCanvasProps {
  children: ReactNode;
  width?: number;
  height?: number;
  style?: React.CSSProperties;
  className?: string;
  dpr?: number | [number, number];
  depth?: boolean;
}

export function WebGPUCanvas({
  children,
  width = 200,
  height = 200,
  style,
  className,
  dpr = [1, 2],
  depth = false
}: WebGPUCanvasProps) {

  const halfW = width / 2;
  const halfH = height / 2;

  return (
    <div style={{ width, height, ...style }} className={className}>
      <Canvas
        style={{ width: '100%', height: '100%', pointerEvents: 'auto' }}
        dpr={dpr}
        gl={(canvas) => {
          // Initialize WebGPU renderer with core optimizations
          const renderer = new WebGPURenderer({
            ...canvas as any,
            powerPreference: "high-performance",
            antialias: true,
            alpha: true,
            depth: depth,
            stencil: false,
          });

          // Fiber expects the renderer to be returned, WebGPU requires async init
          return renderer.init().then(() => renderer);
        }}
      >
        <OrthographicCamera
          makeDefault
          position={[0, 0, 10]}
          zoom={1}
          left={-halfW}
          right={halfW}
          top={halfH}
          bottom={-halfH}
        />

        {children}
      </Canvas>
    </div>
  );
}