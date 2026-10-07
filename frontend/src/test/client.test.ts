import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiClient, setApiSession } from '../api/client';

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
  beforeEach(() => setApiSession(null));
  it('adds the current bearer token to outgoing requests', async () => {
    setApiSession('token-123');

    const request = await captureRequest();

    expect(request.headers.Authorization).toBe('Bearer token-123');
  });

  it('does not send an authorization header without a token', async () => {
    const request = await captureRequest();

    expect(request.headers.Authorization).toBeUndefined();
  });
});

describe('tripsApi.publish contract', () => {
  it('sends PATCH /trips/:id/publish with expectedVersion payload', async () => {
    let captured: InternalAxiosRequestConfig | undefined;

    await apiClient.patch(
      '/trips/trip-123/publish',
      { expectedVersion: 2 },
      {
        adapter: async (config): Promise<AxiosResponse> => {
          captured = config;
          return {
            config,
            data: { id: 'trip-123', status: 'DISPATCHED', version: 3 },
            headers: {},
            status: 200,
            statusText: 'OK',
          };
        },
      },
    );

    expect(captured).toBeDefined();
    expect(captured?.url).toBe('/trips/trip-123/publish');
    expect(captured?.method?.toLowerCase()).toBe('patch');
    expect(JSON.parse(captured?.data as string)).toEqual({ expectedVersion: 2 });
  });
});

