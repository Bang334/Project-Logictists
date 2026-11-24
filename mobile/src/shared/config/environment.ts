const TRAILING_SLASHES = /\/+$/;

export function getApiBaseUrl(): string {
  const configuredUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (!configuredUrl) {
    throw new Error(
      'Thiếu EXPO_PUBLIC_API_URL. Hãy tạo file .env.local từ .env.example.',
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new Error('EXPO_PUBLIC_API_URL không phải URL hợp lệ.');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('EXPO_PUBLIC_API_URL phải sử dụng http hoặc https.');
  }

  return configuredUrl.replace(TRAILING_SLASHES, '');
}
