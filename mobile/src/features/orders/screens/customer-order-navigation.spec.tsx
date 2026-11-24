import { fireEvent, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import { CustomerHomeScreen } from '@/features/auth/screens/CustomerHomeScreen';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

jest.mock('@/features/auth/hooks/useAuth', () => ({
  useAuth: () => ({
    user: {
      id: 'user-1',
      username: 'customer',
      fullName: 'Customer Test',
      role: 'CUSTOMER',
      phone: '0900000000',
      email: null,
      active: true,
      branchId: null,
      locationId: null,
      customer: {
        id: 'customer-1',
        code: 'CUS-1',
        name: 'Customer Test',
        phone: '0900000000',
        email: null,
      },
    },
    refreshProfile: jest.fn(),
    logout: jest.fn(),
  }),
}));

describe('Customer order navigation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('đi từ Customer Home tới danh sách và form tạo đơn', async () => {
    const view = await render(<CustomerHomeScreen />);
    fireEvent.press(view.getByText('Đơn vận chuyển'));
    expect(router.push).toHaveBeenCalledWith('/orders');

    fireEvent.press(view.getByText('Tạo đơn mới'));
    expect(router.push).toHaveBeenCalledWith('/orders/create');
  });
});
