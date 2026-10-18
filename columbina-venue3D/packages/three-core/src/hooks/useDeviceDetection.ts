import { useEffect, useState } from 'react';

/**
 * Hook to detect if the user is on a mobile device based on pointer and width.
 */
export function useDeviceDetection(mobileWidth = 768) {
    const [isMobile, setIsMobile] = useState(false);

    useEffect(() => {
        const checkMobile = () => {
            // pointer: coarse is the standard way to detect touch screens
            const isTouch = window.matchMedia("(pointer: coarse)").matches;
            const isNarrow = window.innerWidth < mobileWidth;
            setIsMobile(isTouch || isNarrow);
        };

        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, [mobileWidth]);

    return isMobile;
}