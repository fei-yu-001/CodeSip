import { useEffect, useRef } from 'react';
import { updateGuards } from './updateGuards';

export function useUpdateGuard(reason: string | undefined) {
  const current = useRef(reason);
  current.current = reason;
  useEffect(() => {
    const unregister = updateGuards.register(() => current.current);
    const detach = updateGuards.attach(window);
    return () => {
      unregister();
      detach();
    };
  }, []);
}
