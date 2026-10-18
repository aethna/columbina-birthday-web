import { useShortcut } from '../../hooks/useShortcut';

interface CanvasCaptureProps {
  /** Enable screenshot functionality. Default: 's' */
  triggerKey?: string;
  /** Custom screenshot filename */
  screenshotName?: string;
}

/**
 * CanvasCapture - Utility to capture the canvas via a shortcut.
 * Default key: 's'
 */
export function CanvasCapture({ 
  triggerKey = 's', 
  screenshotName = 'Screenshot.png' 
}: CanvasCaptureProps) {
  
  // Use the core hook to handle the event logic & cleanup
  useShortcut(triggerKey, () => {
    takeScreenshot(screenshotName);
  });

  return null;
}

/**
 * Capture the first canvas found in the document
 */
export function takeScreenshot(filename: string = 'Screenshot.png'): void {
  const canvas = document.querySelector('canvas');
  
  if (!canvas) {
    console.warn('CanvasCapture: No canvas element found');
    return;
  }

  try {
    const link = document.createElement('a');
    link.download = filename;
    // Note: ensure preserveDrawingBuffer is true in your Canvas settings
    link.href = canvas.toDataURL('image/png');
    link.click();
  } catch (error) {
    console.error('Failed to take screenshot:', error);
  }
}