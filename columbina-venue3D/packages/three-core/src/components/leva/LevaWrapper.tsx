import { useState, ComponentProps } from 'react';
import { Leva } from 'leva';
import { customTheme } from './theme';
import { useShortcut } from '@core/hooks/useShortcut';

interface LevaWrapperProps extends Omit<ComponentProps<typeof Leva>, 'hidden'> {
    initialHidden?: boolean;
}

export function LevaWrapper({ initialHidden = false, ...props }: LevaWrapperProps) {

    const [hidden, setHidden] = useState(initialHidden);

    useShortcut('h', () => {
        setHidden(prev => !prev);
    });

    return (
        <Leva theme={customTheme as any} hidden={hidden} {...props} />
    )
}
