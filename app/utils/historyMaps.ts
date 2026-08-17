export function cloneNullPrototypeRecord<T>(source: Record<string, T>): Record<string, T> {
  const clone: Record<string, T> = Object.create(null);
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(source));
  return clone;
}
