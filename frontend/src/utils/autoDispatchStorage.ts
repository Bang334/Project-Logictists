import { AutomaticDispatchScheduleModeUI } from '../types';

export interface StoredAutoDispatchState {
  branchId: string;
  optimizationJobId: string;
  appliedTripCount: number | null;
  scheduleMode: AutomaticDispatchScheduleModeUI;
  customStartTimeStr?: string | null;
  useCustomTime: boolean;
  selectedVehicleForMap?: string | 'ALL';
  savedAt: string;
}

const STORAGE_PREFIX = 'tms_auto_dispatch_state_';
const LAST_BRANCH_KEY = 'tms_auto_dispatch_last_branch';

/**
 * Lưu trạng thái điều phối tự động của một chi nhánh vào localStorage.
 */
export const saveAutoDispatchState = (state: StoredAutoDispatchState): void => {
  try {
    localStorage.setItem(
      `${STORAGE_PREFIX}${state.branchId}`,
      JSON.stringify(state),
    );
    localStorage.setItem(LAST_BRANCH_KEY, state.branchId);
  } catch (error) {
    console.warn('Lỗi khi lưu phương án điều phối tự động:', error);
  }
};

/**
 * Lấy trạng thái điều phối tự động đã lưu của một chi nhánh từ localStorage.
 */
export const getAutoDispatchState = (
  branchId: string,
): StoredAutoDispatchState | null => {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${branchId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAutoDispatchState;
    if (
      parsed &&
      parsed.branchId === branchId &&
      typeof parsed.optimizationJobId === 'string' &&
      parsed.optimizationJobId.length > 0
    ) {
      return parsed;
    }
  } catch (error) {
    console.warn('Lỗi khi đọc phương án điều phối tự động:', error);
  }
  return null;
};

/**
 * Xóa trạng thái điều phối tự động đã lưu của một chi nhánh.
 */
export const clearAutoDispatchState = (branchId: string): void => {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${branchId}`);
  } catch (error) {
    console.warn('Lỗi khi xóa phương án điều phối tự động:', error);
  }
};

/**
 * Xóa toàn bộ trạng thái điều phối tự động đã lưu của tất cả các chi nhánh.
 */
export const clearAllAutoDispatchStates = (): void => {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  } catch (error) {
    console.warn('Lỗi khi dọn dẹp toàn bộ phương án điều phối:', error);
  }
};

/**
 * Lưu ID chi nhánh được chọn gần nhất.
 */
export const saveLastSelectedBranch = (branchId: string): void => {
  try {
    localStorage.setItem(LAST_BRANCH_KEY, branchId);
  } catch (error) {
    console.warn('Lỗi khi lưu chi nhánh cuối:', error);
  }
};

/**
 * Lấy ID chi nhánh được chọn gần nhất.
 */
export const getLastSelectedBranch = (): string | null => {
  try {
    return localStorage.getItem(LAST_BRANCH_KEY);
  } catch {
    return null;
  }
};
