import type { MessagePort } from 'node:worker_threads';
import type { LegacySource } from '../shared/runtime/migration/legacyExport.js';
export function createElectronLegacySource(filePath: string): LegacySource;
export function serveLegacyExportWorker(port: MessagePort, filePath: string): void;
