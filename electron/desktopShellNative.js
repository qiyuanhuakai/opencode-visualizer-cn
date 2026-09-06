export function safelyDisposeNativeResource(dispose) {
  try {
    dispose();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
}
