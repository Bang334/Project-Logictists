import { useEffect, useState } from 'react';
import { Alert, Button, Descriptions, Spin, Typography } from 'antd';
import { apiClient, apiErrorMessage } from '../api/client';
import { ManagedBranch, parseManagedBranch } from '../types/branches';

export default function BranchDetailPage() {
  const id = new URLSearchParams(window.location.search).get('branch');
  const [branch, setBranch] = useState<ManagedBranch>(), [error, setError] = useState(''), [loading, setLoading] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true; setBranch(undefined); setError('');
    if (!id) { setError('Thiếu ID chi nhánh'); return; }
    setLoading(true);
    void apiClient.get<unknown>('/branches/' + encodeURIComponent(id)).then(r => { if (live) setBranch(parseManagedBranch(r.data)); })
      .catch(e => { if (live) setError(apiErrorMessage(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [id, retry]);
  return <main id="main-content" className="tms-page"><Typography.Title level={3}>Chi tiết chi nhánh</Typography.Title>
    {loading && <Spin />}{error && <Alert type="error" message={error} action={<Button onClick={() => setRetry(n => n + 1)}>Thử lại</Button>} />}
    {branch && <Descriptions column={1} items={[{ key: 'id', label: 'ID', children: branch.id }, { key: 'code', label: 'Mã', children: branch.code }, { key: 'name', label: 'Tên', children: branch.name }, { key: 'address', label: 'Địa chỉ', children: branch.address }, { key: 'active', label: 'Trạng thái', children: branch.active ? 'Hoạt động' : 'Ngừng hoạt động' }]} />}
  </main>;
}
