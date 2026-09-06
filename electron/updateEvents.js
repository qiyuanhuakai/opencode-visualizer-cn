import { assetNameFromInfo, boundedPercent, errorMessage, transition, versionFromInfo } from './updateState.js';

export function attachUpdaterEvents(updater, publish, getAvailableVersion, acceptOffer, rejectOffer) {
  const listeners = {
    'checking-for-update': () => publish('app', transition('checking')),
    'update-available': (info) => {
      try {
        const file = acceptOffer(info);
        publish('app', {
          availableVersion: versionFromInfo(info), phase: 'available', progress: null,
          error: null, assetName: file.name ?? assetNameFromInfo(info),
        });
      } catch (error) {
        rejectOffer(error);
        publish('app', { phase: 'error', progress: null, error: errorMessage(error) });
      }
    },
    'update-not-available': () => publish('app', {
      availableVersion: null, phase: 'up-to-date', progress: null, error: null, assetName: null,
    }),
    'download-progress': (progress) => publish('app', {
      phase: 'downloading', progress: boundedPercent(progress), error: null,
    }),
    'update-downloaded': (info) => publish('app', {
      availableVersion: versionFromInfo(info) ?? getAvailableVersion(),
      phase: 'downloaded', progress: 100, error: null,
    }),
    error: (error) => publish('app', { phase: 'error', progress: null, error: errorMessage(error) }),
  };
  for (const [event, listener] of Object.entries(listeners)) updater.on(event, listener);
  return () => {
    for (const [event, listener] of Object.entries(listeners)) updater.off(event, listener);
  };
}
