import { useRef } from 'react';
import { InputSystem } from '@core';

interface TouchJoystickProps<T extends string> {
  input: InputSystem<T>;
  // Map directions to your Game Action names
  actions: {
    forward: T;
    backward: T;
    left: T; // RotateLeft or StrafeLeft
    right: T; // RotateRight or StrafeRight
    run: T;
  };
}

export function TouchJoystick<T extends string>({ input, actions }: TouchJoystickProps<T>) {
  const knobRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Config (Kept from your original file)
  const MAX_RADIUS = 50; 
  const DEAD_ZONE = 10;      
  const RUN_THRESHOLD = 0.8; 

  // --- Visual Logic (Identical to your original) ---
  const updateKnobPosition = (x: number, y: number) => {
    if (knobRef.current) {
      knobRef.current.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
      
      // Apply smooth transition only when resetting to center
      if (x === 0 && y === 0) {
        knobRef.current.style.transition = 'transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
      } else {
        knobRef.current.style.transition = 'background 0.2s';
      }
    }
  };

  const handleJoystickMove = (clientX: number, clientY: number) => {
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    let deltaX = clientX - centerX;
    let deltaY = clientY - centerY;

    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    let clampedDistance = distance;

    if (distance > MAX_RADIUS) {
      const angle = Math.atan2(deltaY, deltaX);
      deltaX = Math.cos(angle) * MAX_RADIUS;
      deltaY = Math.sin(angle) * MAX_RADIUS;
      clampedDistance = MAX_RADIUS;
    }

    // 1. Update Visuals
    updateKnobPosition(deltaX, deltaY);

    // 2. Calculate Normalized Values (-1 to 1)
    let normX = 0;
    let normY = 0;

    if (clampedDistance > DEAD_ZONE) {
      normX = deltaX / MAX_RADIUS;
      // Invert Y because Screen Y goes DOWN, but 3D World Y goes UP (Forward)
      normY = -(deltaY / MAX_RADIUS); 
    }

    // 3. Update Engine: Axes (Analog)
    input.setAxis('horizontal', normX);
    input.setAxis('vertical', normY);

    // 4. Update Engine: Buttons (Digital) - Based on your original thresholds
    if (clampedDistance > DEAD_ZONE) {
      // Your original logic: Only trigger digital button if > 0.5 in that direction
      input.setButton(actions.forward, normY > 0.5);
      input.setButton(actions.backward, normY < -0.5);
      input.setButton(actions.left, normX < -0.5);
      input.setButton(actions.right, normX > 0.5);
    } else {
      input.setButton(actions.forward, false);
      input.setButton(actions.backward, false);
      input.setButton(actions.left, false);
      input.setButton(actions.right, false);
    }

    // 5. Run Logic
    const pullRatio = clampedDistance / MAX_RADIUS;
    input.setButton(actions.run, pullRatio > RUN_THRESHOLD);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    handleJoystickMove(e.clientX, e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (e.buttons > 0) {
      handleJoystickMove(e.clientX, e.clientY);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    
    // Reset Visuals
    updateKnobPosition(0, 0);
    
    // Reset Engine State
    input.setAxis('horizontal', 0);
    input.setAxis('vertical', 0);
    input.setButton(actions.forward, false);
    input.setButton(actions.backward, false);
    input.setButton(actions.left, false);
    input.setButton(actions.right, false);
    input.setButton(actions.run, false);
  };

  return (
    <div 
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{
        position: 'absolute', 
        left: '20px', 
        bottom: '20px', 
        zIndex: 100,

        width: '100px', 
        height: '100px',
        borderRadius: '50%',

        background: 'rgba(255, 255, 255, 0.1)',
        border: `2px solid rgba(255, 255, 255, 0.3)`,
        backdropFilter: 'blur(4px)',
        
        touchAction: 'none',
        pointerEvents: 'auto',
        cursor: 'pointer',
        userSelect: 'none',

        opacity: 0.5,
        transition: 'opacity 0.5s ease-in-out, border-color 0.2s',
      }}
    >
      <div 
        ref={knobRef}
        style={{
          width: '50px', 
          height: '50px',
          background: 'rgba(255, 255, 255, 0.8)',
          borderRadius: '50%', 
          position: 'absolute',
          top: '50%', 
          left: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
        }} 
      />
    </div>
  );
}