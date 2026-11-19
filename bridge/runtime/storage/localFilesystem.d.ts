/** Target-probed filesystem admission: the volume identity is never inferred from the host OS. */
export function classifyFilesystem(platform: string, type: string): { readonly platform: string; readonly type: string; readonly local: boolean };
/** Darwin assigns filesystem type numbers at runtime, so the mount table's type name is the
 * stable identity; stat(1) has no statfs mode there and its %T is the file type, not the fs. */
export function darwinMountType(mountOutput: string, canonicalPath: string): string;
export function probeLocalFilesystem(directory: string): { readonly platform: string; readonly type: string; readonly local: boolean; readonly canonicalPath: string };
