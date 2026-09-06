export function createUpdateAdmission() {
  const active = new Map();
  return {
    run(component, operation) {
      const running = active.get(component);
      if (running) return running;
      const promise = Promise.resolve()
        .then(operation)
        .finally(() => {
          if (active.get(component) === promise) active.delete(component);
        });
      active.set(component, promise);
      return promise;
    },
    pending() {
      return [...active.values()];
    },
  };
}
