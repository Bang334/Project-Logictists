Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
  writable: true,
});

jest.mock('react-native-signature-canvas', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return React.forwardRef(function MockSignatureCanvas(
    _props: unknown,
    ref: { current: unknown },
  ) {
    React.useImperativeHandle(ref, () => ({
      clearSignature: jest.fn(),
      readSignature: jest.fn(),
    }));
    return React.createElement(View, { testID: 'signature-canvas' });
  });
});
