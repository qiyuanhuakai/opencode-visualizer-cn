// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  chmod: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  chmod: fsMocks.chmod,
  mkdtemp: fsMocks.mkdtemp,
  rm: fsMocks.rm,
}));

import { createUpdateTransport } from '../electron/updateTransport.js';

describe('shared update transport staging cleanup', () => {
  it('removes a newly-created staging directory when private permission setup fails', async () => {
    fsMocks.mkdtemp.mockResolvedValue('/tmp/vis-update-private');
    fsMocks.chmod.mockRejectedValue(new Error('chmod failed'));
    fsMocks.rm.mockResolvedValue(undefined);
    const transport = createUpdateTransport();

    await expect(transport.downloadAsset({
      name: 'VisBridge-1.2.3-x64-Linux.deb',
      digest: `sha256:${'a'.repeat(64)}`,
      size: 4,
      url: 'https://api.github.com/repos/qiyuanhuakai/opencode-visualizer-cn/releases/assets/1',
    })).rejects.toThrow('chmod failed');

    expect(fsMocks.rm).toHaveBeenCalledWith('/tmp/vis-update-private', {
      recursive: true,
      force: true,
    });
    transport.dispose();
  });
});
