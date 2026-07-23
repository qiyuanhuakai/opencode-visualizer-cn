export type ContainerPinScope =
  | { level: 'repo'; root: string }
  | { level: 'branch'; directory: string; repoRoot?: string };

export type ContainerPinPayload = {
  projectId: string;
  scope: ContainerPinScope;
};
