export declare function trayEnvironmentIsSupported(
  platform: NodeJS.Platform,
  app: { isUnityRunning?(): boolean },
  environment: Readonly<Record<string, string | undefined>>,
): boolean;
