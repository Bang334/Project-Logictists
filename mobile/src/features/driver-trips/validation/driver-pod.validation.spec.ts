import { validatePodLocalFile } from './driver-pod.validation';

describe('driver POD file validation', () => {
  it('chấp nhận JPEG PHOTO và PNG SIGNATURE trong giới hạn', () => {
    expect(
      validatePodLocalFile('PHOTO', {
        uri: 'file:///photo.jpg',
        name: 'photo.jpg',
        mediaType: 'image/jpeg',
        sizeBytes: 1024,
      }),
    ).toEqual({ success: true });
    expect(
      validatePodLocalFile('SIGNATURE', {
        uri: 'file:///signature.png',
        name: 'signature.png',
        mediaType: 'image/png',
        sizeBytes: 1024,
      }),
    ).toEqual({ success: true });
  });

  it('từ chối MIME sai, file rỗng và vượt giới hạn', () => {
    expect(
      validatePodLocalFile('PHOTO', {
        uri: 'file:///photo.png',
        name: 'photo.png',
        mediaType: 'image/png',
      }).success,
    ).toBe(false);
    expect(
      validatePodLocalFile('PHOTO', {
        uri: '',
        name: 'photo.jpg',
        mediaType: 'image/jpeg',
      }).success,
    ).toBe(false);
    expect(
      validatePodLocalFile('SIGNATURE', {
        uri: 'file:///signature.png',
        name: 'signature.png',
        mediaType: 'image/png',
        sizeBytes: 2 * 1024 * 1024 + 1,
      }).success,
    ).toBe(false);
  });
});
