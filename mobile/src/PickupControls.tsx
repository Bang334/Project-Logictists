import React, { useState } from 'react';
import { Button, Text, TextInput, View } from 'react-native';
import { AssignmentDetail, PickupScan } from './contracts';
import { DriverStore } from './store';
import { PickupScanner } from './PickupScanner';

export function PickupControls({ stop, store, disabled }: {
  stop: AssignmentDetail['trip']['stops'][number]; store: DriverStore; disabled: boolean;
}) {
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState<{ code: string; preview: PickupScan } | null>(null);
  const [closing, setClosing] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const pending = stop.tasks.filter(t => !t.pickup);
  const loaded = stop.tasks.filter(t => t.pickup?.outcome === 'LOADED').length;
  const outcome = loaded === stop.tasks.length ? 'FULL' : loaded === 0 ? 'NONE' : 'PARTIAL';
  const label = outcome === 'FULL' ? 'Lấy đủ' : outcome === 'NONE' ? 'Chưa lấy được kiện nào' : 'Lấy thiếu';
  if (stop.stopType !== 'PICKUP' || !stop.tasks.length || stop.tasks.some(t => t.action !== 'LOAD')) return <Text>Điểm này cần nghiệp vụ giao hàng hoặc xử lý khác; chưa hỗ trợ trong mốc pickup.</Text>;
  return <View style={{ gap: 12, padding: 12, backgroundColor: '#eaf4ff' }}>
    <Text>Chờ hoàn tất nghiệp vụ tại điểm. Đã xếp lên xe: {loaded}/{stop.tasks.length} kiện.</Text>
    <Button title="Quét QR kiện cần lấy" disabled={disabled || pending.length === 0} onPress={() => { setClosing(false); setScanned(null); setScanning(true); }} />
    {scanning && !disabled && <PickupScanner onClose={() => setScanning(false)} onScan={code => {
      setScanning(false);
      void store.scanPickup(stop.id, code).then(preview => { if (preview) setScanned({ code, preview }); });
    }} />}
    {scanned && <View style={{ gap: 12 }}>
      <Text>Kiện: {scanned.preview.packageCode}</Text>
      <Text>Kế hoạch xếp v{scanned.preview.loadPlanRevision}: vị trí x={scanned.preview.placement.xMm}, y={scanned.preview.placement.yMm} mm; trên sàn xe, qua cửa sau.</Text>
      <Text>Quét mã chưa xác nhận lấy hàng. Chỉ xác nhận sau khi đã nhận và xếp đúng kiện lên xe theo vị trí kế hoạch.</Text>
      <Button title="Xác nhận đã xếp kiện lên xe" disabled={disabled} onPress={() => void store.respond('pickup', '', stop.id, { qrCode: scanned.code, loadedOnVehicle: true })} />
      <Button title="Hủy xác nhận kiện" disabled={disabled} onPress={() => setScanned(null)} />
    </View>}
    <Button title="Kết thúc lấy hàng tại điểm" disabled={disabled} onPress={() => { setScanned(null); setClosing(true); }} />
    {closing && <View style={{ gap: 12 }}>
      <Text>Hiện trạng: {label} — đã lấy {loaded}/{stop.tasks.length} kiện.</Text>
      {pending.map(task => <View key={task.id}>
        <Text>Chưa lấy: {task.package?.packageCode ?? task.id}</Text>
        <TextInput accessibilityLabel={`Lý do chưa lấy ${task.package?.packageCode ?? task.id}`} placeholder="Ghi rõ lý do; chưa rõ thì ghi chưa xác định" multiline maxLength={1000}
          editable={!disabled} value={reasons[task.id] ?? ''} onChangeText={text => setReasons(old => ({ ...old, [task.id]: text }))}
          style={{ borderWidth: 1, padding: 12, marginTop: 6 }} />
      </View>)}
      <Text>Xác nhận kết thúc lần lấy hàng này. Các kiện chưa lấy được giữ lại để điều phối xử lý; không được ghi là đang trên xe.</Text>
      <Button title={`Xác nhận hiện trạng: ${label}`} disabled={disabled || pending.some(t => !reasons[t.id]?.trim())}
        onPress={() => void store.respond('complete-pickup', '', stop.id, { declaredOutcome: outcome, missing: pending.map(t => ({ taskId: t.id, reason: reasons[t.id].trim() })) })} />
      <Button title="Tiếp tục lấy hàng" disabled={disabled} onPress={() => setClosing(false)} />
    </View>}
  </View>;
}
