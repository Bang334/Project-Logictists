import { colors, spacing } from './theme';

export const driverTheme = {
  colors: {
    ...colors,
    background: '#F8FAFC',
    primary: '#1E3A8A',
    text: '#0F172A',
    textMuted: '#475569',
    border: '#CBD5E1',
    focus: '#0284C7',
    info: '#075985',
    infoSurface: '#E0F2FE',
    success: '#047857',
    successSurface: '#ECFDF5',
    warning: '#92400E',
    warningSurface: '#FFFBEB',
    danger: '#B91C1C',
    dangerSurface: '#FEF2F2',
    neutralSurface: '#F1F5F9',
  },
  spacing,
  radius: { card: 16, control: 12, pill: 999 },
  touchTarget: 48,
  actionHeight: 52,
  type: {
    title: { fontSize: 24, lineHeight: 32, fontWeight: '800' },
    heading: { fontSize: 18, lineHeight: 24, fontWeight: '700' },
    strong: { fontSize: 16, lineHeight: 22, fontWeight: '700' },
    body: { fontSize: 16, lineHeight: 22 },
    meta: { fontSize: 14, lineHeight: 20 },
    label: { fontSize: 12, lineHeight: 16 },
  },
} as const;
