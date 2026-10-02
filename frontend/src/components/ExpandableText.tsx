import React, { useState } from 'react';
import { Typography, Tooltip } from 'antd';

const { Text } = Typography;

export interface ExpandableTextProps {
  text?: string | null;
  maxChars?: number;
  strong?: boolean;
  type?: 'secondary' | 'success' | 'warning' | 'danger';
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  subText?: React.ReactNode;
  style?: React.CSSProperties;
  maxWidth?: number | string;
  expandText?: string;
  collapseText?: string;
}

export const ExpandableText: React.FC<ExpandableTextProps> = ({
  text,
  maxChars = 32,
  strong = false,
  type,
  prefix,
  suffix,
  subText,
  style,
  maxWidth = 260,
  expandText = 'Xem thêm',
  collapseText = 'Thu gọn',
}) => {
  const [expanded, setExpanded] = useState<boolean>(false);

  if (!text || text.trim() === '') {
    return (
      <div style={{ maxWidth, ...style }}>
        <Text type="secondary">—</Text>
        {subText && <div style={{ marginTop: 2 }}>{subText}</div>}
      </div>
    );
  }

  const isLong = text.length > maxChars;
  const displayText = expanded || !isLong ? text : `${text.slice(0, maxChars)}...`;

  return (
    <div
      style={{
        maxWidth,
        wordBreak: 'break-word',
        whiteSpace: 'normal',
        lineHeight: 1.45,
        ...style,
      }}
    >
      <Tooltip title={!expanded && isLong ? text : undefined} mouseEnterDelay={0.5}>
        <span
          onClick={(e) => {
            if (isLong) {
              e.stopPropagation();
              setExpanded(!expanded);
            }
          }}
          style={{
            cursor: isLong ? 'pointer' : 'default',
            display: 'inline',
          }}
        >
          {prefix}
          <Text strong={strong} type={type} style={{ color: style?.color }}>
            {displayText}
          </Text>
          {isLong && (
            <span
              style={{
                color: '#2563eb',
                fontSize: '11px',
                marginLeft: 4,
                fontWeight: 500,
                whiteSpace: 'nowrap',
                userSelect: 'none',
              }}
            >
              [{expanded ? collapseText : expandText}]
            </span>
          )}
          {suffix}
        </span>
      </Tooltip>
      {subText && <div style={{ marginTop: 2 }}>{subText}</div>}
    </div>
  );
};

export default ExpandableText;
