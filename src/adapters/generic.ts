import type { EnforcerFn } from "../types.js";

export function watchTool<T extends (...args: unknown[]) => Promise<unknown>>(
  name: string,
  fn: T,
  enforcer: EnforcerFn,
): T {
  const wrapped = async (...args: unknown[]) => {
    const params =
      args.length === 1 && typeof args[0] === "object" && args[0] !== null
        ? (args[0] as Record<string, unknown>)
        : { args };
    return enforcer(name, params, () => fn(...args));
  };
  Object.defineProperty(wrapped, "name", { value: name });
  return wrapped as unknown as T;
}
