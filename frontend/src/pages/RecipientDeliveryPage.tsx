import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Result,
  Space,
  Spin,
  Tag,
  TimePicker,
  Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { apiErrorMessage } from '../api/client';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

interface RecipientAppointmentView {
  id: string;
  batchId: string;
  orderId: string;
  version: number;
  status: string;
  windowStart: string;
  windowEnd: string;
  expiresAt: string;
  requestedStart?: string | null;
  requestedEnd?: string | null;
  responseNote?: string | null;
  order: { orderNumber: string };
}

const STATUS_LABELS: Record<string, { text: string; color: string }> = {
  PENDING: { text: 'Chờ xác nhận', color: 'processing' },
  CONFIRMED: { text: 'Đã xác nhận khung giao', color: 'success' },
  CHANGE_REQUESTED: { text: 'Đã gửi giờ mong muốn', color: 'warning' },
  SCHEDULED: { text: 'Đã chốt lịch giao', color: 'blue' },
  EXPIRED: { text: 'Hết hạn phản hồi', color: 'default' },
  CANCELLED: { text: 'Đã thu hồi', color: 'default' },
};

function formatVnWindow(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const dateLabel = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    dateStyle: 'full',
  }).format(start);
  const timeFmt = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${timeFmt.format(start)} – ${timeFmt.format(end)} · ${dateLabel}`;
}

function formatVnDateTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function readTokenFromLocation(): string {
  const rawHash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!rawHash) return '';
  try {
    return decodeURIComponent(rawHash).trim();
  } catch {
    return rawHash.trim();
  }
}

function toVnDateAndTime(iso: string): { date: Dayjs; time: Dayjs } {
  const value = new Date(iso);
  const parts = new Map(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(value)
      .map(part => [part.type, part.value]),
  );
  const ymd = `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
  const hm = `${parts.get('hour')}:${parts.get('minute')}`;
  return {
    date: dayjs(ymd, 'YYYY-MM-DD'),
    time: dayjs(`${ymd} ${hm}`, 'YYYY-MM-DD HH:mm'),
  };
}

const ChangeScheduleForm: React.FC<{
  initialWindowStart: string;
  initialWindowEnd: string;
  submitting: boolean;
  onSubmit: (values: { date?: Dayjs; startTime?: Dayjs; endTime?: Dayjs; note?: string }) => void;
}> = ({ initialWindowStart, initialWindowEnd, submitting, onSubmit }) => {
  const [form] = Form.useForm<{
    date?: Dayjs;
    startTime?: Dayjs;
    endTime?: Dayjs;
    note?: string;
  }>();

  useEffect(() => {
    const start = toVnDateAndTime(initialWindowStart);
    const end = toVnDateAndTime(initialWindowEnd);
    form.setFieldsValue({
      date: start.date,
      startTime: start.time,
      endTime: end.time,
      note: undefined,
    });
  }, [form, initialWindowEnd, initialWindowStart]);

  return (
    <Card size="small" title="Đề xuất khung giờ thuận tiện hơn">
      <Form form={form} layout="vertical" onFinish={onSubmit}>
        <Form.Item
          name="date"
          label="Ngày nhận hàng"
          rules={[{ required: true, message: 'Vui lòng chọn ngày nhận hàng' }]}
        >
          <DatePicker
            style={{ width: '100%' }}
            format="DD/MM/YYYY"
            disabledDate={current => current && current < dayjs().startOf('day')}
          />
        </Form.Item>
        <Space style={{ width: '100%' }} size="middle" wrap>
          <Form.Item
            name="startTime"
            label="Nhận từ lúc"
            rules={[{ required: true, message: 'Chọn giờ bắt đầu' }]}
          >
            <TimePicker format="HH:mm" minuteStep={15} />
          </Form.Item>
          <Form.Item
            name="endTime"
            label="Đến lúc"
            rules={[{ required: true, message: 'Chọn giờ kết thúc' }]}
          >
            <TimePicker format="HH:mm" minuteStep={15} />
          </Form.Item>
        </Space>
        <Form.Item name="note" label="Ghi chú cho tài xế (tùy chọn)">
          <Input.TextArea rows={2} maxLength={500} placeholder="Ví dụ: Gọi trước 15 phút" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={submitting} disabled={submitting}>
          Gửi khung giờ mong muốn
        </Button>
      </Form>
    </Card>
  );
};

const RecipientDeliveryPage: React.FC = () => {
  const token = useMemo(() => readTokenFromLocation(), []);
  const [appointment, setAppointment] = useState<RecipientAppointmentView | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string>('');
  const [submitError, setSubmitError] = useState<string>('');
  const [successMessage, setSuccessMessage] = useState<string>('');
  const [showChangeForm, setShowChangeForm] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const commandRef = useRef<{ fingerprint: string; key: string }>();

  const loadAppointment = useCallback(async () => {
    if (!token) {
      setLoading(false);
      setLoadError('Liên kết hẹn giao thiếu mã xác thực hoặc không hợp lệ.');
      return;
    }
    setLoading(true);
    setLoadError('');
    try {
      const response = await axios.get<RecipientAppointmentView>(
        `${API_URL}/delivery-planning/recipient`,
        { headers: { 'X-Delivery-Token': token }, timeout: 15_000 },
      );
      setAppointment(response.data);
    } catch (error) {
      setLoadError(apiErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadAppointment();
  }, [loadAppointment]);

  const submitDecision = async (
    decision: 'CONFIRMED' | 'CHANGE_REQUESTED',
    change?: { requestedStart: string; requestedEnd: string; note?: string },
  ) => {
    if (!appointment || submitting || !token) return;
    const payload = {
      version: appointment.version,
      decision,
      ...(change ?? {}),
    };
    const fingerprint = JSON.stringify({ id: appointment.id, ...payload });
    if (commandRef.current?.fingerprint !== fingerprint) {
      commandRef.current = { fingerprint, key: crypto.randomUUID() };
    }
    setSubmitting(true);
    setSubmitError('');
    setSuccessMessage('');
    try {
      const response = await axios.post<RecipientAppointmentView>(
        `${API_URL}/delivery-planning/recipient`,
        { ...payload, idempotencyKey: commandRef.current.key },
        { headers: { 'X-Delivery-Token': token }, timeout: 15_000 },
      );
      commandRef.current = undefined;
      setAppointment(response.data);
      setShowChangeForm(false);
      setSuccessMessage(
        decision === 'CONFIRMED'
          ? 'Đã ghi nhận xác nhận khung giờ nhận hàng của bạn.'
          : 'Đã gửi đề xuất khung giờ nhận hàng mới cho bộ phận điều phối.',
      );
    } catch (error) {
      setSubmitError(apiErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const handleChangeSubmit = (values: {
    date?: Dayjs;
    startTime?: Dayjs;
    endTime?: Dayjs;
    note?: string;
  }) => {
    if (!values.date || !values.startTime || !values.endTime) {
      setSubmitError('Vui lòng chọn ngày và đầy đủ giờ bắt đầu, giờ kết thúc.');
      return;
    }
    const dateStr = values.date.format('YYYY-MM-DD');
    const requestedStartIso = `${dateStr}T${values.startTime.format('HH:mm')}:00+07:00`;
    const requestedEndIso = `${dateStr}T${values.endTime.format('HH:mm')}:00+07:00`;
    const startMs = Date.parse(requestedStartIso);
    const endMs = Date.parse(requestedEndIso);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      setSubmitError('Giờ kết thúc phải sau giờ bắt đầu.');
      return;
    }
    if (startMs <= Date.now()) {
      setSubmitError('Khung giờ mới phải nằm trong tương lai.');
      return;
    }
    void submitDecision('CHANGE_REQUESTED', {
      requestedStart: requestedStartIso,
      requestedEnd: requestedEndIso,
      ...(values.note?.trim() ? { note: values.note.trim() } : {}),
    });
  };

  const isExpired =
    appointment?.status === 'EXPIRED' ||
    (appointment?.status === 'PENDING' && Date.parse(appointment.expiresAt) <= Date.now());
  const effectiveStatus = isExpired ? 'EXPIRED' : appointment?.status ?? '';
  const statusMeta = STATUS_LABELS[effectiveStatus] ?? {
    text: effectiveStatus || 'Không xác định',
    color: 'default',
  };
  const canRespond = Boolean(appointment && effectiveStatus === 'PENDING');

  return (
    <main
      id="main-content"
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #eff6ff 0%, #f8fafc 45%)',
        padding: '32px 16px',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
      }}
    >
      <Card
        style={{ width: '100%', maxWidth: 560, borderRadius: 12 }}
        title={
          <Space direction="vertical" size={2}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              TMS LOGISTICS · XÁC NHẬN LỊCH GIAO HÀNG
            </Typography.Text>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {appointment ? `Đơn hàng ${appointment.order.orderNumber}` : 'Thông tin hẹn giao'}
            </Typography.Title>
          </Space>
        }
        extra={appointment && <Tag color={statusMeta.color}>{statusMeta.text}</Tag>}
      >
        {loading ? (
          <Spin spinning tip="Đang tải thông tin hẹn giao...">
            <div style={{ minHeight: 120 }} />
          </Spin>
        ) : loadError ? (
          <Result
            status="warning"
            title="Không tải được thông tin hẹn giao"
            subTitle={loadError}
            extra={
              token ? (
                <Button type="primary" onClick={() => void loadAppointment()}>
                  Thử lại
                </Button>
              ) : null
            }
          />
        ) : appointment ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {successMessage && <Alert type="success" showIcon message={successMessage} />}
            {submitError && <Alert type="error" showIcon message={submitError} />}

            <Card size="small" style={{ background: '#f8fafc' }}>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Typography.Text type="secondary">Khung giờ dự kiến giao (giờ Việt Nam)</Typography.Text>
                <Typography.Text strong style={{ fontSize: 16, color: '#0f5593' }}>
                  {formatVnWindow(appointment.windowStart, appointment.windowEnd)}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Hạn phản hồi: {formatVnDateTime(appointment.expiresAt)}
                </Typography.Text>
              </Space>
            </Card>

            {effectiveStatus === 'CHANGE_REQUESTED' &&
              appointment.requestedStart &&
              appointment.requestedEnd && (
                <Alert
                  type="info"
                  showIcon
                  message="Khung giờ bạn đã chọn"
                  description={
                    <>
                      <div>{formatVnWindow(appointment.requestedStart, appointment.requestedEnd)}</div>
                      {appointment.responseNote && <div>Ghi chú: {appointment.responseNote}</div>}
                    </>
                  }
                />
              )}

            {effectiveStatus === 'SCHEDULED' && (
              <Alert
                type="success"
                showIcon
                message="Đơn hàng đã được chốt lịch giao chính thức theo khung giờ trên."
              />
            )}

            {effectiveStatus === 'EXPIRED' && (
              <Alert
                type="warning"
                showIcon
                message="Liên kết phản hồi đã quá hạn."
                description="Vui lòng liên hệ nhân viên giao nhận hoặc điều phối nếu cần hẹn lại."
              />
            )}

            {canRespond && (
              <>
                <Space wrap>
                  <Button
                    type="primary"
                    loading={submitting}
                    disabled={submitting}
                    onClick={() => void submitDecision('CONFIRMED')}
                  >
                    Xác nhận nhận hàng khung này
                  </Button>
                  <Button
                    disabled={submitting}
                    onClick={() => {
                      setSubmitError('');
                      setShowChangeForm(prev => !prev);
                    }}
                  >
                    {showChangeForm ? 'Ẩn chọn giờ khác' : 'Đổi khung giờ khác'}
                  </Button>
                </Space>

                {showChangeForm && (
                  <ChangeScheduleForm
                    initialWindowStart={appointment.windowStart}
                    initialWindowEnd={appointment.windowEnd}
                    submitting={submitting}
                    onSubmit={handleChangeSubmit}
                  />
                )}
              </>
            )}

            <div style={{ textAlign: 'right' }}>
              <Button size="small" type="link" loading={loading} onClick={() => void loadAppointment()}>
                Tải lại trạng thái
              </Button>
            </div>
          </Space>
        ) : null}
      </Card>
    </main>
  );
};

export default RecipientDeliveryPage;
