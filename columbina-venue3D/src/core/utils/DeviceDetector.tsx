import { useEffect } from 'react';
import { useDeviceDetection } from '@core';
import { useGameStore } from '../store/gameStore';

export function DeviceDetector() {
  const setIsMobile = useGameStore((state) => state.setIsMobile);
  const isMobile = useDeviceDetection();

  useEffect(() => {
    setIsMobile(isMobile);
  }, [isMobile, setIsMobile]);

  return null;
}