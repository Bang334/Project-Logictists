import { NotFoundException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveLinkSecret(): string {
  const secret = process.env.DELIVERY_LINK_SECRET || process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('Thiếu secret để ký liên kết hẹn giao');
  }
  return secret;
}

function signAppointmentId(appointmentId: string): string {
  return createHmac('sha256', resolveLinkSecret())
    .update(`delivery-recipient:${appointmentId}`)
    .digest('base64url');
}

/**
 * Tạo liên kết công khai /hen-giao#<token> cho người nhận hàng xác nhận hoặc chọn khung giờ.
 */
export function recipientLink(
  appointment: { id: string },
  publicWebUrl?: string | null,
): string {
  const baseUrl = (
    publicWebUrl ||
    process.env.DELIVERY_PUBLIC_WEB_URL ||
    process.env.CORS_ORIGIN?.split(',')[0] ||
    'http://localhost:5173'
  )
    .trim()
    .replace(/\/+$/, '');
  const token = `${appointment.id}.${signAppointmentId(appointment.id)}`;
  return `${baseUrl}/hen-giao#${token}`;
}

/**
 * Xác thực token liên kết người nhận bằng HMAC-SHA256 và trả về appointmentId.
 */
export function verifyRecipientToken(token: string): string {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  const dot = trimmed.indexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) {
    throw new NotFoundException('Liên kết hẹn giao không hợp lệ');
  }
  const appointmentId = trimmed.slice(0, dot);
  const signature = trimmed.slice(dot + 1);
  if (!UUID_REGEX.test(appointmentId) || !signature) {
    throw new NotFoundException('Liên kết hẹn giao không hợp lệ');
  }

  let actual: Buffer;
  let expected: Buffer;
  try {
    actual = Buffer.from(signature, 'base64url');
    expected = Buffer.from(signAppointmentId(appointmentId), 'base64url');
  } catch {
    throw new NotFoundException('Liên kết hẹn giao không hợp lệ');
  }
  if (actual.length === 0 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new NotFoundException('Liên kết hẹn giao không hợp lệ');
  }
  return appointmentId;
}

/**
 * Chuẩn hóa số điện thoại người nhận (hỗ trợ đầu 0 / 84 Việt Nam và định dạng E.164).
 */
export function normalizeRecipientPhone(rawPhone?: string | null): string {
  const cleaned = (rawPhone ?? '').replace(/[\s().-]/g, '');
  const normalized = cleaned
    .replace(/^0(?=\d{9}$)/, '+84')
    .replace(/^84(?=\d{9}$)/, '+84');
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error('Số điện thoại người nhận không hợp lệ');
  }
  return normalized;
}

/**
 * Định dạng khung giờ hẹn giao ngắn gọn theo giờ Việt Nam cho tin nhắn SMS.
 */
export function formatDeliverySmsWindow(windowStart: Date, windowEnd: Date): string {
  const datePart = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(windowStart);
  const timeFormatter = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${timeFormatter.format(windowStart)}-${timeFormatter.format(windowEnd)} ngày ${datePart}`;
}
