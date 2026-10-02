import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';
import { apiClient } from '../api/client';

const captureRequest = async () => {
  let captured: InternalAxiosRequestConfig | undefined;

  await apiClient.get('/test-only', {
    adapter: async (config): Promise<AxiosResponse> => {
      captured = config;
      return {
        config,
        data: null,
        headers: {},
        status: 200,
        statusText: 'OK',
      };
    },
  });

  if (!captured) {
    throw new Error('Request adapter was not called');
  }
  return captured;
};

describe('apiClient authentication', () => {
  it('adds the current bearer token to outgoing requests', async () => {
    localStorage.setItem('tms_token', 'token-123');

    const request = await captureRequest();

    expect(request.headers.Authorization).toBe('Bearer token-123');
  });

  it('does not send an authorization header without a token', async () => {
    const request = await captureRequest();

    expect(request.headers.Authorization).toBeUndefined();
  });
});
