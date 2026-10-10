import React, { useRef, useState } from 'react';
import { ActivityIndicator, Button, Linking, Modal, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

export function PickupScanner({ onScan, onClose }: { onScan: (code: string) => void; onClose: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const captured = useRef(false);
  return <Modal visible onRequestClose={onClose} animationType="slide">
    <View style={{ flex: 1, padding: 24, paddingTop: 60, gap: 16 }}>
      <Text>Quét QR riêng trên nhãn kiện hàng</Text>
      {!permission ? <ActivityIndicator accessibilityLabel="Đang kiểm tra quyền camera" /> : !permission.granted ? <>
        <Text>Cần quyền camera để quét kiện. Không thể thay bằng nhập mã thủ công.</Text>
        <Button title={permission.canAskAgain ? 'Cho phép camera' : 'Mở cài đặt camera'} onPress={() => {
          void (permission.canAskAgain ? requestPermission() : Linking.openSettings()).catch(() => setError('Không mở được quyền camera. Hãy kiểm tra cài đặt thiết bị.'));
        }} />
      </> : <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onMountError={() => setError('Không khởi động được camera. Hãy đóng và thử lại.')}
        onBarcodeScanned={({ data, type }) => {
          if (captured.current || type !== 'qr') return;
          if (!data || data.length > 256) { setError('QR không hợp lệ cho kiện hàng.'); return; }
          captured.current = true;
          onScan(data);
        }} />}
      {error && <Text accessibilityRole="alert">{error}</Text>}
      <Button title="Đóng máy quét" onPress={onClose} />
    </View>
  </Modal>;
}
