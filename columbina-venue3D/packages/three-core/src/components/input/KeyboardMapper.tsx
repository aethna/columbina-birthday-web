// src/core/components/KeyboardMapper.tsx
import { useEffect } from 'react';
import { InputSystem } from '../../input/InputSystem';

interface KeyboardMapperProps<T extends string> {
  input: InputSystem<T>;
  keyMap: Record<string, T>;
}

export function KeyboardMapper<T extends string>({ input, keyMap }: KeyboardMapperProps<T>) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent, isDown: boolean) => {
      // Look up by Code (Physical) OR Key (Letter)
      const action = keyMap[e.code] || keyMap[e.key.toLowerCase()];
      if (action) input.setButton(action, isDown);
    };

    const onDown = (e: KeyboardEvent) => !e.repeat && handleKey(e, true);
    const onUp = (e: KeyboardEvent) => handleKey(e, false);

    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);

    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      input.reset();
    };
  }, [input, keyMap]);

  return null;
}