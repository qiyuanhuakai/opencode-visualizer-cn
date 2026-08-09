import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

export async function stageNodePtyRuntime(rootDirectory, destination, platform, arch) {
  const source = path.join(rootDirectory, 'node_modules', 'node-pty');
  const prebuildName = `${platform}-${arch}`;
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.join(destination, 'prebuilds'), { recursive: true });
  await cp(path.join(source, 'lib'), path.join(destination, 'lib'), { recursive: true });
  await cp(
    path.join(source, 'prebuilds', prebuildName),
    path.join(destination, 'prebuilds', prebuildName),
    { recursive: true },
  );
  await Promise.all([
    copyFile(path.join(source, 'package.json'), path.join(destination, 'package.json')),
    copyFile(path.join(source, 'LICENSE'), path.join(destination, 'LICENSE')),
  ]);
}
