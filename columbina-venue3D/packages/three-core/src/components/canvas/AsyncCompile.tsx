import React, { useRef, useEffect, useState } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { useUploadQueue } from '../../hooks/useUploadQueue';

interface AsyncCompileProps {
  children: React.ReactNode;
  id: string;
  onReady?: (id: string, isReady: boolean) => void;
  debug?: boolean;
  uploadFrames?: number;
  timeout?: number; // Added timeout prop
}

/**
 * Manages asynchronous shader compilation and GPU uploads with bandwidth throttling.
 * Flow: idle → compiled → uploading → done
 */
export function AsyncCompile({ 
  children, 
  id, 
  onReady, 
  debug = false,
  uploadFrames = 3,
  timeout = 3000 // Default 3s safety timeout
}: AsyncCompileProps) {
  // @ts-ignore - WebGPURenderer might have different types than WebGLRenderer
  const { gl, camera } = useThree();
  
  const enqueueUpload = useUploadQueue((state) => state.enqueueUpload);
  const processNextUpload = useUploadQueue((state) => state.processNextUpload);
  const removeUpload = useUploadQueue((state) => state.removeUpload);
  const currentUploader = useUploadQueue((state) => state.currentUploader);
  
  const groupRef = useRef<THREE.Group>(null);
  const [status, setStatus] = useState<'idle' | 'compiled' | 'uploading' | 'done'>('idle');
  const frameCount = useRef(0);
  const startTime = useRef<number>(0);
  
  const log = (...args: any[]) => {
    if (debug) console.log(...args);
  };

  // Stage 1: Async Shader Compilation
  useEffect(() => {
    let isMounted = true;
    
    const compile = async () => {
      log(`📦 [${id}] Stage 1: Starting async compilation...`);
      startTime.current = performance.now();
      
      // syncs with the GPU render loop, preventing mobile race conditions
      await new Promise(resolve => requestAnimationFrame(resolve));
      
      if (groupRef.current && isMounted) {
        try {
          // [!code ++] ADDED: Promise.race to catch Mobile GPU hangs
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('TIMEOUT')), timeout)
          );

          // @ts-ignore - compileAsync is specific to Three/WebGPU
          await Promise.race([
            gl.compileAsync(groupRef.current, camera),
            timeoutPromise
          ]);
          
          if (isMounted) {
            const compileTime = (performance.now() - startTime.current).toFixed(1);
            log(`✨ [${id}] Stage 1 Complete: Compiled in ${compileTime}ms. Joining queue...`);
            setStatus('compiled');
            enqueueUpload(id);
          }
        } catch (error: any) {
          if (error.message === 'TIMEOUT') {
             log(`⚠️ [${id}] Compilation timed out. Skipping optimization.`);
          } else {
             log(`❌ [${id}] Compilation error:`, error);
          }
          
          // Fallback: Force ready state so the object shows and game doesn't hang
          onReady?.(id, true); 
          setStatus('done');
          
          // Prevent queue deadlock if we crashed while holding the upload slot
          if (useUploadQueue.getState().currentUploader === id) {
            processNextUpload();
          }
        }
      }
    };
    
    onReady?.(id, false);
    compile();
    
    return () => {
      isMounted = false;
      onReady?.(id, false);
      removeUpload(id);
    };
  }, [gl, camera, id, enqueueUpload, onReady, removeUpload, processNextUpload, timeout]);

  // Stage 2: Queue Management
  useEffect(() => {
    if (status === 'compiled' && currentUploader === id) {
      log(`⬆️ [${id}] Stage 2: Got upload slot! Transferring data to GPU...`);
      setStatus('uploading');
      frameCount.current = 0;
      startTime.current = performance.now();
    }
  }, [currentUploader, status, id]);

  // Stage 3: GPU Upload Throttling
  useFrame(() => {
    if (status !== 'uploading') return;
    
    frameCount.current += 1;
    
    if (frameCount.current === 1 && debug) {
      log(`📤 [${id}] Frame 1: Initializing textures/geometry...`);
    }
    
    // Wait for the requested number of frames to let GPU finish data transfer
    if (frameCount.current > uploadFrames) {
      const uploadTime = (performance.now() - startTime.current).toFixed(1);
      log(`💾 [${id}] Stage 3 Complete: Uploaded in ${uploadTime}ms (${frameCount.current} frames)`);
      
      setStatus('done');
      onReady?.(id, true);
      processNextUpload();
    }
  });

  const isVisible = status === 'uploading' || status === 'done';

  return (
    <group ref={groupRef} visible={isVisible}>
      {children}
    </group>
  );
}