import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { setPointerActive } from './shared/pointerInteraction';

/**
 * Attach canvas pointer listeners once. Updates pointerInteraction.active.
 * Mount via InteractionSync (or any single Canvas child).
 */
export function useCanvasPointerActive(): void {
  const { gl } = useThree();

  useEffect(() => {
    const canvas = gl.domElement;
    const activate = () => setPointerActive(true);
    const deactivate = () => setPointerActive(false);

    canvas.addEventListener('pointermove', activate);
    canvas.addEventListener('pointerdown', activate);
    canvas.addEventListener('pointerenter', activate);
    canvas.addEventListener('pointerleave', deactivate);
    canvas.addEventListener('pointercancel', deactivate);

    if (canvas.matches(':hover')) {
      setPointerActive(true);
    }

    return () => {
      canvas.removeEventListener('pointermove', activate);
      canvas.removeEventListener('pointerdown', activate);
      canvas.removeEventListener('pointerenter', activate);
      canvas.removeEventListener('pointerleave', deactivate);
      canvas.removeEventListener('pointercancel', deactivate);
      setPointerActive(false);
    };
  }, [gl]);
}
