// Features own their update blockers. The updater only consumes reasons.
export type UpdateGuard = () => string | undefined;
export function createUpdateGuards() {
  const guards = new Set<UpdateGuard>();
  const targets = new Map<EventTarget, { count: number; listener: EventListener }>();
  const reasons = () => [
    ...new Set([...guards].map((guard) => guard()).filter((value): value is string => !!value)),
  ];
  return {
    reasons,
    register(guard: UpdateGuard) {
      // Wrap to allow independent registrations of the same getter.
      const read = () => guard();
      guards.add(read);
      return () => {
        guards.delete(read);
      };
    },
    attach(target: EventTarget) {
      let binding = targets.get(target);
      if (!binding) {
        const listener = (event: Event) => {
          if (reasons().length) event.preventDefault();
        };
        binding = { count: 0, listener };
        targets.set(target, binding);
        target.addEventListener('codesip:before-update', listener);
      }
      binding.count++;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (--binding.count === 0) {
          target.removeEventListener('codesip:before-update', binding.listener);
          targets.delete(target);
        }
      };
    },
  };
}
export const updateGuards = createUpdateGuards();
