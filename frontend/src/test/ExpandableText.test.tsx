import { describe, expect, it } from 'vitest';
import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { ExpandableText } from '../components/ExpandableText';

describe('ExpandableText Component', () => {
  it('renders short text directly without expand button', () => {
    render(<ExpandableText text="Khách hàng ngắn" maxChars={30} />);
    expect(screen.getByText('Khách hàng ngắn')).toBeDefined();
    expect(screen.queryByText('[Xem thêm]')).toBeNull();
  });

  it('renders fallback dash when text is null or empty', () => {
    render(<ExpandableText text="" />);
    expect(screen.getByText('—')).toBeDefined();
  });

  it('truncates long text and expands on click, then collapses on next click', () => {
    const longAddress = '236/6 Điện Biên Phủ, Phường 17, Bình Thạnh, TP.HCM';
    render(<ExpandableText text={longAddress} maxChars={25} />);

    // Initially truncated
    expect(screen.getByText(/236\/6 Điện Biên Phủ/)).toBeDefined();
    expect(screen.getByText('[Xem thêm]')).toBeDefined();

    // Click to expand
    fireEvent.click(screen.getByText('[Xem thêm]'));
    expect(screen.getByText(longAddress)).toBeDefined();
    expect(screen.getByText('[Thu gọn]')).toBeDefined();

    // Click again to collapse
    fireEvent.click(screen.getByText('[Thu gọn]'));
    expect(screen.getByText('[Xem thêm]')).toBeDefined();
  });
});
