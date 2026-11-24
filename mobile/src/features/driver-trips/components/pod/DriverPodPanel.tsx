import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import SignatureScreen, {
  type SignatureViewRef,
} from "react-native-signature-canvas";
import { useDriverPod, type DriverPodUploadStore } from "@/features/driver-trips/hooks/useDriverPod";
import type {
  DriverPodFile,
  DriverPodLocalFile,
  DriverTripStop,
} from "@/features/driver-trips/types/driver-trip.types";
import { PrimaryButton } from "@/shared/components/PrimaryButton";
import { ScreenMessage } from "@/shared/components/ScreenMessage";
import { driverTheme } from "@/shared/theme/driver-theme";
import { DriverStatusBadge } from "../DriverTripStatusBadge";

const { colors, spacing } = driverTheme;
const deliveryLabels = { SUCCESS: "Giao thành công", PARTIAL: "Giao một phần", FAILED: "Giao thất bại" };

interface Props {
  tripId: string;
  stop: DriverTripStop;
  readOnly?: boolean;
  onSignatureInteractionChange?: (isInteracting: boolean) => void;
  onUploadChange?: (uploading: boolean) => void;
  uploadStore?: DriverPodUploadStore;
}

interface PendingPhoto {
  file: DriverPodLocalFile;
  capturedAt: string;
  supersedesId?: string;
}

export function DriverPodPanel({
  tripId,
  stop,
  readOnly = false,
  onSignatureInteractionChange,
  onUploadChange,
  uploadStore,
}: Props) {
  const attempt = stop.deliveryAttempt;
  if (!attempt) return null;
  return (
    <DriverPodPanelContent
      key={attempt.id}
      tripId={tripId}
      stop={stop}
      attemptId={attempt.id}
      readOnly={readOnly}
      onSignatureInteractionChange={onSignatureInteractionChange}
      onUploadChange={onUploadChange}
      uploadStore={uploadStore}
    />
  );
}

function DriverPodPanelContent({
  tripId,
  stop,
  attemptId,
  readOnly,
  onSignatureInteractionChange,
  onUploadChange,
  uploadStore,
}: {
  tripId: string;
  stop: DriverTripStop;
  attemptId: string;
  readOnly: boolean;
  onSignatureInteractionChange?: (isInteracting: boolean) => void;
  onUploadChange?: (uploading: boolean) => void;
  uploadStore?: DriverPodUploadStore;
}) {
  const pod = useDriverPod({ tripId, stopId: stop.id, attemptId, onUploadChange, uploadStore });
  const { width, fontScale } = useWindowDimensions();
  const twoColumns = width >= 340 && fontScale <= 1.2;
  const signatureRef = useRef<SignatureViewRef>(null);
  const [showSignature, setShowSignature] = useState(false);
  const [pendingPhoto, setPendingPhoto] = useState<PendingPhoto | null>(null);
  const [preview, setPreview] = useState<{
    url: string;
    title: string;
  } | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);

  useEffect(() => {
    if (readOnly) onSignatureInteractionChange?.(false);
  }, [readOnly, onSignatureInteractionChange]);

  const activeItems =
    pod.pod?.items.filter(
      (item) => item.uploadStatus === "UPLOADED" && !item.isSuperseded,
    ) ?? [];
  const activeSignature = activeItems.find(
    (item) => item.evidenceType === "SIGNATURE",
  );
  const hasActivePhoto = activeItems.some(
    (item) => item.evidenceType === "PHOTO",
  );

  const capturePhoto = async (supersedesId?: string) => {
    setCaptureError(null);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setCaptureError(
        "Ứng dụng cần quyền camera để chụp bằng chứng giao hàng.",
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      cameraType: ImagePicker.CameraType.back,
      quality: 0.75,
      exif: false,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) {
      setCaptureError("Không nhận được ảnh từ camera.");
      return;
    }
    if (asset.mimeType && asset.mimeType !== "image/jpeg") {
      setCaptureError("Camera phải tạo ảnh JPEG để dùng làm bằng chứng.");
      return;
    }
    setPendingPhoto({
      file: {
        uri: asset.uri,
        name: asset.fileName || `pod-photo-${Crypto.randomUUID()}.jpg`,
        mediaType: "image/jpeg",
        sizeBytes: asset.fileSize,
      },
      capturedAt: new Date().toISOString(),
      supersedesId,
    });
  };

  const uploadPendingPhoto = async () => {
    if (!pendingPhoto) return;
    const success = await pod.upload(
      "PHOTO",
      pendingPhoto.file,
      pendingPhoto.capturedAt,
      pendingPhoto.supersedesId,
    );
    if (success) setPendingPhoto(null);
  };

  const saveSignature = async (dataUrl: string) => {
    setCaptureError(null);
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    if (!base64 || base64 === dataUrl || !FileSystem.cacheDirectory) {
      setCaptureError("Không thể tạo file chữ ký PNG.");
      return;
    }
    const uri = `${FileSystem.cacheDirectory}pod-signature-${Crypto.randomUUID()}.png`;
    try {
      await FileSystem.writeAsStringAsync(uri, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const info = await FileSystem.getInfoAsync(uri);
      const success = await pod.upload(
        "SIGNATURE",
        {
          uri,
          name: "signature.png",
          mediaType: "image/png",
          sizeBytes: info.exists ? info.size : undefined,
        },
        new Date().toISOString(),
        activeSignature?.id,
      );
      if (success) {
        setShowSignature(false);
        onSignatureInteractionChange?.(false);
      }
    } catch {
      setCaptureError("Không thể lưu file chữ ký trên thiết bị.");
    }
  };

  const viewUploadedFile = async (item: DriverPodFile) => {
    const result = await pod.getView(item.id);
    if (result) {
      setPreview({
        url: result.url,
        title: item.evidenceType === "PHOTO" ? "Ảnh giao hàng" : "Chữ ký",
      });
    }
  };

  const requirements = !pod.isLoading && !pod.error ? pod.pod?.requirements : undefined;
  const photoStatus = !requirements
    ? "Chưa xác nhận trạng thái ảnh"
    : requirements.photoUploaded
    ? "Đã tải ảnh bằng chứng"
    : requirements.photoRequired
      ? "Chưa có ảnh bắt buộc"
      : "Ảnh không bắt buộc";
  const photos = pod.pod?.items.filter((item) => item.evidenceType === "PHOTO") ?? [];
  const signatures = pod.pod?.items.filter((item) => item.evidenceType === "SIGNATURE") ?? [];
  const attempt = stop.deliveryAttempt;
  const renderEvidence = (item: DriverPodFile, label: string, tile = false) => (
    <View key={item.id} style={[
      styles.itemCard, tile && styles.tile,
      item.uploadStatus === "FAILED" && styles.failedItem,
      item.isSuperseded && styles.supersededItem,
    ]}>
      <Text style={styles.previewTitle}>{label}</Text>
      <DriverStatusBadge small label={item.isSuperseded ? "Đã được thay thế" : uploadStatusLabel(item.uploadStatus)}
        tone={item.isSuperseded ? "neutral" : item.uploadStatus === "UPLOADED" ? "success"
          : item.uploadStatus === "FAILED" ? "error" : "info"} />
      {item.uploadStatus === "UPLOADED" ? (
        <EvidenceAction label="Xem lại" accessibilityLabel={`Xem lại ${label.toLowerCase()}`}
          disabled={pod.isViewing} onPress={() => void viewUploadedFile(item)} />
      ) : null}
      {!readOnly && item.evidenceType === "PHOTO" && item.uploadStatus === "UPLOADED" && !item.isSuperseded ? (
        <EvidenceAction label="Thay ảnh này" accessibilityLabel={`Thay ${label.toLowerCase()}`}
          disabled={pod.isUploading} onPress={() => void capturePhoto(item.id)} />
      ) : null}
    </View>
  );

  return (
    <View style={styles.panel} testID={`driver-pod-${attemptId}`}>
      <View style={styles.stopCard}>
        <DriverStatusBadge label={`Điểm ${stop.sequence} · Giao hàng`} tone="active" small />
        <Text style={styles.title}>{stop.address}</Text>
        {attempt ? (
          <>
            <Text style={styles.helperText}>Lần giao {attempt.attemptNumber} · {deliveryLabels[attempt.result]}</Text>
            {attempt.recipientName ? <Text style={styles.helperText}>Người nhận: {attempt.recipientName}</Text> : null}
          </>
        ) : null}
      </View>

      <View style={styles.policyCard}>
        <Text accessibilityRole="header" style={styles.title}>Yêu cầu bằng chứng</Text>
        <Text style={styles.helperText}>Máy chủ đã ghi nhận lần giao.</Text>
        {!readOnly ? (
          <Text style={styles.helperText}>Hoàn thành chuyến từ màn Tổng quan chuyến.</Text>
        ) : null}
        <DriverStatusBadge label={pod.isLoading ? "Đang kiểm tra POD…" : photoStatus}
          tone={requirements?.photoUploaded ? "success" : requirements?.photoRequired ? "warning" : "neutral"} small />
      </View>

      {pod.isUploading ? (
        <Text accessibilityLiveRegion="polite" style={styles.helperText}>Đang tải bằng chứng lên máy chủ…</Text>
      ) : null}
      {captureError ? <ScreenMessage message={captureError} /> : null}
      {pod.error ? <ScreenMessage message={pod.error} /> : null}

      <View style={styles.section}>
        <View style={styles.sectionHeading}>
          <Text accessibilityRole="header" style={styles.title}>Ảnh chứng từ</Text>
          {requirements ? <DriverStatusBadge label={requirements.photoRequired ? "Bắt buộc" : "Không bắt buộc"}
            tone={requirements.photoRequired ? "warning" : "neutral"} small /> : null}
        </View>
        {photos.length ? <View style={[styles.evidenceGrid, twoColumns && styles.columns]}>
          {photos.map((item, index) => renderEvidence(item, `Ảnh ${index + 1}`, twoColumns))}
        </View> : null}
        {!readOnly && (pendingPhoto ? (
          <View style={styles.localPreview}>
            <Text style={styles.previewTitle}>
              {pendingPhoto.supersedesId
                ? "Ảnh thay thế chưa tải lên"
                : "Ảnh mới chưa tải lên"}
            </Text>
            <Image
              source={{ uri: pendingPhoto.file.uri }}
              style={styles.previewImage}
              resizeMode="contain"
              testID="pod-local-photo-preview"
            />
            <PrimaryButton
              appearance="driver"
              label="Chụp lại"
              variant="secondary"
              disabled={pod.isUploading}
              onPress={() => void capturePhoto(pendingPhoto.supersedesId)}
            />
            <PrimaryButton
              appearance="driver"
              label="Hủy ảnh"
              variant="secondary"
              disabled={pod.isUploading}
              onPress={() => setPendingPhoto(null)}
            />
            <PrimaryButton
              appearance="driver"
              label="Xác nhận tải ảnh lên"
              loading={pod.isUploading}
              onPress={() => void uploadPendingPhoto()}
            />
          </View>
        ) : (
          <PrimaryButton
            appearance="driver"
            label={
              hasActivePhoto ? "Chụp thêm ảnh bằng chứng" : "Chụp ảnh bằng chứng"
            }
            loading={pod.isUploading}
            onPress={() => void capturePhoto()}
          />
        ))}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeading}>
          <Text accessibilityRole="header" style={styles.title}>Chữ ký người nhận</Text>
          <DriverStatusBadge label="Tùy chọn" tone="neutral" small />
        </View>
        {signatures.map((item) => renderEvidence(item, "Chữ ký"))}
        {!readOnly ? <PrimaryButton
          appearance="driver"
          label={
            showSignature
              ? "Đóng khung chữ ký"
              : activeSignature
                ? "Thay chữ ký"
                : "Thêm chữ ký (tùy chọn)"
          }
          variant="secondary"
          disabled={pod.isUploading}
          onPress={() => {
            onSignatureInteractionChange?.(false);
            setShowSignature((current) => !current);
          }}
        /> : null}
        {!readOnly && showSignature ? (
          <>
            <Text style={styles.helperText}>
              Chữ ký chỉ được tải lên khi nhấn “Dùng chữ ký”.
            </Text>
            <View
              style={styles.signatureContainer}
              testID="signature-touch-area"
              onTouchStart={() => onSignatureInteractionChange?.(true)}
              onTouchEnd={() => onSignatureInteractionChange?.(false)}
              onTouchCancel={() => onSignatureInteractionChange?.(false)}
            >
              <SignatureScreen
                ref={signatureRef}
                onOK={(signature) => void saveSignature(signature)}
                onEmpty={() => setCaptureError("Vui lòng ký trước khi xác nhận.")}
                onBegin={() => onSignatureInteractionChange?.(true)}
                onEnd={() => onSignatureInteractionChange?.(false)}
                autoClear={false}
                scrollable={false}
                nestedScrollEnabled={false}
                style={styles.signatureCanvas}
                webviewContainerStyle={styles.signatureCanvas}
                webviewProps={{ overScrollMode: "never" }}
                webStyle=".m-signature-pad { box-shadow: none; border: none; } .m-signature-pad--body { border: none; } .m-signature-pad--footer { display: none; } body,html { width: 100%; height: 100%; }"
              />
            </View>
            <PrimaryButton
              appearance="driver"
              label="Xóa nét ký"
              variant="secondary"
              disabled={pod.isUploading}
              onPress={() => signatureRef.current?.clearSignature()}
            />
            <PrimaryButton
              appearance="driver"
              label={activeSignature ? "Dùng chữ ký mới" : "Dùng chữ ký"}
              disabled={pod.isUploading}
              onPress={() => {
                onSignatureInteractionChange?.(false);
                signatureRef.current?.readSignature();
              }}
            />
          </>
        ) : null}
      </View>

      {!readOnly && pod.canRetry ? (
        <PrimaryButton
          appearance="driver"
          label="Thử tải lại file vừa chọn"
          variant="secondary"
          loading={pod.isUploading}
          onPress={() => void pod.retry()}
        />
      ) : null}
      <EvidenceAction
        label="Làm mới trạng thái POD" loading={pod.isLoading}
        disabled={pod.isUploading}
        onPress={() => void pod.reload()}
      />

      <Modal
        visible={Boolean(preview)}
        transparent
        animationType="fade"
        onRequestClose={() => setPreview(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.title}>{preview?.title}</Text>
            {preview ? (
              <Image
                source={{ uri: preview.url }}
                style={styles.remotePreviewImage}
                resizeMode="contain"
                testID="pod-remote-preview"
              />
            ) : null}
            <Text style={styles.helperText}>
              Liên kết xem chỉ có hiệu lực trong thời gian ngắn.
            </Text>
            <PrimaryButton appearance="driver" label="Đóng" onPress={() => setPreview(null)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

function EvidenceAction({ label, accessibilityLabel, onPress, disabled, loading }: {
  label: string; accessibilityLabel?: string; onPress(): void; disabled?: boolean; loading?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled || !!loading, busy: !!loading }}
      disabled={disabled || loading} onPress={onPress} style={styles.evidenceAction}>
      {loading ? <ActivityIndicator color={colors.info} /> :
        <Text style={[styles.actionText, disabled && styles.disabledText]}>{label}</Text>}
    </Pressable>
  );
}

function uploadStatusLabel(status: string) {
  if (status === "UPLOADED") return "Đã tải lên";
  if (status === "FAILED") return "Tải lên thất bại";
  if (status === "UPLOADING") return "Đang tải lên";
  return "Chờ tải lên";
}

const styles = StyleSheet.create({
  panel: { gap: spacing.sm },
  stopCard: {
    padding: spacing.md, gap: spacing.xs, borderRadius: driverTheme.radius.card,
    backgroundColor: colors.infoSurface,
  },
  policyCard: {
    padding: spacing.md, gap: spacing.xs, borderRadius: driverTheme.radius.card,
    backgroundColor: colors.neutralSurface, borderColor: colors.border, borderWidth: 1,
  },
  section: {
    padding: spacing.md,
    gap: spacing.sm,
    borderRadius: driverTheme.radius.card,
    backgroundColor: colors.surface,
  },
  sectionHeading: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.xs, justifyContent: "space-between" },
  title: { ...driverTheme.type.strong, color: colors.text },
  evidenceGrid: { gap: spacing.xs },
  columns: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  tile: { width: "48%" },
  itemCard: {
    gap: spacing.xs,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.background,
  },
  failedItem: { borderColor: colors.danger, backgroundColor: colors.dangerSurface },
  supersededItem: { opacity: 0.65 },
  localPreview: { gap: spacing.sm },
  previewTitle: { ...driverTheme.type.meta, color: colors.text, fontWeight: "700" },
  previewImage: {
    width: "100%",
    height: 260,
    borderRadius: 12,
    backgroundColor: colors.surface,
  },
  signatureContainer: {
    height: 280,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  signatureCanvas: { flex: 1 },
  helperText: { ...driverTheme.type.meta, color: colors.textMuted },
  evidenceAction: { minHeight: driverTheme.touchTarget, justifyContent: "center" },
  actionText: { ...driverTheme.type.meta, color: colors.info, fontWeight: "700" },
  disabledText: { opacity: 0.55 },
  modalBackdrop: {
    flex: 1,
    justifyContent: "center",
    padding: spacing.lg,
    backgroundColor: "rgba(0,0,0,0.7)",
  },
  modalCard: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: 16,
    backgroundColor: colors.background,
  },
  remotePreviewImage: {
    width: "100%",
    height: 420,
    borderRadius: 12,
    backgroundColor: colors.surface,
  },
});
