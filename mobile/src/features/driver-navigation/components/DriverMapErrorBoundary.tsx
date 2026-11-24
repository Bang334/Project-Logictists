import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ScreenMessage } from '@/shared/components/ScreenMessage';

export class DriverMapErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Do not log access tokens or native error payloads in production output.
  }

  render() {
    if (this.state.failed) {
      return <ScreenMessage message="Không thể hiển thị Mapbox. Bạn vẫn có thể quay lại chi tiết chuyến và dùng điều hướng ngoài." />;
    }
    return this.props.children;
  }
}
