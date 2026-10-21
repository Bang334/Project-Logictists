import React, { useEffect, useState } from 'react';
import { Alert, Button, Select, Space } from 'antd';
import axios from 'axios';
import { apiErrorMessage, customersApi } from '../api/client';
import { CustomerChoice } from '../types/customers';

export default function CustomerSelect({ branchId, value, onChange, disabled }: { branchId?: string; value?: string; onChange?: (value?: string) => void; disabled?: boolean }) {
  const [rows, setRows] = useState<CustomerChoice[]>([]), [selected, setSelected] = useState<CustomerChoice>();
  const [search, setSearch] = useState(''), [page, setPage] = useState(1), [total, setTotal] = useState(0), [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  useEffect(() => { setSearch(''); setPage(1); setRows([]); setSelected(undefined); }, [branchId]);
  useEffect(() => {
    let live = true;
    setSelected(undefined);
    if (value && branchId) void customersApi.getOne(value, branchId).then(c => { if (live) setSelected(c); }).catch(e => { if (live && !axios.isCancel(e)) setError(apiErrorMessage(e)); });
    return () => { live = false; };
  }, [value, branchId, reload]);
  useEffect(() => {
    let live = true; setRows([]); setTotal(0); setError('');
    if (!branchId) { setLoading(false); return; }
    setLoading(true);
    const timer = window.setTimeout(() => {
      void customersApi.lookup({ branchId, search, page, pageSize: 25 }).then(r => { if (live) { setRows(r.items); setTotal(r.total); } })
        .catch(e => { if (live && !axios.isCancel(e)) setError(apiErrorMessage(e)); }).finally(() => { if (live) setLoading(false); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [branchId, search, page, reload]);
  const choices = selected && !rows.some(r => r.id === selected.id) ? [selected, ...rows] : rows;
  return <Space direction="vertical" style={{ width: '100%' }}>
    <Select aria-label="Khách hàng" style={{ width: '100%' }} value={value} onChange={onChange} disabled={disabled || !branchId} loading={loading}
      showSearch filterOption={false} onSearch={s => { setSearch(s); setPage(1); }} placeholder="Tìm mã, tên hoặc điện thoại khách"
      options={choices.map(c => ({ value: c.id, label: `${c.code} — ${c.name}` }))} notFoundContent={loading ? 'Đang tìm...' : 'Không có khách phù hợp'} />
    <Space wrap><Button size="small" disabled={disabled || loading || page <= 1} onClick={() => setPage(p => p - 1)}>Khách: trang trước</Button>
      <span>Trang {page} · {total} khách</span><Button size="small" disabled={disabled || loading || page * 25 >= total} onClick={() => setPage(p => p + 1)}>Khách: trang sau</Button></Space>
    {error && <Alert type="error" message={error} action={<Button onClick={() => setReload(n => n + 1)}>Thử lại</Button>} />}
  </Space>;
}
