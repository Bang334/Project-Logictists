import type {
  DriverPodEvidenceType,
  DriverPodLocalFile,
} from '@/features/driver-trips/types/driver-trip.types';

const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;

export type PodFileValidation =
  | { success: true }
  | { success: false; message: string };

export function validatePodLocalFile(
  evidenceType: DriverPodEvidenceType,
  file: DriverPodLocalFile,
): PodFileValidation {
  if (!file.uri.trim() || !file.name.trim()) {
    return { success: false, message: 'File bằng chứng không hợp lệ.' };
  }
  const expectedMediaType =
    evidenceType === 'PHOTO' ? 'image/jpeg' : 'image/png';
  if (file.mediaType !== expectedMediaType) {
    return {
      success: false,
      message:
        evidenceType === 'PHOTO'
          ? 'Ảnh giao hàng phải có định dạng JPEG.'
          : 'Chữ ký phải có định dạng PNG.',
    };
  }
  const maxBytes =
    evidenceType === 'PHOTO' ? PHOTO_MAX_BYTES : SIGNATURE_MAX_BYTES;
  if (
    file.sizeBytes !== undefined &&
    (!Number.isInteger(file.sizeBytes) ||
      file.sizeBytes <= 0 ||
      file.sizeBytes > maxBytes)
  ) {
    return {
      success: false,
      message: `File vượt giới hạn ${Math.round(maxBytes / 1024 / 1024)} MB hoặc có kích thước không hợp lệ.`,
    };
  }
  return { success: true };
}
