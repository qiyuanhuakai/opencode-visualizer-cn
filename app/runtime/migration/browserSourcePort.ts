import { openLegacyExport, readLegacyExportPage, resolveLegacyLocalBinding } from './legacyExport';
import type { LegacySource } from './legacyExport';
import type { LegacySourcePort } from './sourceArchive';
import { describeLocalBinding } from './legacyBinding';

export function createBrowserLegacySourcePort(source: LegacySource): LegacySourcePort {
  return {
    open: () => openLegacyExport(source),
    page: request => readLegacyExportPage(source, request),
    async binding(sourceKey) {
      return describeLocalBinding(await resolveLegacyLocalBinding(source, sourceKey), sourceKey);
    },
  };
}
