export interface DaemonStopResponse {
  writeHead(statusCode: number): { end(): unknown };
}

export function acknowledgeDaemonStop(
  response: DaemonStopResponse,
  shutdown: () => Promise<void>,
  exitProcess: () => void,
): void;

export function runDaemonProcess(
  options: object,
  createBridgeServer: (options: object) => object,
): Promise<void>;
