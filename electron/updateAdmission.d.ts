import type { DesktopComponent, DesktopUpdateState } from '../app/types/desktop';

type UpdateSnapshot = Readonly<Record<DesktopComponent, DesktopUpdateState>>;

export interface UpdateAdmission {
  run(component: DesktopComponent, operation: () => Promise<UpdateSnapshot>): Promise<UpdateSnapshot>;
  pending(): readonly Promise<UpdateSnapshot>[];
}

export declare function createUpdateAdmission(): UpdateAdmission;
